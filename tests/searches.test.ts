import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetJobs } from "../src/agent/jobs.ts";
import { EXHAUSTED_TTL_MS, isRecentlyExhausted } from "../src/agent/orchestrator.ts";
import { openDb } from "../src/db/index.ts";
import { findOrCreateSearch } from "../src/db/repository.ts";
import type { PlacesFetcher, SerperPlace } from "../src/ingest/serper.ts";
import { createServer } from "../src/server.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetJobs();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prospecteezy-searches-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function start(options: { fetcher?: PlacesFetcher; db?: Database } = {}) {
  const dir = tempDir();
  const db = options.db ?? openDb(join(dir, "test.db"));
  const { server } = createServer({
    db,
    port: 0,
    skipEnrichment: true,
    fetcher: options.fetcher,
    masterKeyPath: join(dir, ".master.key"),
  });
  cleanups.push(() => server.stop(true));
  return { db, base: `http://localhost:${server.port}` };
}

/** Fake Serper: `available` results per query, pages of `num`; counts calls. */
function fakeFetcher(available: number) {
  const calls: string[] = [];
  const fetcher: PlacesFetcher = async (query, page, num) => {
    calls.push(`${query}#${page}`);
    const startIndex = (page - 1) * num;
    const size = Math.max(0, Math.min(num, available - startIndex));
    return Array.from({ length: size }, (_, i): SerperPlace => ({
      title: `${query} ${startIndex + i}`,
      placeId: `${query}-p${startIndex + i}`,
      cid: `${query}-c${startIndex + i}`,
    }));
  };
  return { fetcher, calls };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function waitForJob(base: string, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const { json } = await call(base, "GET", `/api/progress/${jobId}`);
    if (json.job.status !== "running") return json.job;
    await Bun.sleep(10);
  }
  throw new Error("job não terminou a tempo");
}

async function searchById(base: string, id: number) {
  const { json } = await call(base, "GET", "/api/searches");
  return (json.searches as any[]).find((s) => s.id === id);
}

describe("GET /api/searches status", () => {
  test("idle → running (with running_job_id) → exhausted, keeping the existing fields", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = fakeFetcher(3).fetcher;
    const { base } = start({ fetcher: async (...args) => (await gate, inner(...args)) });

    const started = await call(base, "POST", "/api/searches", { niche: "padarias", city: "Recife-PE", count: 5 });
    expect(started.status).toBe(202);
    const running = await searchById(base, started.json.search_id);
    expect(running).toMatchObject({
      niche: "padarias",
      city: "Recife-PE",
      status: "running",
      running_job_id: started.json.job_id,
      exhausted_at: null,
    });
    for (const field of ["query_normalized", "created_at", "last_used_at", "last_page", "total_collected", "lead_count"]) {
      expect(running).toHaveProperty(field);
    }

    release();
    const job = await waitForJob(base, started.json.job_id);
    expect(job.result).toMatchObject({ collected_new: 3, exhausted: true });
    const done = await searchById(base, started.json.search_id);
    expect(done).toMatchObject({ status: "exhausted", running_job_id: null, lead_count: 3 });
    expect(typeof done.exhausted_at).toBe("string");
  });

  test("a search that still has results is idle after its collection", async () => {
    const { base } = start({ fetcher: fakeFetcher(100).fetcher });
    const started = await call(base, "POST", "/api/searches", { niche: "dentistas", city: "Campinas-SP", count: 10 });
    await waitForJob(base, started.json.job_id);
    expect(await searchById(base, started.json.search_id)).toMatchObject({ status: "idle", exhausted_at: null, lead_count: 10 });
  });
});

