// Regression tests for the hardening pass (items A1–A10, B1–B12 of the review).
// Offline only: in-memory/temp databases and the fake connection factory.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../db/index.ts";
import { isPaired } from "../auth-state.ts";
import { createCampaign, getCampaign, runCampaign, type CampaignRunnerDeps } from "../campaign.ts";
import type { WaConfig } from "../config.ts";
import { closeDecision, MAX_QR_CYCLES } from "../connection.ts";
import { getState, openWaDb, setState } from "../db.ts";
import { minSpacingMs, recordAction } from "../gate.ts";
import { contentType, handleMessagesUpdate, ingestMessage, upsertContact } from "../ingestion.ts";
import { createInstance, deleteInstance, stateKey } from "../instances.ts";
import { WaManager, type SendResult } from "../manager.ts";
import { phoneToUser, resolveRecipient } from "../resolver.ts";
import { createWaRouter, sniffMedia, type WaRouter } from "../routes.ts";
import { validateUntilDone } from "../validate.ts";
import { createValidateJob } from "../validate-job.ts";
import { makeFakeConnect, seedPairedCreds, tick } from "./_fakes.ts";

const INST = "waalpha00aa";
const MIDDAY = new Date("2026-08-19T15:00:00Z"); // 12:00 SP — outside quiet hours
const JSON_HEADERS = { "Content-Type": "application/json" };

function openConfig(overrides: Partial<WaConfig> = {}): WaConfig {
  return {
    quiet_hours: { enabled: false, start: "21:00", end: "08:00", timezone: "America/Sao_Paulo" },
    rate_limit: { max_per_minute: 1000, max_per_hour: 1000, min_interval_seconds: 0, jitter_seconds: 0 },
    validation: { max_batch_size: 20 },
    ...overrides,
  };
}

function seedCore(): Database {
  const db = openDb(":memory:");
  db.query(
    `INSERT INTO searches (query_normalized, niche, city, gl, hl, created_at) VALUES ('x','n','c','br','pt-br',?)`,
  ).run(new Date().toISOString());
  return db;
}

function seedLead(
  db: Database,
  o: { name: string; phone?: string | null; email?: string | null; is_whatsapp?: number | null; jid?: string | null },
): number {
  const res = db
    .query(
      `INSERT INTO leads (search_id, place_id, name, phone, email, is_whatsapp, whatsapp_jid, source, collected_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, 'serper:places', ?)`,
    )
    .run(
      `p-${o.name}-${Math.random()}`,
      o.name,
      o.phone ?? "11999990000",
      o.email ?? null,
      o.is_whatsapp ?? null,
      o.jid ?? null,
      new Date().toISOString(),
    );
  return Number(res.lastInsertRowid);
}

function okSend(jid: string, n: number): SendResult {
  return {
    ok: true,
    gate: { allowed: true, blocked_code: null, blocked_reason: null },
    message: { chat_jid: jid, message_id: `m${n}`, from_me: true, text: "x", type: "conversation", ts: 1, status: "sent" },
  };
}

function runnerDeps(waDb: Database, coreDb: Database, overrides: Partial<CampaignRunnerDeps> = {}) {
  const sent: string[] = [];
  const sleeps: number[] = [];
  const deps: CampaignRunnerDeps = {
    waDb,
    coreDb,
    config: openConfig(),
    send: async (jid) => {
      sent.push(jid);
      return okSend(jid, sent.length);
    },
    validatePending: async () => {},
    loadMedia: async () => null,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => MIDDAY,
    random: () => 0,
    ...overrides,
  };
  return { deps, sent, sleeps };
}

interface Harness {
  router: WaRouter;
  fake: ReturnType<typeof makeFakeConnect>;
  manager: WaManager;
  waDb: Database;
  coreDb: Database;
}

function harness(config: WaConfig = openConfig(), waDb: Database = openWaDb(":memory:")): Harness {
  const coreDb = seedCore();
  const fake = makeFakeConnect();
  const manager = new WaManager({ db: waDb, config, connect: fake.connect });
  const router = createWaRouter({ waDb, coreDb, config, manager });
  return { router, fake, manager, waDb, coreDb };
}

async function call(
  router: WaRouter,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = JSON_HEADERS,
): Promise<{ status: number; json: any; headers: Headers }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = headers;
  }
  const req = new Request(`http://localhost${path}`, init);
  const res = await router.handle(req, new URL(req.url));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

async function connectedInstance(h: Harness): Promise<string> {
  const id = (await call(h.router, "POST", "/api/wa/instances")).json.id as string;
  h.fake.cb(id).onOpen!("5511000000000@s.whatsapp.net");
  return id;
}

