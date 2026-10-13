import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db/index.ts";
import { findOrCreateSearch, getCursor } from "../src/db/repository.ts";
import { collectPlaces, type PlacesFetcher, type SerperPlace } from "../src/ingest/serper.ts";

/**
 * Mock Serper universe: 100 unique places served 10 per page.
 * To be adversarial (results shift between calls on the real API), every
 * page after the first repeats the last 2 places of the previous page —
 * so raw pages contain duplicates and the client must keep fetching until
 * the target of NEW leads is met.
 */
function makePlace(index: number): SerperPlace {
  return {
    position: index + 1,
    title: `Escritório ${index + 1}`,
    address: `Rua ${index + 1}, São Paulo - SP`,
    latitude: -23.5 - index / 1000,
    longitude: -46.6 - index / 1000,
    rating: 4.5,
    ratingCount: 10 + index,
    category: "Advogado",
    phoneNumber: `+55 11 90000-${String(1000 + index).slice(-4)}`,
    website: index % 2 === 0 ? `https://escritorio${index + 1}.com.br` : undefined,
    cid: `cid-${index}`,
    placeId: `place-${index}`,
  };
}

const UNIVERSE = Array.from({ length: 100 }, (_, i) => makePlace(i));

/** Clean pages: page N = places [(N-1)*10, N*10). */
const cleanFetcher: PlacesFetcher = async (_query, page, num) => {
  const start = (page - 1) * num;
  return UNIVERSE.slice(start, start + num);
};

/** Overlapping pages: page N>1 repeats the previous page's last 2 places. */
const overlappingFetcher: PlacesFetcher = async (_query, page, num) => {
  const start = (page - 1) * (num - 2);
  return UNIVERSE.slice(start, start + num);
};

