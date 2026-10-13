// Advanced lead filters. The API supports a free-text `filter` and `tags`, so
// tags alone stay server-side; any other filter runs client-side over the full
// lead list (≤ 5000), tags included (lead rows carry them).
import type { Lead, LeadSort, TagsMode } from "./api/types";
import { matchesTags } from "./tags";

export type Presence = "all" | "with" | "without";
export type WhatsAppFilter = "all" | "yes" | "no" | "pending";

export interface AdvancedFilters {
  categories: string[];
  whatsapp: WhatsAppFilter;
  minRating: number;
  maxRating: number;
  website: Presence;
  email: Presence;
  phone: Presence;
  /** Tag names; leads with any / all of them (tagsMode). */
  tags: string[];
  tagsMode: TagsMode;
}

export const DEFAULT_FILTERS: AdvancedFilters = {
  categories: [],
  whatsapp: "all",
  minRating: 0,
  maxRating: 5,
  website: "all",
  email: "all",
  phone: "all",
  tags: [],
  tagsMode: "any",
};

export function activeFilterCount(f: AdvancedFilters): number {
  return (
    f.categories.length +
    (f.whatsapp !== "all" ? 1 : 0) +
    (f.minRating > 0 ? 1 : 0) +
    (f.maxRating < 5 ? 1 : 0) +
    (f.website !== "all" ? 1 : 0) +
    (f.email !== "all" ? 1 : 0) +
    (f.phone !== "all" ? 1 : 0) +
    f.tags.length
  );
}

/** True when a filter the API can't apply is active (tags alone go to the server). */
export function needsLocalFiltering(f: AdvancedFilters): boolean {
  return activeFilterCount({ ...f, tags: [] }) > 0;
}

function presenceOk(value: unknown, presence: Presence): boolean {
  if (presence === "with") return Boolean(value);
  if (presence === "without") return !value;
  return true;
}

export function matchesText(lead: Lead, text: string): boolean {
  const term = text.trim().toLowerCase();
  if (!term) return true;
  return [lead.name, lead.category, lead.address, lead.phone, lead.email, lead.website]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(term);
}

export function matchesFilters(lead: Lead, f: AdvancedFilters): boolean {
  if (f.categories.length > 0 && !f.categories.includes(lead.category ?? "")) return false;
  if (f.whatsapp === "yes" && lead.is_whatsapp !== 1) return false;
  if (f.whatsapp === "no" && lead.is_whatsapp !== 0) return false;
  if (f.whatsapp === "pending" && lead.is_whatsapp !== null) return false;
  if (f.minRating > 0 && !(Number(lead.rating) >= f.minRating)) return false;
  if (f.maxRating < 5 && !(Number(lead.rating) <= f.maxRating)) return false;
  if (!matchesTags(lead, f.tags, f.tagsMode)) return false;
  return presenceOk(lead.website, f.website) && presenceOk(lead.email, f.email) && presenceOk(lead.phone, f.phone);
}

export function sortLeads(leads: Lead[], sort: LeadSort | null): Lead[] {
  if (!sort) return leads;
  const sign = sort.desc ? -1 : 1;
  const key = sort.column;
  return [...leads].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * sign;
    return String(va).localeCompare(String(vb), "pt-BR") * sign;
  });
}

/** Filter + sort + paginate the full list (used when advanced filters are active). */
export function filterLeadsLocally(
  leads: Lead[],
  options: { text: string; filters: AdvancedFilters; sort: LeadSort | null; page: number; pageSize: number; searchId?: number | null },
): { leads: Lead[]; total: number } {
  const filtered = sortLeads(
    leads.filter(
      (lead) =>
        (options.searchId == null || lead.search_id === options.searchId) &&
        matchesText(lead, options.text) &&
        matchesFilters(lead, options.filters),
    ),
    options.sort,
  );
  const start = (options.page - 1) * options.pageSize;
  return { leads: filtered.slice(start, start + options.pageSize), total: filtered.length };
}

export function categoriesOf(leads: Lead[]): string[] {
  return [...new Set(leads.map((l) => l.category).filter((c): c is string => Boolean(c)))].sort((a, b) =>
    a.localeCompare(b, "pt-BR"),
  );
}