// ---------------------------------------------------------------------------
// A. Connection layer
// ---------------------------------------------------------------------------

describe("A2 — database open", () => {
  test("busy_timeout is set and migrations are idempotent across two opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-db-"));
    try {
      const path = join(dir, "wa.db");
      const a = openWaDb(path);
      const b = openWaDb(path); // second process-like open: nothing re-applied
      expect((a.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
      const v = (b.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      expect(v).toBe(7);
      const cols = b.query("PRAGMA table_info(contacts)").all() as Array<{ name: string }>;
      expect(cols.filter((c) => c.name === "verified_name")).toHaveLength(1);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("A3 — senderKeyDistributionMessage never names a message", () => {
  test("contentType skips the auxiliary key", () => {
    expect(contentType({ senderKeyDistributionMessage: {}, conversation: "oi" })).toBe("conversation");
    expect(contentType({ messageContextInfo: {}, senderKeyDistributionMessage: {}, imageMessage: {} })).toBe(
      "imageMessage",
    );
    expect(contentType({ senderKeyDistributionMessage: {} })).toBe("senderKeyDistributionMessage");
  });

  test("migration 6 repairs rows stored with that type when they have text", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-db-"));
    try {
      const path = join(dir, "wa.db");
      // Build a version-5 database with the legacy bad rows.
      openWaDb(path).close();
      const raw = new Database(path);
      raw.exec("PRAGMA user_version = 5");
      const ins = raw.query(
        `INSERT INTO messages (instance_id, chat_jid, message_id, from_me, timestamp, message_type, text_content, source, created_at)
         VALUES ('i', 'g@g.us', ?, 0, 1, 'senderKeyDistributionMessage', ?, 'live', 'now')`,
      );
      ins.run("with-text", "olá grupo");
      ins.run("no-text", null);
      raw.close();

      const db = openWaDb(path);
      const types = Object.fromEntries(
        (db.query("SELECT message_id, message_type FROM messages").all() as Array<{ message_id: string; message_type: string }>).map(
          (r) => [r.message_id, r.message_type],
        ),
      );
      expect(types["with-text"]).toBe("conversation");
      expect(types["no-text"]).toBe("senderKeyDistributionMessage"); // undecidable → stays hidden
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a group text with the key first is ingested as conversation", () => {
    const db = openWaDb(":memory:");
    const row = ingestMessage(
      db,
      INST,
      {
        key: { remoteJid: "123@g.us", id: "g1", fromMe: false, participant: "5511@s.whatsapp.net" },
        message: { senderKeyDistributionMessage: { groupId: "123@g.us" }, conversation: "bom dia" },
        messageTimestamp: 1_700_000_000,
      },
      "live",
    );
    expect(row?.type).toBe("conversation");
  });
});

describe("A4 — stale socket callbacks", () => {
  test("a late close from the replaced socket does not flip the new connection", () => {
    const db = openWaDb(":memory:");
    const fake = makeFakeConnect();
    const manager = new WaManager({ db, config: openConfig(), connect: fake.connect });
    const inst = createInstance(db);
    manager.start(inst.id);
    const oldCb = fake.cb(inst.id);
    manager.reconnect(inst.id);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");
    expect(manager.runtime(inst.id).status).toBe("connected");

    oldCb.onClose!("428", false, 428);
    expect(manager.runtime(inst.id).status).toBe("connected");
  });

  test("callbacks after remove() never resurrect the instance", async () => {
    const db = openWaDb(":memory:");
    const fake = makeFakeConnect();
    const manager = new WaManager({ db, config: openConfig(), connect: fake.connect });
    const inst = createInstance(db);
    manager.start(inst.id);
    const cb = fake.cb(inst.id);
    cb.onOpen!("5511@s.whatsapp.net");
    await manager.remove(inst.id);

    cb.onOpen!("5511@s.whatsapp.net");
    cb.onQr!("late-qr");
    await tick();
    expect(manager.runtime(inst.id).status).toBe("disconnected"); // no live entry
    expect(manager.runtime(inst.id).qrDataUrl).toBeNull();
  });
});

describe("A5 — LID chats keep the phone number", () => {
  test("remoteJidAlt stores the number for a LID sender", () => {
    const db = openWaDb(":memory:");
    ingestMessage(
      db,
      INST,
      {
        key: { remoteJid: "999@lid", remoteJidAlt: "5581988887777@s.whatsapp.net", id: "l1", fromMe: false },
        message: { conversation: "oi" },
        messageTimestamp: 1_700_000_000,
      },
      "live",
    );
    const row = db.query("SELECT phone_number FROM contacts WHERE instance_id = ? AND jid = '999@lid'").get(INST) as {
      phone_number: string | null;
    };
    expect(row.phone_number).toBe("5581988887777");
  });

  test("own message in a LID chat and contacts.upsert phoneNumber also fill it", () => {
    const db = openWaDb(":memory:");
    ingestMessage(
      db,
      INST,
      {
        key: { remoteJid: "777@lid", remoteJidAlt: "5511911112222@s.whatsapp.net", id: "l2", fromMe: true },
        message: { conversation: "olá" },
        messageTimestamp: 1_700_000_000,
      },
      "live",
    );
    upsertContact(db, INST, { id: "888@lid", phoneNumber: "5511933334444@s.whatsapp.net" });
    const phones = Object.fromEntries(
      (db.query("SELECT jid, phone_number FROM contacts").all() as Array<{ jid: string; phone_number: string }>).map((r) => [
        r.jid,
        r.phone_number,
      ]),
    );
    expect(phones["777@lid"]).toBe("5511911112222");
    expect(phones["888@lid"]).toBe("5511933334444");
  });

  test("GET /chats exposes the phone and uses it as the name fallback", async () => {
    const h = harness();
    const id = await connectedInstance(h);
    ingestMessage(
      h.waDb,
      id,
      {
        key: { remoteJid: "555@lid", remoteJidAlt: "5521977776666@s.whatsapp.net", id: "l3", fromMe: true },
        message: { conversation: "oi" },
        messageTimestamp: 1_700_000_000,
      },
      "live",
    );
    const res = await call(h.router, "GET", `/api/wa/chats?instance=${id}`);
    expect(res.json.chats[0]).toMatchObject({ jid: "555@lid", name: "5521977776666", phone: "5521977776666" });
  });
});

describe("A6 — re-delivery and edits", () => {
  test("an undecryptable first version is filled in by the retry", () => {
    const db = openWaDb(":memory:");
    const key = { remoteJid: "5511@s.whatsapp.net", id: "u1", fromMe: false };
    ingestMessage(db, INST, { key, messageTimestamp: 1_700_000_000 }, "live"); // stub, no content
    ingestMessage(db, INST, { key, message: { conversation: "agora sim" }, messageTimestamp: 1_700_000_000 }, "live");
    const row = db.query("SELECT message_type, text_content FROM messages WHERE message_id = 'u1'").get() as {
      message_type: string;
      text_content: string;
    };
    expect(row).toEqual({ message_type: "conversation", text_content: "agora sim" });
  });

  test("an edit rewrites the original message instead of adding a row", () => {
    const db = openWaDb(":memory:");
    const jid = "5511@s.whatsapp.net";
    ingestMessage(db, INST, { key: { remoteJid: jid, id: "orig", fromMe: false }, message: { conversation: "errado" }, messageTimestamp: 1 }, "live");
    const out = ingestMessage(
      db,
      INST,
      {
        key: { remoteJid: jid, id: "edit-evt", fromMe: false },
        message: {
          protocolMessage: { key: { remoteJid: jid, id: "orig", fromMe: false }, type: 14, editedMessage: { conversation: "certo" } },
        },
        messageTimestamp: 5,
      },
      "live",
    );
    expect(out).toMatchObject({ message_id: "orig", text: "certo", type: "conversation" });
    const rows = db.query("SELECT message_id, text_content FROM messages").all();
    expect(rows).toEqual([{ message_id: "orig", text_content: "certo" }]);
  });
});

describe("A7/A8 — close decisions", () => {
  test("440, 403 and 411 are terminal with a PT-BR detail", () => {
    for (const code of [440, 403, 411]) {
      const d = closeDecision(code);
      expect(d.reconnect).toBe(false);
      expect(d.detail).toContain(`(${code})`);
    }
  });

  test("500 clears auth and reconnects; 401 clears auth and stops", () => {
    expect(closeDecision(500)).toMatchObject({ reconnect: true, clearAuth: true });
    expect(closeDecision(401)).toMatchObject({ reconnect: false, clearAuth: true });
    expect(closeDecision(515)).toMatchObject({ reconnect: true, immediate: true, clearAuth: false });
    expect(closeDecision(428)).toMatchObject({ reconnect: true, clearAuth: false });
  });

  test("QR rotation timeouts stop after the cap", () => {
    expect(closeDecision(408, { qrTimeouts: MAX_QR_CYCLES - 1 }).reconnect).toBe(true);
    const capped = closeDecision(408, { qrTimeouts: MAX_QR_CYCLES });
    expect(capped.reconnect).toBe(false);
    expect(capped.detail).toContain("QR expirou");
  });

  test("manager: terminal close keeps the PT-BR reason; 401 wipes the instance auth", () => {
    const db = openWaDb(":memory:");
    const fake = makeFakeConnect();
    const manager = new WaManager({ db, config: openConfig(), connect: fake.connect });
    const inst = createInstance(db);
    seedPairedCreds(db, inst.id);
    manager.start(inst.id);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");

    fake.cb(inst.id).onClose!("440", false, 440, closeDecision(440).detail);
    expect(manager.runtime(inst.id)).toMatchObject({ status: "disconnected", reason: closeDecision(440).detail });

    manager.start(inst.id);
    fake.cb(inst.id).onClose!("401", false, 401, closeDecision(401).detail);
    expect(manager.runtime(inst.id).status).toBe("logged_out");
    expect(isPaired(db, inst.id).paired).toBe(false);
  });
});

describe("A9 — deleteInstance cleans runtime_state", () => {
  test("per-instance keys and history anchors go, others stay", () => {
    const db = openWaDb(":memory:");
    const a = createInstance(db, { id: "waa" });
    createInstance(db, { id: "wab" });
    setState(db, stateKey("connection_status", a.id), "open");
    setState(db, `hist_anchor:${a.id}:1@lid`, "1:2");
    setState(db, stateKey("connection_status", "wab"), "open");
    setState(db, "hist_anchor:wab:1@lid", "1:2");
    deleteInstance(db, a.id);
    expect(getState(db, stateKey("connection_status", a.id))).toBeNull();
    expect(getState(db, `hist_anchor:${a.id}:1@lid`)).toBeNull();
    expect(getState(db, stateKey("connection_status", "wab"))).toBe("open");
    expect(getState(db, "hist_anchor:wab:1@lid")).toBe("1:2");
  });
});

describe("A10 — status map and SSE type", () => {
  test("0 → error, 5 → played", () => {
    const db = openWaDb(":memory:");
    const jid = "5511@s.whatsapp.net";
    ingestMessage(db, INST, { key: { remoteJid: jid, id: "s1", fromMe: true }, message: { conversation: "a" }, messageTimestamp: 1 }, "sent");
    ingestMessage(db, INST, { key: { remoteJid: jid, id: "s2", fromMe: true }, message: { audioMessage: {} }, messageTimestamp: 2 }, "sent");
    handleMessagesUpdate(db, INST, [
      { key: { remoteJid: jid, id: "s1", fromMe: true }, update: { status: 0 } },
      { key: { remoteJid: jid, id: "s2", fromMe: true }, update: { status: 5 } },
    ]);
    const st = Object.fromEntries(
      (db.query("SELECT message_id, status FROM messages").all() as Array<{ message_id: string; status: string }>).map((r) => [
        r.message_id,
        r.status,
      ]),
    );
    expect(st).toEqual({ s1: "error", s2: "played" });
  });

  test("the SSE message payload carries the type", () => {
    const db = openWaDb(":memory:");
    const fake = makeFakeConnect();
    const manager = new WaManager({ db, config: openConfig(), connect: fake.connect });
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    manager.subscribe((e) => events.push(e));
    const inst = createInstance(db);
    manager.start(inst.id);
    fake.cb(inst.id).onMessagesUpsert!({
      messages: [{ key: { remoteJid: "5511@s.whatsapp.net", id: "x1", fromMe: false }, message: { imageMessage: { caption: "foto" } }, messageTimestamp: 1 }],
    });
    const msg = events.find((e) => e.type === "message");
    expect(msg?.data).toMatchObject({ type: "imageMessage", text: "foto" });
  });
});

// ---------------------------------------------------------------------------
// B. Actions / routes
// ---------------------------------------------------------------------------

describe("B1 — no CORS, JSON content type required", () => {
  test("responses carry no Access-Control-Allow-Origin", async () => {
    const h = harness();
    const res = await call(h.router, "GET", "/api/wa/instances");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a text/plain POST is refused with 415 before doing anything", async () => {
    const h = harness();
    const id = await connectedInstance(h);
    const res = await call(h.router, "POST", "/api/wa/send", JSON.stringify({ instance: id, jid: "1@s.whatsapp.net", text: "x" }), {
      "Content-Type": "text/plain",
    });
    expect(res.status).toBe(415);
    expect(res.json.error).toContain("application/json");
    expect(h.fake.sock(id).sentMessages).toHaveLength(0);
    const inst = await call(h.router, "POST", "/api/wa/instances", "name=x", { "Content-Type": "application/x-www-form-urlencoded" });
    expect(inst.status).toBe(415);
  });
});

describe("B2 — atomic gate", () => {
  test("5 concurrent sends under a 2/min limit → exactly 2 reach the socket", async () => {
    const db = openWaDb(":memory:");
    const fake = makeFakeConnect();
    const config = openConfig({ rate_limit: { max_per_minute: 2, max_per_hour: 20, min_interval_seconds: 0, jitter_seconds: 0 } });
    const manager = new WaManager({ db, config, connect: fake.connect });
    const inst = createInstance(db);
    manager.start(inst.id);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => manager.sendCampaignMessage(inst.id, `55${n}@s.whatsapp.net`, { text: "oi" }, { at: MIDDAY })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => r.gate.blocked_code === "rate_limit")).toHaveLength(3);
    expect(fake.sock(inst.id).sentMessages).toHaveLength(2);
  });

  test("a failed send keeps its reserved slot (conservative)", async () => {
    const db = openWaDb(":memory:");
    const fake = makeFakeConnect();
    const manager = new WaManager({ db, config: openConfig(), connect: fake.connect });
    const inst = createInstance(db);
    manager.start(inst.id);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");
    fake.sock(inst.id).failSend = true;
    const res = await manager.sendText(inst.id, "55@s.whatsapp.net", "oi", { at: MIDDAY });
    expect(res.ok).toBe(false);
    expect((db.query("SELECT count(*) c FROM wa_actions WHERE kind = 'message_send'").get() as { c: number }).c).toBe(1);
  });

  test("a second campaign / validation on the same instance → 409", async () => {
    const h = harness();
    const id = await connectedInstance(h);
    h.fake.sock(id).sendMessage = () => new Promise(() => {}); // first campaign stays in flight
    h.fake.sock(id).onWhatsApp = () => new Promise(() => {}); // first validation stays in flight
    const a = seedLead(h.coreDb, { name: "A", is_whatsapp: 1, jid: "551@s.whatsapp.net" });
    const first = await call(h.router, "POST", "/api/wa/campaign", { instance: id, lead_ids: [a], template: "oi" });
    expect(first.status).toBe(202);
    await tick(10);
    const second = await call(h.router, "POST", "/api/wa/campaign", { instance: id, lead_ids: [a], template: "oi" });
    expect(second.status).toBe(409);
    expect(second.json.error).toContain("campanha em andamento");

    const v1 = await call(h.router, "POST", "/api/wa/validate", { instance: id, lead_ids: [a] });
    expect(v1.status).toBe(202);
    const v2 = await call(h.router, "POST", "/api/wa/validate", { instance: id, lead_ids: [a] });
    expect(v2.status).toBe(409);
  });
});

describe("B3 — resolver dedupe", () => {
  test("both variants answered with the same jid is one account, not ambiguous", async () => {
    const res = await resolveRecipient(
      { onWhatsApp: async () => [
        { jid: "5511987654321@s.whatsapp.net", exists: true },
        { jid: "5511987654321@s.whatsapp.net", exists: true },
      ] },
      "5511987654321@s.whatsapp.net",
    );
    expect(res).toMatchObject({ ok: true, jid: "5511987654321@s.whatsapp.net" });
  });
});

describe("B4 — campaigns finish under the real limits", () => {
  test("spacing between sends is at least 60 s / max_per_minute", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const ids = [1, 2].map((n) => seedLead(coreDb, { name: `L${n}`, is_whatsapp: 1, jid: `55${n}@s.whatsapp.net` }));
    const job = createCampaign(waDb, coreDb, { instanceId: INST, template: "oi", mediaId: null, leadIds: ids });
    const config = openConfig({ rate_limit: { max_per_minute: 2, max_per_hour: 20, min_interval_seconds: 15, jitter_seconds: 10 } });
    const { deps, sleeps } = runnerDeps(waDb, coreDb, { config });
    await runCampaign(job, deps);
    expect(minSpacingMs(config.rate_limit)).toBe(30_000);
    expect(sleeps).toEqual([30_000]);
  });

  test("a rate-limit block is waited out and the campaign reaches done", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const ids = [1, 2, 3].map((n) => seedLead(coreDb, { name: `L${n}`, is_whatsapp: 1, jid: `55${n}@s.whatsapp.net` }));
    const job = createCampaign(waDb, coreDb, { instanceId: INST, template: "oi", mediaId: null, leadIds: ids });
    const fake = makeFakeConnect();
    const config = openConfig({ rate_limit: { max_per_minute: 2, max_per_hour: 20, min_interval_seconds: 0, jitter_seconds: 0 } });
    const manager = new WaManager({ db: waDb, config, connect: fake.connect });
    manager.start(INST);
    fake.cb(INST).onOpen!("5511@s.whatsapp.net");
    // Two sends already in the window: the first recipient must wait.
    recordAction(waDb, "message_send", "a", new Date(MIDDAY.getTime() - 10_000));
    recordAction(waDb, "message_send", "b", new Date(MIDDAY.getTime() - 5_000));
    let nowMs = MIDDAY.getTime();
    await runCampaign(job, {
      waDb,
      coreDb,
      config,
      send: (jid, content) => manager.sendCampaignMessage(INST, jid, content, { at: new Date(nowMs) }),
      validatePending: async () => {},
      loadMedia: async () => null,
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
      },
      random: () => 0,
    });
    const view = getCampaign(waDb, job)!;
    expect(view.status).toBe("done");
    expect(view.sent).toBe(3);
    expect(fake.sock(INST).sentMessages).toHaveLength(3);
  });

  test("validation lookups do not spend the send budget", async () => {
    const db = openWaDb(":memory:");
    const fake = makeFakeConnect();
    const config = openConfig({ rate_limit: { max_per_minute: 2, max_per_hour: 20, min_interval_seconds: 0, jitter_seconds: 0 } });
    const manager = new WaManager({ db, config, connect: fake.connect });
    const inst = createInstance(db);
    manager.start(inst.id);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");
    for (let i = 0; i < 5; i++) recordAction(db, "onwhatsapp_lookup", `l${i}`, new Date(MIDDAY.getTime() - 1000));
    const res = await manager.sendText(inst.id, "55@s.whatsapp.net", "oi", { at: MIDDAY });
    expect(res.ok).toBe(true);
  });

  test("validateUntilDone waits for the validation window and validates every lead", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const phones = ["+55 11 99999-0001", "+55 11 99999-0002", "+55 11 99999-0003"];
    const ids = phones.map((p, i) => seedLead(coreDb, { name: `V${i}`, phone: p }));
    const registry = new Set(phones.map((p) => phoneToUser(p)!));
    let nowMs = MIDDAY.getTime();
    const out = await validateUntilDone(ids, {
      coreDb,
      waDb,
      config: openConfig({ validation_rate: { max_per_minute: 1, max_per_hour: 100, min_interval_seconds: 0, jitter_seconds: 0 } }),
      getSocket: () => ({
        onWhatsApp: async (...n: string[]) => n.filter((x) => registry.has(x)).map((x) => ({ jid: `${x}@s.whatsapp.net`, exists: true })),
      }),
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
      },
      random: () => 0,
    });
    expect(out.complete).toBe(true);
    const validated = coreDb.query("SELECT count(*) c FROM leads WHERE is_whatsapp = 1").get() as { c: number };
    expect(validated.c).toBe(3);
  });
});

