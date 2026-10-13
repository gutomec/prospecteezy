import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../db/index.ts";
import type { WaConfig } from "../config.ts";
import { openWaDb, PROJECT_ROOT } from "../db.ts";
import { WaManager } from "../manager.ts";
import { createWaRouter, type WaRouter } from "../routes.ts";
import { makeFakeConnect, type FakeConnect } from "./_fakes.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

function openConfig(): WaConfig {
  return {
    quiet_hours: { enabled: false, start: "21:00", end: "08:00", timezone: "America/Sao_Paulo" },
    rate_limit: { max_per_minute: 1000, max_per_hour: 1000, min_interval_seconds: 0, jitter_seconds: 0 },
    validation: { max_batch_size: 20 },
  };
}

interface Harness {
  router: WaRouter;
  fake: FakeConnect;
  waDb: Database;
  coreDb: Database;
}

function makeHarness(): Harness {
  const waDb = openWaDb(":memory:");
  const coreDb = openDb(":memory:");
  coreDb
    .query(`INSERT INTO searches (query_normalized, niche, city, gl, hl, created_at) VALUES ('x','n','c','br','pt-br',?)`)
    .run(new Date().toISOString());
  const fake = makeFakeConnect();
  const manager = new WaManager({ db: waDb, config: openConfig(), connect: fake.connect });
  const router = createWaRouter({ waDb, coreDb, config: openConfig(), manager });
  return { router, fake, waDb, coreDb };
}

function seedLead(coreDb: Database, name: string, jid: string | null, isWa: number | null): number {
  const res = coreDb
    .query(
      `INSERT INTO leads (search_id, place_id, name, phone, is_whatsapp, whatsapp_jid, source, collected_at)
       VALUES (1, ?, ?, '11999990000', ?, ?, 'serper:places', ?)`,
    )
    .run(`p-${name}-${Math.random()}`, name, isWa, jid, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

async function call(router: WaRouter, req: Request): Promise<{ status: number; json: any }> {
  const res = await router.handle(req, new URL(req.url));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function poll(router: WaRouter, jobId: string, want: string, tries = 40): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const r = await call(router, new Request(`http://localhost/api/wa/campaign/${jobId}`));
    if (r.json?.status === want) return r.json;
    await new Promise((res) => setTimeout(res, 10));
  }
  return (await call(router, new Request(`http://localhost/api/wa/campaign/${jobId}`))).json;
}

describe("campaign routes", () => {
  test("POST /api/wa/media stores an upload and returns a handle", async () => {
    const { router, waDb } = makeHarness();
    const fd = new FormData();
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fd.append("file", new File([PNG], "photo.png", { type: "image/png" }));
    const res = await call(router, new Request("http://localhost/api/wa/media", { method: "POST", body: fd }));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ kind: "image", mime: "image/png", filename: "photo.png", size: 8 });
    expect(res.json.media_id).toMatch(/^med[0-9a-f]{12}$/);
    const row = waDb.query("SELECT file_path FROM wa_media WHERE id = ?").get(res.json.media_id) as { file_path: string };
    const abs = join(PROJECT_ROOT, row.file_path);
    expect(existsSync(abs)).toBe(true);
    unlinkSync(abs); // clean the test artifact off disk
  });

  test("POST /api/wa/campaign returns job_id fast; GET evolves to done", async () => {
    const { router, fake, coreDb } = makeHarness();
    const id = (await call(router, new Request("http://localhost/api/wa/instances", { method: "POST" }))).json.id;
    fake.cb(id).onOpen!("5511@s.whatsapp.net");
    const lead = seedLead(coreDb, "Ana", "5581999990000@s.whatsapp.net", 1);

    const created = await call(
      router,
      new Request("http://localhost/api/wa/campaign", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ instance: id, lead_ids: [lead], template: "Olá {{name}}" }),
      }),
    );
    expect(created.status).toBe(202);
    expect(created.json.job_id).toMatch(/^cmp[0-9a-f]{12}$/);

    const done = await poll(router, created.json.job_id, "done");
    expect(done.status).toBe("done");
    expect(done).toMatchObject({ total: 1, sent: 1 });
    expect(done.recipients[0]).toMatchObject({ lead_id: lead, status: "sent" });
    expect(fake.sock(id).sentMessages[0]).toEqual({ jid: "5581999990000@s.whatsapp.net", text: "Olá Ana" });
  });

  test("campaign with a non-WhatsApp lead skips it (never sends)", async () => {
    const { router, fake, coreDb } = makeHarness();
    const id = (await call(router, new Request("http://localhost/api/wa/instances", { method: "POST" }))).json.id;
    fake.cb(id).onOpen!("5511@s.whatsapp.net");
    const lead = seedLead(coreDb, "SemZap", null, 0);

    const created = await call(
      router,
      new Request("http://localhost/api/wa/campaign", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ instance: id, lead_ids: [lead], template: "oi {{name}}" }),
      }),
    );
    const done = await poll(router, created.json.job_id, "done");
    expect(done).toMatchObject({ sent: 0, skipped: 1 });
    expect(done.recipients[0]).toMatchObject({ status: "skipped", reason: "not_whatsapp" });
    expect(fake.sock(id).sentMessages).toHaveLength(0);
  });

  test("empty lead_ids is rejected", async () => {
    const { router } = makeHarness();
    const id = (await call(router, new Request("http://localhost/api/wa/instances", { method: "POST" }))).json.id;
    const res = await call(
      router,
      new Request("http://localhost/api/wa/campaign", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ instance: id, lead_ids: [], template: "oi" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("empty template without media is rejected", async () => {
    const { router, coreDb } = makeHarness();
    const id = (await call(router, new Request("http://localhost/api/wa/instances", { method: "POST" }))).json.id;
    const lead = seedLead(coreDb, "Ana", "5511@s.whatsapp.net", 1);
    const res = await call(
      router,
      new Request("http://localhost/api/wa/campaign", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ instance: id, lead_ids: [lead], template: "   " }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("GET unknown campaign 404s", async () => {
    const { router } = makeHarness();
    const res = await call(router, new Request("http://localhost/api/wa/campaign/cmpnope"));
    expect(res.status).toBe(404);
  });
});
