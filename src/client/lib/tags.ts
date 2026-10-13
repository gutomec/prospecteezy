// Pure tag helpers (mirror of src/db/tags.ts identity rules) + the badge
// palette. Tested in tests/tags.test.ts.
import type { Lead, TagsMode } from "./api/types";

export const TAG_MAX_LENGTH = 40;
export const MAX_TAGS_PER_REQUEST = 20;

/** Trimmed, inner whitespace collapsed; null when empty or longer than 40 chars. */
export function normalizeTagName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= TAG_MAX_LENGTH ? name : null;
}

/** Tag identity: lowercase, no diacritics ("Ação Social" → "acao social"). */
export function tagSlug(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function sameTag(a: string, b: string): boolean {
  return tagSlug(a) === tagSlug(b);
}

/** Appends a tag unless the list already has it (same slug). Invalid names are ignored. */
export function addTag(list: readonly string[], raw: string): string[] {
  const name = normalizeTagName(raw);
  if (!name || list.some((t) => sameTag(t, name))) return [...list];
  return [...list, name];
}

export function removeTag(list: readonly string[], name: string): string[] {
  return list.filter((t) => !sameTag(t, name));
}

/** Distinct tags carried by the given leads (first spelling wins), sorted by slug. */
export function tagsOfLeads(leads: readonly Pick<Lead, "tags">[]): string[] {
  const bySlug = new Map<string, string>();
  for (const lead of leads) for (const tag of lead.tags ?? []) if (!bySlug.has(tagSlug(tag))) bySlug.set(tagSlug(tag), tag);
  return [...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b, "pt-BR")).map(([, name]) => name);
}

/** Lead carries any / all of `wanted` (empty `wanted` = no restriction). */
export function matchesTags(lead: Pick<Lead, "tags">, wanted: readonly string[], mode: TagsMode): boolean {
  if (wanted.length === 0) return true;
  const own = new Set((lead.tags ?? []).map(tagSlug));
  return mode === "all" ? wanted.every((t) => own.has(tagSlug(t))) : wanted.some((t) => own.has(tagSlug(t)));
}

/**
 * Subtle badge colors, picked by slug so a tag always looks the same. Text is
 * the 800 shade on a 50 tint (light) and the 200 shade on a 950 tint (dark):
 * both ≥ 7:1 contrast, above WCAG AA.
 */
export const TAG_PALETTE = [
  "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800/70 dark:text-slate-200 dark:border-slate-700",
  "bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950/60 dark:text-sky-200 dark:border-sky-900",
  "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-200 dark:border-emerald-900",
  "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/60 dark:text-amber-200 dark:border-amber-900",
  "bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-200 dark:border-rose-900",
  "bg-violet-50 text-violet-800 border-violet-200 dark:bg-violet-950/60 dark:text-violet-200 dark:border-violet-900",
  "bg-teal-50 text-teal-800 border-teal-200 dark:bg-teal-950/60 dark:text-teal-200 dark:border-teal-900",
] as const;

/** Stable palette index for a tag (djb2 over the slug). */
export function tagColorIndex(name: string): number {
  let hash = 5381;
  for (const char of tagSlug(name)) hash = ((hash * 33) ^ char.codePointAt(0)!) >>> 0;
  return hash % TAG_PALETTE.length;
}

export function tagColorClass(name: string): string {
  return TAG_PALETTE[tagColorIndex(name)]!;
}

export interface TagOption {
  name: string;
  /** Leads carrying the tag (shown in the list when known). */
  count?: number;
}

/**
 * Autocomplete for TagInput: options not already chosen whose slug contains
 * the typed text's slug (prefix matches first), capped at `limit`; plus the
 * "create" candidate when the text is a valid new tag.
 */
export function tagSuggestions(
  options: readonly TagOption[],
  chosen: readonly string[],
  query: string,
  { allowCreate = true, limit = 8 }: { allowCreate?: boolean; limit?: number } = {},
): { options: TagOption[]; create: string | null } {
  const q = tagSlug(query);
  const taken = new Set(chosen.map(tagSlug));
  const seen = new Set<string>();
  const matches: TagOption[] = [];
  for (const option of options) {
    const slug = tagSlug(option.name);
    if (taken.has(slug) || seen.has(slug) || !slug.includes(q)) continue;
    seen.add(slug);
    matches.push(option);
  }
  if (q) matches.sort((a, b) => Number(!tagSlug(a.name).startsWith(q)) - Number(!tagSlug(b.name).startsWith(q)));
  const name = normalizeTagName(query);
  const create = allowCreate && name && !taken.has(tagSlug(name)) && !seen.has(tagSlug(name)) ? name : null;
  return { options: matches.slice(0, limit), create };
}