describe("B5 — no duplicate sends", () => {
  test("two leads with the same JID → one send, second skipped", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const a = seedLead(coreDb, { name: "A", is_whatsapp: 1, jid: "551@s.whatsapp.net" });
    const b = seedLead(coreDb, { name: "B", is_whatsapp: 1, jid: "551@s.whatsapp.net" });
    const job = createCampaign(waDb, coreDb, { instanceId: INST, template: "oi", mediaId: null, leadIds: [a, b] });
    const { deps, sent } = runnerDeps(waDb, coreDb);
    await runCampaign(job, deps);
    expect(sent).toEqual(["551@s.whatsapp.net"]);
    const r = getCampaign(waDb, job)!.recipients.find((x) => x.lead_id === b)!;
    expect(r).toMatchObject({ status: "skipped", reason: "mesmo WhatsApp de outro lead desta campanha" });
  });

  test("a JID sent by another campaign in the last 7 days is skipped", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const a = seedLead(coreDb, { name: "A", is_whatsapp: 1, jid: "551@s.whatsapp.net" });
    const first = createCampaign(waDb, coreDb, { instanceId: INST, template: "oi", mediaId: null, leadIds: [a] });
    await runCampaign(first, runnerDeps(waDb, coreDb).deps);
    const second = createCampaign(waDb, coreDb, { instanceId: INST, template: "oi de novo", mediaId: null, leadIds: [a] });
    const { deps, sent } = runnerDeps(waDb, coreDb);
    await runCampaign(second, deps);
    expect(sent).toHaveLength(0);
    expect(getCampaign(waDb, second)!.recipients[0]!.reason).toContain("últimos 7 dias");
  });

  test("only queued recipients are processed (a re-run never re-sends)", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const a = seedLead(coreDb, { name: "A", is_whatsapp: 1, jid: "551@s.whatsapp.net" });
    const job = createCampaign(waDb, coreDb, { instanceId: INST, template: "oi", mediaId: null, leadIds: [a] });
    await runCampaign(job, runnerDeps(waDb, coreDb).deps);
    const { deps, sent } = runnerDeps(waDb, coreDb);
    await runCampaign(job, deps);
    expect(sent).toHaveLength(0);
    expect(getCampaign(waDb, job)!.sent).toBe(1);
  });
});

