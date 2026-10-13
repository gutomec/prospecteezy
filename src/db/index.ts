import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Idempotent, versioned migrations tracked via PRAGMA user_version.
 * Each entry runs exactly once per database file; re-running openDb is a no-op.
 */
const MIGRATIONS: (string | ((db: Database) => void))[] = [
  `
  CREATE TABLE IF NOT EXISTS searches (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    query_normalized TEXT NOT NULL UNIQUE,
    niche            TEXT NOT NULL,
    city             TEXT NOT NULL,
    gl               TEXT NOT NULL DEFAULT 'br',
    hl               TEXT NOT NULL DEFAULT 'pt-br',
    created_at       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS search_cursor (
    search_id       INTEGER PRIMARY KEY REFERENCES searches(id),
    last_page       INTEGER NOT NULL DEFAULT 0,
    total_collected INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leads (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    search_id    INTEGER NOT NULL REFERENCES searches(id),
    place_id     TEXT UNIQUE,
    cid          TEXT,
    position     INTEGER,
    name         TEXT NOT NULL,
    category     TEXT,
    address      TEXT,
    latitude     REAL,
    longitude    REAL,
    phone        TEXT,
    website      TEXT,
    rating       REAL,
    rating_count INTEGER,
    email        TEXT,
    socials_json TEXT,
    is_whatsapp  INTEGER,
    whatsapp_jid TEXT,
    source       TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    enriched_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_leads_place_id    ON leads(place_id);
  CREATE INDEX IF NOT EXISTS idx_leads_cid         ON leads(cid);
  CREATE INDEX IF NOT EXISTS idx_leads_search_id   ON leads(search_id);
  CREATE INDEX IF NOT EXISTS idx_leads_is_whatsapp ON leads(is_whatsapp);

  CREATE TABLE IF NOT EXISTS lead_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id      INTEGER NOT NULL REFERENCES leads(id),
    event        TEXT NOT NULL,
    payload_json TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_lead_events_lead_id ON lead_events(lead_id);
  `,
  // v2: "mais N" resumes the search used last, not the one created last.
  (db) => addColumnIfMissing(db, "searches", "last_used_at", "TEXT"),
  // v3: optional AI layer — settings, encrypted secrets, LLM providers,
  // agent threads and per-lead AI enrichment. Additive only.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS llm_providers (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        label       TEXT NOT NULL,
        model       TEXT NOT NULL,
        base_url    TEXT,
        api_key_enc TEXT,
        is_active   INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_threads (
        id                   TEXT PRIMARY KEY,
        messages_json        TEXT NOT NULL,
        credits_used         INTEGER NOT NULL DEFAULT 0,
        last_user_message_id TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
    `);
    addColumnIfMissing(db, "leads", "ai_enrichment_json", "TEXT");
    addColumnIfMissing(db, "leads", "ai_enriched_at", "TEXT");
  },
  // v4: POST /api/chat (AI SDK UI message stream). The conversation is kept as
  // AI SDK UIMessage[] (server = source of truth), apart from the AG-UI
  // ai_threads (ModelMessage[]) so the two formats never mix. Additive only.
  `
  CREATE TABLE IF NOT EXISTS ai_chats (
    id            TEXT PRIMARY KEY,
    title         TEXT,
    messages_json TEXT NOT NULL,
    credits_used  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_chats_updated_at ON ai_chats(updated_at DESC);
  `,
  // v5: when the last collection of a search found the source exhausted
  // (Google Maps had no more results). Cleared by a later productive run.
  (db) => addColumnIfMissing(db, "searches", "exhausted_at", "TEXT"),
  // v6: tags. Free-text labels identified by slug (lowercase, no accents).
  // Leads ↔ tags is many-to-many; a search's tags are inherited by the leads
  // it collects. Additive only; rows vanish with their lead/search/tag.
  `
  CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lead_tags (
    lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (lead_id, tag_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_lead_tags_tag_id ON lead_tags(tag_id);
  CREATE TABLE IF NOT EXISTS search_tags (
    search_id  INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (search_id, tag_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_search_tags_tag_id ON search_tags(tag_id);
  `,
];

/** Additive and safe to re-run: skips the ALTER when the column exists. */
function addColumnIfMissing(db: Database, table: string, column: string, type: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function openDb(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  const current = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let i = current.user_version; i < MIGRATIONS.length; i++) {
    // IMMEDIATE takes the write lock first, so two processes opening the same
    // file cannot both apply a migration; the version is re-read under it.
    db.transaction(() => {
      const row = db.query("PRAGMA user_version").get() as { user_version: number };
      if (row.user_version > i) return;
      const migration = MIGRATIONS[i]!;
      if (typeof migration === "string") db.exec(migration);
      else migration(db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    }).immediate();
  }
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
