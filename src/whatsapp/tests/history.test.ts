import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../db/index.ts";
import { WA_CONFIG } from "../config.ts";
import { openWaDb } from "../db.ts";
import { handleContactsSet, handleHistorySetChunked, ingestMessage } from "../ingestion.ts";
import { createInstance } from "../instances.ts";
import { WaManager } from "../manager.ts";
import { createWaRouter, type WaRouter } from "../routes.ts";
import { makeFakeConnect, type FakeConnect } from "./_fakes.ts";

const INST = "wahist00aaaa";

function historyPayload() {
  return {
    contacts: [
      { id: "5511@s.whatsapp.net", name: "Agenda Ana", notify: "PushAna" },
      { id: "5522@s.whatsapp.net", verifiedName: "Empresa Bravo" },
    ],
    chats: [{ id: "5511@s.whatsapp.net", name: "Ana", conversationTimestamp: 500 }],
    messages: [
      { key: { remoteJid: "5511@s.whatsapp.net", id: "h1" }, message: { conversation: "primeira" }, messageTimestamp: 100 },
      { key: { remoteJid: "5511@s.whatsapp.net", id: "h2" }, message: { conversation: "segunda" }, messageTimestamp: 200 },
      { key: { remoteJid: "5511@s.whatsapp.net", id: "h3" }, message: { conversation: "terceira" }, messageTimestamp: 300 },
    ],
  };
}

describe("history sync ingestion", () => {
  test("handleHistorySetChunked ingests messages + contacts (with names)", async () => {
    const db = openWaDb(":memory:");
    const res = await handleHistorySetChunked(db, INST, historyPayload(), { chunkSize: 2 });
    expect(res).toEqual({ chats: 1, contacts: 2, messages: 3 });

    const msgCount = db.query("SELECT count(*) c FROM messages WHERE instance_id = ?").get(INST) as { c: number };
    expect(msgCount.c).toBe(3);
    // address-book name landed as display_name (the "saved" signal)
    const ana = db.query("SELECT display_name, notify_name FROM contacts WHERE jid = '5511@s.whatsapp.net'").get() as {
      display_name: string | null;
      notify_name: string | null;
    };
    expect(ana).toEqual({ display_name: "Agenda Ana", notify_name: "PushAna" });
    // verified-only contact is NOT saved (display_name null)
    const bravo = db.query("SELECT display_name, verified_name FROM contacts WHERE jid = '5522@s.whatsapp.net'").get() as {
      display_name: string | null;
      verified_name: string;
    };
    expect(bravo.display_name).toBeNull();
    expect(bravo.verified_name).toBe("Empresa Bravo");
  });

  test("chunking is deterministic regardless of chunk size", async () => {
    const a = openWaDb(":memory:");
    const b = openWaDb(":memory:");
    const r1 = await handleHistorySetChunked(a, INST, historyPayload(), { chunkSize: 1 });
    const r2 = await handleHistorySetChunked(b, INST, historyPayload(), { chunkSize: 999 });
    expect(r1).toEqual(r2);
  });

  test("handleContactsSet writes display_name (the initial address book)", () => {
    const db = openWaDb(":memory:");
    const n = handleContactsSet(db, INST, [
      { id: "5533@s.whatsapp.net", name: "Contato Salvo", notify: "push", verifiedName: "V" },
    ]);
    expect(n).toBe(1);
    const row = db.query("SELECT display_name, notify_name, verified_name FROM contacts WHERE jid='5533@s.whatsapp.net'").get();
    expect(row).toEqual({ display_name: "Contato Salvo", notify_name: "push", verified_name: "V" });
  });
});

// ---------------------------------------------------------------------------
// Lazy-load pagination through the router.
// ---------------------------------------------------------------------------

interface Harness {
  router: WaRouter;
  fake: FakeConnect;
  waDb: Database;
  instanceId: string;
}

function harness(connected = true): Harness {
  const waDb = openWaDb(":memory:");
  const coreDb = openDb(":memory:");
  const fake = makeFakeConnect();
  const manager = new WaManager({ db: waDb, config: WA_CONFIG, connect: fake.connect, now: () => 1_000_000 });
  const router = createWaRouter({ waDb, coreDb, config: WA_CONFIG, manager });
  const instanceId = createInstance(waDb).id;
  if (connected) {
    manager.start(instanceId);
    fake.cb(instanceId).onOpen!("5599@s.whatsapp.net");
  }
  return { router, fake, waDb, instanceId };
}

function seedMessages(waDb: Database, id: string, jid: string, count: number): void {
  for (let i = 1; i <= count; i++) {
    ingestMessage(waDb, id, { key: { remoteJid: jid, id: `m${i}` }, message: { conversation: `msg ${i}` }, messageTimestamp: i * 10 }, "live");
  }
}

