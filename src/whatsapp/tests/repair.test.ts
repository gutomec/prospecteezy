import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { isPaired } from "../auth-state.ts";
import { openDb } from "../../db/index.ts";
import { WA_CONFIG } from "../config.ts";
import { openWaDb } from "../db.ts";
import { ingestMessage, upsertContact } from "../ingestion.ts";
import { createInstance } from "../instances.ts";
import { WaManager } from "../manager.ts";
import { createWaRouter, type WaRouter } from "../routes.ts";
import { makeFakeConnect, seedPairedCreds, tick, type FakeConnect } from "./_fakes.ts";

function setup() {
  const db = openWaDb(":memory:");
  const fake = makeFakeConnect();
  const manager = new WaManager({ db, config: WA_CONFIG, connect: fake.connect });
  return { db, fake, manager };
}

function counts(db: Database, id: string): { chats: number; contacts: number } {
  const chats = (db.query("SELECT count(*) c FROM chats WHERE instance_id = ?").get(id) as { c: number }).c;
  const contacts = (db.query("SELECT count(*) c FROM contacts WHERE instance_id = ?").get(id) as { c: number }).c;
  return { chats, contacts };
}

function seedData(db: Database, id: string): void {
  // Two conversations + a couple of contacts, as if ingested before the crash.
  ingestMessage(db, id, { key: { remoteJid: "5511@s.whatsapp.net", id: "m1" }, message: { conversation: "oi" }, messageTimestamp: 10, pushName: "Ana" }, "live");
  ingestMessage(db, id, { key: { remoteJid: "5522@s.whatsapp.net", id: "m2" }, message: { conversation: "ola" }, messageTimestamp: 20, pushName: "Bia" }, "live");
  upsertContact(db, id, { id: "5533@s.whatsapp.net", name: "Contato Salvo" });
}

describe("WaManager.repair", () => {
  test("preserves chats + contacts, wipes auth, and emits a fresh QR", async () => {
    const { db, fake, manager } = setup();
    const inst = createInstance(db);
    seedPairedCreds(db, inst.id);
    seedData(db, inst.id);
    manager.start(inst.id);
    fake.cb(inst.id).onOpen!("5599@s.whatsapp.net");
    expect(manager.runtime(inst.id).status).toBe("connected");
    expect(isPaired(db, inst.id).paired).toBe(true);

    const before = counts(db, inst.id);
    expect(before.chats).toBeGreaterThan(0);
    expect(before.contacts).toBeGreaterThan(0);

    manager.repair(inst.id);
    // auth wiped → next connection needs a QR
    expect(isPaired(db, inst.id).paired).toBe(false);
    expect(manager.runtime(inst.id).status).toBe("connecting");

    fake.cb(inst.id).onQr!("fresh-qr");
    await tick();
    const rt = manager.runtime(inst.id);
    expect(rt.status).toBe("qr");
    expect(rt.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    // data survived the repair unchanged
    expect(counts(db, inst.id)).toEqual(before);
    // the instance row itself is kept (unlike DELETE)
    expect(db.query("SELECT 1 FROM instances WHERE id = ?").get(inst.id)).not.toBeNull();
  });

  test("repair only touches THIS instance's auth (other accounts untouched)", async () => {
    const { db, fake, manager } = setup();
    const a = createInstance(db);
    const b = createInstance(db);
    seedPairedCreds(db, a.id);
    seedPairedCreds(db, b.id);
    manager.start(a.id);
    fake.cb(a.id).onOpen!("a@s.whatsapp.net");
    manager.repair(a.id);
    expect(isPaired(db, a.id).paired).toBe(false);
    expect(isPaired(db, b.id).paired).toBe(true);
  });
});

describe("WaManager.reconnect fallbacks", () => {
  test("valid session reconnects with NO QR", async () => {
    const { db, fake, manager } = setup();
    const inst = createInstance(db);
    seedPairedCreds(db, inst.id);
    manager.start(inst.id);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");
    manager.disconnect(inst.id);

    manager.reconnect(inst.id);
    expect(isPaired(db, inst.id).paired).toBe(true);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net"); // opened straight away, no QR
    await tick();
    expect(manager.runtime(inst.id).status).toBe("connected");
    expect(manager.runtime(inst.id).qrDataUrl).toBeNull();
  });

  test("logged-out session (401) auto-repairs to a QR, keeping data", async () => {
    const { db, fake, manager } = setup();
    const inst = createInstance(db);
    seedPairedCreds(db, inst.id);
    seedData(db, inst.id);
    const before = counts(db, inst.id);
    manager.start(inst.id);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");

    manager.reconnect(inst.id);
    // the reconnected socket reports the session is gone (device unlinked)
    fake.cb(inst.id).onClose!("401", false, 401);
    // manager auto-wiped auth and restarted → drive the QR of the fresh socket
    expect(isPaired(db, inst.id).paired).toBe(false);
    fake.cb(inst.id).onQr!("fresh-qr");
    await tick();
    expect(manager.runtime(inst.id).status).toBe("qr");
    expect(counts(db, inst.id)).toEqual(before); // chats/contacts preserved
  });

  test("without the reconnect flag, a 401 close just reports logged_out", async () => {
    const { db, fake, manager } = setup();
    const inst = createInstance(db);
    seedPairedCreds(db, inst.id);
    manager.start(inst.id); // plain start, no repairOnLoggedOut
    fake.cb(inst.id).onClose!("401", false, 401);
    expect(manager.runtime(inst.id).status).toBe("logged_out");
  });
});

describe("POST /api/wa/instances/:id/repair", () => {
  async function call(router: WaRouter, method: string, path: string): Promise<{ status: number; json: any }> {
    const req = new Request(`http://localhost${path}`, { method });
    const res = await router.handle(req, new URL(req.url));
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  test("route repairs an existing instance and reports connecting", async () => {
    const db = openWaDb(":memory:");
    const coreDb = openDb(":memory:");
    const fake: FakeConnect = makeFakeConnect();
    const manager = new WaManager({ db, config: WA_CONFIG, connect: fake.connect });
    const router = createWaRouter({ waDb: db, coreDb, config: WA_CONFIG, manager });

    const id = (await call(router, "POST", "/api/wa/instances")).json.id;
    seedPairedCreds(db, id);
    seedData(db, id);
    fake.cb(id).onOpen!("5511@s.whatsapp.net");
    const before = counts(db, id);

    const res = await call(router, "POST", `/api/wa/instances/${id}/repair`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, status: "connecting" });
    expect(isPaired(db, id).paired).toBe(false);
    expect(counts(db, id)).toEqual(before);

    // QR flows through /qr after the fresh socket emits it
    fake.cb(id).onQr!("fresh");
    await tick();
    const qr = await call(router, "GET", `/api/wa/instances/${id}/qr`);
    expect(qr.json.status).toBe("qr");
    expect(qr.json.qr).toMatch(/^data:image\/png;base64,/);
  });
});