describe("POST /api/searches/:id/more", () => {
  test("collects more for THAT search (not the most recent one) and resumes its cursor", async () => {
    const { fetcher, calls } = fakeFetcher(100);
    const { db, base } = start({ fetcher });
    const a = await call(base, "POST", "/api/searches", { niche: "advogados", city: "Curitiba-PR", count: 10 });
    await waitForJob(base, a.json.job_id);
    const b = await call(base, "POST", "/api/searches", { niche: "contadores", city: "Londrina-PR", count: 10 });
    await waitForJob(base, b.json.job_id);

    const more = await call(base, "POST", `/api/searches/${a.json.search_id}/more`, { count: 20 });
    expect(more.status).toBe(202);
    expect(more.json).toMatchObject({ search_id: a.json.search_id, already_running: false });
    expect(typeof more.json.job_id).toBe("string");
    expect(Array.isArray(more.json.steps)).toBe(true);
    const job = await waitForJob(base, more.json.job_id);
    expect(job.result).toMatchObject({ collected_new: 20, duplicates_skipped: 0 });
    // Pages 2 and 3 of the first search: the cursor resumed, no page re-fetched.
    expect(calls.filter((c) => c.startsWith("advogados"))).toEqual([
      "advogados em Curitiba-PR#1",
      "advogados em Curitiba-PR#2",
      "advogados em Curitiba-PR#3",
    ]);
    const count = (id: number) =>
      (db.query("SELECT COUNT(*) AS n FROM leads WHERE search_id = ?").get(id) as { n: number }).n;
    expect(count(a.json.search_id)).toBe(30);
    expect(count(b.json.search_id)).toBe(10);
  });

  test("one job per search: a second request joins the running job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = fakeFetcher(100).fetcher;
    const { db, base } = start({ fetcher: async (...args) => (await gate, inner(...args)) });
    const search = findOrCreateSearch(db, "academias", "Recife-PE");
    const first = await call(base, "POST", `/api/searches/${search.id}/more`, { count: 10 });
    const second = await call(base, "POST", `/api/searches/${search.id}/more`, { count: 30 });
    expect(second.status).toBe(202);
    expect(second.json).toMatchObject({ job_id: first.json.job_id, already_running: true, search_id: search.id });
    release();
    await waitForJob(base, first.json.job_id);
  });

  test("recently exhausted → 409 code exhausted without calling Serper", async () => {
    const { fetcher, calls } = fakeFetcher(4);
    const { base } = start({ fetcher });
    const started = await call(base, "POST", "/api/searches", { niche: "pilates", city: "Toledo-PR", count: 50 });
    await waitForJob(base, started.json.job_id);
    const before = calls.length;

    const more = await call(base, "POST", `/api/searches/${started.json.search_id}/more`, { count: 20 });
    expect(more.status).toBe(409);
    expect(more.json).toEqual({
      error: "Esta busca já esgotou os resultados do Google Maps nas últimas 24 horas. Tente outro termo ou outra cidade.",
      code: "exhausted",
    });
    expect(calls.length).toBe(before);
  });

  test("exhaustion older than 24 h no longer blocks", async () => {
    const { fetcher, calls } = fakeFetcher(4);
    const { db, base } = start({ fetcher });
    const search = findOrCreateSearch(db, "pilates", "Toledo-PR");
    const old = new Date(Date.now() - EXHAUSTED_TTL_MS - 60_000).toISOString();
    db.query("UPDATE searches SET exhausted_at = ? WHERE id = ?").run(old, search.id);
    expect((await searchById(base, search.id)).status).toBe("idle");
    const more = await call(base, "POST", `/api/searches/${search.id}/more`, { count: 5 });
    expect(more.status).toBe(202);
    await waitForJob(base, more.json.job_id);
    expect(calls.length).toBe(1);
  });

  test("404 for an unknown or malformed id", async () => {
    const { base } = start({ fetcher: fakeFetcher(10).fetcher });
    expect((await call(base, "POST", "/api/searches/999/more", { count: 5 })).status).toBe(404);
    const bad = await call(base, "POST", "/api/searches/abc/more", { count: 5 });
    expect(bad.status).toBe(404);
    expect(bad.json.error).toBe("Busca não encontrada.");
  });

  test("400 for an invalid count or body", async () => {
    const { db, base } = start({ fetcher: fakeFetcher(10).fetcher });
    const search = findOrCreateSearch(db, "bares", "Natal-RN");
    for (const body of [{}, { count: 0 }, { count: 2.5 }, { count: "20" }, "not json"]) {
      const res = await call(base, "POST", `/api/searches/${search.id}/more`, body);
      expect(res.status).toBe(400);
      expect(res.json.error).toContain("count");
    }
  });

  test("503 when no Serper key is configured", async () => {
    const previous = Bun.env.SERPER_API_KEY;
    delete Bun.env.SERPER_API_KEY;
    try {
      const { db, base } = start(); // no fetcher → real client path
      const search = findOrCreateSearch(db, "bares", "Natal-RN");
      const res = await call(base, "POST", `/api/searches/${search.id}/more`, { count: 5 });
      expect(res.status).toBe(503);
      expect(res.json.error).toContain("SERPER_API_KEY ausente");
    } finally {
      if (previous !== undefined) Bun.env.SERPER_API_KEY = previous;
    }
  });
});

