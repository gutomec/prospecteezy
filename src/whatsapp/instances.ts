// Instance registry (wa-backend phase). One instance = one paired WhatsApp
// account = one Baileys socket. Auth is scoped by category prefix (auth-state.ts)
// and mirror rows are filtered by instance_id. The active instance for sending
// is persisted in runtime_state so the selector survives reloads/restarts.
//
// Pattern ported from the squad template lib/instances.ts (~/squads is READ-ONLY):
// same slug rule and the `main`-is-legacy convention, trimmed to what this
// project's HTTP backend needs (no org-level status machine, no daemon targets).
import type { Database } from "bun:sqlite";
import { DEFAULT_INSTANCE } from "./auth-state.ts";
import { getState, nowIso, setState } from "./db.ts";

export { DEFAULT_INSTANCE } from "./auth-state.ts";
export const INSTANCE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ACTIVE_KEY = "active_instance";

export interface InstanceRow {
  id: string;
  name: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
}

export function isValidInstanceId(id: string): boolean {
  return INSTANCE_ID_RE.test(id);
}

/** Fresh, collision-resistant slug that satisfies INSTANCE_ID_RE (letter-first). */
export function generateInstanceId(): string {
  return `wa${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/** Runtime_state key namespaced per instance ('main' keeps the legacy key). */
export function stateKey(key: string, instanceId: string = DEFAULT_INSTANCE): string {
  return instanceId === DEFAULT_INSTANCE ? key : `${key}@${instanceId}`;
}

export function listInstances(db: Database): InstanceRow[] {
  return db
    .query("SELECT id, name, phone, created_at, updated_at FROM instances ORDER BY created_at")
    .all() as InstanceRow[];
}

export function getInstance(db: Database, id: string): InstanceRow | null {
  return db
    .query("SELECT id, name, phone, created_at, updated_at FROM instances WHERE id = ?")
    .get(id) as InstanceRow | null;
}

export function instanceExists(db: Database, id: string): boolean {
  return Boolean(db.query("SELECT 1 FROM instances WHERE id = ?").get(id));
}

export function createInstance(
  db: Database,
  input: { id?: string; name?: string | null } = {},
): InstanceRow {
  const id = input.id ?? generateInstanceId();
  if (!isValidInstanceId(id)) {
    throw new Error(`Id de instância inválido: '${id}' (slug: letra inicial + [a-z0-9-], máx. 32).`);
  }
  if (instanceExists(db, id)) {
    throw new Error(`Instância '${id}' já existe.`);
  }
  const at = nowIso();
  db.query(
    "INSERT INTO instances (id, name, phone, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)",
  ).run(id, input.name ?? null, at, at);
  // First instance created becomes the active one by default.
  if (!getActiveInstance(db)) setActiveInstance(db, id);
  return getInstance(db, id)!;
}

export function setInstancePhone(db: Database, id: string, phone: string | null): void {
  db.query("UPDATE instances SET phone = ?, updated_at = ? WHERE id = ?").run(phone, nowIso(), id);
}

export function deleteInstance(db: Database, id: string): void {
  db.transaction(() => {
    db.query("DELETE FROM instances WHERE id = ?").run(id);
    db.query("DELETE FROM chats WHERE instance_id = ?").run(id);
    db.query("DELETE FROM messages WHERE instance_id = ?").run(id);
    db.query("DELETE FROM contacts WHERE instance_id = ?").run(id);
    // Per-instance runtime_state: `<key>@<id>` and lazy-load anchors. The id
    // is a slug ([a-z0-9-]), so it carries no LIKE wildcards. `main` uses the
    // legacy unsuffixed keys.
    db.query("DELETE FROM runtime_state WHERE key LIKE ? OR key LIKE ?").run(`%@${id}`, `hist_anchor:${id}:%`);
    if (id === DEFAULT_INSTANCE) {
      for (const k of ["connection_status", "me_jid", "last_disconnect"]) {
        db.query("DELETE FROM runtime_state WHERE key = ?").run(stateKey(k, id));
      }
    }
    if (getActiveInstance(db) === id) {
      const next = db.query("SELECT id FROM instances LIMIT 1").get() as { id: string } | null;
      setActiveInstance(db, next?.id ?? null);
    }
  })();
}

export function getActiveInstance(db: Database): string | null {
  const value = getState(db, ACTIVE_KEY);
  return value && value.length > 0 ? value : null;
}

export function setActiveInstance(db: Database, id: string | null): void {
  setState(db, ACTIVE_KEY, id ?? "");
}