async function get(router: WaRouter, path: string): Promise<any> {
  const req = new Request(`http://localhost${path}`);
  const res = await router.handle(req, new URL(req.url));
  return (await res.json()) as any;
}

describe("GET messages pagination (before + has_more/fetching)", () => {
  const JID = "5511@s.whatsapp.net";

  test("no cursor returns the most recent page, ascending, has_more when older exist", async () => {
    const { router, waDb, instanceId } = harness();
    seedMessages(waDb, instanceId, JID, 50);
    const res = await get(router, `/api/wa/chats/${encodeURIComponent(JID)}/messages?instance=${instanceId}&limit=20`);
    expect(res.messages).toHaveLength(20);
    // ascending, ending on the most recent (m50)
    expect(res.messages[0].id).toBe("m31");
    expect(res.messages[19].id).toBe("m50");
    expect(res.has_more).toBe(true); // 30 older still in the mirror
    expect(res.fetching).toBe(false);
  });

  test("before paginates older messages from the mirror", async () => {
    const { router, waDb, instanceId } = harness();
    seedMessages(waDb, instanceId, JID, 50);
    // oldest loaded so far is m31 (ts 310) → ask for the 20 before it
    const res = await get(router, `/api/wa/chats/${encodeURIComponent(JID)}/messages?instance=${instanceId}&limit=20&before=310`);
    expect(res.messages).toHaveLength(20);
    expect(res.messages[0].id).toBe("m11");
    expect(res.messages[19].id).toBe("m30");
    expect(res.has_more).toBe(true); // m1..m10 still older
  });

  test("mirror exhausted while connected → triggers fetchMessageHistory with the oldest key/ts; fetching=true", async () => {
    const { router, fake, waDb, instanceId } = harness();
    seedMessages(waDb, instanceId, JID, 10);
    // page before m1 (ts 10) → nothing older in the mirror
    const res = await get(router, `/api/wa/chats/${encodeURIComponent(JID)}/messages?instance=${instanceId}&limit=20&before=10`);
    expect(res.messages).toHaveLength(0);
    expect(res.fetching).toBe(true);
    expect(res.has_more).toBe(true);
    const fetches = fake.sock(instanceId).historyFetches;
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.key).toEqual({ remoteJid: JID, id: "m1", fromMe: false }); // oldest message anchor
    expect(fetches[0]!.ts).toBe(10);
  });

  test("mirror exhausted but NOT connected → has_more:false (no fetch possible)", async () => {
    const { router, waDb, instanceId } = harness(false); // never opened
    seedMessages(waDb, instanceId, JID, 5);
    const res = await get(router, `/api/wa/chats/${encodeURIComponent(JID)}/messages?instance=${instanceId}&limit=10&before=10`);
    expect(res.has_more).toBe(false);
    expect(res.fetching).toBe(false);
  });

  test("repeated exhausted request with no new data settles to has_more:false (real end)", async () => {
    // manager with a controllable clock to cross the settle window
    const waDb = openWaDb(":memory:");
    const coreDb = openDb(":memory:");
    const fake = makeFakeConnect();
    let clock = 1_000_000;
    const manager = new WaManager({ db: waDb, config: WA_CONFIG, connect: fake.connect, now: () => clock });
    const router = createWaRouter({ waDb, coreDb, config: WA_CONFIG, manager });
    const instanceId = createInstance(waDb).id;
    manager.start(instanceId);
    fake.cb(instanceId).onOpen!("x@s.whatsapp.net");
    seedMessages(waDb, instanceId, JID, 3);

    // first exhausted request → triggers a fetch
    const first = await get(router, `/api/wa/chats/${encodeURIComponent(JID)}/messages?instance=${instanceId}&limit=10&before=10`);
    expect(first.fetching).toBe(true);
    expect(fake.sock(instanceId).historyFetches).toHaveLength(1);

    // same request immediately after → still within settle window → pending (keep polling)
    const pending = await get(router, `/api/wa/chats/${encodeURIComponent(JID)}/messages?instance=${instanceId}&limit=10&before=10`);
    expect(pending.fetching).toBe(true);
    expect(fake.sock(instanceId).historyFetches).toHaveLength(1); // not re-fetched

    // advance past the settle window with still no new data → real end
    clock += 9000;
    const done = await get(router, `/api/wa/chats/${encodeURIComponent(JID)}/messages?instance=${instanceId}&limit=10&before=10`);
    expect(done.has_more).toBe(false);
    expect(done.fetching).toBe(false);
  });
});