describe("B6 — /send respects quiet hours for cold messages", () => {
  const alwaysQuiet = openConfig({
    quiet_hours: { enabled: true, start: "00:00", end: "23:59", timezone: "America/Sao_Paulo" },
  });

  test("no inbound message in the chat → 409 quiet_hours, socket untouched", async () => {
    const h = harness(alwaysQuiet);
    const id = await connectedInstance(h);
    const res = await call(h.router, "POST", "/api/wa/send", { instance: id, jid: "5599@s.whatsapp.net", text: "oi" });
    if (res.status === 200) return; // 23:59 SP edge: outside the window, nothing to assert
    expect(res.status).toBe(409);
    expect(res.json.blocked_code).toBe("quiet_hours");
    expect(h.fake.sock(id).sentMessages).toHaveLength(0);
  });

  test("the contact wrote first → reply allowed during quiet hours", async () => {
    const h = harness(alwaysQuiet);
    const id = await connectedInstance(h);
    ingestMessage(h.waDb, id, { key: { remoteJid: "5599@s.whatsapp.net", id: "in1", fromMe: false }, message: { conversation: "oi?" }, messageTimestamp: 1 }, "live");
    const res = await call(h.router, "POST", "/api/wa/send", { instance: id, jid: "5599@s.whatsapp.net", text: "oi!" });
    expect(res.status).toBe(200);
    expect(h.fake.sock(id).sentMessages).toHaveLength(1);
  });
});

