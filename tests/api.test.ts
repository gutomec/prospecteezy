import { afterEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db/index.ts";
import { createServer } from "../src/server.ts";
import type { PlacesFetcher, SerperPlace } from "../src/ingest/serper.ts";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

function startTestServer(options: Parameters<typeof createServer>[0] = {}) {
  const { server, db } = createServer({
    db: openDb(":memory:"),
    port: 0,
    skipEnrichment: true,
    ...options,
  });
  stop = () => server.stop(true);
  return { server, db, base: `http://localhost:${server.port}` };
}

const mockFetcher: PlacesFetcher = async (_query, page, num) => {
  if (page > 3) return [];
  const start = (page - 1) * num;
  return Array.from({ length: num }, (_, i): SerperPlace => {
    const index = start + i;
    return {
      position: index + 1,
      title: `Lugar ${index + 1}`,
      placeId: `place-${index}`,
      cid: `cid-${index}`,
      category: "Advogado",
    };
  });
};

async function waitForJob(base: string, jobId: string) {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/api/progress/${jobId}`);
    const { job } = (await res.json()) as { job: { status: string } };
    if (job.status !== "running") return job;
    await Bun.sleep(20);
  }
  throw new Error("job não terminou a tempo");
}

describe("REST API", () => {
  test("POST /api/prospect without SERPER_API_KEY fails with a clear PT-BR message", async () => {
    const previous = Bun.env.SERPER_API_KEY;
    delete Bun.env.SERPER_API_KEY;
    try {
      const { base } = startTestServer(); // no fetcher injected → real client path
      const res = await fetch(`${base}/api/prospect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Busque 10 padarias em Curitiba" }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("SERPER_API_KEY ausente");
      expect(body.error).toContain(".env");
    } finally {
      if (previous !== undefined) Bun.env.SERPER_API_KEY = previous;
    }
  });

  test("prospect end-to-end with mocked Serper: job completes and leads are queryable", async () => {
    const { base } = startTestServer({ fetcher: mockFetcher });

    const res = await fetch(`${base}/api/prospect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Busque os 20 principais escritórios de advocacia de São Paulo-SP",
      }),
    });
    expect(res.status).toBe(202);
    const { job_id, search_id } = (await res.json()) as {
      job_id: string;
      search_id: number;
    };

    const job = await waitForJob(base, job_id);
    expect(job.status).toBe("completed");

    const leadsRes = await fetch(`${base}/api/leads?search_id=${search_id}`);
    const { leads, total } = (await leadsRes.json()) as {
      leads: { name: string; source: string }[];
      total: number;
    };
    expect(total).toBe(20);
    expect(leads[0]!.source).toBe("serper:places");

    const searchesRes = await fetch(`${base}/api/searches`);
    const { searches } = (await searchesRes.json()) as {
      searches: { lead_count: number; last_page: number }[];
    };
    expect(searches[0]!.lead_count).toBe(20);
    expect(searches[0]!.last_page).toBeGreaterThan(0);
  });

  test("unintelligible request returns 422 with guidance", async () => {
    const { base } = startTestServer({ fetcher: mockFetcher });
    const res = await fetch(`${base}/api/prospect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "bom dia" }),
    });
    expect(res.status).toBe(422);
  });

  test("APP_PATHS serve the React shell; unknown paths get JSON 404", async () => {
    // Development bundling: under `bun test` (test file inside the project) Bun
    // 1.4's production HTML bundler fails to resolve the "@/" tsconfig alias.
    // Production bundling is exercised by booting the real server instead.
    const previous = Bun.env.NODE_ENV;
    Bun.env.NODE_ENV = "development";
    let base: string;
    try {
      base = startTestServer({ fetcher: mockFetcher }).base;
    } finally {
      Bun.env.NODE_ENV = previous;
    }
    for (const path of ["/", "/leads", "/whatsapp", "/configuracoes"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('lang="pt-BR"');
      expect(html).toContain('<div id="root">');
    }
    for (const path of ["/nao-existe", "/api/nao-existe"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });
});
