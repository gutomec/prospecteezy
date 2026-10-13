import { describe, expect, test } from "bun:test";
import { leadsQueryString } from "../lib/api/endpoints";
import type { Lead } from "../lib/api/types";
import { leadsToCsv } from "../lib/csv";
import { activeFilterCount, DEFAULT_FILTERS, filterLeadsLocally, matchesFilters, needsLocalFiltering } from "../lib/lead-filters";
import {
  addTag,
  matchesTags,
  normalizeTagName,
  removeTag,
  TAG_PALETTE,
  tagColorClass,
  tagColorIndex,
  tagSlug,
  tagsOfLeads,
  tagSuggestions,
} from "../lib/tags";
import { filterChips } from "../features/leads/filters-popover";
import { tagCountsOf } from "../features/leads/lead-tags-popover";

function lead(id: number, tags: string[] = [], overrides: Partial<Lead> = {}): Lead {
  return {
    id,
    search_id: 1,
    place_id: null,
    cid: null,
    position: 1,
    name: `Lead ${id}`,
    category: "Academia",
    address: null,
    latitude: null,
    longitude: null,
    phone: null,
    website: null,
    rating: 4,
    rating_count: 1,
    email: null,
    socials_json: null,
    is_whatsapp: null,
    whatsapp_jid: null,
    source: "serper:places",
    collected_at: "2026-10-12T00:00:00.000Z",
    enriched_at: null,
    tags,
    ...overrides,
  };
}

describe("tag identity (mirrors the server)", () => {
  test("slug and normalization", () => {
    expect(tagSlug("  Ação   Social ")).toBe("acao social");
    expect(tagSlug("ACADEMIA")).toBe(tagSlug("Acadêmia"));
    expect(normalizeTagName("  a  b ")).toBe("a b");
    expect(normalizeTagName("")).toBeNull();
    expect(normalizeTagName("x".repeat(41))).toBeNull();
  });

  test("addTag / removeTag dedupe by slug", () => {
    expect(addTag(["Academia"], "academia")).toEqual(["Academia"]);
    expect(addTag(["Academia"], "  Quente ")).toEqual(["Academia", "Quente"]);
    expect(addTag(["Academia"], "   ")).toEqual(["Academia"]);
    expect(removeTag(["Academia", "Quente"], "ACADÊMIA")).toEqual(["Quente"]);
  });

  test("matchesTags any/all; missing tags field counts as none", () => {
    const l = lead(1, ["Academia", "Quente"]);
    expect(matchesTags(l, [], "all")).toBe(true);
    expect(matchesTags(l, ["quente", "frio"], "any")).toBe(true);
    expect(matchesTags(l, ["quente", "frio"], "all")).toBe(false);
    expect(matchesTags(l, ["acadêmia", "QUENTE"], "all")).toBe(true);
    expect(matchesTags({}, ["x"], "any")).toBe(false);
  });

  test("tagsOfLeads / tagCountsOf: distinct, sorted, counted", () => {
    const leads = [lead(1, ["Quente", "Academia"]), lead(2, ["academia"]), lead(3)];
    expect(tagsOfLeads(leads)).toEqual(["Academia", "Quente"]);
    expect(tagCountsOf(leads)).toEqual([
      { name: "Academia", count: 2 },
      { name: "Quente", count: 1 },
    ]);
  });
});

describe("palette", () => {
  test("stable per slug, in range, light + dark classes on every entry", () => {
    expect(tagColorIndex("Academia")).toBe(tagColorIndex("acadêmia"));
    for (const name of ["a", "Quente", "Prioridade", "Já contatado", "x".repeat(40)]) {
      const index = tagColorIndex(name);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(TAG_PALETTE.length);
      expect(tagColorClass(name)).toBe(TAG_PALETTE[index]!);
    }
    for (const entry of TAG_PALETTE) {
      expect(entry).toMatch(/\bbg-\w+-(50|100)\b/);
      expect(entry).toMatch(/\btext-\w+-(700|800)\b/);
      expect(entry).toMatch(/\bdark:text-\w+-200\b/);
      expect(entry).toMatch(/\bdark:bg-\w+-(800|950)\/\d+\b/);
    }
    // The palette actually spreads tags across colors.
    const used = new Set(["Academia", "Quente", "Frio", "Prioridade", "Advocacia", "Saúde", "Retornar", "VIP"].map(tagColorIndex));
    expect(used.size).toBeGreaterThan(3);
  });
});

