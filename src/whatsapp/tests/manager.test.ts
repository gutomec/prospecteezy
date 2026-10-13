import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { isPaired } from "../auth-state.ts";
import { WA_CONFIG, type WaConfig } from "../config.ts";
import { openWaDb } from "../db.ts";
import { recordAction } from "../gate.ts";
import { createInstance } from "../instances.ts";
import { WaManager, type WaEvent } from "../manager.ts";
import { makeFakeConnect, seedPairedCreds, tick } from "./_fakes.ts";

const MIDDAY = new Date("2026-08-19T15:00:00Z"); // 12:00 SP — outside quiet hours

function setup(config: WaConfig = WA_CONFIG) {
  const db = openWaDb(":memory:");
  const fake = makeFakeConnect();
  const events: WaEvent[] = [];
  const manager = new WaManager({ db, config, connect: fake.connect });
  manager.subscribe((e) => events.push(e));
  return { db, fake, manager, events };
}

describe("WaManager lifecycle + QR", () => {
  test("start → connecting, onQr renders a PNG data URL, onOpen → connected", async () => {
    const { db, fake, manager, events } = setup();
    const inst = createInstance(db);
    manager.start(inst.id);
    expect(manager.runtime(inst.id).status).toBe("connecting");

    fake.cb(inst.id).onQr!("2@abcd,efgh, ==");
    await tick();
    const rt = manager.runtime(inst.id);
    expect(rt.status).toBe("qr");
    expect(rt.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(rt.qrExpiresAt).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "qr")).toBe(true);

    fake.cb(inst.id).onOpen!("5511888@s.whatsapp.net");
    expect(manager.runtime(inst.id).status).toBe("connected");
    expect(manager.runtime(inst.id).qrDataUrl).toBeNull(); // QR cleared on open
    // phone stamped on the instance row
    const phone = db.query("SELECT phone FROM instances WHERE id = ?").get(inst.id) as { phone: string | null };
    expect(phone.phone).toBe("5511888");
  });

  test("two instances connect and coexist independently", async () => {
    const { db, fake, manager } = setup();
    const a = createInstance(db);
    const b = createInstance(db);
    manager.start(a.id);
    manager.start(b.id);
    fake.cb(a.id).onOpen!("111@s.whatsapp.net");
    fake.cb(b.id).onQr!("qr-b");
    await tick();
    expect(manager.runtime(a.id).status).toBe("connected");
    expect(manager.runtime(b.id).status).toBe("qr");
  });
});

describe("WaManager disconnect / reconnect / remove", () => {
  test("disconnect preserves auth; reconnect reuses it with no new QR", async () => {
    const { db, fake, manager } = setup();
    const inst = createInstance(db);
    seedPairedCreds(db, inst.id);
    manager.start(inst.id);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");
    expect(manager.runtime(inst.id).status).toBe("connected");

    manager.disconnect(inst.id);
    expect(manager.runtime(inst.id).status).toBe("disconnected");
    expect(isPaired(db, inst.id).paired).toBe(true); // auth preserved

    manager.reconnect(inst.id);
    expect(isPaired(db, inst.id).paired).toBe(true); // still valid → reused
    // A valid session reopens straight to 'open' with no QR emitted.
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");
    await tick();
    expect(manager.runtime(inst.id).status).toBe("connected");
    expect(manager.runtime(inst.id).qrDataUrl).toBeNull();
  });

  test("remove (DELETE) logs out, wipes auth and forces a new QR next time", async () => {
    const { db, fake, manager } = setup();
    const inst = createInstance(db);
    seedPairedCreds(db, inst.id);
    manager.start(inst.id);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");
    const sock = fake.sock(inst.id);

    await manager.remove(inst.id);
    expect(sock.loggedOut).toBe(true); // Baileys logout called
    expect(isPaired(db, inst.id).paired).toBe(false); // auth wiped → next connect needs QR
  });

  test("removing one instance does not touch the other's auth", async () => {
    const { db, fake, manager } = setup();
    const a = createInstance(db);
    const b = createInstance(db);
    seedPairedCreds(db, a.id);
    seedPairedCreds(db, b.id);
    manager.start(a.id);
    fake.cb(a.id).onOpen!("a@s.whatsapp.net");
    await manager.remove(a.id);
    expect(isPaired(db, a.id).paired).toBe(false);
    expect(isPaired(db, b.id).paired).toBe(true);
  });
});

describe("WaManager send (through the gate)", () => {
  function connect(db: Database, fake: ReturnType<typeof makeFakeConnect>, manager: WaManager, id: string) {
    manager.start(id);
    fake.cb(id).onOpen!("5511@s.whatsapp.net");
  }

  test("allowed send hits the socket and mirrors the message + emits event", async () => {
    const { db, fake, manager, events } = setup();
    const inst = createInstance(db);
    connect(db, fake, manager, inst.id);

    const res = await manager.sendText(inst.id, "5599@s.whatsapp.net", "olá", { at: MIDDAY });
    expect(res.ok).toBe(true);
    expect(fake.sock(inst.id).sentMessages).toEqual([{ jid: "5599@s.whatsapp.net", text: "olá" }]);
    const mirrored = db
      .query("SELECT from_me, text_content, status FROM messages WHERE instance_id = ? AND chat_jid = '5599@s.whatsapp.net'")
      .get(inst.id) as { from_me: number; text_content: string; status: string };
    expect(mirrored).toMatchObject({ from_me: 1, text_content: "olá", status: "sent" });
    expect(events.some((e) => e.type === "message" && e.data.from_me === true)).toBe(true);
    // send accounted for anti-ban budget
    const actions = db.query("SELECT count(*) c FROM wa_actions WHERE kind = 'message_send'").get() as { c: number };
    expect(actions.c).toBe(1);
  });

  test("gate blocks over the rate limit — socket is NOT touched", async () => {
    const { db, fake, manager } = setup();
    const inst = createInstance(db);
    connect(db, fake, manager, inst.id);
    // Fill the per-minute window (max_per_minute = 2 in WA_CONFIG).
    recordAction(db, "message_send", "x", new Date(MIDDAY.getTime() - 10_000));
    recordAction(db, "message_send", "y", new Date(MIDDAY.getTime() - 5_000));

    const res = await manager.sendText(inst.id, "5599@s.whatsapp.net", "spam", { at: MIDDAY });
    expect(res.ok).toBe(false);
    expect(res.gate.blocked_code).toBe("rate_limit");
    expect(fake.sock(inst.id).sentMessages).toHaveLength(0); // gate is the only path
  });

  test("send on a non-connected instance is refused", async () => {
    const { db, manager } = setup();
    const inst = createInstance(db);
    const res = await manager.sendText(inst.id, "5599@s.whatsapp.net", "oi");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/não conectada/);
  });
});
