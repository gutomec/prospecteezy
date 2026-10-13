import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Dedicated WhatsApp database (data/whatsapp.db), separate from the core
 * data/prospecteezy.db on purpose:
 * - the core owns the versioned migrations of prospecteezy.db (PRAGMA
 *   user_version); adding session tables there would collide with its
 *   migration counter;
 * - the session (auth_state) holds Signal keys — wiping the session must
 *   never risk lead data, and vice versa;
 * - mirrors the squad convention (template database: data/whatsapp.db).
 *
 * Lead results (is_whatsapp, whatsapp_jid, lead_events) stay in the core DB,
 * written through the columns the core already created.
 */
const MIGRATIONS: (string | ((db: Database) => void))[] = [
  `
  -- Baileys session state, squad auth-state pattern (SQLite instead of
  -- useMultiFileAuthState, which upstream marks as not-for-production).
  CREATE TABLE IF NOT EXISTS auth_state (
    category   TEXT NOT NULL,
    key_id     TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (category, key_id)
  );

  -- Every account-touching action (onWhatsApp lookup, contact push) is
  -- recorded here; the anti-ban gate counts rows in sliding windows.
  CREATE TABLE IF NOT EXISTS wa_actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    target     TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wa_actions_created_at ON wa_actions(created_at);

  -- Minimal port of the squad CRM graph (lib/crm.ts): validated leads become
  -- addressable contacts here — a JID is directly messageable, no need to
  -- write into the phone's address book.
  CREATE TABLE IF NOT EXISTS wa_entities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    contact_jid TEXT,
    lead_id     INTEGER,
    attributes  TEXT NOT NULL DEFAULT '{}',
    source      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_entities_lead_id
    ON wa_entities(lead_id) WHERE lead_id IS NOT NULL;

  -- Small key-value runtime state (connection_status, me_jid, paired_at...).
  CREATE TABLE IF NOT EXISTS runtime_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // -------------------------------------------------------------------------
  // Migration 2 (wa-backend phase): multi-instance HTTP backend + messaging
  // mirror. Each instance is one Baileys socket with its own auth (auth_state
  // categories prefixed `i:<id>:` — see auth-state.ts). The mirror tables
  // (chats, messages, contacts) are scoped by instance_id so two accounts
  // coexist in the same file. The active instance for sending is persisted in
  // runtime_state under `active_instance`.
  // -------------------------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS instances (
    id         TEXT PRIMARY KEY,
    name       TEXT,
    phone      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Conversations mirror. Populated from Baileys ingestion (history sync +
  -- live upserts) from the moment the instance connects — the WhatsApp
  -- multi-device protocol does not backfill the full old history.
  CREATE TABLE IF NOT EXISTS chats (
    instance_id       TEXT NOT NULL,
    jid               TEXT NOT NULL,
    name              TEXT,
    is_group          INTEGER NOT NULL DEFAULT 0,
    last_message_at   INTEGER,
    last_message_text TEXT,
    unread            INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (instance_id, jid)
  );
  CREATE INDEX IF NOT EXISTS idx_chats_activity
    ON chats(instance_id, last_message_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    instance_id  TEXT NOT NULL,
    chat_jid     TEXT NOT NULL,
    message_id   TEXT NOT NULL,
    from_me      INTEGER NOT NULL,
    sender_jid   TEXT,
    timestamp    INTEGER NOT NULL,
    message_type TEXT,
    text_content TEXT,
    status       TEXT,
    source       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (instance_id, chat_jid, message_id, from_me)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_thread
    ON messages(instance_id, chat_jid, timestamp);

  CREATE TABLE IF NOT EXISTS contacts (
    instance_id  TEXT NOT NULL,
    jid          TEXT NOT NULL,
    phone_number TEXT,
    display_name TEXT,
    notify_name  TEXT,
    raw_json     TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (instance_id, jid)
  );
  `,
  // -------------------------------------------------------------------------
  // Migration 3 (campaign-backend phase): personalized mass send. A campaign is
  // an async job over selected leads: it validates pending ones (gated), skips
  // non-WhatsApp, renders {{column}} placeholders per lead and sends through the
  // gate (spaced, no rate-limit relaxation — the throttle is the anti-ban
  // protection here). One optional media (image/video/document) per campaign,
  // sent as the caption carrier. Media bytes live on disk; wa_media holds the
  // metadata handle referenced by a campaign.
  // -------------------------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS wa_media (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,          -- image | video | document
    mime       TEXT,
    filename   TEXT,
    size       INTEGER NOT NULL,
    file_path  TEXT NOT NULL,          -- relative to project root
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id          TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    template    TEXT NOT NULL,
    media_id    TEXT,                  -- wa_media.id, null = text only
    status      TEXT NOT NULL,         -- queued | running | done | paused | failed
    total       INTEGER NOT NULL DEFAULT 0,
    sent        INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    skipped     INTEGER NOT NULL DEFAULT 0,
    reason      TEXT,                  -- pause/failure detail
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaign_recipients (
    campaign_id TEXT NOT NULL,
    lead_id     INTEGER NOT NULL,
    seq         INTEGER NOT NULL,      -- send order
    phone       TEXT,
    jid         TEXT,
    status      TEXT NOT NULL,         -- queued | sent | failed | skipped
    reason      TEXT,                  -- not_whatsapp | not_validated | empty_message | <error>
    message_id  TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (campaign_id, lead_id)
  );
  CREATE INDEX IF NOT EXISTS idx_campaign_recipients_seq
    ON campaign_recipients(campaign_id, seq);
  `,
  // -------------------------------------------------------------------------
  // Migration 4 (wa-quality-backend phase): the WhatsApp verified/business name
  // is distinct from the address-book name. Before this, upsertContact collapsed
  // contact.name ?? contact.verifiedName into display_name, so a business's
  // verified name looked like a saved address-book entry. Split them: the
  // "saved in the phone's address book" signal is display_name (contact.name)
  // IS NOT NULL, never the verified name. Additive column — legacy rows keep
  // NULL; new ingests populate it correctly.
  // -------------------------------------------------------------------------
  `
  ALTER TABLE contacts ADD COLUMN verified_name TEXT;
  `,
  // -------------------------------------------------------------------------
  // Migration 5 (validate-backend phase): standalone WhatsApp validation jobs.
  // A job runs validateLeadsCore (onWhatsApp lookups) over selected leads, in
  // gated batches, and tracks per-lead progress. The authoritative result
  // (is_whatsapp / whatsapp_jid) is written to the CORE db by validateLeadsCore;
  // these tables only hold job progress so GET /validate/:job can report it.
  // -------------------------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS validate_jobs (
    id          TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    status      TEXT NOT NULL,        -- queued | running | done | paused | failed
    total       INTEGER NOT NULL DEFAULT 0,
    reason      TEXT,                 -- pause/failure detail
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS validate_results (
    job_id     TEXT NOT NULL,
    lead_id    INTEGER NOT NULL,
    seq        INTEGER NOT NULL,      -- processing order
    phone      TEXT,
    status     TEXT NOT NULL,         -- queued | is_whatsapp | not_whatsapp | ambiguous | failed | skipped
    jid        TEXT,
    reason     TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, lead_id)
  );
  CREATE INDEX IF NOT EXISTS idx_validate_results_seq
    ON validate_results(job_id, seq);
  `,
  // -------------------------------------------------------------------------
  // Migration 6 (hardening phase): data repair + indexes, all idempotent.
  // - Group messages whose content started with senderKeyDistributionMessage
  //   were typed after that system key and hidden from threads/previews. The
  //   raw message is not stored, so the real type cannot be re-derived: rows
  //   that carry text get 'conversation' (they are text or captions); rows
  //   without text stay hidden (undecidable without the raw payload).
  // - wa_actions is now counted per kind (send vs lookup budgets).
  // - campaign_recipients is searched by jid (cross-campaign dedupe).
  // -------------------------------------------------------------------------
  `
  UPDATE messages SET message_type = 'conversation'
   WHERE message_type = 'senderKeyDistributionMessage' AND text_content IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_wa_actions_kind_created_at ON wa_actions(kind, created_at);
  CREATE INDEX IF NOT EXISTS idx_campaign_recipients_jid ON campaign_recipients(jid, status);
  `,
  // -------------------------------------------------------------------------
  // Migration 7 (wa-media phase): media download + reply context + reactions.
  // - message_media: one row per media message (same key as messages). raw_json
  //   is the minimal WAMessage {key, message:{<type>: node}, messageTimestamp}
  //   serialized with Baileys BufferJSON — what downloadMediaMessage and
  //   updateMediaMessage (reupload) need. NULL raw_json = keys never seen (not
  //   downloadable). jpegThumbnail is kept apart (base64) for instant previews.
  //   cache_path = downloaded (or sent) file, project-relative when possible.
  // - messages.quoted_*: reply context (quoted message id + short text/type).
  // - message_reactions: latest reaction per reactor on a target message.
  // Rows ingested before this migration have no media/quoted data (the raw
  // payload was never stored); the API reports them as unavailable.
  // Idempotent even if re-run (columns are added only when missing).
  // -------------------------------------------------------------------------
  (db) => {
    db.exec(`
  CREATE TABLE IF NOT EXISTS message_media (
    instance_id   TEXT NOT NULL,
    chat_jid      TEXT NOT NULL,
    message_id    TEXT NOT NULL,
    from_me       INTEGER NOT NULL,
    kind          TEXT NOT NULL,       -- image | video | audio | voice | document | sticker
    mimetype      TEXT,
    file_name     TEXT,
    file_size     INTEGER,
    duration_s    INTEGER,
    width         INTEGER,
    height        INTEGER,
    thumbnail_b64 TEXT,
    raw_json      TEXT,
    cache_path    TEXT,
    cache_sha256  TEXT,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (instance_id, chat_jid, message_id, from_me)
  );

  CREATE TABLE IF NOT EXISTS message_reactions (
    instance_id TEXT NOT NULL,
    chat_jid    TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    reactor     TEXT NOT NULL,         -- 'me' or the reacting participant jid
    from_me     INTEGER NOT NULL,
    emoji       TEXT NOT NULL,
    timestamp   INTEGER NOT NULL,
    PRIMARY KEY (instance_id, chat_jid, target_id, reactor)
  );
  `);
    for (const column of ["quoted_id", "quoted_text", "quoted_type"]) addColumnIfMissing(db, "messages", column, "TEXT");
  },
];