describe("POST /api/searches", () => {
  test("starts a structured search with the /api/prospect response shape", async () => {
    const { db, base } = start({ fetcher: fakeFetcher(100).fetcher });
    const res = await call(base, "POST", "/api/searches", { niche: "  clínicas   de estética ", city: "Cascavel-PR", count: 15 });
    expect(res.status).toBe(202);
    expect(Object.keys(res.json).sort()).toEqual(["already_running", "job_id", "search_id", "steps"]);
    expect(res.json.already_running).toBe(false);
    const job = await waitForJob(base, res.json.job_id);
    expect(job.result.collected_new).toBe(20); // whole pages are persisted (credit already spent)
    const row = db.query("SELECT niche, city FROM searches WHERE id = ?").get(res.json.search_id);
    expect(row).toEqual({ niche: "clínicas de estética", city: "Cascavel-PR" });
  });

  test("same niche+city (accents/case ignored) resumes the existing search", async () => {
    const { base } = start({ fetcher: fakeFetcher(100).fetcher });
    const a = await call(base, "POST", "/api/searches", { niche: "Clínicas", city: "São Paulo-SP", count: 10 });
    await waitForJob(base, a.json.job_id);
    const b = await call(base, "POST", "/api/searches", { niche: "clinicas", city: "sao paulo-sp", count: 10 });
    expect(b.json.search_id).toBe(a.json.search_id);
    await waitForJob(base, b.json.job_id);
    expect((await searchById(base, a.json.search_id)).lead_count).toBe(20);
  });

  test("409 when that niche+city is recently exhausted (no Serper call)", async () => {
    const { fetcher, calls } = fakeFetcher(2);
    const { base } = start({ fetcher });
    const a = await call(base, "POST", "/api/searches", { niche: "museus", city: "Toledo-PR", count: 10 });
    await waitForJob(base, a.json.job_id);
    const before = calls.length;
    const again = await call(base, "POST", "/api/searches", { niche: "Museus", city: "Toledo-PR", count: 10 });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("exhausted");
    expect(calls.length).toBe(before);
    // Another city is fine.
    const other = await call(base, "POST", "/api/searches", { niche: "museus", city: "Cascavel-PR", count: 10 });
    expect(other.status).toBe(202);
    await waitForJob(base, other.json.job_id);
  });

  test("400 with PT-BR messages for invalid input", async () => {
    const { db, base } = start({ fetcher: fakeFetcher(10).fetcher });
    const cases: [unknown, string][] = [
      ["nope", "Corpo inválido"],
      [{ city: "Recife-PE", count: 5 }, '"niche"'],
      [{ niche: "a", city: "Recife-PE", count: 5 }, '"niche"'],
      [{ niche: "bares", city: " ", count: 5 }, '"city"'],
      [{ niche: "bares", city: "Recife-PE" }, '"count"'],
      [{ niche: "bares", city: "Recife-PE", count: 0 }, '"count"'],
    ];
    for (const [body, fragment] of cases) {
      const res = await call(base, "POST", "/api/searches", body);
      expect(res.status).toBe(400);
      expect(res.json.error).toContain(fragment);
    }
    expect((db.query("SELECT COUNT(*) AS n FROM searches").get() as { n: number }).n).toBe(0);
  });

  test("503 without a Serper key and no search is created", async () => {
    const previous = Bun.env.SERPER_API_KEY;
    delete Bun.env.SERPER_API_KEY;
    try {
      const { db, base } = start();
      const res = await call(base, "POST", "/api/searches", { niche: "bares", city: "Recife-PE", count: 5 });
      expect(res.status).toBe(503);
      expect((db.query("SELECT COUNT(*) AS n FROM searches").get() as { n: number }).n).toBe(0);
    } finally {
      if (previous !== undefined) Bun.env.SERPER_API_KEY = previous;
    }
  });
});