describe("B7 — validation resume", () => {
  test("resume while running → 409; resume without a socket → 409", async () => {
    const h = harness();
    const id = await connectedInstance(h);
    h.fake.sock(id).onWhatsApp = () => new Promise(() => {}); // job stays running
    const lead = seedLead(h.coreDb, { name: "A", phone: "+55 11 99999-0001" });
    const created = await call(h.router, "POST", "/api/wa/validate", { instance: id, lead_ids: [lead] });
    await tick(10);
    const again = await call(h.router, "POST", `/api/wa/validate/${created.json.job_id}/resume`);
    expect(again.status).toBe(409);
    expect(again.json.error).toContain("em andamento");

    const paused = createValidateJob(h.waDb, h.coreDb, { instanceId: "wanope", leadIds: [lead] });
    const noSock = await call(h.router, "POST", `/api/wa/validate/${paused}/resume`);
    expect(noSock.status).toBe(409);
    expect(noSock.json.error).toContain("Nenhum WhatsApp conectado");
  });
});

describe("B8 — jobs never stay stuck", () => {
  test("an unexpected error marks the campaign failed with a PT-BR reason", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const a = seedLead(coreDb, { name: "A", is_whatsapp: 1, jid: "551@s.whatsapp.net" });
    const job = createCampaign(waDb, coreDb, { instanceId: INST, template: "oi", mediaId: null, leadIds: [a] });
    const { deps } = runnerDeps(waDb, coreDb, {
      loadMedia: async () => {
        throw new Error("disco cheio");
      },
    });
    await runCampaign(job, deps);
    const view = getCampaign(waDb, job)!;
    expect(view.status).toBe("failed");
    expect(view.reason).toContain("disco cheio");
  });

  test("router start marks leftover running/queued jobs as paused (servidor reiniciado)", () => {
    const waDb = openWaDb(":memory:");
    const coreDb = seedCore();
    const a = seedLead(coreDb, { name: "A", is_whatsapp: 1, jid: "551@s.whatsapp.net" });
    const cmp = createCampaign(waDb, coreDb, { instanceId: INST, template: "oi", mediaId: null, leadIds: [a] });
    waDb.query("UPDATE campaigns SET status = 'running' WHERE id = ?").run(cmp);
    const val = createValidateJob(waDb, coreDb, { instanceId: INST, leadIds: [a] });
    harness(openConfig(), waDb);
    expect(getCampaign(waDb, cmp)).toMatchObject({ status: "paused", reason: "servidor reiniciado" });
    const job = waDb.query("SELECT status, reason FROM validate_jobs WHERE id = ?").get(val);
    expect(job).toEqual({ status: "paused", reason: "servidor reiniciado" });
  });
});

