import type { Database } from "bun:sqlite";
import { nowIso } from "./index.ts";
import { applySearchTagsToNewLead, tagFilterClause, withTags, type TagsMode } from "./tags.ts";

export interface SearchRow {
  id: number;
  query_normalized: string;
  niche: string;
  city: string;
  gl: string;
  hl: string;
  created_at: string;
  last_used_at: string | null;
  /** Set when the last collection ran the source dry; null otherwise. */
  exhausted_at: string | null;
}

export interface CursorRow {
  search_id: number;
  last_page: number;
  total_collected: number;
  updated_at: string;
}

export interface LeadInput {
  search_id: number;
  place_id: string | null;
  cid: string | null;
  position: number | null;
  name: string;
  category: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  rating_count: number | null;
  source: string;
}

export interface LeadRow extends LeadInput {
  id: number;
  email: string | null;
  socials_json: string | null;
  is_whatsapp: number | null;
  whatsapp_jid: string | null;
  collected_at: string;
  enriched_at: string | null;
}

/** Accent-stripped, lowercased, space-collapsed identity for cursor lookup. */
export function normalizeQuery(niche: string, city: string): string {
  return `${niche} ${city}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function findOrCreateSearch(
  db: Database,
  niche: string,
  city: string,
  gl = "br",
  hl = "pt-br",
): SearchRow {
  const queryNormalized = normalizeQuery(niche, city);
  const existing = db
    .query("SELECT * FROM searches WHERE query_normalized = ?")
    .get(queryNormalized) as SearchRow | null;
  if (existing) return existing;

  db.query(
    `INSERT INTO searches (query_normalized, niche, city, gl, hl, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(queryNormalized, niche, city, gl, hl, nowIso());
  return db
    .query("SELECT * FROM searches WHERE query_normalized = ?")
    .get(queryNormalized) as SearchRow;
}

export function getCursor(db: Database, searchId: number): CursorRow {
  const row = db
    .query("SELECT * FROM search_cursor WHERE search_id = ?")
    .get(searchId) as CursorRow | null;
  return (
    row ?? { search_id: searchId, last_page: 0, total_collected: 0, updated_at: "" }
  );
}

export function saveCursor(
  db: Database,
  searchId: number,
  lastPage: number,
  totalCollected: number,
): void {
  db.query(
    `INSERT INTO search_cursor (search_id, last_page, total_collected, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(search_id) DO UPDATE SET
       last_page = excluded.last_page,
       total_collected = excluded.total_collected,
       updated_at = excluded.updated_at`,
  ).run(searchId, lastPage, totalCollected, nowIso());
}

/**
 * Inserts a lead only when it is new. Dedup key: place_id OR cid (the same
 * place may first arrive with only one of them). When a cid match lacks the
 * place_id, it is backfilled. Returns true when inserted.
 */
export function insertLeadIfNew(db: Database, lead: LeadInput): boolean {
  if (!lead.place_id && !lead.cid) {
    return false; // no stable identity — refuse rather than risk duplicates
  }
  if (lead.place_id) {
    const dup = db
      .query("SELECT id FROM leads WHERE place_id = ?")
      .get(lead.place_id);
    if (dup) return false;
  }
  if (lead.cid) {
    const dup = db
      .query("SELECT id, place_id FROM leads WHERE cid = ?")
      .get(lead.cid) as { id: number; place_id: string | null } | null;
    if (dup) {
      // Safe w.r.t. UNIQUE(place_id): no row holds lead.place_id (checked above).
      if (lead.place_id && !dup.place_id) {
        db.query("UPDATE leads SET place_id = ? WHERE id = ?").run(lead.place_id, dup.id);
      }
      return false;
    }
  }

  const result = db
    .query(
      `INSERT INTO leads (
        search_id, place_id, cid, position, name, category, address,
        latitude, longitude, phone, website, rating, rating_count,
        source, collected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      lead.search_id,
      lead.place_id,
      lead.cid,
      lead.position,
      lead.name,
      lead.category,
      lead.address,
      lead.latitude,
      lead.longitude,
      lead.phone,
      lead.website,
      lead.rating,
      lead.rating_count,
      lead.source,
      nowIso(),
    );
  const leadId = Number(result.lastInsertRowid);
  addLeadEvent(db, leadId, "collected", { source: lead.source });
  applySearchTagsToNewLead(db, leadId, lead.search_id);
  return true;
}

export function addLeadEvent(
  db: Database,
  leadId: number,
  event: string,
  payload?: unknown,
): void {
  db.query(
    "INSERT INTO lead_events (lead_id, event, payload_json, created_at) VALUES (?, ?, ?, ?)",
  ).run(leadId, event, payload === undefined ? null : JSON.stringify(payload), nowIso());
}

export function markEnriched(
  db: Database,
  leadId: number,
  email: string | null,
  socials: Record<string, string>,
): void {
  db.query(
    `UPDATE leads SET
       email = COALESCE(?, email),
       socials_json = COALESCE(?, socials_json),
       enriched_at = ?
     WHERE id = ?`,
  ).run(email, Object.keys(socials).length ? JSON.stringify(socials) : null, nowIso(), leadId);
  addLeadEvent(db, leadId, "enriched", { email, socials });
}

const LEAD_SORT_COLUMNS = new Set([
  "id",
  "name",
  "category",
  "rating",
  "rating_count",
  "position",
  "collected_at",
  "is_whatsapp",
]);

export interface LeadListParams {
  search_id?: number;
  filter?: string;
  /** Tag names or slugs; leads with any (default) / all of them. */
  tags?: string[];
  tags_mode?: TagsMode;
  sort?: string; // column or column:desc
  page?: number;
  page_size?: number;
}

export function listLeads(db: Database, params: LeadListParams) {
  const clauses: string[] = [];
  const args: (string | number)[] = [];

  if (params.search_id !== undefined) {
    clauses.push("search_id = ?");
    args.push(params.search_id);
  }
  if (params.filter) {
    clauses.push(
      "(name LIKE ? OR category LIKE ? OR address LIKE ? OR phone LIKE ? OR email LIKE ? OR website LIKE ?)",
    );
    const like = `%${params.filter}%`;
    args.push(like, like, like, like, like, like);
  }
  const tagClause = params.tags?.length ? tagFilterClause(params.tags, params.tags_mode ?? "any") : null;
  if (tagClause) {
    clauses.push(tagClause.sql);
    args.push(...tagClause.args);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  let orderBy = "ORDER BY id ASC";
  if (params.sort) {
    const [col, dir] = params.sort.split(":");
    if (col && LEAD_SORT_COLUMNS.has(col)) {
      orderBy = `ORDER BY ${col} ${dir === "desc" ? "DESC" : "ASC"}`;
    }
  }

  const pageSize = Math.min(Math.max(params.page_size ?? 50, 1), 500);
  const page = Math.max(params.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const total = (
    db.query(`SELECT COUNT(*) AS n FROM leads ${where}`).get(...args) as { n: number }
  ).n;
  const leads = db
    .query(`SELECT * FROM leads ${where} ${orderBy} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, offset) as LeadRow[];

  return { leads: withTags(db, leads), total, page, page_size: pageSize };
}

export function getLead(db: Database, id: number): LeadRow | null {
  return db.query("SELECT * FROM leads WHERE id = ?").get(id) as LeadRow | null;
}

/** getLead plus `tags: string[]` (GET /api/leads/:id). */
export function getLeadWithTags(db: Database, id: number): (LeadRow & { tags: string[] }) | null {
  const lead = getLead(db, id);
  return lead ? withTags(db, [lead])[0]! : null;
}

/**
 * Permanently deletes the given leads, their lead_events and lead_tags in a
 * single transaction (children first to respect the FK lead_events.lead_id →
 * leads.id; lead_tags also cascades).
 * Ids are bound as parameterized placeholders — never interpolated into SQL.
 * Empty ids is a no-op returning 0. Non-existent ids are ignored; the return
 * value counts only the leads that actually existed and were removed.
 */
export function deleteLeads(db: Database, ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  const run = db.transaction((leadIds: number[]) => {
    db.query(`DELETE FROM lead_events WHERE lead_id IN (${placeholders})`).run(...leadIds);
    db.query(`DELETE FROM lead_tags WHERE lead_id IN (${placeholders})`).run(...leadIds);
    const result = db.query(`DELETE FROM leads WHERE id IN (${placeholders})`).run(...leadIds);
    return result.changes;
  });
  return run(ids);
}

export function listSearches(db: Database) {
  return db
    .query(
      `SELECT s.*,
              COALESCE(c.last_page, 0)       AS last_page,
              COALESCE(c.total_collected, 0) AS total_collected,
              (SELECT COUNT(*) FROM leads l WHERE l.search_id = s.id) AS lead_count
       FROM searches s
       LEFT JOIN search_cursor c ON c.search_id = s.id
       ORDER BY s.created_at DESC`,
    )
    .all() as SearchListRow[];
}

export function getSearch(db: Database, id: number): SearchRow | null {
  return db.query("SELECT * FROM searches WHERE id = ?").get(id) as SearchRow | null;
}

/** Records (ISO timestamp) or clears (null) the search's source exhaustion. */
export function setSearchExhausted(db: Database, searchId: number, at: string | null): void {
  db.query("UPDATE searches SET exhausted_at = ? WHERE id = ?").run(at, searchId);
}

export type SearchListRow = SearchRow & { last_page: number; total_collected: number; lead_count: number };

/** The search used last by a job (falls back to the newest one created). */
export function getMostRecentSearch(db: Database): SearchRow | null {
  return db
    .query(
      "SELECT * FROM searches ORDER BY last_used_at IS NULL, last_used_at DESC, id DESC LIMIT 1",
    )
    .get() as SearchRow | null;
}

/** Marks the search as used now (strictly after any previous use, even within 1 ms). */
export function touchSearch(db: Database, searchId: number): void {
  const latest = (db.query("SELECT MAX(last_used_at) AS at FROM searches").get() as {
    at: string | null;
  }).at;
  let at = Date.now();
  if (latest && Date.parse(latest) >= at) at = Date.parse(latest) + 1;
  db.query("UPDATE searches SET last_used_at = ? WHERE id = ?").run(
    new Date(at).toISOString(),
    searchId,
  );
}

export function listLeadsToEnrich(db: Database, searchId: number): LeadRow[] {
  return db
    .query(
      "SELECT * FROM leads WHERE search_id = ? AND website IS NOT NULL AND enriched_at IS NULL",
    )
    .all(searchId) as LeadRow[];
}

/** Leads with a website among the given ids, regardless of enrichment state. */
export function listLeadsWithWebsiteByIds(db: Database, ids: number[]): LeadRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .query(`SELECT * FROM leads WHERE id IN (${placeholders}) AND website IS NOT NULL`)
    .all(...ids) as LeadRow[];
}