describe("persisted exhaustion (searches.exhausted_at)", () => {
  test("survives a server restart and is cleared by a productive run", async () => {
    const dir = tempDir();
    const path = join(dir, "persist.db");
    let available = 3;
    const fetcher: PlacesFetcher = (q, p, n) => fakeFetcher(available).fetcher(q, p, n);

    const first = start({ fetcher, db: openDb(path) });
    const started = await call(first.base, "POST", "/api/searches", { niche: "lojas", city: "Ijuí-RS", count: 10 });
    await waitForJob(first.base, started.json.job_id);
    const id = started.json.search_id as number;
    expect(isRecentlyExhausted(first.db, id)).toBe(true);
    first.db.close();

    const reopened = openDb(path);
    expect(isRecentlyExhausted(reopened, id)).toBe(true);
    const second = start({ fetcher, db: reopened });
    expect((await call(second.base, "POST", `/api/searches/${id}/more`, { count: 5 })).status).toBe(409);

    // Past the TTL with new results on the source: a run that collects without
    // exhausting clears the mark.
    reopened.query("UPDATE searches SET exhausted_at = ? WHERE id = ?").run(new Date(Date.now() - EXHAUSTED_TTL_MS - 1).toISOString(), id);
    available = 100;
    const more = await call(second.base, "POST", `/api/searches/${id}/more`, { count: 5 });
    expect(more.status).toBe(202);
    await waitForJob(second.base, more.json.job_id);
    expect((reopened.query("SELECT exhausted_at FROM searches WHERE id = ?").get(id) as any).exhausted_at).toBeNull();
    expect(isRecentlyExhausted(reopened, id)).toBe(false);
  });

  test("migration v5 is additive on a v4 database", () => {
    const path = join(tempDir(), "v4.db");
    const legacy = openDb(path);
    legacy.exec("ALTER TABLE searches DROP COLUMN exhausted_at");
    legacy.exec("PRAGMA user_version = 4");
    findOrCreateSearch(legacy, "padarias", "Recife");
    legacy.close();
    const migrated = openDb(path);
    expect(migrated.query("SELECT niche, exhausted_at FROM searches").all()).toEqual([{ niche: "padarias", exhausted_at: null }]);
    expect((migrated.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(6);
    migrated.close();
  });
});

describe("GET /api/leads?search_id", () => {
  test("filters the leads by search", async () => {
    const { base } = start({ fetcher: fakeFetcher(100).fetcher });
    const a = await call(base, "POST", "/api/searches", { niche: "hotéis", city: "Gramado-RS", count: 10 });
    await waitForJob(base, a.json.job_id);
    const b = await call(base, "POST", "/api/searches", { niche: "pousadas", city: "Gramado-RS", count: 20 });
    await waitForJob(base, b.json.job_id);
    const list = await call(base, "GET", `/api/leads?search_id=${a.json.search_id}`);
    expect(list.json.total).toBe(10);
    expect((list.json.leads as any[]).every((l) => l.search_id === a.json.search_id)).toBe(true);
    expect((await call(base, "GET", "/api/leads")).json.total).toBe(30);
  });
});