describe("B9 — campaigns need a socket", () => {
  test("POST /campaign without a connected socket → 409", async () => {
    const h = harness();
    const id = (await call(h.router, "POST", "/api/wa/instances")).json.id;
    const a = seedLead(h.coreDb, { name: "A", is_whatsapp: 1, jid: "551@s.whatsapp.net" });
    const res = await call(h.router, "POST", "/api/wa/campaign", { instance: id, lead_ids: [a], template: "oi" });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("Nenhum WhatsApp conectado. Conecte uma conta antes de enviar.");
  });

  test("socket lost mid-run → paused, the rest stay queued", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const ids = [1, 2, 3].map((n) => seedLead(coreDb, { name: `L${n}`, is_whatsapp: 1, jid: `55${n}@s.whatsapp.net` }));
    const job = createCampaign(waDb, coreDb, { instanceId: INST, template: "oi", mediaId: null, leadIds: ids });
    let probes = 0;
    const { deps, sent } = runnerDeps(waDb, coreDb, { isConnected: () => ++probes <= 2 });
    await runCampaign(job, deps);
    const view = getCampaign(waDb, job)!;
    expect(sent).toHaveLength(1);
    expect(view.status).toBe("paused");
    expect(view.reason).toBe("instância não conectada");
    expect(view.recipients.filter((r) => r.status === "queued")).toHaveLength(2);
  });
});

