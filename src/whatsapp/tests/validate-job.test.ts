import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../db/index.ts";
import type { WaConfig } from "../config.ts";
import { openWaDb } from "../db.ts";
import { createInstance } from "../instances.ts";
import { WaManager } from "../manager.ts";
import { phoneToUser, type OnWhatsAppSocket } from "../resolver.ts";
import { createWaRouter, type WaRouter } from "../routes.ts";
import { createValidateJob, getValidateJob, runValidateJob, type ValidateRunnerDeps } from "../validate-job.ts";
import { makeFakeConnect, type FakeConnect } from "./_fakes.ts";

const MIDDAY = new Date("2026-08-20T15:00:00Z"); // outside quiet hours (12:00 SP)

function openConfig(): WaConfig {
  return {
    quiet_hours: { enabled: false, start: "21:00", end: "08:00", timezone: "America/Sao_Paulo" },
    rate_limit: { max_per_minute: 1000, max_per_hour: 1000, min_interval_seconds: 0, jitter_seconds: 0 },
    validation: { max_batch_size: 20 },
  };
}

function seedCore(): Database {
  const db = openDb(":memory:");
  db.query(
    `INSERT INTO searches (query_normalized, niche, city, gl, hl, created_at) VALUES ('x','n','c','br','pt-br',?)`,
  ).run(new Date().toISOString());
  return db;
}

