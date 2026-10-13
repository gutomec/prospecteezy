// Baileys auth state persisted in SQLite (auth_state table) — port of the
// agentic-whatsapp-nirvana squad's template/lib/auth-state.ts, single-instance
// (this project runs exactly one dedicated number). Mirrors the upstream
// AuthenticationState { creds, keys } contract, serialized with BufferJSON.
import type { Database } from "bun:sqlite";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "baileys";

export interface SQLiteAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearAll: () => void;
}

/** Default instance id — its auth uses the LEGACY unprefixed categories, so the
 *  single-number `wa:pair`/validate/contacts flows keep working untouched. */
export const DEFAULT_INSTANCE = "main";

/**
 * Multi-instance auth scoping (ported from the squad template, ADR 005):
 * `main` keeps the legacy categories ('creds', 'pre-key', ...) so nothing that
 * already exists moves; every other instance prefixes its categories with
 * `i:<id>:`. The auth_state PK (category, key_id) stays unique across accounts
 * by construction.
 */
export function authCategoryPrefix(instanceId: string = DEFAULT_INSTANCE): string {
  return instanceId === DEFAULT_INSTANCE ? "" : `i:${instanceId}:`;
}

export function useSQLiteAuthState(
  db: Database,
  instanceId: string = DEFAULT_INSTANCE,
): SQLiteAuthState {
  const prefix = authCategoryPrefix(instanceId);
  const readStmt = db.prepare("SELECT value FROM auth_state WHERE category = ? AND key_id = ?");
  const writeStmt = db.prepare(
    `INSERT INTO auth_state (category, key_id, value, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (category, key_id)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const deleteStmt = db.prepare("DELETE FROM auth_state WHERE category = ? AND key_id = ?");

  const read = (category: string, keyId = ""): unknown => {
    const row = readStmt.get(prefix + category, keyId) as { value: string } | null;
    if (!row) return null;
    return JSON.parse(row.value, BufferJSON.reviver);
  };
  const write = (category: string, keyId: string, value: unknown): void => {
    writeStmt.run(prefix + category, keyId, JSON.stringify(value, BufferJSON.replacer));
  };

  const creds: AuthenticationCreds =
    (read("creds") as AuthenticationCreds | null) ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const data: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = read(type, id);
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          if (value !== null && value !== undefined) {
            data[id] = value as SignalDataTypeMap[T];
          }
        }
        return data;
      },
      set: (data: SignalDataSet) => {
        const tx = db.transaction(() => {
          for (const category in data) {
            const entries = data[category as keyof SignalDataTypeMap];
            for (const id in entries) {
              const value = entries[id];
              if (value === null || value === undefined) deleteStmt.run(prefix + category, id);
              else write(category, id, value);
            }
          }
        });
        tx();
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      write("creds", "", creds);
    },
    clearAll: () => {
      // Clears ONLY this instance's auth (never the other accounts).
      if (prefix === "") {
        db.prepare("DELETE FROM auth_state WHERE category NOT LIKE 'i:%'").run();
      } else {
        db.prepare("DELETE FROM auth_state WHERE category LIKE ?").run(`${prefix}%`);
      }
    },
  };
}

/** Wipes the auth of a single instance (DELETE/logout flow); next connect needs
 *  a fresh QR. Never touches the other instances' credentials. */
export function clearInstanceAuth(db: Database, instanceId: string = DEFAULT_INSTANCE): void {
  useSQLiteAuthState(db, instanceId).clearAll();
}

/** The account is paired when the stored credentials carry an identity. */
export function isPaired(
  db: Database,
  instanceId: string = DEFAULT_INSTANCE,
): { paired: boolean; meJid: string | null } {
  const row = db
    .prepare("SELECT value FROM auth_state WHERE category = ? AND key_id = ''")
    .get(`${authCategoryPrefix(instanceId)}creds`) as { value: string } | null;
  if (!row) return { paired: false, meJid: null };
  try {
    const creds = JSON.parse(row.value, BufferJSON.reviver) as AuthenticationCreds;
    const meJid = creds.me?.id ?? null;
    return { paired: Boolean(creds.registered || meJid), meJid };
  } catch {
    return { paired: false, meJid: null };
  }
}
