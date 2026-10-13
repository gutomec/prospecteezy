import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db/index.ts";
import { findOrCreateSearch } from "../src/db/repository.ts";
import {
  collectPlaces,
  createSerperFetcher,
  type PlacesFetcher,
  type SerperPlace,
} from "../src/ingest/serper.ts";

/** Builds N distinct places to serve across paginated mock responses. */
function makePlaces(count: number, offset = 0): SerperPlace[] {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i;
    return {
      position: n + 1,
      title: `Lugar ${n + 1}`,
      cid: `cid-${n}`,
      placeId: `place-${n}`,
      phoneNumber: `+55 11 90000-${String(1000 + n).slice(-4)}`,
    };
  });
}

/**
 * Serves a fixed universe `pageSize` per page. Page N returns
 * `universe[(N-1)*pageSize, N*pageSize)` — a naturally partial last page.
 */
function paginatedFetcher(universeSize: number): PlacesFetcher {
  const universe = makePlaces(universeSize);
  return async (_query, page, num) => {
    const start = (page - 1) * num;
    return universe.slice(start, start + num);
  };
}

describe("Regra A — parâmetro location no corpo do Serper", () => {
  test("createSerperFetcher inclui `location` no body enviado ao Serper", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ places: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const fetcher = createSerperFetcher({ apiKey: "test-key", fetchImpl });
    await fetcher("escritórios de advocacia em São Paulo-SP", 1, 10, "São Paulo-SP");

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.location).toBe("São Paulo-SP");
    expect(capturedBody!.q).toBe("escritórios de advocacia em São Paulo-SP");
    expect(capturedBody!.page).toBe(1);
    expect(capturedBody!.num).toBe(10);
  });

  test("sem location, o campo não é enviado (mudança aditiva, sem regressão)", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ places: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const fetcher = createSerperFetcher({ apiKey: "test-key", fetchImpl });
    await fetcher("padarias em Curitiba", 1, 10);

    expect(capturedBody).not.toBeNull();
    expect("location" in capturedBody!).toBe(false);
  });

  test("collectPlaces passa a cidade da busca como location para o fetcher", async () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "escritórios de advocacia", "São Paulo-SP");
    let seenLocation: string | undefined;

    const fetcher: PlacesFetcher = async (_q, _page, _num, location) => {
      seenLocation = location;
      return [];
    };

    await collectPlaces({ db, search, fetcher, targetNew: 10 });
    expect(seenLocation).toBe("São Paulo-SP");
  });
});

describe("Regra B — exaustão em página parcial (correção de bug)", () => {
  test("páginas [10,10,4] com pageSize 10 param na parcial: exhausted, 24 novos, 3 páginas, sem requisição extra", async () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "advogados", "Campinas");

    let callCount = 0;
    const fetcher: PlacesFetcher = async (_q, page, num) => {
      callCount += 1;
      return paginatedFetcher(24)(_q, page, num);
    };

    const result = await collectPlaces({
      db,
      search,
      fetcher,
      targetNew: 100, // alvo bem acima do disponível
      pageSize: 10,
    });

    expect(result.collectedNew).toBe(24);
    expect(result.pagesConsumed).toBe(3); // NÃO 4 — parou na parcial, sem página extra
    expect(result.exhausted).toBe(true);
    expect(result.lastPage).toBe(3); // cursor na última página REAL processada
    expect(callCount).toBe(3); // nenhuma requisição de sobra ao Serper
  });

  test("alvo inatingível: pedir 100 com só 42 disponíveis para em 42 (exhausted, sem loop)", async () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "clínicas", "Sorocaba");

    let callCount = 0;
    const fetcher: PlacesFetcher = async (_q, page, num) => {
      callCount += 1;
      return paginatedFetcher(42)(_q, page, num);
    };

    const result = await collectPlaces({
      db,
      search,
      fetcher,
      targetNew: 100,
      pageSize: 10,
    });

    expect(result.collectedNew).toBe(42); // parou no total disponível
    expect(result.exhausted).toBe(true);
    expect(result.pagesConsumed).toBe(5); // 10+10+10+10+2, a 5ª é parcial
    expect(callCount).toBe(5); // sem loop infinito, sem requisição além da parcial
  });

  test("página cheia exata seguida de alvo atingido não marca exhausted", async () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "restaurantes", "Santos");

    const result = await collectPlaces({
      db,
      search,
      fetcher: paginatedFetcher(200), // universo grande, todas as páginas cheias
      targetNew: 20,
      pageSize: 10,
    });

    expect(result.collectedNew).toBe(20);
    expect(result.pagesConsumed).toBe(2);
    expect(result.exhausted).toBe(false); // alvo atingido, fonte NÃO esgotada
  });
});
