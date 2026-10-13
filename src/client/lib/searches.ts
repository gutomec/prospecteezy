// Pure helpers for the "Buscas" panel (search history): ordering, status
// labels, relative time and count parsing. Tested in tests/searches.test.ts.
import type { Tone } from "@/components/common/status-badge";
import { ApiError } from "./api/client";
import type { Search, SearchStatus } from "./api/types";

export const SEARCH_COUNT_MIN = 1;
export const SEARCH_COUNT_DEFAULT = 20;

export const SEARCH_STATUS: Record<SearchStatus, { label: string; tone: Tone; hint: string | null }> = {
  running: { label: "Em andamento", tone: "info", hint: null },
  exhausted: { label: "Esgotada", tone: "warning", hint: "O Google Maps não tem mais resultados para esta combinação" },
  idle: { label: "Disponível", tone: "success", hint: null },
};

/** "dentistas em Campinas-SP" */
export function searchLabel(search: Pick<Search, "niche" | "city">): string {
  return `${search.niche} em ${search.city}`;
}

/** Last time the search was used (falls back to its creation). */
export function searchLastUsed(search: Pick<Search, "last_used_at" | "created_at">): string {
  return search.last_used_at ?? search.created_at;
}

/** Most recently used first; ties by id (newest first). */
export function sortSearches<T extends Pick<Search, "id" | "last_used_at" | "created_at">>(searches: T[]): T[] {
  const time = (s: T) => Date.parse(searchLastUsed(s)) || 0;
  return [...searches].sort((a, b) => time(b) - time(a) || b.id - a.id);
}

const relativeFormatter = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["week", 7 * 86_400],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "agora mesmo", "há 5 minutos", "ontem", "há 3 semanas"; "—" when invalid. */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const seconds = Math.round((time - now) / 1000);
  if (Math.abs(seconds) < 45) return "agora mesmo";
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size || unit === "minute") {
      return relativeFormatter.format(Math.round(seconds / size) || Math.sign(seconds), unit);
    }
  }
  return "—";
}

/** Positive integer count (no upper limit) from an input value, else null. */
export function parseSearchCount(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= SEARCH_COUNT_MIN ? value : null;
}

/** True for the 409 `{ code: "exhausted" }` of POST /api/searches[/:id/more]. */
export function isExhaustedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    typeof error.body === "object" &&
    error.body !== null &&
    (error.body as { code?: unknown }).code === "exhausted"
  );
}