function seedLead(db: Database, name: string, phone: string | null): number {
  const res = db
    .query(
      `INSERT INTO leads (search_id, place_id, name, phone, source, collected_at) VALUES (1, ?, ?, ?, 'serper:places', ?)`,
    )
    .run(`p-${name}-${Math.random()}`, name, phone, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

/** Inline onWhatsApp mock: only `registry` numbers come back (matched by jid). */
function mockSocket(registry: string[]): { sock: OnWhatsAppSocket; calls: string[][] } {
  const calls: string[][] = [];
  const set = new Set(registry);
  return {
    calls,
    sock: {
      onWhatsApp: async (...numbers) => {
        calls.push(numbers);
        return numbers.filter((n) => set.has(n)).map((n) => ({ jid: `${n}@s.whatsapp.net`, exists: true }));
      },
    },
  };
}

function deps(waDb: Database, coreDb: Database, getSocket: () => OnWhatsAppSocket | null): ValidateRunnerDeps {
  return {
    waDb,
    coreDb,
    config: openConfig(),
    getSocket,
    sleep: async () => {},
    now: () => MIDDAY,
    random: () => 0,
  };
}

function leadWa(coreDb: Database, leadId: number): { is_whatsapp: number | null; whatsapp_jid: string | null } {
  return coreDb.query("SELECT is_whatsapp, whatsapp_jid FROM leads WHERE id = ?").get(leadId) as {
    is_whatsapp: number | null;
    whatsapp_jid: string | null;
  };
}

describe("runValidateJob (reuses validateLeadsCore)", () => {
  test("validates leads matched by jid; writes is_whatsapp to the core db", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const a = seedLead(coreDb, "Ana", "+55 11 99999-8888"); // 5511999998888 (mobile)
    const b = seedLead(coreDb, "Bia", "+55 11 3333-4444"); // 551133334444 (landline, not registered)
    const { sock } = mockSocket(["5511999998888"]);
    const job = createValidateJob(waDb, coreDb, { instanceId: "waalpha", leadIds: [a, b] });

    await runValidateJob(job, deps(waDb, coreDb, () => sock));

    const view = getValidateJob(waDb, job)!;
    expect(view.status).toBe("done");
    expect(view).toMatchObject({ total: 2, checked: 2, is_whatsapp: 1, not_whatsapp: 1, ambiguous: 0, failed: 0 });
    const byLead = Object.fromEntries(view.results.map((r) => [r.lead_id, r]));
    expect(byLead[a]).toMatchObject({ is_whatsapp: true, jid: "5511999998888@s.whatsapp.net" });
    expect(byLead[b]!.is_whatsapp).toBe(false);
    // persisted to the core db
    expect(leadWa(coreDb, a)).toEqual({ is_whatsapp: 1, whatsapp_jid: "5511999998888@s.whatsapp.net" });
    expect(leadWa(coreDb, b)).toEqual({ is_whatsapp: 0, whatsapp_jid: null });
  });

  test("ninth-digit: a 12-digit mobile resolves to the canonical 13-digit jid", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const id = seedLead(coreDb, "Ciro", "551199998888"); // 12-digit mobile → variant adds the 9
    const { sock, calls } = mockSocket(["5511999998888"]); // only the 13-digit exists
    const job = createValidateJob(waDb, coreDb, { instanceId: "waalpha", leadIds: [id] });

    await runValidateJob(job, deps(waDb, coreDb, () => sock));

    // both variants queried in one round-trip
    expect(calls[0]).toEqual(["551199998888", "5511999998888"]);
    expect(leadWa(coreDb, id)).toEqual({ is_whatsapp: 1, whatsapp_jid: "5511999998888@s.whatsapp.net" });
  });

  test("AMBIGUOUS (both ninth-digit variants exist) → not written, flagged for humans", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const id = seedLead(coreDb, "Duda", "5511999998888");
    const { sock } = mockSocket(["5511999998888", "551199998888"]); // BOTH exist
    const job = createValidateJob(waDb, coreDb, { instanceId: "waalpha", leadIds: [id] });

    await runValidateJob(job, deps(waDb, coreDb, () => sock));

    const view = getValidateJob(waDb, job)!;
    expect(view.ambiguous).toBe(1);
    expect(view.results[0]!.is_whatsapp).toBeNull(); // no guess
    expect(view.results[0]!.reason).toContain("duas contas distintas");
    expect(leadWa(coreDb, id)).toEqual({ is_whatsapp: null, whatsapp_jid: null }); // never written
  });

  test("lead without a phone → skipped", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const id = seedLead(coreDb, "SemFone", null);
    const { sock, calls } = mockSocket([]);
    const job = createValidateJob(waDb, coreDb, { instanceId: "waalpha", leadIds: [id] });
    await runValidateJob(job, deps(waDb, coreDb, () => sock));
    const view = getValidateJob(waDb, job)!;
    expect(view.results[0]!.is_whatsapp).toBeNull();
    expect(calls).toHaveLength(0); // no lookup for a lead without a phone
  });

  test("no connected socket → job paused, leads stay queued for a resume", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const id = seedLead(coreDb, "Ana", "+55 11 99999-8888");
    const job = createValidateJob(waDb, coreDb, { instanceId: "waalpha", leadIds: [id] });
    await runValidateJob(job, deps(waDb, coreDb, () => null));
    const view = getValidateJob(waDb, job)!;
    expect(view.status).toBe("paused");
    expect(view.reason).toBe("instância não conectada");
    expect(view.checked).toBe(0);
    expect(view.results[0]).toEqual({ lead_id: id, phone: "+55 11 99999-8888", is_whatsapp: null });
  });

  // A validation-rate config small enough that a handful of leads cannot fit in
  // one minute — forces the runner to pace across windows.
  function drainConfig(): WaConfig {
    return {
      quiet_hours: { enabled: false, start: "21:00", end: "08:00", timezone: "America/Sao_Paulo" },
      rate_limit: { max_per_minute: 1000, max_per_hour: 1000, min_interval_seconds: 0, jitter_seconds: 0 },
      validation_rate: { max_per_minute: 2, max_per_hour: 1000, min_interval_seconds: 1, jitter_seconds: 0 },
      validation: { max_batch_size: 20 },
    };
  }

  test("auto-drain: a job larger than the per-minute rate finishes on its own", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const phones = [
      "+55 11 99999-0001",
      "+55 11 99999-0002",
      "+55 11 99999-0003",
      "+55 11 99999-0004",
      "+55 11 99999-0005",
    ];
    const ids = phones.map((p, i) => seedLead(coreDb, `Lead ${i}`, p));
    // Register only the 13-digit form of each → each is a clean "exists".
    const registry = phones.map((p) => phoneToUser(p)!);
    const { sock, calls } = mockSocket(registry);
    const job = createValidateJob(waDb, coreDb, { instanceId: "waalpha", leadIds: ids });

    let nowMs = MIDDAY.getTime();
    const startMs = nowMs;
    const sleeps: number[] = [];
    // Advancing clock: sleep() moves time forward, so the rate-limit window
    // eventually frees and the drain can resume — no re-trigger.
    await runValidateJob(job, {
      waDb,
      coreDb,
      config: drainConfig(),
      getSocket: () => sock,
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      random: () => 0,
    });

    const view = getValidateJob(waDb, job)!;
    expect(view.status).toBe("done"); // drained to completion on its own
    expect(view.checked).toBe(5);
    expect(view.is_whatsapp).toBe(5);
    expect(calls.length).toBe(5); // exactly one lookup per lead

    // Paced: five leads at 2/min cannot fit in a single minute, so the clock
    // must have advanced past one minute.
    expect(nowMs - startMs).toBeGreaterThan(60_000);

    // Rate respected: no 60s sliding window ever held more than max_per_minute.
    const times = (
      waDb.query("SELECT created_at FROM wa_actions ORDER BY created_at").all() as { created_at: string }[]
    ).map((r) => new Date(r.created_at).getTime());
    for (const t of times) {
      const within = times.filter((u) => u > t - 60_000 && u <= t).length;
      expect(within).toBeLessThanOrEqual(2);
    }

    // Jitter maintained between consecutive lookups (min_interval 1s → 1000ms).
    expect(sleeps).toContain(1000);
  });

  test("instance disconnects mid-drain → paused with reason, no loop", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const phones = [
      "+55 11 98888-0001",
      "+55 11 98888-0002",
      "+55 11 98888-0003",
      "+55 11 98888-0004",
      "+55 11 98888-0005",
    ];
    const ids = phones.map((p, i) => seedLead(coreDb, `Lead ${i}`, p));
    const { sock } = mockSocket(phones.map((p) => phoneToUser(p)!));
    const job = createValidateJob(waDb, coreDb, { instanceId: "waalpha", leadIds: ids });

    let nowMs = MIDDAY.getTime();
    // Socket answers the first drain iteration, then the instance drops.
    let live = 1;
    await runValidateJob(job, {
      waDb,
      coreDb,
      config: drainConfig(),
      getSocket: () => (live-- > 0 ? sock : null),
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
      },
      random: () => 0,
    });

    const view = getValidateJob(waDb, job)!;
    expect(view.status).toBe("paused");
    expect(view.reason).toBe("instância não conectada");
    // Some leads were validated before the drop; the rest stay queued (not
    // failed), so a resume continues exactly where it stopped.
    expect(view.is_whatsapp).toBe(2);
    expect(view.failed).toBe(0);
    expect(view.checked).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface Harness {
  router: WaRouter;
  fake: FakeConnect;
  waDb: Database;
  coreDb: Database;
}