describe("cursor pagination with dedup", () => {
  test("30 then +30 of the same query yields 60 unique leads, zero duplicates", async () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "escritórios de advocacia", "São Paulo-SP");

    const first = await collectPlaces({
      db,
      search,
      fetcher: cleanFetcher,
      targetNew: 30,
    });
    expect(first.collectedNew).toBe(30);
    expect(first.pagesConsumed).toBe(3);

    const cursorAfterFirst = getCursor(db, search.id);
    expect(cursorAfterFirst.last_page).toBe(3);
    expect(cursorAfterFirst.total_collected).toBe(30);

    const second = await collectPlaces({
      db,
      search,
      fetcher: cleanFetcher,
      targetNew: 30,
    });
    expect(second.collectedNew).toBe(30);
    expect(second.duplicatesSkipped).toBe(0); // cursor resumed, no page refetched

    const total = (
      db.query("SELECT COUNT(*) AS n FROM leads WHERE search_id = ?").get(search.id) as {
        n: number;
      }
    ).n;
    const unique = (
      db
        .query("SELECT COUNT(DISTINCT place_id) AS n FROM leads WHERE search_id = ?")
        .get(search.id) as { n: number }
    ).n;
    expect(total).toBe(60);
    expect(unique).toBe(60);

    const cursorAfterSecond = getCursor(db, search.id);
    expect(cursorAfterSecond.last_page).toBe(6);
    expect(cursorAfterSecond.total_collected).toBe(60);
  });

  test("pages with overlapping results: duplicates are skipped and target of NEW leads is still met", async () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "clínicas de estética", "Fortaleza");

    // Every fetched lead is persisted (credit already spent), so a run can
    // slightly exceed the target — never fall short while pages have data.
    const first = await collectPlaces({
      db,
      search,
      fetcher: overlappingFetcher,
      targetNew: 30,
    });
    expect(first.collectedNew).toBeGreaterThanOrEqual(30);
    expect(first.duplicatesSkipped).toBeGreaterThan(0);

    const second = await collectPlaces({
      db,
      search,
      fetcher: overlappingFetcher,
      targetNew: 30,
    });
    expect(second.collectedNew).toBeGreaterThanOrEqual(30);

    const unique = (
      db
        .query("SELECT COUNT(DISTINCT place_id) AS n FROM leads WHERE search_id = ?")
        .get(search.id) as { n: number }
    ).n;
    const total = (
      db.query("SELECT COUNT(*) AS n FROM leads WHERE search_id = ?").get(search.id) as {
        n: number;
      }
    ).n;
    expect(total).toBe(unique); // zero duplicate rows ever inserted
    expect(total).toBe(first.collectedNew + second.collectedNew);
  });

  test("dedup falls back to cid when place_id is missing", async () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "padarias", "Curitiba");
    const noPlaceId: PlacesFetcher = async (_q, page) =>
      page === 1
        ? [
            { title: "Padaria A", cid: "cid-a" },
            { title: "Padaria A duplicada", cid: "cid-a" },
            { title: "Padaria B", cid: "cid-b" },
          ]
        : [];

    const result = await collectPlaces({ db, search, fetcher: noPlaceId, targetNew: 10 });
    expect(result.collectedNew).toBe(2);
    expect(result.duplicatesSkipped).toBe(1);
    expect(result.exhausted).toBe(true);
  });

  test("source exhaustion: stops when Serper returns an empty page", async () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "planetários", "Boa Vista");
    const tiny: PlacesFetcher = async (_q, page, num) =>
      page === 1 ? UNIVERSE.slice(0, 4) : [];

    const result = await collectPlaces({ db, search, fetcher: tiny, targetNew: 30 });
    expect(result.collectedNew).toBe(4);
    expect(result.exhausted).toBe(true);
    expect(getCursor(db, search.id).last_page).toBe(1);
  });

  test("every lead carries source and collected_at", async () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "escritórios de advocacia", "Recife");
    await collectPlaces({ db, search, fetcher: cleanFetcher, targetNew: 5, pageSize: 5 });

    const rows = db
      .query("SELECT source, collected_at FROM leads WHERE search_id = ?")
      .all(search.id) as { source: string; collected_at: string }[];
    expect(rows.length).toBe(5);
    for (const row of rows) {
      expect(row.source).toBe("serper:places");
      expect(row.collected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

describe("no page cap, repeated-page guard", () => {
  test("keeps paging past 100 pages while the source brings new leads", async () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "restaurantes", "São Paulo-SP");
    const fetcher: PlacesFetcher = async (_q, page, num) =>
      page > 120 ? [] : Array.from({ length: num }, (_, i) => makePlace(page * 100 + i));
    const result = await collectPlaces({ db, search, fetcher, targetNew: 5000 });
    expect(result.pagesConsumed).toBe(121);
    expect(result.collectedNew).toBe(1200);
    expect(result.exhausted).toBe(true);
  });

  test("keeps paging through pages of already-known leads until new ones appear", async () => {
    const db = openDb(":memory:");
    // Another search already collected the places shown on pages 1–8.
    const other = findOrCreateSearch(db, "engenharia", "São Paulo-SP");
    const known: PlacesFetcher = async (_q, page, num) =>
      page > 8 ? [] : Array.from({ length: num }, (_, i) => makePlace(page * 100 + i));
    await collectPlaces({ db, search: other, fetcher: known, targetNew: 1000 });

    const search = findOrCreateSearch(db, "engenheiros civis", "São Paulo-SP");
    const overlapping: PlacesFetcher = async (_q, page, num) =>
      page > 12 ? [] : Array.from({ length: num }, (_, i) => makePlace(page * 100 + i));
    const result = await collectPlaces({ db, search, fetcher: overlapping, targetNew: 1000 });
    expect(result.duplicatesSkipped).toBe(80);
    expect(result.collectedNew).toBe(40);
    expect(result.pagesConsumed).toBe(13);
  });

  test("stops when the source answers with the same page again", async () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "bares", "Natal-RN");
    // Pages 1–3 are real; from page 4 on the source repeats page 3 forever.
    const fetcher: PlacesFetcher = async (_q, page, num) =>
      Array.from({ length: num }, (_, i) => makePlace(Math.min(page, 3) * 100 + i));
    const steps: string[] = [];
    const result = await collectPlaces({ db, search, fetcher, targetNew: 1000, onProgress: (m) => steps.push(m) });
    expect(result.collectedNew).toBe(30);
    expect(result.pagesConsumed).toBe(4);
    expect(result.exhausted).toBe(true);
    expect(getCursor(db, search.id).last_page).toBe(3);
    expect(steps.at(-1)).toContain("repetiu a página anterior");
  });
});
