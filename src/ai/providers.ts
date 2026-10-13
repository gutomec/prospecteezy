import type { Database } from "bun:sqlite";
import { nowIso } from "../db/index.ts";
import { last4, type SecretBox } from "../settings/secrets.ts";
import { isProviderKind, PROVIDER_KIND_LABELS, type ProviderKind } from "./models.ts";

export interface ProviderRow {
  id: string;
  kind: ProviderKind;
  label: string;
  model: string;
  base_url: string | null;
  api_key_enc: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

/** Browser-safe view: the key itself never leaves the server. */
export interface ProviderView {
  id: string;
  kind: ProviderKind;
  label: string;
  model: string;
  base_url: string | null;
  has_key: boolean;
  last4: string | null;
  is_active: boolean;
  created_at: string;
}

export class ProviderValidationError extends Error {}

const MAX_LABEL = 100;
const MAX_MODEL = 200;
const MAX_KEY = 1000;
const MAX_URL = 500;

export async function toView(row: ProviderRow, box: SecretBox): Promise<ProviderView> {
  const key = row.api_key_enc ? await box.decrypt(row.api_key_enc) : null;
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    model: row.model,
    base_url: row.base_url,
    has_key: row.api_key_enc !== null,
    last4: last4(key),
    is_active: row.is_active === 1,
    created_at: row.created_at,
  };
}

export function getProvider(db: Database, id: string): ProviderRow | null {
  return db.query("SELECT * FROM llm_providers WHERE id = ?").get(id) as ProviderRow | null;
}

export function listProviderRows(db: Database): ProviderRow[] {
  return db.query("SELECT * FROM llm_providers ORDER BY created_at ASC, id ASC").all() as ProviderRow[];
}

export function getActiveProvider(db: Database): ProviderRow | null {
  return db.query("SELECT * FROM llm_providers WHERE is_active = 1 LIMIT 1").get() as ProviderRow | null;
}

/** Decrypted API key of a provider: null when absent, undefined when unreadable. */
export async function providerApiKey(row: ProviderRow, box: SecretBox): Promise<string | null | undefined> {
  if (!row.api_key_enc) return null;
  return (await box.decrypt(row.api_key_enc)) ?? undefined;
}

function optionalString(body: Record<string, unknown>, field: string, max: number): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ProviderValidationError(`Campo "${field}" deve ser texto.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ProviderValidationError(`Campo "${field}" excede ${max} caracteres.`);
  return trimmed;
}

function validateBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return url;
  } catch {
    /* fall through */
  }
  throw new ProviderValidationError("URL base inválida: use um endereço http:// ou https:// (ex.: http://localhost:11434/v1).");
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ProviderValidationError("Corpo inválido. Envie um objeto JSON.");
  }
  return body as Record<string, unknown>;
}

export async function createProvider(db: Database, box: SecretBox, rawBody: unknown): Promise<ProviderRow> {
  const body = asObject(rawBody);
  if (!isProviderKind(body.kind)) {
    throw new ProviderValidationError(
      'Tipo de provedor inválido. Use "openai", "google", "anthropic", "openrouter" ou "openai_compatible".',
    );
  }
  const kind = body.kind;
  const model = optionalString(body, "model", MAX_MODEL);
  if (!model) throw new ProviderValidationError("Informe o modelo (ex.: gpt-5-mini).");
  const label = optionalString(body, "label", MAX_LABEL) || PROVIDER_KIND_LABELS[kind];
  const apiKey = optionalString(body, "api_key", MAX_KEY) || null;
  const rawUrl = optionalString(body, "base_url", MAX_URL) || null;
  const baseUrl = rawUrl ? validateBaseUrl(rawUrl) : null;
  if (kind === "openai_compatible" && !baseUrl) {
    throw new ProviderValidationError(
      'Para "Compatível com OpenAI", informe a URL base (ex.: http://localhost:11434/v1).',
    );
  }
  if (kind !== "openai_compatible" && !apiKey) {
    throw new ProviderValidationError("Informe a chave de API do provedor.");
  }

  const apiKeyEnc = apiKey ? await box.encrypt(apiKey) : null;
  const id = crypto.randomUUID();
  const now = nowIso();
  db.transaction(() => {
    const hasActive = getActiveProvider(db) !== null;
    db.query(
      `INSERT INTO llm_providers (id, kind, label, model, base_url, api_key_enc, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, kind, label, model, baseUrl, apiKeyEnc, hasActive ? 0 : 1, now, now);
  }).immediate();
  return getProvider(db, id)!;
}

/** PATCH: omitted or empty api_key keeps the stored one; kind cannot change. */
export async function updateProvider(
  db: Database,
  box: SecretBox,
  id: string,
  rawBody: unknown,
): Promise<ProviderRow | null> {
  const row = getProvider(db, id);
  if (!row) return null;
  const body = asObject(rawBody);
  const label = optionalString(body, "label", MAX_LABEL);
  const model = optionalString(body, "model", MAX_MODEL);
  const apiKey = optionalString(body, "api_key", MAX_KEY);
  const rawUrl = optionalString(body, "base_url", MAX_URL);

  if (model !== undefined && !model) throw new ProviderValidationError("Informe o modelo (ex.: gpt-5-mini).");
  let baseUrl = row.base_url;
  if (rawUrl !== undefined) baseUrl = rawUrl ? validateBaseUrl(rawUrl) : null;
  if (row.kind === "openai_compatible" && !baseUrl) {
    throw new ProviderValidationError(
      'Para "Compatível com OpenAI", informe a URL base (ex.: http://localhost:11434/v1).',
    );
  }
  const apiKeyEnc = apiKey ? await box.encrypt(apiKey) : row.api_key_enc;

  db.query(
    `UPDATE llm_providers SET label = ?, model = ?, base_url = ?, api_key_enc = ?, updated_at = ? WHERE id = ?`,
  ).run(label || row.label, model || row.model, baseUrl, apiKeyEnc, nowIso(), id);
  return getProvider(db, id);
}

export function deleteProvider(db: Database, id: string): boolean {
  return db.query("DELETE FROM llm_providers WHERE id = ?").run(id).changes > 0;
}

/** Makes `id` the single active provider (atomic). */
export function activateProvider(db: Database, id: string): ProviderRow | null {
  let found = false;
  db.transaction(() => {
    if (!getProvider(db, id)) return;
    found = true;
    db.query("UPDATE llm_providers SET is_active = 0 WHERE is_active = 1").run();
    db.query("UPDATE llm_providers SET is_active = 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
  }).immediate();
  return found ? getProvider(db, id) : null;
}

export function deactivateProviders(db: Database): void {
  db.query("UPDATE llm_providers SET is_active = 0 WHERE is_active = 1").run();
}
