import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../db/index.ts";
import { updateLeadTags } from "../../db/tags.ts";
import { WA_CONFIG } from "../config.ts";
import { openWaDb } from "../db.ts";
import { WaManager } from "../manager.ts";
import { createWaRouter, type WaRouter } from "../routes.ts";
import { makeFakeConnect, type FakeConnect } from "./_fakes.ts";

interface Harness {
  router: WaRouter;
  fake: FakeConnect;
  waDb: Database;
  coreDb: Database;
}

function makeHarness(): Harness {
  const waDb = openWaDb(":memory:");
  const coreDb = openDb(":memory:");
  const fake = makeFakeConnect();
  // Quiet hours off: these tests exercise routing and the rate limit, and must
  // not depend on the wall clock (quiet hours have their own tests).
  const config = { ...WA_CONFIG, quiet_hours: { ...WA_CONFIG.quiet_hours, enabled: false } };
  const manager = new WaManager({ db: waDb, config, connect: fake.connect });
  const router = createWaRouter({ waDb, coreDb, config, manager });
  return { router, fake, waDb, coreDb };
}

async function call(
  router: WaRouter,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
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

function seedLead(coreDb: Database): void {
  coreDb
    .query(
      `INSERT INTO searches (query_normalized, niche, city, gl, hl, created_at)
       VALUES ('x', 'clínicas', 'Recife', 'br', 'pt-br', ?)`,
    )
    .run(new Date().toISOString());
  coreDb
    .query(
      `INSERT INTO leads (search_id, place_id, name, phone, is_whatsapp, whatsapp_jid, source, collected_at)
       VALUES (1, 'p1', 'Clínica X', '+55 81 99999-0000', 1, '5581999990000@s.whatsapp.net', 'serper:places', ?)`,
    )
    .run(new Date().toISOString());
}

describe("/api/wa routes", () => {
  test("POST /instances creates + returns id; GET /instances lists it", async () => {
    const { router } = makeHarness();
    const created = await call(router, "POST", "/api/wa/instances", { name: "Suporte" });
    expect(created.status).toBe(201);
    expect(created.json.id).toMatch(/^wa[0-9a-f]{10}$/);

    const list = await call(router, "GET", "/api/wa/instances");
    expect(list.status).toBe(200);
    expect(list.json.instances).toHaveLength(1);
    expect(list.json.instances[0]).toMatchObject({
      id: created.json.id,
      name: "Suporte",
      status: "connecting",
      is_active: true,
    });
  });

  test("GET /instances/:id/qr returns a data URL while pairing", async () => {
    const { router, fake } = makeHarness();
    const { json } = await call(router, "POST", "/api/wa/instances");
    fake.cb(json.id).onQr!("qr-string");
    await new Promise((r) => setTimeout(r, 40));
    const qr = await call(router, "GET", `/api/wa/instances/${json.id}/qr`);
    expect(qr.status).toBe(200);
    expect(qr.json.status).toBe("qr");
    expect(qr.json.qr).toMatch(/^data:image\/png;base64,/);
    expect(qr.json.expires_at).toBeGreaterThan(0);
  });

  test("POST /instances/:id/select persists the active instance", async () => {
    const { router, waDb } = makeHarness();
    const a = (await call(router, "POST", "/api/wa/instances")).json.id;
    const b = (await call(router, "POST", "/api/wa/instances")).json.id;
    const sel = await call(router, "POST", `/api/wa/instances/${b}/select`);
    expect(sel.json).toMatchObject({ ok: true, active_instance: b });
    const list = await call(router, "GET", "/api/wa/instances");
    const active = list.json.instances.find((i: any) => i.is_active);
    expect(active.id).toBe(b);
    // persisted, independent of the manager memory
    expect((waDb.query("SELECT value FROM runtime_state WHERE key = 'active_instance'").get() as { value: string }).value).toBe(b);
  });

  test("disconnect then reconnect keep the instance listed", async () => {
    const { router, fake } = makeHarness();
    const id = (await call(router, "POST", "/api/wa/instances")).json.id;
    fake.cb(id).onOpen!("5511@s.whatsapp.net");
    const disc = await call(router, "POST", `/api/wa/instances/${id}/disconnect`);
    expect(disc.json.status).toBe("disconnected");
    const rec = await call(router, "POST", `/api/wa/instances/${id}/reconnect`);
    expect(rec.json.status).toBe("connecting");
  });

  test("DELETE /instances/:id removes it", async () => {
    const { router, fake } = makeHarness();
    const id = (await call(router, "POST", "/api/wa/instances")).json.id;
    fake.cb(id).onOpen!("5511@s.whatsapp.net");
    const del = await call(router, "DELETE", `/api/wa/instances/${id}`);
    expect(del.json.ok).toBe(true);
    const list = await call(router, "GET", "/api/wa/instances");
    expect(list.json.instances).toHaveLength(0);
  });

  test("POST /send mirrors the message; /chats and /messages read it back", async () => {
    const { router, fake } = makeHarness();
    const id = (await call(router, "POST", "/api/wa/instances")).json.id;
    fake.cb(id).onOpen!("5511@s.whatsapp.net");

    const jid = "5581999990000@s.whatsapp.net";
    const sent = await call(router, "POST", "/api/wa/send", { instance: id, jid, text: "bom dia" });
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ ok: true });
    expect(sent.json.message).toMatchObject({ from_me: true, text: "bom dia" });

    const chats = await call(router, "GET", `/api/wa/chats?instance=${id}`);
    expect(chats.json.chats[0]).toMatchObject({ jid, last_message: "bom dia" });

    const messages = await call(router, "GET", `/api/wa/chats/${encodeURIComponent(jid)}/messages?instance=${id}`);
    expect(messages.json.messages).toHaveLength(1);
    expect(messages.json.messages[0]).toMatchObject({ from_me: true, text: "bom dia", status: "sent" });
  });

  test("POST /send blocked by the gate returns 429 with a code", async () => {
    const { router, fake, waDb } = makeHarness();
    const id = (await call(router, "POST", "/api/wa/instances")).json.id;
    fake.cb(id).onOpen!("5511@s.whatsapp.net");
    // saturate per-minute window
    waDb.query("INSERT INTO wa_actions (kind, target, created_at) VALUES ('message_send','a',?)").run(new Date().toISOString());
    waDb.query("INSERT INTO wa_actions (kind, target, created_at) VALUES ('message_send','b',?)").run(new Date().toISOString());
    const blocked = await call(router, "POST", "/api/wa/send", { instance: id, jid: "5599@s.whatsapp.net", text: "x" });
    expect(blocked.status).toBe(429);
    expect(blocked.json).toMatchObject({ ok: false, blocked_code: "rate_limit" });
  });

  test("GET /leads exposes is_whatsapp=1 leads as initiable contacts", async () => {
    const { router, coreDb } = makeHarness();
    seedLead(coreDb);
    const leads = await call(router, "GET", "/api/wa/leads");
    expect(leads.json.leads).toHaveLength(1);
    expect(leads.json.leads[0]).toMatchObject({
      lead_id: 1,
      name: "Clínica X",
      jid: "5581999990000@s.whatsapp.net",
      tags: [],
    });
    updateLeadTags(coreDb, [1], ["Academia", "Quente"], []);
    const tagged = await call(router, "GET", "/api/wa/leads");
    expect(tagged.json.leads[0].tags).toEqual(["Academia", "Quente"]);
  });

  test("unknown /api/wa path 404s", async () => {
    const { router } = makeHarness();
    const res = await call(router, "GET", "/api/wa/nope");
    expect(res.status).toBe(404);
  });
});