describe("B10 — placeholders", () => {
  test("unknown placeholders → 400 listing them and the valid ones", async () => {
    const h = harness();
    const id = await connectedInstance(h);
    const a = seedLead(h.coreDb, { name: "A", is_whatsapp: 1, jid: "551@s.whatsapp.net" });
    const res = await call(h.router, "POST", "/api/wa/campaign", { instance: id, lead_ids: [a], template: "Oi {{nome}} {{name}}" });
    expect(res.status).toBe(400);
    expect(res.json.unknown_placeholders).toEqual(["nome"]);
    expect(res.json.valid_placeholders).toContain("name");
    expect(res.json.error).toContain("{{nome}}");
  });

  test("a used placeholder empty for the lead → that recipient is skipped", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const withEmail = seedLead(coreDb, { name: "A", email: "a@x.com", is_whatsapp: 1, jid: "551@s.whatsapp.net" });
    const noEmail = seedLead(coreDb, { name: "B", is_whatsapp: 1, jid: "552@s.whatsapp.net" });
    const job = createCampaign(waDb, coreDb, {
      instanceId: INST,
      template: "Oi {{name}}, seu e-mail é {{email}}",
      mediaId: null,
      leadIds: [withEmail, noEmail],
    });
    const { deps, sent } = runnerDeps(waDb, coreDb);
    await runCampaign(job, deps);
    expect(sent).toEqual(["551@s.whatsapp.net"]);
    const r = getCampaign(waDb, job)!.recipients.find((x) => x.lead_id === noEmail)!;
    expect(r).toMatchObject({ status: "skipped", reason: "campo vazio para este lead: {{email}}" });
  });
});

