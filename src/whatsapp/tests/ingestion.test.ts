import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openWaDb } from "../db.ts";
import {
  extractText,
  handleHistorySet,
  handleMessagesUpdate,
  handleMessagesUpsert,
  ingestMessage,
  unwrapContent,
} from "../ingestion.ts";

const INST = "waalpha00aa";

function liveMsg(jid: string, id: string, text: string, fromMe = false): Record<string, unknown> {
  return {
    key: { remoteJid: jid, id, fromMe },
    message: { conversation: text },
    messageTimestamp: 1_700_000_100,
    pushName: fromMe ? "Owner" : "Fulano",
  };
}

function chatRow(db: Database, jid: string) {
  return db
    .query("SELECT name, last_message_text, last_message_at FROM chats WHERE instance_id = ? AND jid = ?")
    .get(INST, jid) as { name: string | null; last_message_text: string | null; last_message_at: number | null } | null;
}

describe("text extraction", () => {
  test("conversation and extendedText", () => {
    expect(extractText({ conversation: "oi" })).toBe("oi");
    expect(extractText({ extendedTextMessage: { text: "link" } })).toBe("link");
  });
  test("unwraps ephemeral/viewOnce envelopes", () => {
    const wrapped = { ephemeralMessage: { message: { conversation: "secreta" } } };
    expect(extractText(wrapped)).toBe("secreta");
    expect(unwrapContent(wrapped)).toEqual({ conversation: "secreta" });
  });
  test("non-text content returns null but does not throw", () => {
    expect(extractText({ imageMessage: {} })).toBeNull();
  });
});

describe("mirror ingestion", () => {
  test("upsert creates chat + message and updates last_message", () => {
    const db = openWaDb(":memory:");
    const rows = handleMessagesUpsert(db, INST, {
      messages: [liveMsg("5511@s.whatsapp.net", "m1", "primeira")],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("primeira");
    expect(rows[0]!.from_me).toBe(false);
    const chat = chatRow(db, "5511@s.whatsapp.net");
    expect(chat?.last_message_text).toBe("primeira");
    expect(chat?.name).toBe("Fulano");
    const count = db
      .query("SELECT count(*) c FROM messages WHERE instance_id = ? AND chat_jid = ?")
      .get(INST, "5511@s.whatsapp.net") as { c: number };
    expect(count.c).toBe(1);
  });

  test("mirror rows are scoped per instance", () => {
    const db = openWaDb(":memory:");
    handleMessagesUpsert(db, "waaa", { messages: [liveMsg("5511@s.whatsapp.net", "m1", "A")] });
    handleMessagesUpsert(db, "wabb", { messages: [liveMsg("5511@s.whatsapp.net", "m1", "B")] });
    const a = db.query("SELECT text_content FROM messages WHERE instance_id = 'waaa'").get() as { text_content: string };
    const b = db.query("SELECT text_content FROM messages WHERE instance_id = 'wabb'").get() as { text_content: string };
    expect(a.text_content).toBe("A");
    expect(b.text_content).toBe("B");
  });

  test("duplicate message_id is ignored (idempotent)", () => {
    const db = openWaDb(":memory:");
    handleMessagesUpsert(db, INST, { messages: [liveMsg("5511@s.whatsapp.net", "dup", "x")] });
    handleMessagesUpsert(db, INST, { messages: [liveMsg("5511@s.whatsapp.net", "dup", "x")] });
    const count = db.query("SELECT count(*) c FROM messages WHERE instance_id = ?").get(INST) as { c: number };
    expect(count.c).toBe(1);
  });

  test("status@broadcast is skipped", () => {
    const db = openWaDb(":memory:");
    const r = ingestMessage(db, INST, liveMsg("status@broadcast", "s1", "x"), "live");
    expect(r).toBeNull();
  });

  test("history set backfills chats/contacts/messages", () => {
    const db = openWaDb(":memory:");
    const res = handleHistorySet(db, INST, {
      contacts: [{ id: "5511@s.whatsapp.net", name: "Contato" }],
      chats: [{ id: "5511@s.whatsapp.net", name: "Chat", conversationTimestamp: 1_700_000_000 }],
      messages: [liveMsg("5511@s.whatsapp.net", "h1", "antiga")],
    });
    expect(res).toEqual({ chats: 1, contacts: 1, messages: 1 });
  });

  test("messages.update maps delivery status", () => {
    const db = openWaDb(":memory:");
    handleMessagesUpsert(db, INST, { messages: [liveMsg("5511@s.whatsapp.net", "u1", "oi", true)] });
    const touched = handleMessagesUpdate(db, INST, [
      { key: { remoteJid: "5511@s.whatsapp.net", id: "u1", fromMe: true }, update: { status: 3 } },
    ]);
    expect(touched).toBe(1);
    const row = db
      .query("SELECT status FROM messages WHERE instance_id = ? AND message_id = 'u1'")
      .get(INST) as { status: string };
    expect(row.status).toBe("delivered");
  });
});
