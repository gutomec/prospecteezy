import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, request } from "../lib/api/client";
import { leadsQueryString } from "../lib/api/endpoints";
import type { Lead } from "../lib/api/types";
import { csvSafe, leadsToCsv } from "../lib/csv";
import { parseAiEnrichment, safeUrl, whatsappState } from "../lib/format";
import { activeFilterCount, DEFAULT_FILTERS, filterLeadsLocally, matchesFilters } from "../lib/lead-filters";
import { selectionLabel } from "../features/leads/leads-state";
import { validationOutcome } from "../features/leads/jobs/lead-jobs";
import { computeMetrics } from "../features/leads/metric-cards";
import { APP_PATHS } from "../routes";

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 1,
    search_id: 1,
    place_id: null,
    cid: null,
    position: 1,
    name: "Clínica Sorriso",
    category: "Dentista",
    address: "Rua A, 1",
    latitude: null,
    longitude: null,
    phone: "+55 11 99999-0000",
    website: "https://sorriso.com.br",
    rating: 4.5,
    rating_count: 10,
    email: null,
    socials_json: null,
    is_whatsapp: null,
    whatsapp_jid: null,
    source: "serper:places",
    collected_at: "2026-10-12T10:00:00.000Z",
    enriched_at: null,
    ...overrides,
  };
}

describe("api client", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("sends JSON Content-Type and a JSON body on every write", async () => {
    const seen: RequestInit[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await request("/x", { method: "POST" });
    await request("/x", { method: "DELETE", body: { ids: [1] } });
    await request("/x");
    expect((seen[0]!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(seen[0]!.body).toBe("{}");
    expect(seen[1]!.body).toBe('{"ids":[1]}');
    expect(seen[2]!.body).toBeUndefined();
  });

  test("turns {error} into an ApiError with the PT-BR message", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Lead não encontrado." }), { status: 404 })) as unknown as typeof fetch;
    const error = await request<never>("/api/leads/9").catch((e: unknown) => e as ApiError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe("Lead não encontrado.");
    expect(error.status).toBe(404);
  });

  test("network failure → status 0 with a PT-BR hint", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = await request<never>("/api/leads").catch((e: unknown) => e as ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toContain("servidor local");
  });

  test("leads query string uses column:desc", () => {
    expect(leadsQueryString({ filter: " ana ", sort: { column: "rating", desc: true }, page: 2, page_size: 50 })).toBe(
      "?filter=ana&sort=rating%3Adesc&page=2&page_size=50",
    );
  });
});

describe("csv export", () => {
  test("neutralizes formula injection", () => {
    for (const bad of ["=1+1", "+5511", "-2", "@SUM(A1)", "\tx", "\rx"]) expect(csvSafe(bad).startsWith("'")).toBe(true);
    expect(csvSafe("Clínica")).toBe("Clínica");
  });

  test("BOM, ; separator, CRLF, quoted cells", () => {
    const csv = leadsToCsv([lead({ name: 'A "B"', phone: "=cmd" })]);
    expect(csv.startsWith("﻿nome;categoria")).toBe(true);
    expect(csv).toContain("\r\n");
    expect(csv).toContain('"A ""B"""');
    expect(csv).toContain(`"'=cmd"`);
  });
});

describe("safe values", () => {
  test("safeUrl only allows http(s)", () => {
    expect(safeUrl("https://x.com")).toBe("https://x.com/");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,x")).toBeNull();
    expect(safeUrl("x.com")).toBeNull();
    expect(safeUrl(42)).toBeNull();
  });

  test("ai enrichment parsing tolerates garbage", () => {
    expect(parseAiEnrichment({ ai_enrichment_json: "{bad" })).toBeNull();
    expect(parseAiEnrichment({ ai_enrichment_json: "[1]" })).toBeNull();
    expect(parseAiEnrichment({ ai_enrichment_json: '{"summary":"ok"}' })?.summary).toBe("ok");
  });

  test("whatsapp state honours the session's ambiguous set", () => {
    expect(whatsappState(lead({ is_whatsapp: 1 }))).toBe("yes");
    expect(whatsappState(lead({ is_whatsapp: null }), new Set([1]))).toBe("ambiguous");
  });
});

describe("advanced filters", () => {
  const leads = [
    lead({ id: 1, is_whatsapp: 1, email: "a@a.com", rating: 5 }),
    lead({ id: 2, is_whatsapp: 0, website: null, rating: 3, category: "Advogado" }),
    lead({ id: 3, rating: null, phone: null }),
  ];

  test("counts active filters", () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, categories: ["a", "b"], email: "with" })).toBe(3);
  });

  test("whatsapp / presence / rating", () => {
    expect(leads.filter((l) => matchesFilters(l, { ...DEFAULT_FILTERS, whatsapp: "pending" })).map((l) => l.id)).toEqual([3]);
    expect(leads.filter((l) => matchesFilters(l, { ...DEFAULT_FILTERS, website: "without" })).map((l) => l.id)).toEqual([2]);
    expect(leads.filter((l) => matchesFilters(l, { ...DEFAULT_FILTERS, minRating: 4 })).map((l) => l.id)).toEqual([1]);
    expect(leads.filter((l) => matchesFilters(l, { ...DEFAULT_FILTERS, categories: ["Advogado"] })).map((l) => l.id)).toEqual([2]);
  });

  test("local filter paginates and sorts", () => {
    const page = filterLeadsLocally(leads, { text: "", filters: DEFAULT_FILTERS, sort: { column: "rating", desc: true }, page: 1, pageSize: 2 });
    expect(page.total).toBe(3);
    expect(page.leads.map((l) => l.id)).toEqual([1, 2]);
  });
});

describe("leads view helpers", () => {
  test("selection label", () => {
    expect(selectionLabel(1, 0)).toBe("1 selecionado");
    expect(selectionLabel(3, 2)).toBe("3 selecionados (2 fora desta página)");
  });

  test("validation outcome mirrors the backend reason tokens", () => {
    expect(validationOutcome({ lead_id: 1, phone: null, is_whatsapp: true })).toBe("yes");
    expect(validationOutcome({ lead_id: 1, phone: null, is_whatsapp: null })).toBe("queued");
    expect(validationOutcome({ lead_id: 1, phone: null, is_whatsapp: null, reason: "sem telefone" })).toBe("no_phone");
    expect(validationOutcome({ lead_id: 1, phone: null, is_whatsapp: null, reason: "lookup_failed" })).toBe("failed");
    expect(validationOutcome({ lead_id: 1, phone: null, is_whatsapp: null, reason: "duas contas distintas — decisão humana" })).toBe("ambiguous");
  });

  test("metrics count today and shares", () => {
    const now = new Date("2026-10-12T15:00:00");
    const m = computeMetrics(
      [lead({ is_whatsapp: 1, email: "x@x.com", collected_at: new Date("2026-10-12T09:00:00").toISOString() }), lead({ collected_at: "2026-09-01T00:00:00Z" })],
      now,
    );
    expect(m.total).toBe(2);
    expect(m.withWhatsapp).toBe(1);
    expect(m.today).toBe(1);
    expect(m.series).toHaveLength(14);
  });

  test("SPA paths never include a catch-all", () => {
    expect(APP_PATHS).toContain("/");
    expect(APP_PATHS.some((p) => p.includes("*") || p.startsWith("/api"))).toBe(false);
  });
});