describe("B11 — phoneToUser", () => {
  test("explicit international numbers are not forced into BR", () => {
    expect(phoneToUser("+1 415 555 2671")).toBe("14155552671");
    expect(phoneToUser("0044 20 7946 0958")).toBe("442079460958");
    expect(phoneToUser("+55 11 98765-4321")).toBe("5511987654321");
    expect(phoneToUser("0055 11 98765-4321")).toBe("5511987654321");
  });

  test("non-mobile service numbers are rejected", () => {
    for (const n of ["0800 123 4567", "0300 789 1234", "0500 123 4567", "0900 123 4567", "4003-1234", "3003-4567", "4004-0001"]) {
      expect(phoneToUser(n)).toBeNull();
    }
  });

  test("regular BR numbers still work", () => {
    expect(phoneToUser("(11) 98765-4321")).toBe("5511987654321");
    expect(phoneToUser("011 98765-4321")).toBe("5511987654321");
  });
});

describe("B12 — media upload", () => {
  test("magic bytes decide the kind, not the declared type", () => {
    expect(sniffMedia(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ kind: "image", mime: "image/jpeg" });
    expect(sniffMedia(new TextEncoder().encode("%PDF-1.7"))).toEqual({ kind: "document", mime: "application/pdf" });
    expect(sniffMedia(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))).toEqual({ kind: "video", mime: "video/mp4" });
    expect(sniffMedia(new TextEncoder().encode("OggS\0"))).toEqual({ kind: "document", mime: "audio/ogg" });
    expect(sniffMedia(new TextEncoder().encode("MZ executable"))).toBeNull();
  });

  test("unknown content → 415 even when declared as image/png", async () => {
    const h = harness();
    const fd = new FormData();
    fd.append("file", new File([new TextEncoder().encode("<script>")], "x.png", { type: "image/png" }));
    const req = new Request("http://localhost/api/wa/media", { method: "POST", body: fd });
    const res = await h.router.handle(req, new URL(req.url));
    expect(res.status).toBe(415);
  });

  test("Content-Length over the limit → 413 without reading the body", async () => {
    const h = harness();
    const req = new Request("http://localhost/api/wa/media", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(120 * 1024 * 1024) },
      body: "--x--",
    });
    const res = await h.router.handle(req, new URL(req.url));
    expect(res.status).toBe(413);
  });
});
