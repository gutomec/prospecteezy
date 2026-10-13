import { describe, expect, test } from "bun:test";
import { openWaDb } from "../db.ts";
import { WaManager, type WaEvent } from "../manager.ts";
import { createInstance } from "../instances.ts";
import { formatSse, parseSseStream } from "../routes.ts";
import { makeFakeConnect } from "./_fakes.ts";

describe("SSE wire format", () => {
  test("formatSse → parseSseStream round-trips an event", () => {
    const event: WaEvent = { type: "message", instance: "waabc", data: { text: "oi", from_me: true, ts: 42 } };
    const wire = formatSse(event);
    expect(wire).toContain("event: message\n");
    const parsed = parseSseStream(wire);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      event: "message",
      data: { instance: "waabc", text: "oi", from_me: true, ts: 42 },
    });
  });

  test("parseSseStream reads a multi-event buffer and ignores heartbeats", () => {
    const buffer =
      ": connected\n\n" +
      formatSse({ type: "status", instance: "w1", data: { status: "qr" } }) +
      formatSse({ type: "message", instance: "w1", data: { text: "a" } });
    const parsed = parseSseStream(buffer);
    expect(parsed.map((p) => p.event)).toEqual(["status", "message"]);
  });

  test("manager events serialize through the SSE bus", () => {
    const db = openWaDb(":memory:");
    const fake = makeFakeConnect();
    const manager = new WaManager({ db, connect: fake.connect });
    const captured: string[] = [];
    manager.subscribe((e) => captured.push(formatSse(e)));

    const inst = createInstance(db);
    manager.start(inst.id);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");

    const parsed = parseSseStream(captured.join(""));
    const statuses = parsed.filter((p) => p.event === "status").map((p) => p.data.status);
    expect(statuses).toContain("connecting");
    expect(statuses).toContain("connected");
  });
});

describe("message_status (delivery ticks)", () => {
  test("messages.update writes the status and pushes message_status on the SSE bus", () => {
    const db = openWaDb(":memory:");
    const fake = makeFakeConnect();
    const manager = new WaManager({ db, connect: fake.connect });
    const captured: string[] = [];
    manager.subscribe((e) => captured.push(formatSse(e)));

    const inst = createInstance(db);
    manager.start(inst.id);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");
    const jid = "5581999990000@s.whatsapp.net";
    fake.cb(inst.id).onMessagesUpsert!({
      type: "notify",
      messages: [{ key: { remoteJid: jid, id: "out1", fromMe: true }, message: { conversation: "oi" }, messageTimestamp: 1_700_000_100 }],
    });
    fake.cb(inst.id).onMessagesUpdate!([
      { key: { remoteJid: jid, id: "out1", fromMe: true }, update: { status: 3 } },
      { key: { remoteJid: jid, id: "out1", fromMe: true }, update: { status: 4 } },
      // Not mirrored / no status: written nowhere, pushed nowhere.
      { key: { remoteJid: jid, id: "unknown", fromMe: true }, update: { status: 4 } },
      { key: { remoteJid: jid, id: "out1", fromMe: true }, update: { starred: true } },
    ]);

    const ticks = parseSseStream(captured.join("")).filter((p) => p.event === "message_status");
    expect(ticks.map((p) => p.data)).toEqual([
      { instance: inst.id, chat_jid: jid, message_id: "out1", from_me: true, status: "delivered" },
      { instance: inst.id, chat_jid: jid, message_id: "out1", from_me: true, status: "read" },
    ]);
    const row = db.query("SELECT status FROM messages WHERE message_id = 'out1'").get() as { status: string };
    expect(row.status).toBe("read");
  });
});