function addColumnIfMissing(db: Database, table: string, column: string, type: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** Project root resolved from this file (src/whatsapp/db.ts → two levels up). */
const PROJECT_ROOT = join(import.meta.dir, "..", "..");

export const WA_DB_PATH = join(PROJECT_ROOT, "data", "whatsapp.db");
export const CORE_DB_PATH = join(PROJECT_ROOT, "data", "prospecteezy.db");
/** On-disk store for campaign media (bytes). Metadata lives in wa_media. */
export const WA_MEDIA_DIR = join(PROJECT_ROOT, "data", "wa-media");
export { PROJECT_ROOT };

export function openWaDb(path: string = WA_DB_PATH): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  // Wait on a concurrent writer (CLI script, hot-reloaded server) instead of
  // failing with SQLITE_BUSY. Set first so the WAL switch itself also waits.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");

  // One step per write transaction, taken with BEGIN IMMEDIATE and the version
  // RE-READ inside it: two processes opening the file at once serialize here
  // and the second sees the bumped version (never runs an ALTER twice).
  while (userVersion(db) < MIGRATIONS.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = userVersion(db);
      if (current < MIGRATIONS.length) {
        const migration = MIGRATIONS[current]!;
        if (typeof migration === "string") db.exec(migration);
        else migration(db);
        db.exec(`PRAGMA user_version = ${current + 1}`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function setState(db: Database, key: string, value: string): void {
  db.query(
    `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowIso());
}

export function getState(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM runtime_state WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}
