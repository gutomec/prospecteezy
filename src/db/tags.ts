// Tags: free-text labels on leads (many-to-many) and on searches (inherited by
// the leads a search collects). Identity is the slug (case- and
// accent-insensitive); the display name is the first one seen.
import type { Database } from "bun:sqlite";
import { nowIso } from "./index.ts";
import { addLeadEvent } from "./repository.ts";

export const TAG_MAX_LENGTH = 40;
/** Max distinct tags in one request (add, remove or a search's set). */
export const MAX_TAGS_PER_REQUEST = 20;

export interface TagRow {
  id: number;
  slug: string;
  name: string;
  created_at: string;
}

export type TagWithCount = Pick<TagRow, "id" | "name" | "slug"> & { lead_count: number };

/** Trimmed, inner whitespace collapsed; null when empty or longer than 40 chars. */
export function normalizeTagName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= TAG_MAX_LENGTH ? name : null;
}

/** Identity of a tag: lowercase, diacritics stripped, spaces collapsed ("Ação Social" → "acao social"). */
export function tagSlug(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Validates a request's tag list: an array of strings, each 1–40 chars after
 * normalization, at most MAX_TAGS_PER_REQUEST distinct ones. Duplicates (same
 * slug) collapse to the first spelling. Returns the PT-BR error otherwise.
 */
export function parseTagList(value: unknown, field = "tags"): { tags: string[] } | { error: string } {
  const invalid = `Campo "${field}" inválido: envie uma lista de textos de 1 a ${TAG_MAX_LENGTH} caracteres (no máximo ${MAX_TAGS_PER_REQUEST} tags).`;
  if (!Array.isArray(value)) return { error: invalid };
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return { error: invalid };
    const name = normalizeTagName(item);
    if (!name) return { error: invalid };
    const slug = tagSlug(name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    tags.push(name);
  }
  if (tags.length > MAX_TAGS_PER_REQUEST) return { error: invalid };
  return { tags };
}

/** Finds or creates each tag (by slug); keeps the first-seen display name. */
export function ensureTags(db: Database, names: string[]): TagRow[] {
  const insert = db.query("INSERT OR IGNORE INTO tags (slug, name, created_at) VALUES (?, ?, ?)");
  const select = db.query("SELECT * FROM tags WHERE slug = ?");
  const rows: TagRow[] = [];
  const at = nowIso();
  for (const raw of names) {
    const name = normalizeTagName(raw);
    if (!name) continue;
    const slug = tagSlug(name);
    insert.run(slug, name, at);
    const row = select.get(slug) as TagRow;
    if (!rows.some((r) => r.id === row.id)) rows.push(row);
  }
  return rows;
}

/** Existing tags matching the given names or slugs (unknown ones are skipped). */
export function findTags(db: Database, namesOrSlugs: string[]): TagRow[] {
  const slugs = [...new Set(namesOrSlugs.map(tagSlug).filter(Boolean))];
  if (slugs.length === 0) return [];
  return db
    .query("SELECT * FROM tags WHERE slug IN (SELECT value FROM json_each(?)) ORDER BY slug")
    .all(JSON.stringify(slugs)) as TagRow[];
}

/** GET /api/tags: every tag with how many leads carry it, by name. */
export function listTags(db: Database): TagWithCount[] {
  return db
    .query(
      `SELECT t.id, t.name, t.slug, COUNT(lt.lead_id) AS lead_count
       FROM tags t LEFT JOIN lead_tags lt ON lt.tag_id = t.id
       GROUP BY t.id ORDER BY t.slug, t.id`,
    )
    .all() as TagWithCount[];
}

type LeadTagChanges = Map<number, string[]>;

function recordChange(changes: LeadTagChanges, leadId: number, name: string): void {
  const list = changes.get(leadId);
  if (list) list.push(name);
  else changes.set(leadId, [name]);
}

function writeEvents(db: Database, changes: LeadTagChanges, event: "tags_added" | "tags_removed", extra: Record<string, unknown>): void {
  for (const [leadId, names] of changes) addLeadEvent(db, leadId, event, { tags: names, ...extra });
}

/**
 * Adds tags to existing leads (unknown ids ignored). Creates missing tags.
 * One `tags_added` event per lead that actually gained a tag. Not transactional
 * by itself: callers wrap it (see updateLeadTags / setSearchTags).
 */
function addTagsToLeadsRaw(db: Database, leadIds: number[], tags: TagRow[], extra: Record<string, unknown>): LeadTagChanges {
  const changes: LeadTagChanges = new Map();
  if (leadIds.length === 0 || tags.length === 0) return changes;
  const ids = JSON.stringify(leadIds);
  const insert = db.query(
    `INSERT OR IGNORE INTO lead_tags (lead_id, tag_id, created_at)
     SELECT l.id, ?, ? FROM leads l WHERE l.id IN (SELECT value FROM json_each(?))
     RETURNING lead_id`,
  );
  const at = nowIso();
  for (const tag of tags) {
    for (const row of insert.all(tag.id, at, ids) as { lead_id: number }[]) recordChange(changes, row.lead_id, tag.name);
  }
  writeEvents(db, changes, "tags_added", extra);
  return changes;
}

function removeTagsFromLeadsRaw(db: Database, leadIds: number[], tags: TagRow[]): LeadTagChanges {
  const changes: LeadTagChanges = new Map();
  if (leadIds.length === 0 || tags.length === 0) return changes;
  const ids = JSON.stringify(leadIds);
  const remove = db.query(
    "DELETE FROM lead_tags WHERE tag_id = ? AND lead_id IN (SELECT value FROM json_each(?)) RETURNING lead_id",
  );
  for (const tag of tags) {
    for (const row of remove.all(tag.id, ids) as { lead_id: number }[]) recordChange(changes, row.lead_id, tag.name);
  }
  writeEvents(db, changes, "tags_removed", {});
  return changes;
}

/**
 * POST /api/leads/tags: bulk add and/or remove, in one transaction. Removal
 * matches existing tags by name or slug (unknown ones are ignored). Returns how
 * many distinct leads changed.
 */
export function updateLeadTags(db: Database, leadIds: number[], add: string[], remove: string[]): { updated: number } {
  return db.transaction(() => {
    const touched = new Set<number>();
    const added = addTagsToLeadsRaw(db, leadIds, ensureTags(db, add), {});
    for (const id of added.keys()) touched.add(id);
    const removed = removeTagsFromLeadsRaw(db, leadIds, findTags(db, remove));
    for (const id of removed.keys()) touched.add(id);
    return { updated: touched.size };
  })();
}

/** Tags of a search, by name. */
export function getSearchTags(db: Database, searchId: number): string[] {
  return (
    db
      .query(
        "SELECT t.name FROM search_tags st JOIN tags t ON t.id = st.tag_id WHERE st.search_id = ? ORDER BY t.slug",
      )
      .all(searchId) as { name: string }[]
  ).map((r) => r.name);
}

/** search id → tag names, in one query. */
export function getTagsBySearch(db: Database): Map<number, string[]> {
  const rows = db
    .query("SELECT st.search_id, t.name FROM search_tags st JOIN tags t ON t.id = st.tag_id ORDER BY t.slug")
    .all() as { search_id: number; name: string }[];
  const map = new Map<number, string[]>();
  for (const row of rows) {
    const list = map.get(row.search_id);
    if (list) list.push(row.name);
    else map.set(row.search_id, [row.name]);
  }
  return map;
}

/**
 * Links tags to a search and applies the newly linked ones to the leads the
 * search already collected (`tags_added` events with via "search").
 * `replace` = the given list becomes the search's whole set; tags dropped from
 * the search stay on its leads (they may have been tagged otherwise).
 */
function linkSearchTags(db: Database, searchId: number, names: string[], replace: boolean): void {
  const tags = ensureTags(db, names);
  if (replace) {
    db.query(
      "DELETE FROM search_tags WHERE search_id = ? AND tag_id NOT IN (SELECT value FROM json_each(?))",
    ).run(searchId, JSON.stringify(tags.map((t) => t.id)));
  }
  const link = db.query("INSERT OR IGNORE INTO search_tags (search_id, tag_id, created_at) VALUES (?, ?, ?)");
  const at = nowIso();
  const fresh = tags.filter((tag) => link.run(searchId, tag.id, at).changes > 0);
  if (fresh.length === 0) return;
  const leadIds = (
    db.query("SELECT id FROM leads WHERE search_id = ?").all(searchId) as { id: number }[]
  ).map((r) => r.id);
  addTagsToLeadsRaw(db, leadIds, fresh, { via: "search", search_id: searchId });
}

/** PUT /api/searches/:id/tags: replaces the search's tags (see linkSearchTags). */
export function setSearchTags(db: Database, searchId: number, names: string[]): string[] {
  db.transaction(() => linkSearchTags(db, searchId, names, true))();
  return getSearchTags(db, searchId);
}

/** Adds tags to a search (union), e.g. from POST /api/searches or "Buscar mais". */
export function addSearchTags(db: Database, searchId: number, names: string[]): void {
  if (names.length === 0) return;
  db.transaction(() => linkSearchTags(db, searchId, names, false))();
}

/** Gives a freshly inserted lead its search's tags (called by insertLeadIfNew). */
export function applySearchTagsToNewLead(db: Database, leadId: number, searchId: number): void {
  const rows = db
    .query(
      `INSERT OR IGNORE INTO lead_tags (lead_id, tag_id, created_at)
       SELECT ?, st.tag_id, ? FROM search_tags st WHERE st.search_id = ?
       RETURNING tag_id`,
    )
    .all(leadId, nowIso(), searchId) as { tag_id: number }[];
  if (rows.length === 0) return;
  const names = (
    db
      .query("SELECT name FROM tags WHERE id IN (SELECT value FROM json_each(?)) ORDER BY slug")
      .all(JSON.stringify(rows.map((r) => r.tag_id))) as { name: string }[]
  ).map((r) => r.name);
  addLeadEvent(db, leadId, "tags_added", { tags: names, via: "search", search_id: searchId });
}

/** lead id → tag names (by slug order), one grouped query for a page of leads. */
export function getTagsForLeads(db: Database, leadIds: number[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (leadIds.length === 0) return map;
  const rows = db
    .query(
      `SELECT lt.lead_id, t.name FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
       WHERE lt.lead_id IN (SELECT value FROM json_each(?)) ORDER BY lt.lead_id, t.slug`,
    )
    .all(JSON.stringify(leadIds)) as { lead_id: number; name: string }[];
  for (const row of rows) {
    const list = map.get(row.lead_id);
    if (list) list.push(row.name);
    else map.set(row.lead_id, [row.name]);
  }
  return map;
}

/** Adds `tags: string[]` to each lead row (one query). */
export function withTags<T extends { id: number }>(db: Database, leads: T[]): (T & { tags: string[] })[] {
  const map = getTagsForLeads(db, leads.map((l) => l.id));
  return leads.map((lead) => ({ ...lead, tags: map.get(lead.id) ?? [] }));
}

export type TagsMode = "any" | "all";

/**
 * SQL clause (on `leads.id`, alias-free) + args restricting leads to those
 * carrying any / all of the given tags (names or slugs). Unknown tags match
 * nothing ("all" with an unknown tag → no lead).
 */
export function tagFilterClause(namesOrSlugs: string[], mode: TagsMode): { sql: string; args: (string | number)[] } | null {
  const slugs = [...new Set(namesOrSlugs.map(tagSlug).filter(Boolean))];
  if (slugs.length === 0) return null;
  const json = JSON.stringify(slugs);
  if (mode === "all") {
    return {
      sql: `id IN (SELECT lt.lead_id FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
                   WHERE t.slug IN (SELECT value FROM json_each(?))
                   GROUP BY lt.lead_id HAVING COUNT(DISTINCT lt.tag_id) = ?)`,
      args: [json, slugs.length],
    };
  }
  return {
    sql: `id IN (SELECT lt.lead_id FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
                 WHERE t.slug IN (SELECT value FROM json_each(?)))`,
    args: [json],
  };
}
