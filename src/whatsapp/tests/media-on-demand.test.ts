// media-on-demand phase: nothing downloads by default. `cached` flag in the
// messages list, per-chat media summary, bulk download job (concurrency 2,
// one per chat, size cap) and media recovery via on-demand history sync
// (re-delivered messages store their keys even when already mirrored).
// Offline: fake socket (_fakes.ts), fake downloader, temp media dir.
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../db/index.ts";
import type { WaConfig } from "../config.ts";
import { openWaDb } from "../db.ts";
import { handleMessagesUpsert, ingestMessage } from "../ingestion.ts";
import { WaManager } from "../manager.ts";
import { getMessageMedia, MAX_DOWNLOAD_BYTES, resolveStoredPath, type MediaDownloader } from "../media.ts";
import { mediaSummary } from "../media-jobs.ts";
import { createWaRouter, type WaRouter } from "../routes.ts";
import { makeFakeConnect, tick, type FakeConnect } from "./_fakes.ts";

const CHAT = "5581999990000@s.whatsapp.net";
const JSON_HEADERS = { "Content-Type": "application/json" };
const FILE_BYTES = new TextEncoder().encode("0123456789abcdefghij"); // 20 bytes

const config: WaConfig = {
  quiet_hours: { enabled: false, start: "21:00", end: "08:00", timezone: "America/Sao_Paulo" },
  rate_limit: { max_per_minute: 1000, max_per_hour: 1000, min_interval_seconds: 0, jitter_seconds: 0 },
  validation: { max_batch_size: 20 },
};

