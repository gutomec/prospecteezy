import { describe, expect, test } from "bun:test";
import { ApiError } from "../lib/api/client";
import type { Lead } from "../lib/api/types";
import { DEFAULT_FILTERS, filterLeadsLocally } from "../lib/lead-filters";
import {
  formatRelativeTime,
  isExhaustedError,
  parseSearchCount,
  SEARCH_STATUS,
  searchLabel,
  searchLastUsed,
  sortSearches,
} from "../lib/searches";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("SEARCH_STATUS", () => {
  test("labels, tones and the exhausted tooltip", () => {
    expect(SEARCH_STATUS.running).toMatchObject({ label: "Em andamento", tone: "info", hint: null });
    expect(SEARCH_STATUS.exhausted).toEqual({
      label: "Esgotada",
      tone: "warning",
      hint: "O Google Maps não tem mais resultados para esta combinação",
    });
    expect(SEARCH_STATUS.idle).toMatchObject({ label: "Disponível", tone: "success" });
  });
});

describe("searchLabel / searchLastUsed / sortSearches", () => {
  test("label joins niche and city", () => {
    expect(searchLabel({ niche: "dentistas", city: "Campinas-SP" })).toBe("dentistas em Campinas-SP");
  });

  test("last used falls back to created_at", () => {
    expect(searchLastUsed({ last_used_at: null, created_at: "2026-01-01T00:00:00.000Z" })).toBe("2026-01-01T00:00:00.000Z");
    expect(searchLastUsed({ last_used_at: "2026-02-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" })).toBe("2026-02-01T00:00:00.000Z");
  });

  test("most recently used first, never-used ranked by creation, ties by newest id", () => {
    const list = [
      { id: 1, last_used_at: ago(5 * DAY), created_at: ago(9 * DAY) },
      { id: 2, last_used_at: null, created_at: ago(1 * DAY) },
      { id: 3, last_used_at: ago(1 * HOUR), created_at: ago(9 * DAY) },
      { id: 4, last_used_at: ago(1 * HOUR), created_at: ago(2 * DAY) },
    ];
    expect(sortSearches(list).map((s) => s.id)).toEqual([4, 3, 2, 1]);
    expect(list.map((s) => s.id)).toEqual([1, 2, 3, 4]); // not mutated
  });
});

describe("formatRelativeTime", () => {
  test("PT-BR relative phrases", () => {
    expect(formatRelativeTime(ago(10_000), NOW)).toBe("agora mesmo");
    expect(formatRelativeTime(ago(5 * MIN), NOW)).toBe("há 5 minutos");
    expect(formatRelativeTime(ago(1 * MIN), NOW)).toBe("há 1 minuto");
    expect(formatRelativeTime(ago(3 * HOUR), NOW)).toBe("há 3 horas");
    expect(formatRelativeTime(ago(1 * DAY), NOW)).toBe("ontem");
    expect(formatRelativeTime(ago(3 * DAY), NOW)).toBe("há 3 dias");
    expect(formatRelativeTime(ago(14 * DAY), NOW)).toBe("há 2 semanas");
    expect(formatRelativeTime(ago(60 * DAY), NOW)).toBe("há 2 meses");
    expect(formatRelativeTime(ago(400 * DAY), NOW)).toBe("ano passado");
  });

  test("invalid or missing → dash", () => {
    expect(formatRelativeTime(null, NOW)).toBe("—");
    expect(formatRelativeTime("ontem", NOW)).toBe("—");
  });
});

describe("parseSearchCount", () => {
  test("positive integers, no upper limit", () => {
    expect(parseSearchCount("20")).toBe(20);
    expect(parseSearchCount(" 500 ")).toBe(500);
    expect(parseSearchCount("1")).toBe(1);
    expect(parseSearchCount("20000")).toBe(20000);
    for (const bad of ["0", "", "2.5", "-3", "abc", "1e2"]) expect(parseSearchCount(bad)).toBeNull();
  });
});

describe("isExhaustedError", () => {
  test("only the 409 with code exhausted", () => {
    expect(isExhaustedError(new ApiError("esgotou", 409, { error: "esgotou", code: "exhausted" }))).toBe(true);
    expect(isExhaustedError(new ApiError("conflito", 409, { error: "conflito" }))).toBe(false);
    expect(isExhaustedError(new ApiError("x", 400, { code: "exhausted" }))).toBe(false);
    expect(isExhaustedError(new Error("x"))).toBe(false);
  });
});

describe("filterLeadsLocally with a search filter", () => {
  test("keeps only the leads of that search", () => {
    const leads = [1, 2, 3, 4].map((id) => ({ id, search_id: id % 2 === 0 ? 7 : 8, name: `L${id}`, category: null, address: null, phone: null, email: null, website: null, rating: null, is_whatsapp: null }) as unknown as Lead);
    const base = { text: "", filters: DEFAULT_FILTERS, sort: null, page: 1, pageSize: 50 };
    expect(filterLeadsLocally(leads, { ...base, searchId: 7 }).leads.map((l) => l.id)).toEqual([2, 4]);
    expect(filterLeadsLocally(leads, { ...base, searchId: null }).total).toBe(4);
  });
});