describe("tagSuggestions", () => {
  const options = [
    { name: "Academia", count: 4 },
    { name: "Crossfit", count: 1 },
    { name: "Pilates", count: 2 },
    { name: "Academia de bairro", count: 0 },
  ];

  test("excludes chosen tags, prefix matches first, accent-insensitive", () => {
    const result = tagSuggestions(options, ["Pilates"], "ACADE");
    expect(result.options.map((o) => o.name)).toEqual(["Academia", "Academia de bairro"]);
    expect(result.create).toBe("ACADE");
    expect(tagSuggestions(options, [], "fit").options.map((o) => o.name)).toEqual(["Crossfit"]);
  });

  test("no create row for an existing or chosen tag, or when creation is off", () => {
    expect(tagSuggestions(options, [], "acadêmia").create).toBeNull();
    expect(tagSuggestions(options, ["Novo"], "novo").create).toBeNull();
    expect(tagSuggestions(options, [], "Novo", { allowCreate: false }).create).toBeNull();
    expect(tagSuggestions(options, [], "   ").create).toBeNull();
    expect(tagSuggestions(options, [], "").options).toHaveLength(4);
    expect(tagSuggestions(options, [], "", { limit: 2 }).options).toHaveLength(2);
  });
});

describe("query building", () => {
  test("tags + tags_mode (all only when asked)", () => {
    expect(leadsQueryString({ tags: ["Academia", "Já contatado"] })).toBe("?tags=Academia%2CJ%C3%A1+contatado");
    expect(leadsQueryString({ tags: ["a", "b"], tags_mode: "all", page: 1 })).toBe("?tags=a%2Cb&tags_mode=all&page=1");
    expect(leadsQueryString({ tags: [], tags_mode: "all" })).toBe("");
  });
});

describe("filters", () => {
  test("tags alone stay server-side; with other filters everything runs locally", () => {
    const tagsOnly = { ...DEFAULT_FILTERS, tags: ["Quente"] };
    expect(activeFilterCount(tagsOnly)).toBe(1);
    expect(needsLocalFiltering(tagsOnly)).toBe(false);
    expect(needsLocalFiltering({ ...tagsOnly, email: "with" })).toBe(true);
  });

  test("local filtering applies tags with any/all", () => {
    const leads = [lead(1, ["Academia"]), lead(2, ["Academia", "Quente"], { email: "a@b.c" }), lead(3, ["Quente"], { email: "c@d.e" })];
    const run = (tags: string[], tagsMode: "any" | "all", email: "all" | "with" = "with") =>
      filterLeadsLocally(leads, { text: "", filters: { ...DEFAULT_FILTERS, email, tags, tagsMode }, sort: null, page: 1, pageSize: 50 }).leads.map((l) => l.id);
    expect(run(["academia"], "any")).toEqual([2]);
    expect(run(["academia", "quente"], "any")).toEqual([2, 3]);
    expect(run(["academia", "quente"], "all")).toEqual([2]);
    expect(matchesFilters(lead(4), { ...DEFAULT_FILTERS, tags: ["x"] })).toBe(false);
  });

  test("chips: one removable chip per tag", () => {
    const f = { ...DEFAULT_FILTERS, tags: ["Academia", "Quente"], tagsMode: "all" as const };
    const chips = filterChips(f);
    expect(chips.map((c) => c.label)).toEqual(["Tag: Academia (todas)", "Tag: Quente (todas)"]);
    expect(chips[0]!.remove(f).tags).toEqual(["Quente"]);
    expect(filterChips({ ...DEFAULT_FILTERS, tags: ["Academia"] }).map((c) => c.label)).toEqual(["Tag: Academia"]);
  });
});

describe("CSV", () => {
  test("tags column joined with ', ' and formula-safe", () => {
    const csv = leadsToCsv([lead(1, ["Academia", "Quente"]), lead(2, ["=HYPERLINK(1)"]), lead(3, [], { tags: undefined })]);
    const [header, ...rows] = csv.replace(/^﻿/, "").split("\r\n");
    expect(header!.split(";").at(-1)).toBe("tags");
    expect(rows[0]!.split(";").at(-1)).toBe('"Academia, Quente"');
    expect(rows[1]!.split(";").at(-1)).toBe(`"'=HYPERLINK(1)"`);
    expect(rows[2]!.split(";").at(-1)).toBe('""');
  });
});
