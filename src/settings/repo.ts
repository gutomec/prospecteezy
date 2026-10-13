import type { Database } from "bun:sqlite";
import { nowIso } from "../db/index.ts";
import { last4, type SecretBox } from "./secrets.ts";

const SERPER_KEY = "serper_api_key";
const COMPANY_PROFILE_KEY = "company_profile";

export function getSetting(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM app_settings WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowIso());
}

export function deleteSetting(db: Database, key: string): void {
  db.query("DELETE FROM app_settings WHERE key = ?").run(key);
}

// ---------------------------------------------------------------- company profile

export const COMPANY_PROFILE_FIELDS = [
  "name",
  "website",
  "description",
  "offering",
  "target_customers",
  "differentiators",
  "tone",
  "signature",
  "call_to_action",
  "extra_instructions",
] as const;

export type CompanyProfile = Partial<Record<(typeof COMPANY_PROFILE_FIELDS)[number], string>>;

export const COMPANY_FIELD_MAX = 4000;

export function getCompanyProfile(db: Database): CompanyProfile | null {
  const raw = getSetting(db, COMPANY_PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CompanyProfile;
  } catch {
    return null;
  }
}

/** Validates a PUT body. Unknown keys are ignored; blank fields are dropped. */
export function parseCompanyProfile(
  body: unknown,
): { ok: true; profile: CompanyProfile } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Corpo inválido. Envie um objeto JSON com os campos do perfil da empresa." };
  }
  const profile: CompanyProfile = {};
  for (const field of COMPANY_PROFILE_FIELDS) {
    const value = (body as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      return { ok: false, error: `Campo "${field}" deve ser texto.` };
    }
    const trimmed = value.trim();
    if (trimmed.length > COMPANY_FIELD_MAX) {
      return { ok: false, error: `Campo "${field}" excede ${COMPANY_FIELD_MAX} caracteres.` };
    }
    if (trimmed) profile[field] = trimmed;
  }
  return { ok: true, profile };
}

/** Saves the profile; an all-empty profile clears it (GET returns null). */
export function saveCompanyProfile(db: Database, profile: CompanyProfile): CompanyProfile | null {
  if (Object.keys(profile).length === 0) {
    deleteSetting(db, COMPANY_PROFILE_KEY);
    return null;
  }
  setSetting(db, COMPANY_PROFILE_KEY, JSON.stringify(profile));
  return profile;
}

// ---------------------------------------------------------------- serper key

export interface SerperStatus {
  configured: boolean;
  source: "settings" | "env" | null;
  last4: string | null;
}

/** Decrypted DB key, or null (absent or unreadable). `unreadable` flags the latter. */
async function readStoredSerperKey(
  db: Database,
  box: SecretBox,
): Promise<{ key: string | null; unreadable: boolean }> {
  const blob = getSetting(db, SERPER_KEY);
  if (!blob) return { key: null, unreadable: false };
  const key = await box.decrypt(blob);
  return { key, unreadable: key === null };
}

function envSerperKey(): string | null {
  const value = Bun.env.SERPER_API_KEY?.trim();
  return value ? value : null;
}

/** Settings value ?? SERPER_API_KEY from .env ?? null. */
export async function getSerperApiKey(db: Database, box: SecretBox): Promise<string | null> {
  return (await readStoredSerperKey(db, box)).key ?? envSerperKey();
}

export async function getSerperStatus(
  db: Database,
  box: SecretBox,
): Promise<SerperStatus & { unreadable: boolean }> {
  const stored = await readStoredSerperKey(db, box);
  if (stored.key) {
    return { configured: true, source: "settings", last4: last4(stored.key), unreadable: false };
  }
  const env = envSerperKey();
  if (env) return { configured: true, source: "env", last4: last4(env), unreadable: stored.unreadable };
  return { configured: false, source: null, last4: null, unreadable: stored.unreadable };
}

export async function setSerperApiKey(db: Database, box: SecretBox, apiKey: string): Promise<void> {
  setSetting(db, SERPER_KEY, await box.encrypt(apiKey));
}

export function deleteSerperApiKey(db: Database): void {
  deleteSetting(db, SERPER_KEY);
}
