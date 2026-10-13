import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../db/index.ts";
import { WA_CONFIG } from "../config.ts";
import { openWaDb } from "../db.ts";
import { ingestMessage, upsertContact } from "../ingestion.ts";
import { createInstance } from "../instances.ts";
import { WaManager } from "../manager.ts";
import { createWaRouter, type WaRouter } from "../routes.ts";
import { makeFakeConnect } from "./_fakes.ts";

function harness(): { router: WaRouter; waDb: Database; instanceId: string } {
  const waDb = openWaDb(":memory:");
  const coreDb = openDb(":memory:");
  const manager = new WaManager({ db: waDb, config: WA_CONFIG, connect: makeFakeConnect().connect });
  const router = createWaRouter({ waDb, coreDb, config: WA_CONFIG, manager });
  const instanceId = createInstance(waDb).id;
  return { router, waDb, instanceId };
}

async function get(router: WaRouter, path: string): Promise<any> {
  const req = new Request(`http://localhost${path}`);
  const res = await router.handle(req, new URL(req.url));
  return (await res.json()) as any;
}

function msg(jid: string, id: string, content: Record<string, unknown>, ts: number, extra: Record<string, unknown> = {}) {
  return { key: { remoteJid: jid, id, ...(extra.fromMe ? { fromMe: true } : {}) }, message: content, messageTimestamp: ts, ...extra };
}

describe("contacts schema + upsert separation", () => {
  test("migration adds verified_name column", () => {
    const db = openWaDb(":memory:");
    const cols = (db.query("PRAGMA table_info(contacts)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("verified_name");
  });

  test("upsertContact stores name / notify / verified in separate columns", () => {
    const db = openWaDb(":memory:");
    upsertContact(db, "waalpha", {
      id: "5511@s.whatsapp.net",
      name: "Nome da Agenda",
      notify: "PushName",
      verifiedName: "Empresa Verificada",
    });
    const row = db
      .query("SELECT display_name, notify_name, verified_name FROM contacts WHERE jid = ?")
      .get("5511@s.whatsapp.net");
    expect(row).toEqual({ display_name: "Nome da Agenda", notify_name: "PushName", verified_name: "Empresa Verificada" });
  });

  test("a contact with only a verified name is NOT saved (display_name stays null)", () => {
    const db = openWaDb(":memory:");
    upsertContact(db, "waalpha", { id: "5522@s.whatsapp.net", verifiedName: "Só Verificado", notify: "push" });
    const row = db
      .query("SELECT display_name, verified_name FROM contacts WHERE jid = ?")
      .get("5522@s.whatsapp.net") as { display_name: string | null; verified_name: string };
    expect(row.display_name).toBeNull();
    expect(row.verified_name).toBe("Só Verificado");
  });
});

describe("/api/wa/chats name resolution + preview", () => {
  test("coalesce: address-book name, then pushName, then the number; saved flag", async () => {
    const { router, waDb, instanceId } = harness();
    // A: fromMe (chats.name null) + saved contact (display_name) → uses the contact name, saved=true
    ingestMessage(waDb, instanceId, msg("55A@s.whatsapp.net", "a1", { conversation: "oi" }, 100, { fromMe: true }), "live");
    upsertContact(waDb, instanceId, { id: "55A@s.whatsapp.net", name: "Contato Salvo" });
    // B: received with pushName (chats.name set), no address-book name → pushName, saved=false
    ingestMessage(waDb, instanceId, msg("55B@s.whatsapp.net", "b1", { conversation: "ola" }, 200, { pushName: "PushB" }), "live");
    // C: fromMe, nothing named anywhere → number fallback, saved=false
    ingestMessage(waDb, instanceId, msg("55C@s.whatsapp.net", "c1", { conversation: "e ai" }, 300, { fromMe: true }), "live");

    const res = await get(router, `/api/wa/chats?instance=${instanceId}`);
    const byJid = Object.fromEntries(res.chats.map((c: any) => [c.jid, c]));
    expect(byJid["55A@s.whatsapp.net"]).toMatchObject({ name: "Contato Salvo", saved: true, last_type: "conversation" });
    expect(byJid["55B@s.whatsapp.net"]).toMatchObject({ name: "PushB", saved: false });
    expect(byJid["55C@s.whatsapp.net"]).toMatchObject({ name: "55C", saved: false });
  });

  test("preview ignores system messages (shows the last real message + its type)", async () => {
    const { router, waDb, instanceId } = harness();
    ingestMessage(waDb, instanceId, msg("55E@s.whatsapp.net", "e1", { conversation: "conteúdo real" }, 400, { fromMe: true }), "live");
    ingestMessage(waDb, instanceId, msg("55E@s.whatsapp.net", "e2", { protocolMessage: { type: 0 } }, 500, { fromMe: true }), "live");

    const res = await get(router, `/api/wa/chats?instance=${instanceId}`);
    const chat = res.chats.find((c: any) => c.jid === "55E@s.whatsapp.net");
    expect(chat.last_message).toBe("conteúdo real"); // the system message never becomes the preview
    expect(chat.last_type).toBe("conversation");
  });
});

describe("/api/wa/chats/:jid/messages type + system filter", () => {
  test("exposes message_type and drops protocolMessage / senderKeyDistribution / reaction", async () => {
    const { router, waDb, instanceId } = harness();
    const jid = "55Z@s.whatsapp.net";
    ingestMessage(waDb, instanceId, msg(jid, "z1", { conversation: "texto" }, 10), "live");
    ingestMessage(waDb, instanceId, msg(jid, "z2", { imageMessage: { caption: "foto" } }, 20), "live");
    ingestMessage(waDb, instanceId, msg(jid, "z3", { protocolMessage: { type: 0 } }, 30), "live");
    ingestMessage(waDb, instanceId, msg(jid, "z4", { senderKeyDistributionMessage: { groupId: "g" } }, 40), "live");
    ingestMessage(waDb, instanceId, msg(jid, "z5", { reactionMessage: { text: "👍" } }, 50), "live");

    const res = await get(router, `/api/wa/chats/${encodeURIComponent(jid)}/messages?instance=${instanceId}`);
    expect(res.messages.map((m: any) => m.type)).toEqual(["conversation", "imageMessage"]);
    expect(res.messages[1]).toMatchObject({ type: "imageMessage", text: "foto" }); // media stays, labelled
  });
});