function harness(): Harness {
  const waDb = openWaDb(":memory:");
  const coreDb = seedCore();
  const fake = makeFakeConnect();
  const manager = new WaManager({ db: waDb, config: openConfig(), connect: fake.connect });
  const router = createWaRouter({ waDb, coreDb, config: openConfig(), manager });
  return { router, fake, waDb, coreDb };
}

async function call(router: WaRouter, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const req = new Request(`http://localhost${path}`, init);
  const res = await router.handle(req, new URL(req.url));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function poll(router: WaRouter, jobId: string, want: string, tries = 40): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const r = await call(router, "GET", `/api/wa/validate/${jobId}`);
    if (r.json?.status === want) return r.json;
    await new Promise((res) => setTimeout(res, 10));
  }
  return (await call(router, "GET", `/api/wa/validate/${jobId}`)).json;
}

describe("/api/wa/validate routes", () => {
  test("POST creates a job; GET evolves to done with counts", async () => {
    const { router, fake, coreDb } = harness();
    const id = (await call(router, "POST", "/api/wa/instances")).json.id;
    fake.cb(id).onOpen!("5599@s.whatsapp.net");
    fake.sock(id).onWhatsAppRegistry.add("5511999998888");
    const lead = seedLead(coreDb, "Ana", "+55 11 99999-8888");

    const created = await call(router, "POST", "/api/wa/validate", { instance: id, lead_ids: [lead] });
    expect(created.status).toBe(202);
    expect(created.json.job_id).toMatch(/^val[0-9a-f]{12}$/);

    const done = await poll(router, created.json.job_id, "done");
    expect(done).toMatchObject({ total: 1, checked: 1, is_whatsapp: 1 });
    expect(done.results[0]).toMatchObject({ lead_id: lead, is_whatsapp: true });
  });

  test("POST without a connected instance → 409 with a clear PT-BR message", async () => {
    const { router, coreDb } = harness();
    const id = (await call(router, "POST", "/api/wa/instances")).json.id; // created, not opened
    const lead = seedLead(coreDb, "Ana", "+55 11 99999-8888");
    const res = await call(router, "POST", "/api/wa/validate", { instance: id, lead_ids: [lead] });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("Nenhum WhatsApp conectado");
  });

  test("empty lead_ids → 400; unknown job → 404", async () => {
    const { router, fake } = harness();
    const id = (await call(router, "POST", "/api/wa/instances")).json.id;
    fake.cb(id).onOpen!("5599@s.whatsapp.net");
    expect((await call(router, "POST", "/api/wa/validate", { instance: id, lead_ids: [] })).status).toBe(400);
    expect((await call(router, "GET", "/api/wa/validate/valnope")).status).toBe(404);
  });
});