interface Harness {
  router: WaRouter;
  fake: FakeConnect;
  manager: WaManager;
  waDb: Database;
  downloads: string[];
  maxConcurrent: number;
  /** Resolves every pending download when called (for "slow" harnesses). */
  release: () => void;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeHarness(opts: { slow?: boolean; failIds?: string[] } = {}): Harness {
  const waDb = openWaDb(":memory:");
  const fake = makeFakeConnect();
  const manager = new WaManager({ db: waDb, config, connect: fake.connect });
  const dir = mkdtempSync(join(tmpdir(), "wa-media-od-"));
  dirs.push(dir);
  let releaseAll: () => void = () => {};
  const gate = new Promise<void>((resolve) => (releaseAll = resolve));
  const h: Harness = {
    router: null as unknown as WaRouter,
    fake,
    manager,
    waDb,
    downloads: [],
    maxConcurrent: 0,
    release: () => releaseAll(),
  };
  let active = 0;
  const downloader: MediaDownloader = async (message) => {
    const id = String(message.key.id);
    h.downloads.push(id);
    active++;
    h.maxConcurrent = Math.max(h.maxConcurrent, active);
    try {
      if (opts.slow) await gate;
      else await tick(5);
      if (opts.failIds?.includes(id)) throw new Error("boom");
    } finally {
      active--;
    }
    return (async function* () {
      yield FILE_BYTES;
    })();
  };
  h.router = createWaRouter({ waDb, coreDb: openDb(":memory:"), config, manager, mediaDir: dir, downloader });
  return h;
}

async function call(h: Harness, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = JSON_HEADERS;
  }
  const req = new Request(`http://localhost${path}`, init);
  const res = await h.router.handle(req, new URL(req.url));
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function connected(h: Harness): Promise<string> {
  const id = (await call(h, "POST", "/api/wa/instances")).json.id as string;
  h.fake.cb(id).onOpen!("5511000000000@s.whatsapp.net");
  return id;
}

function imageMessage(id: string, ts: number, extra: Record<string, unknown> = {}) {
  return {
    key: { remoteJid: CHAT, id, fromMe: false },
    messageTimestamp: ts,
    message: {
      imageMessage: {
        url: "https://mmg.example/x",
        directPath: "/v/t62/x",
        mediaKey: new Uint8Array([7, 7, 7, 7]),
        mimetype: "image/jpeg",
        fileLength: 20,
        ...extra,
      },
    },
  };
}

function textMessage(id: string, ts: number, text: string) {
  return { key: { remoteJid: CHAT, id, fromMe: false }, messageTimestamp: ts, message: { conversation: text } };
}

/** A message mirrored before the media update: the row exists, no message_media. */
function legacyMedia(db: Database, instance: string, id: string, ts: number, type = "imageMessage"): void {
  db.query(
    `INSERT INTO messages (instance_id, chat_jid, message_id, from_me, sender_jid, timestamp, message_type, text_content, status, source, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, NULL, NULL, 'history', '2026-01-01T00:00:00Z')`,
  ).run(instance, CHAT, id, CHAT, ts, type);
}

const chatPath = (suffix: string) => `/api/wa/chats/${encodeURIComponent(CHAT)}/${suffix}`;

async function pollJob(h: Harness, jobId: string) {
  for (let i = 0; i < 100; i++) {
    const r = await call(h, "GET", `/api/wa/media-jobs/${jobId}`);
    if (r.json.status !== "running") return r.json;
    await tick(10);
  }
  throw new Error("job never finished");
}

describe("cached flag in the messages list", () => {
  test("false until downloaded, true after, false again if the file is gone", async () => {
    const h = makeHarness();
    const id = await connected(h);
    ingestMessage(h.waDb, id, imageMessage("img", 100), "live");
    const list = async () => (await call(h, "GET", `${chatPath("messages")}?instance=${id}`)).json.messages[0].media;
    expect(await list()).toMatchObject({ available: true, cached: false });
    expect(h.downloads).toEqual([]); // listing downloads nothing
    await call(h, "GET", `/api/wa/messages/media?instance=${id}&chat=${encodeURIComponent(CHAT)}&id=img&from_me=0`);
    expect(await list()).toMatchObject({ available: true, cached: true });
    const row = getMessageMedia(h.waDb, { instance: id, chat: CHAT, id: "img", fromMe: false })!;
    rmSync(resolveStoredPath(row.cache_path!));
    expect(await list()).toMatchObject({ available: true, cached: false });
  });
});

describe("GET /api/wa/chats/:jid/media-summary", () => {
  test("counts cached, downloadable (known and unknown size) and unavailable", async () => {
    const h = makeHarness();
    const id = await connected(h);
    ingestMessage(h.waDb, id, imageMessage("cached", 100), "live");
    ingestMessage(h.waDb, id, imageMessage("known", 101, { fileLength: 1000 }), "live");
    ingestMessage(h.waDb, id, imageMessage("unknown", 102, { fileLength: undefined }), "live");
    ingestMessage(h.waDb, id, imageMessage("nokeys", 103, { mediaKey: undefined }), "live");
    ingestMessage(h.waDb, id, textMessage("txt", 104, "oi"), "live");
    legacyMedia(h.waDb, id, "legacy", 50, "documentMessage");
    await call(h, "GET", `/api/wa/messages/media?instance=${id}&chat=${encodeURIComponent(CHAT)}&id=cached&from_me=0`);

    const r = await call(h, "GET", `${chatPath("media-summary")}?instance=${id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      total: 5,
      cached: 1,
      downloadable: 2,
      unavailable: 2,
      downloadable_bytes: 1000,
      unknown_size_count: 1,
      cached_bytes: FILE_BYTES.length,
    });
    expect((await call(h, "GET", `${chatPath("media-summary")}?instance=nope`)).status).toBe(400);
  });
});

describe("POST /api/wa/chats/:jid/media/download + GET /api/wa/media-jobs/:id", () => {
  test("downloads every downloadable media with concurrency 2; then the list shows them cached", async () => {
    const h = makeHarness({ failIds: ["bad"] });
    const id = await connected(h);
    for (let i = 0; i < 5; i++) ingestMessage(h.waDb, id, imageMessage(`m${i}`, 100 + i), "live");
    ingestMessage(h.waDb, id, imageMessage("bad", 200), "live");
    ingestMessage(h.waDb, id, imageMessage("huge", 201, { fileLength: MAX_DOWNLOAD_BYTES + 1 }), "live");
    legacyMedia(h.waDb, id, "legacy", 50);

    const start = await call(h, "POST", chatPath("media/download"), { instance: id });
    expect(start.status).toBe(202);
    const job = await pollJob(h, start.json.job_id);
    expect(job).toMatchObject({ status: "done", total: 7, done: 5, failed: 2, bytes: 5 * FILE_BYTES.length });
    expect(job.errors).toEqual(
      expect.arrayContaining([
        { message_id: "bad", code: "download_failed" },
        { message_id: "huge", code: "too_large" },
      ]),
    );
    expect(h.maxConcurrent).toBe(2);
    expect(h.downloads).not.toContain("huge"); // skipped before any transfer
    expect(mediaSummary(h.waDb, id, CHAT)).toMatchObject({ cached: 5, downloadable: 2, unavailable: 1 });
    const msgs = (await call(h, "GET", `${chatPath("messages")}?instance=${id}`)).json.messages;
    expect(msgs.find((m: any) => m.id === "m0").media.cached).toBe(true);
  });

  test("one job per chat (409 with job_id); 409 when disconnected; 404 unknown job; 415/400", async () => {
    const h = makeHarness({ slow: true });
    const id = await connected(h);
    ingestMessage(h.waDb, id, imageMessage("a", 100), "live");
    const first = await call(h, "POST", chatPath("media/download"), { instance: id });
    expect(first.status).toBe(202);
    const second = await call(h, "POST", chatPath("media/download"), { instance: id });
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({ code: "job_running", job_id: first.json.job_id });
    expect((await call(h, "GET", `/api/wa/media-jobs/${first.json.job_id}`)).json).toMatchObject({ status: "running", total: 1, done: 0 });
    h.release();
    expect(await pollJob(h, first.json.job_id)).toMatchObject({ status: "done", done: 1 });
    // Finished → a new job is allowed (nothing left to download).
    const third = await call(h, "POST", chatPath("media/download"), { instance: id });
    expect(third.status).toBe(202);
    expect(await pollJob(h, third.json.job_id)).toMatchObject({ status: "done", total: 0 });

    h.manager.disconnect(id);
    const offline = await call(h, "POST", chatPath("media/download"), { instance: id });
    expect(offline.status).toBe(409);
    expect(offline.json.code).toBe("not_connected");
    expect(offline.json.error).toContain("desconectado");

    expect((await call(h, "GET", "/api/wa/media-jobs/nope")).status).toBe(404);
    const req = new Request(`http://localhost${chatPath("media/download")}`, { method: "POST", body: "x" });
    expect((await h.router.handle(req, new URL(req.url))).status).toBe(415);
    expect((await call(h, "POST", chatPath("media/download"), { instance: "nope" })).status).toBe(400);
  });
});

describe("ingestion: a re-delivery of an already mirrored message stores its media keys", () => {
  test("history set and messages.upsert (append/notify) fill message_media for existing rows", () => {
    const db = openWaDb(":memory:");
    legacyMedia(db, "i1", "h1", 10);
    legacyMedia(db, "i1", "u1", 11);
    expect(getMessageMedia(db, { instance: "i1", chat: CHAT, id: "h1", fromMe: false })).toBeNull();
    ingestMessage(db, "i1", imageMessage("h1", 10), "history");
    handleMessagesUpsert(db, "i1", { messages: [imageMessage("u1", 11)] });
    for (const id of ["h1", "u1"]) {
      expect(getMessageMedia(db, { instance: "i1", chat: CHAT, id, fromMe: false })?.raw_json).not.toBeNull();
    }
    const n = db.query("SELECT count(*) AS n FROM messages WHERE chat_jid = ?").get(CHAT) as { n: number };
    expect(n.n).toBe(2); // no duplicate rows
  });

  test("an older history message never replaces the chat preview", () => {
    const db = openWaDb(":memory:");
    ingestMessage(db, "i1", textMessage("new", 500, "mais recente"), "live");
    ingestMessage(db, "i1", textMessage("old", 10, "antiga"), "history");
    const chat = db.query("SELECT last_message_text, last_message_at FROM chats WHERE jid = ?").get(CHAT);
    expect(chat).toEqual({ last_message_text: "mais recente", last_message_at: 500 });
  });
});

describe("POST /api/wa/chats/:jid/media/recover (on-demand history sync)", () => {
  /** Makes the fake phone answer each history request with `pages[n]` (null = silence). */
  function phoneAnswers(h: Harness, id: string, pages: Array<Array<Record<string, unknown>> | null>) {
    const sock = h.fake.sock(id);
    const original = sock.fetchMessageHistory;
    sock.fetchMessageHistory = async (count, key, ts) => {
      const requestId = await original(count, key, ts);
      const page = pages[sock.historyFetches.length - 1];
      if (page) {
        setTimeout(() => h.fake.cb(id).onHistorySet!({ messages: page, syncType: 7, peerDataRequestSessionId: requestId }), 5);
      }
      return requestId;
    };
  }

  test("anchored at the newest message (ms timestamp); re-delivered keys make the media downloadable", async () => {
    const h = makeHarness();
    const id = await connected(h);
    legacyMedia(h.waDb, id, "old-img", 100);
    ingestMessage(h.waDb, id, textMessage("newest", 900, "última"), "live");
    phoneAnswers(h, id, [[imageMessage("old-img", 100), textMessage("t", 120, "meio")]]);

    const r = await call(h, "POST", chatPath("media/recover"), { instance: id });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ requested: 1, recovered: 1, still_unavailable: 0 });
    expect(h.fake.sock(id).historyFetches).toEqual([{ count: 50, key: { remoteJid: CHAT, id: "newest", fromMe: false }, ts: 900_000 }]);
    expect(mediaSummary(h.waDb, id, CHAT)).toMatchObject({ downloadable: 1, unavailable: 0 });
    const chat = h.waDb.query("SELECT last_message_text FROM chats WHERE jid = ?").get(CHAT) as { last_message_text: string };
    expect(chat.last_message_text).toBe("última");
  });

  test("pages backwards from the oldest message of each batch until the oldest missing media is covered", async () => {
    const h = makeHarness();
    const id = await connected(h);
    legacyMedia(h.waDb, id, "a", 100);
    legacyMedia(h.waDb, id, "b", 300);
    ingestMessage(h.waDb, id, textMessage("newest", 900, "x"), "live");
    phoneAnswers(h, id, [
      [imageMessage("b", 300), textMessage("p1", 250, "y")],
      [imageMessage("a", 100), textMessage("p2", 90, "z")],
      [textMessage("never", 10, "w")],
    ]);
    const r = await h.manager.recoverChatMedia(id, CHAT, { timeoutMs: 2000 });
    expect(r).toEqual({ requested: 2, recovered: 2, still_unavailable: 0 });
    const fetches = h.fake.sock(id).historyFetches;
    expect(fetches[1]).toEqual({ count: 50, key: { remoteJid: CHAT, id: "p1", fromMe: false }, ts: 250_000 });
  });

  test("silent phone → stops at the timeout; empty answer → stops; nothing unavailable → no request", async () => {
    const h = makeHarness();
    const id = await connected(h);
    legacyMedia(h.waDb, id, "a", 100);
    ingestMessage(h.waDb, id, textMessage("newest", 900, "x"), "live");
    phoneAnswers(h, id, [null]);
    expect(await h.manager.recoverChatMedia(id, CHAT, { timeoutMs: 80 })).toEqual({ requested: 1, recovered: 0, still_unavailable: 1 });

    const h2 = makeHarness();
    const id2 = await connected(h2);
    legacyMedia(h2.waDb, id2, "a", 100);
    ingestMessage(h2.waDb, id2, textMessage("newest", 900, "x"), "live");
    phoneAnswers(h2, id2, [[], []]);
    expect(await h2.manager.recoverChatMedia(id2, CHAT, { timeoutMs: 2000 })).toEqual({ requested: 1, recovered: 0, still_unavailable: 1 });

    const h3 = makeHarness();
    const id3 = await connected(h3);
    ingestMessage(h3.waDb, id3, imageMessage("ok", 100), "live");
    const r = await call(h3, "POST", chatPath("media/recover"), { instance: id3 });
    expect(r.json).toEqual({ requested: 0, recovered: 0, still_unavailable: 0 });
    expect(h3.fake.sock(id3).historyFetches).toEqual([]);

    h3.manager.disconnect(id3);
    const offline = await call(h3, "POST", chatPath("media/recover"), { instance: id3 });
    expect(offline.status).toBe(409);
    expect(offline.json.code).toBe("not_connected");
  });

  test("one recovery per chat at a time", async () => {
    const h = makeHarness();
    const id = await connected(h);
    legacyMedia(h.waDb, id, "a", 100);
    ingestMessage(h.waDb, id, textMessage("newest", 900, "x"), "live");
    phoneAnswers(h, id, [null]);
    // The route uses the 45 s default: start it, check the lock, then let the phone answer.
    const first = call(h, "POST", chatPath("media/recover"), { instance: id });
    await tick(10);
    const second = await call(h, "POST", chatPath("media/recover"), { instance: id });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("recover_running");
    h.fake.cb(id).onHistorySet!({ messages: [imageMessage("a", 100)], syncType: 7 });
    expect((await first).json).toEqual({ requested: 1, recovered: 1, still_unavailable: 0 });
  });
});
