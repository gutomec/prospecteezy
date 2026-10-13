// Campaign resume (POST /api/wa/campaign/:job/resume) and boot-time auto-start
// of paired instances. Offline: fake connection factory, in-memory DBs.
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../db/index.ts";
import type { WaConfig } from "../config.ts";
import { getState, openWaDb } from "../db.ts";
import { createInstance } from "../instances.ts";
import { WaManager } from "../manager.ts";
import { createCampaign, setCampaignStatus } from "../campaign.ts";
import { createWaRouter, type WaRouter } from "../routes.ts";
import { makeFakeConnect, seedPairedCreds, tick, type FakeConnect } from "./_fakes.ts";

function openConfig(quiet = false): WaConfig {
  return {
    quiet_hours: { enabled: quiet, start: "21:00", end: "08:00", timezone: "America/Sao_Paulo" },
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

function harness(opts: { quiet?: boolean; now?: () => Date } = {}): Harness {
  const waDb = openWaDb(":memory:");
  const coreDb = openDb(":memory:");
  coreDb
    .query(`INSERT INTO searches (query_normalized, niche, city, gl, hl, created_at) VALUES ('x','n','c','br','pt-br',?)`)
    .run(new Date().toISOString());
  const fake = makeFakeConnect();
  const config = openConfig(opts.quiet);
  const manager = new WaManager({ db: waDb, config, connect: fake.connect });
  const router = createWaRouter({ waDb, coreDb, config, manager, now: opts.now });
  return { router, fake, waDb, coreDb };
}

function seedLead(coreDb: Database, name: string, jid: string | null, isWa: number | null, phone = "11999990000"): number {
  const res = coreDb
    .query(
      `INSERT INTO leads (search_id, place_id, name, phone, is_whatsapp, whatsapp_jid, source, collected_at)
       VALUES (1, ?, ?, ?, ?, ?, 'serper:places', ?)`,
    )
    .run(`p-${name}-${Math.random()}`, name, phone, isWa, jid, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

async function call(router: WaRouter, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://localhost${path}`, init);
  const res = await router.handle(req, new URL(req.url));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function poll(router: WaRouter, jobId: string, want: string, tries = 60): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const r = await call(router, "GET", `/api/wa/campaign/${jobId}`);
    if (r.json?.status === want) return r.json;
    await tick(10);
  }
  return (await call(router, "GET", `/api/wa/campaign/${jobId}`)).json;
}

/** A connected instance + a campaign paused with the given leads still queued. */
async function pausedCampaign(h: Harness, leadIds: number[]): Promise<{ instance: string; jobId: string }> {
  const instance = (await call(h.router, "POST", "/api/wa/instances")).json.id as string;
  h.fake.cb(instance).onOpen!("5511@s.whatsapp.net");
  const jobId = createCampaign(h.waDb, h.coreDb, { instanceId: instance, template: "Olá {{name}}", mediaId: null, leadIds });
  setCampaignStatus(h.waDb, jobId, "paused", "servidor reiniciado");
  return { instance, jobId };
}

const NEVER = () => new Promise<never>(() => {});

describe("POST /api/wa/campaign/:job/resume", () => {
  test("resumes a paused campaign over the still-queued recipients only (no re-send)", async () => {
    const h = harness();
    const ana = seedLead(h.coreDb, "Ana", "5581999990001@s.whatsapp.net", 1);
    const bia = seedLead(h.coreDb, "Bia", "5581999990002@s.whatsapp.net", 1);
    const { instance, jobId } = await pausedCampaign(h, [ana, bia]);
    // Ana was already sent before the pause.
    h.waDb
      .query("UPDATE campaign_recipients SET status = 'sent', jid = ? WHERE campaign_id = ? AND lead_id = ?")
      .run("5581999990001@s.whatsapp.net", jobId, ana);

    const res = await call(h.router, "POST", `/api/wa/campaign/${jobId}/resume`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, job_id: jobId });

    const done = await poll(h.router, jobId, "done");
    expect(done.status).toBe("done");
    expect(done.sent).toBe(2);
    expect(h.fake.sock(instance).sentMessages).toEqual([{ jid: "5581999990002@s.whatsapp.net", text: "Olá Bia" }]);
  });

  test("409 when the campaign is already running", async () => {
    const h = harness();
    const ana = seedLead(h.coreDb, "Ana", "5581999990001@s.whatsapp.net", 1);
    const { instance, jobId } = await pausedCampaign(h, [ana]);
    h.fake.sock(instance).sendMessage = NEVER; // the runner stays inside the send
    expect((await call(h.router, "POST", `/api/wa/campaign/${jobId}/resume`)).status).toBe(200);
    const again = await call(h.router, "POST", `/api/wa/campaign/${jobId}/resume`);
    expect(again.status).toBe(409);
    expect(again.json.error).toContain("já está em andamento");
  });

  test("409 when done; 404 when unknown", async () => {
    const h = harness();
    const ana = seedLead(h.coreDb, "Ana", "5581999990001@s.whatsapp.net", 1);
    const { jobId } = await pausedCampaign(h, [ana]);
    setCampaignStatus(h.waDb, jobId, "done");
    const res = await call(h.router, "POST", `/api/wa/campaign/${jobId}/resume`);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("já terminou");
    expect((await call(h.router, "POST", "/api/wa/campaign/cmpnope/resume")).status).toBe(404);
  });

  test("409 without a connected socket (campaign stays paused)", async () => {
    const h = harness();
    const ana = seedLead(h.coreDb, "Ana", "5581999990001@s.whatsapp.net", 1);
    const { instance, jobId } = await pausedCampaign(h, [ana]);
    h.fake.cb(instance).onClose!("428", false, 428, "caiu");
    const res = await call(h.router, "POST", `/api/wa/campaign/${jobId}/resume`);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("Nenhum WhatsApp conectado");
    expect((await call(h.router, "GET", `/api/wa/campaign/${jobId}`)).json.status).toBe("paused");
  });

  test("409 when another campaign is running on the instance", async () => {
    const h = harness();
    const ana = seedLead(h.coreDb, "Ana", "5581999990001@s.whatsapp.net", 1);
    const bia = seedLead(h.coreDb, "Bia", "5581999990002@s.whatsapp.net", 1);
    const { instance, jobId } = await pausedCampaign(h, [ana]);
    h.fake.sock(instance).sendMessage = NEVER;
    const other = await call(h.router, "POST", "/api/wa/campaign", { instance, lead_ids: [bia], template: "oi" });
    expect(other.status).toBe(202);
    const res = await call(h.router, "POST", `/api/wa/campaign/${jobId}/resume`);
    expect(res.status).toBe(409);
    expect(res.json.job_id).toBe(other.json.job_id);
  });

  test("409 when a validation is running on the instance", async () => {
    const h = harness();
    const ana = seedLead(h.coreDb, "Ana", "5581999990001@s.whatsapp.net", 1);
    const pending = seedLead(h.coreDb, "Pendente", null, null, "+55 11 99999-8888");
    const { instance, jobId } = await pausedCampaign(h, [ana]);
    h.fake.sock(instance).onWhatsApp = NEVER; // the validation stays inside the lookup
    const val = await call(h.router, "POST", "/api/wa/validate", { instance, lead_ids: [pending] });
    expect(val.status).toBe(202);
    const res = await call(h.router, "POST", `/api/wa/campaign/${jobId}/resume`);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("validação em andamento");
  });

  test("409 inside quiet hours (the runner would only pause again)", async () => {
    // 02:00 UTC = 23:00 America/Sao_Paulo → inside 21:00–08:00.
    const h = harness({ quiet: true, now: () => new Date("2026-10-12T02:00:00Z") });
    const ana = seedLead(h.coreDb, "Ana", "5581999990001@s.whatsapp.net", 1);
    const { instance, jobId } = await pausedCampaign(h, [ana]);
    const res = await call(h.router, "POST", `/api/wa/campaign/${jobId}/resume`);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("Horário de silêncio");
    expect(h.fake.sock(instance).sentMessages).toHaveLength(0);
  });

  test("a non-JSON Content-Type is refused (415)", async () => {
    const h = harness();
    const ana = seedLead(h.coreDb, "Ana", "5581999990001@s.whatsapp.net", 1);
    const { jobId } = await pausedCampaign(h, [ana]);
    const req = new Request(`http://localhost/api/wa/campaign/${jobId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });
    expect((await h.router.handle(req, new URL(req.url))).status).toBe(415);
  });
});

describe("auto-start of paired instances on boot", () => {
  function managerOn(db: Database): { manager: WaManager; fake: FakeConnect } {
    const fake = makeFakeConnect();
    return { manager: new WaManager({ db, config: openConfig(), connect: fake.connect }), fake };
  }

  test("starts only paired, non-blocked instances, staggered", async () => {
    const db = openWaDb(":memory:");
    createInstance(db, { id: "paired-a" });
    createInstance(db, { id: "unpaired" });
    createInstance(db, { id: "paired-b" });
    createInstance(db, { id: "blocked" });
    seedPairedCreds(db, "paired-a");
    seedPairedCreds(db, "paired-b");
    seedPairedCreds(db, "blocked");
    const { manager: first } = managerOn(db);
    first.start("blocked");
    first.disconnect("blocked"); // manual disconnect persists a block

    const { manager, fake } = managerOn(db);
    expect(manager.autoStartPaired({ staggerMs: 80 })).toEqual(["paired-a", "paired-b"]);
    await tick(20);
    expect([...fake.instances.keys()]).toEqual(["paired-a"]); // the second waits its turn
    await tick(120);
    expect([...fake.instances.keys()]).toEqual(["paired-a", "paired-b"]); // never a QR socket for 'unpaired'
    expect(manager.runtime("blocked").reason).toBe("Desconectado manualmente.");
  });

  test("a terminal close blocks the next boot; a successful open clears it", async () => {
    const db = openWaDb(":memory:");
    createInstance(db, { id: "acc" });
    seedPairedCreds(db, "acc");
    const { manager: before, fake: f1 } = managerOn(db);
    before.start("acc");
    const detail = "Sessão substituída (440): esta conta foi aberta em outro lugar. Reconecte manualmente.";
    f1.cb("acc").onClose!("440", false, 440, detail);
    expect(getState(db, "autostart_block@acc")).toBe(detail);

    const { manager: after, fake: f2 } = managerOn(db);
    expect(after.autoStartPaired({ staggerMs: 0 })).toEqual([]);
    expect(after.runtime("acc")).toMatchObject({ status: "disconnected", reason: detail });
    expect(f2.instances.size).toBe(0);

    after.reconnect("acc"); // the user reconnects by hand
    f2.cb("acc").onOpen!("5511@s.whatsapp.net");
    expect(getState(db, "autostart_block@acc")).toBe("");
    const { manager: third } = managerOn(db);
    expect(third.autoStartPaired({ staggerMs: 0 })).toEqual(["acc"]);
  });

  test("the router auto-starts only when asked (tests stay socket-free by default)", async () => {
    const waDb = openWaDb(":memory:");
    const coreDb = openDb(":memory:");
    createInstance(waDb, { id: "acc" });
    seedPairedCreds(waDb, "acc");

    const off = makeFakeConnect();
    createWaRouter({ waDb, coreDb, config: openConfig(), manager: new WaManager({ db: waDb, connect: off.connect }) });
    await tick(20);
    expect(off.instances.size).toBe(0);

    const on = makeFakeConnect();
    createWaRouter({
      waDb,
      coreDb,
      config: openConfig(),
      manager: new WaManager({ db: waDb, connect: on.connect }),
      autoStart: { staggerMs: 0 },
    });
    await tick(20);
    expect([...on.instances.keys()]).toEqual(["acc"]);
  });
});
