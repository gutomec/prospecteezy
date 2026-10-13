import { afterEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db/index.ts";
import { findOrCreateSearch, insertLeadIfNew } from "../src/db/repository.ts";
import { createServer } from "../src/server.ts";
import {
  completeJob,
  createJob,
  FINISHED_JOB_TTL_MS,
  getJob,
  pruneJobs,
} from "../src/agent/jobs.ts";
import type { PlacesFetcher, SerperPlace } from "../src/ingest/serper.ts";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

const publicDns = async () => ["93.184.216.34"];

function startTestServer(options: Parameters<typeof createServer>[0] = {}) {
  const { server, db } = createServer({
    db: openDb(":memory:"),
    port: 0,
    skipEnrichment: true,
    crawlerResolveHost: publicDns,
    ...options,
  });
  stop = () => server.stop(true);
  return { server, db, port: server.port!, base: `http://127.0.0.1:${server.port}` };
}

function places(page: number, num: number, prefix = "p"): SerperPlace[] {
  if (page > 2) return [];
  return Array.from({ length: num }, (_, i) => ({
    title: `Lugar ${page}-${i}`,
    placeId: `${prefix}-${page}-${i}`,
    cid: `${prefix}-cid-${page}-${i}`,
  }));
}
const quickFetcher: PlacesFetcher = async (_q, page, num) => places(page, num);

async function waitForJob(base: string, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${base}/api/progress/${jobId}`);
    const { job } = (await res.json()) as { job: any };
    if (job.status !== "running") return job;
    await Bun.sleep(10);
  }
  throw new Error("job não terminou a tempo");
}

function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function addLead(db: ReturnType<typeof openDb>, searchId: number, n: number, website: string | null) {
  insertLeadIfNew(db, {
    search_id: searchId,
    place_id: `place-${n}`,
    cid: `cid-${n}`,
    position: n,
    name: `Lead ${n}`,
    category: null,
    address: null,
    latitude: null,
    longitude: null,
    phone: null,
    website,
    rating: null,
    rating_count: null,
    source: "serper:places",
  });
}

describe("network exposure (item 1)", () => {
  test("binds to loopback and is reachable as localhost and 127.0.0.1", async () => {
    const { server, port } = startTestServer();
    expect(server.hostname).toBe("127.0.0.1");
    expect((await fetch(`http://localhost:${port}/api/searches`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/searches`)).status).toBe(200);
  });

  test("no wildcard CORS headers on API responses", async () => {
    const { base } = startTestServer();
    const res = await fetch(`${base}/api/searches`, { headers: { Origin: "http://evil.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("foreign Host header (DNS rebinding) is rejected with 403 JSON, incl. /api/wa/*", async () => {
    const { base, port } = startTestServer();
    // The SPA shell (APP_PATHS) is an HTML bundle route outside the guard: it
    // carries no data. Every /api path and any other path stays guarded.
    for (const path of ["/api/searches", "/api/leads", "/api/wa/status", "/nao-existe"]) {
      const res = await fetch(`${base}${path}`, { headers: { Host: `evil.com:${port}` } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("Acesso negado");
    }
    const wrongPort = await fetch(`${base}/api/searches`, { headers: { Host: "localhost:1" } });
    expect(wrongPort.status).toBe(403);
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      const ok = await fetch(`${base}/api/searches`, { headers: { Host: host } });
      expect(ok.status).toBe(200);
    }
  });

  test("cross-origin writes are rejected; same-origin and Origin-less writes pass", async () => {
    const { base, port } = startTestServer({ fetcher: quickFetcher });
    const evil = { Origin: "http://evil.com" };
    expect((await post(base, "/api/prospect", { text: "Busque 5 padarias em Recife" }, evil)).status).toBe(403);
    expect(
      (
        await fetch(`${base}/api/prospect`, {
          method: "POST",
          headers: { "Content-Type": "text/plain", ...evil },
          body: JSON.stringify({ text: "Busque 5 padarias em Recife" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/api/leads`, { method: "DELETE", headers: evil, body: '{"ids":[1]}' })).status,
    ).toBe(403);
    expect((await post(base, "/api/wa/send", {}, evil)).status).toBe(403);
    expect((await fetch(`${base}/api/prospect`, { method: "OPTIONS", headers: evil })).status).toBe(403);
    expect((await post(base, "/api/leads/enrich", { ids: [1] }, { Origin: "null" })).status).toBe(403);

    const same = await post(base, "/api/prospect", { text: "Busque 5 padarias em Recife" }, {
      Origin: `http://localhost:${port}`,
    });
    expect(same.status).toBe(202);
    await waitForJob(base, ((await same.json()) as { job_id: string }).job_id);
    const noOrigin = await post(base, "/api/prospect", { text: "Busque 5 clínicas em Natal" });
    expect(noOrigin.status).toBe(202);
    await waitForJob(base, ((await noOrigin.json()) as { job_id: string }).job_id);
  });
});

describe("GET /api/leads params (item 11)", () => {
  test("sort=city and junk page/page_size no longer 500", async () => {
    const { base } = startTestServer();
    for (const qs of ["sort=city", "sort=city:desc", "page=abc", "page_size=xyz", "page=-3&page_size=0"]) {
      const res = await fetch(`${base}/api/leads?${qs}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { page: number; page_size: number };
      expect(body.page).toBeGreaterThanOrEqual(1);
      expect(body.page_size).toBeGreaterThanOrEqual(1);
    }
  });

  test("invalid search_id → 400 PT-BR", async () => {
    const { base } = startTestServer();
    const res = await fetch(`${base}/api/leads?search_id=abc`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("search_id");
  });

  test("unexpected errors become JSON 500 in PT-BR", async () => {
    const { base, db } = startTestServer();
    db.close();
    const original = console.error;
    console.error = () => {};
    try {
      const res = await fetch(`${base}/api/searches`);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toContain("Erro interno");
    } finally {
      console.error = original;
    }
  });
});

describe("one running job per search (item 3) and last-used search (item 4)", () => {
  test("a second request for a search with a running job returns the same job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slowFetcher: PlacesFetcher = async (_q, page, num) => {
      calls += 1;
      await gate;
      return places(page, num);
    };
    const { base } = startTestServer({ fetcher: slowFetcher });
    const text = "Busque 10 padarias em Recife";
    const first = (await (await post(base, "/api/prospect", { text })).json()) as any;
    const res2 = await post(base, "/api/prospect", { text: "mais 50" });
    expect(res2.status).toBe(202);
    const second = (await res2.json()) as any;
    expect(second.job_id).toBe(first.job_id);
    expect(second.already_running).toBe(true);
    expect(first.already_running).toBe(false);
    release();
    const job = await waitForJob(base, first.job_id);
    expect(job.status).toBe("completed");
    expect(calls).toBe(1);

    // finished → a new request starts a new job
    const third = (await (await post(base, "/api/prospect", { text })).json()) as any;
    expect(third.job_id).not.toBe(first.job_id);
    await waitForJob(base, third.job_id);
  });

  test('"mais N" continues the search used last, not the newest one', async () => {
    const { base } = startTestServer({ fetcher: quickFetcher });
    const a = (await (await post(base, "/api/prospect", { text: "Busque 5 padarias em Recife" })).json()) as any;
    await waitForJob(base, a.job_id);
    const b = (await (await post(base, "/api/prospect", { text: "Busque 5 clínicas em Natal" })).json()) as any;
    await waitForJob(base, b.job_id);
    const again = (await (await post(base, "/api/prospect", { text: "Busque 5 padarias em Recife" })).json()) as any;
    await waitForJob(base, again.job_id);
    const more = (await (await post(base, "/api/prospect", { text: "mais 5" })).json()) as any;
    expect(more.search_id).toBe(a.search_id);
    await waitForJob(base, more.job_id);
  });
});

describe("POST /api/leads/enrich (item 14) + enrichment robustness (items 2, 9)", () => {
  test("invalid bodies → 400 PT-BR", async () => {
    const { base } = startTestServer();
    const bad = [
      "não é json",
      {},
      { ids: [] },
      { ids: "1,2" },
      { ids: [1, "2"] },
      { ids: [1.5] },
    ];
    for (const body of bad) {
      const res = await fetch(`${base}/api/leads/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("Corpo inválido");
    }
  });

  test("re-enriches selected leads (even already enriched), survives bad sites, reports progress", async () => {
    const deletedLeadId = 3;
    let db!: ReturnType<typeof openDb>;
    const crawlerFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === "apagado.com.br") {
        // lead removed while being crawled → markEnriched hits the FK and throws
        db.query("DELETE FROM lead_events WHERE lead_id = ?").run(deletedLeadId);
        db.query("DELETE FROM leads WHERE id = ?").run(deletedLeadId);
      }
      if (url.pathname !== "/") return new Response("não encontrado", { status: 404 });
      const n = url.hostname.match(/^site(\d+)\./)?.[1];
      const html =
        url.hostname === "quebrado.com.br"
          ? `<a href="mailto:contato%@quebrado.com.br">x</a>`
          : `<a href="mailto:contato${n ?? ""}@${url.hostname}">x</a>`;
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;

    const started = startTestServer({ crawlerFetch });
    db = started.db;
    const { base } = started;
    const search = findOrCreateSearch(db, "padarias", "Recife");
    addLead(db, search.id, 1, "https://quebrado.com.br/");
    addLead(db, search.id, 2, null);
    addLead(db, search.id, 3, "https://apagado.com.br/");
    for (let n = 4; n <= 25; n++) addLead(db, search.id, n, `https://site${n}.com.br/`);
    db.query("UPDATE leads SET enriched_at = '2026-01-01T00:00:00.000Z' WHERE id = 4").run();

    const ids = Array.from({ length: 25 }, (_, i) => i + 1).concat([999]);
    const res = await post(base, "/api/leads/enrich", { ids });
    expect(res.status).toBe(202);
    const { job_id } = (await res.json()) as { job_id: string };
    expect(typeof job_id).toBe("string");

    const originalWarn = console.warn;
    console.warn = () => {}; // the deleted lead logs its (expected) FK failure
    let job: any;
    try {
      job = await waitForJob(base, job_id);
    } finally {
      console.warn = originalWarn;
    }
    expect(job.status).toBe("completed");
    expect(job.search_id).toBeNull();
    expect(job.result).toEqual({
      collected_new: 0,
      duplicates_skipped: 0,
      pages_consumed: 0,
      enriched: 22,
      exhausted: false,
    });
    const messages = (job.steps as { message: string }[]).map((s) => s.message);
    expect(messages.some((m) => m.includes("2 leads ignorados"))).toBe(true);
    expect(messages.filter((m) => m.startsWith("Enriquecimento em andamento")).length).toBe(2);
    expect(messages.at(-1)).toBe("Enriquecimento concluído: 22 e-mails encontrados.");

    const broken = db.query("SELECT email, enriched_at FROM leads WHERE id = 1").get() as any;
    expect(broken.email).toBeNull();
    expect(broken.enriched_at).not.toBeNull();
    const reenriched = db.query("SELECT email, enriched_at FROM leads WHERE id = 4").get() as any;
    expect(reenriched.email).toBe("contato4@site4.com.br");
    expect(reenriched.enriched_at).not.toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("job registry pruning (item 13)", () => {
  test("finished jobs older than 1 h are evicted; running ones are kept", () => {
    const old = new Date(Date.now() - FINISHED_JOB_TTL_MS - 1000).toISOString();
    const finished = createJob();
    completeJob(finished, {
      collected_new: 0,
      duplicates_skipped: 0,
      pages_consumed: 0,
      enriched: 0,
      exhausted: false,
    });
    finished.updated_at = old;
    const running = createJob();
    running.updated_at = old;
    const fresh = createJob();
    completeJob(fresh, {
      collected_new: 0,
      duplicates_skipped: 0,
      pages_consumed: 0,
      enriched: 0,
      exhausted: false,
    });
    pruneJobs();
    expect(getJob(finished.id)).toBeNull();
    expect(getJob(running.id)).not.toBeNull();
    expect(getJob(fresh.id)).not.toBeNull();
    running.status = "failed"; // don't leak a "running" job into other tests
  });
});
