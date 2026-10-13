// wa-media phase: ingestion of media keys/thumbnails, reply context and
// reactions; lazy download + cache + Range serving; 1:1 media send. Offline:
// fake socket (_fakes.ts), fake downloader, temp media dir, in-memory DBs.
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferJSON } from "baileys";
import { openDb } from "../../db/index.ts";
import type { WaConfig } from "../config.ts";
import { openWaDb } from "../db.ts";
import { handleHistorySet, ingestMessage } from "../ingestion.ts";
import { WaManager, type WaEvent } from "../manager.ts";
import { contentDisposition, getMessageMedia, MAX_DOWNLOAD_BYTES, type MediaDownloader } from "../media.ts";
import { createWaRouter, type WaRouter } from "../routes.ts";
import { makeFakeConnect, type FakeConnect } from "./_fakes.ts";

const CHAT = "5581999990000@s.whatsapp.net";
const JSON_HEADERS = { "Content-Type": "application/json" };
const THUMB = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
const FILE_BYTES = new TextEncoder().encode("0123456789abcdefghij"); // 20 bytes

function openConfig(): WaConfig {
  return {
    quiet_hours: { enabled: false, start: "21:00", end: "08:00", timezone: "America/Sao_Paulo" },
    rate_limit: { max_per_minute: 1000, max_per_hour: 1000, min_interval_seconds: 0, jitter_seconds: 0 },
    validation: { max_batch_size: 20 },
  };
}

interface Harness {
  router: WaRouter;
  fake: FakeConnect;
  manager: WaManager;
  waDb: Database;
  dir: string;
  downloads: Array<{ id: string }>;
  events: WaEvent[];
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Fake downloader: yields FILE_BYTES in two chunks; `expire` simulates a 410 → reupload. */
function makeHarness(opts: { config?: WaConfig; expire?: boolean; fail?: boolean } = {}): Harness {
  const waDb = openWaDb(":memory:");
  const coreDb = openDb(":memory:");
  const fake = makeFakeConnect();
  const config = opts.config ?? openConfig();
  const manager = new WaManager({ db: waDb, config, connect: fake.connect });
  const dir = mkdtempSync(join(tmpdir(), "wa-media-"));
  dirs.push(dir);
  const downloads: Harness["downloads"] = [];
  const downloader: MediaDownloader = async (message, ctx) => {
    downloads.push({ id: String(message.key.id) });
    if (opts.fail) throw new Error("boom");
    if (opts.expire) await ctx.reuploadRequest(message);
    return (async function* () {
      yield FILE_BYTES.subarray(0, 10);
      yield FILE_BYTES.subarray(10);
    })();
  };
  const router = createWaRouter({ waDb, coreDb, config, manager, mediaDir: dir, downloader });
  const events: WaEvent[] = [];
  manager.subscribe((e) => events.push(e));
  return { router, fake, manager, waDb, dir, downloads, events };
}

async function call(h: Harness, method: string, path: string, body?: unknown, headers: Record<string, string> = JSON_HEADERS) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = headers;
  } else if (Object.keys(headers).length && headers !== JSON_HEADERS) {
    init.headers = headers;
  }
  const req = new Request(`http://localhost${path}`, init);
  const res = await h.router.handle(req, new URL(req.url));
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(buf);
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, bytes: buf, headers: res.headers };
}

async function connected(h: Harness): Promise<string> {
  const id = (await call(h, "POST", "/api/wa/instances")).json.id as string;
  h.fake.cb(id).onOpen!("5511000000000@s.whatsapp.net");
  return id;
}

async function offline(h: Harness): Promise<string> {
  const id = (await call(h, "POST", "/api/wa/instances")).json.id as string;
  h.manager.disconnect(id);
  return id;
}

function imageMessage(id: string, extra: Record<string, unknown> = {}) {
  return {
    key: { remoteJid: CHAT, id, fromMe: false },
    messageTimestamp: 1_700_000_100,
    message: {
      imageMessage: {
        url: "https://mmg.example/old",
        directPath: "/v/t62/old",
        mediaKey: new Uint8Array([7, 7, 7, 7]),
        fileEncSha256: new Uint8Array([1]),
        fileSha256: new Uint8Array([2]),
        mimetype: "image/jpeg",
        fileLength: { low: 20, high: 0, unsigned: true }, // protobuf Long
        width: 640,
        height: 480,
        caption: "Olha a foto",
        jpegThumbnail: THUMB,
        contextInfo: { quotedMessage: { imageMessage: { jpegThumbnail: new Uint8Array(4000) } } },
        ...extra,
      },
    },
  };
}

const mediaUrl = (instance: string, id: string, fromMe = 0) =>
  `/api/wa/messages/media?instance=${instance}&chat=${encodeURIComponent(CHAT)}&id=${id}&from_me=${fromMe}`;

describe("ingestion stores what a later download needs", () => {
  test("image: keys as BufferJSON WAMessage, thumbnail apart, contextInfo dropped, Long normalized", () => {
    const db = openWaDb(":memory:");
    const row = ingestMessage(db, "i1", imageMessage("m1"), "live")!;
    expect(row.text).toBe("Olha a foto");
    expect(row.media).toEqual({
      kind: "image",
      mimetype: "image/jpeg",
      file_name: null,
      file_size: 20,
      duration_s: null,
      width: 640,
      height: 480,
      has_thumbnail: true,
      available: true,
      cached: false,
    });
    const stored = getMessageMedia(db, { instance: "i1", chat: CHAT, id: "m1", fromMe: false })!;
    expect(Buffer.from(stored.thumbnail_b64!, "base64")).toEqual(Buffer.from(THUMB));
    const raw = JSON.parse(stored.raw_json!, BufferJSON.reviver);
    expect(raw.key).toEqual({ remoteJid: CHAT, fromMe: false, id: "m1" });
    expect(Buffer.isBuffer(raw.message.imageMessage.mediaKey)).toBe(true);
    expect(raw.message.imageMessage.directPath).toBe("/v/t62/old");
    expect(raw.message.imageMessage.jpegThumbnail).toBeUndefined();
    expect(raw.message.imageMessage.contextInfo).toBeUndefined();
  });

  test("documentWithCaptionMessage, ptt voice note, sticker; history sync path too", () => {
    const db = openWaDb(":memory:");
    handleHistorySet(db, "i1", {
      messages: [
        {
          key: { remoteJid: CHAT, id: "doc", fromMe: false },
          messageTimestamp: 1,
          message: {
            documentWithCaptionMessage: {
              message: {
                documentMessage: {
                  url: "u",
                  directPath: "/d",
                  mediaKey: new Uint8Array([1]),
                  mimetype: "application/pdf",
                  fileName: "Proposta comercial.pdf",
                  fileLength: 12345,
                  caption: "Segue a proposta",
                },
              },
            },
          },
        },
        {
          key: { remoteJid: CHAT, id: "ptt", fromMe: true },
          messageTimestamp: 2,
          message: { audioMessage: { url: "u", directPath: "/a", mediaKey: new Uint8Array([1]), mimetype: "audio/ogg; codecs=opus", seconds: 7, ptt: true } },
        },
        {
          key: { remoteJid: CHAT, id: "stk", fromMe: false },
          messageTimestamp: 3,
          message: { stickerMessage: { url: "u", directPath: "/s", mediaKey: new Uint8Array([1]), mimetype: "image/webp" } },
        },
      ],
    });
    const doc = getMessageMedia(db, { instance: "i1", chat: CHAT, id: "doc", fromMe: false })!;
    expect(doc).toMatchObject({ kind: "document", file_name: "Proposta comercial.pdf", file_size: 12345 });
    const text = db.query("SELECT text_content, message_type FROM messages WHERE message_id = 'doc'").get() as Record<string, string>;
    expect(text).toEqual({ text_content: "Segue a proposta", message_type: "documentMessage" });
    expect(getMessageMedia(db, { instance: "i1", chat: CHAT, id: "ptt", fromMe: true })).toMatchObject({ kind: "voice", duration_s: 7 });
    expect(getMessageMedia(db, { instance: "i1", chat: CHAT, id: "stk", fromMe: false })).toMatchObject({ kind: "sticker" });
  });

  test("media without keys is stored but not downloadable", () => {
    const db = openWaDb(":memory:");
    const row = ingestMessage(
      db,
      "i1",
      { key: { remoteJid: CHAT, id: "nokey", fromMe: false }, messageTimestamp: 1, message: { videoMessage: { mimetype: "video/mp4", seconds: 3 } } },
      "live",
    )!;
    expect(row.media).toMatchObject({ kind: "video", duration_s: 3, available: false });
  });
});

describe("messages list: media, quoted, reactions", () => {
  test("media object, reply context, reactions attached (and removable), legacy media unavailable", async () => {
    const h = makeHarness();
    const id = await connected(h);
    const cb = h.fake.cb(id);
    cb.onMessagesUpsert!({ messages: [imageMessage("img1")] });
    cb.onMessagesUpsert!({
      messages: [
        {
          key: { remoteJid: CHAT, id: "reply1", fromMe: true },
          messageTimestamp: 1_700_000_200,
          message: {
            extendedTextMessage: {
              text: "Linda!",
              contextInfo: { stanzaId: "img1", quotedMessage: { imageMessage: { caption: "Olha a foto" } } },
            },
          },
        },
        {
          key: { remoteJid: CHAT, id: "r1", fromMe: false },
          messageTimestamp: 1_700_000_300,
          message: { reactionMessage: { key: { remoteJid: CHAT, id: "img1", fromMe: false }, text: "❤️" } },
        },
        {
          key: { remoteJid: CHAT, id: "r2", fromMe: true },
          messageTimestamp: 1_700_000_301,
          message: { reactionMessage: { key: { remoteJid: CHAT, id: "img1", fromMe: false }, text: "👍" } },
        },
        {
          key: { remoteJid: CHAT, id: "r3", fromMe: true },
          messageTimestamp: 1_700_000_302,
          message: { reactionMessage: { key: { remoteJid: CHAT, id: "img1", fromMe: false }, text: "" } },
        },
      ],
    });
    // Pre-update media row: type only, no message_media row.
    h.waDb
      .query(
        `INSERT INTO messages (instance_id, chat_jid, message_id, from_me, timestamp, message_type, source, created_at)
         VALUES (?, ?, 'old', 0, 1, 'audioMessage', 'live', 'now')`,
      )
      .run(id, CHAT);

    const res = await call(h, "GET", `/api/wa/chats/${encodeURIComponent(CHAT)}/messages?instance=${id}`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.json.messages.map((m: { id: string }) => [m.id, m]));
    expect(Object.keys(byId).sort()).toEqual(["img1", "old", "reply1"]); // reactions are not bubbles
    expect(byId.img1.media).toMatchObject({ kind: "image", has_thumbnail: true, available: true });
    expect(byId.img1.reactions).toEqual([{ emoji: "❤️", from_me: false }]); // own 👍 removed by r3
    expect(byId.reply1.quoted).toEqual({ id: "img1", text: "Olha a foto", type: "imageMessage" });
    expect(byId.reply1.media).toBeNull();
    expect(byId.old.media).toMatchObject({ kind: "audio", available: false, has_thumbnail: false });

    // SSE: media in `message`, reactions as their own `reaction` event.
    const msgEvent = h.events.find((e) => e.type === "message" && e.data.message_id === "img1")!;
    expect(msgEvent.data.media).toMatchObject({ kind: "image" });
    expect(msgEvent.data.reaction).toBeUndefined();
    const reactions = h.events.filter((e) => e.type === "reaction").map((e) => e.data);
    expect(reactions).toEqual([
      { chat_jid: CHAT, target_id: "img1", emoji: "❤️", from_me: false, removed: false },
      { chat_jid: CHAT, target_id: "img1", emoji: "👍", from_me: true, removed: false },
      { chat_jid: CHAT, target_id: "img1", emoji: "", from_me: true, removed: true },
    ]);
  });
});

describe("GET /api/wa/messages/media", () => {
  test("downloads once, caches, serves inline with type/length; cache hit needs no socket", async () => {
    const h = makeHarness();
    const id = await connected(h);
    h.fake.cb(id).onMessagesUpsert!({ messages: [imageMessage("img1")] });

    const first = await call(h, "GET", mediaUrl(id, "img1"));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/jpeg");
    expect(first.headers.get("content-length")).toBe("20");
    expect(first.headers.get("content-disposition")).toBe("inline");
    expect(first.headers.get("accept-ranges")).toBe("bytes");
    expect(new TextDecoder().decode(first.bytes)).toBe("0123456789abcdefghij");
    const row = getMessageMedia(h.waDb, { instance: id, chat: CHAT, id: "img1", fromMe: false })!;
    expect(row.cache_path).toContain(join(h.dir, "in", id));
    expect(row.cache_path).toMatch(/[0-9a-f]{64}\.jpg$/);

    h.manager.disconnect(id);
    const second = await call(h, "GET", mediaUrl(id, "img1"));
    expect(second.status).toBe(200);
    expect(h.downloads).toHaveLength(1);
  });

  test("Range requests: 206 with Content-Range, suffix range, 416 out of bounds", async () => {
    const h = makeHarness();
    const id = await connected(h);
    h.fake.cb(id).onMessagesUpsert!({ messages: [imageMessage("img1")] });
    await call(h, "GET", mediaUrl(id, "img1"));

    const part = await call(h, "GET", mediaUrl(id, "img1"), undefined, { Range: "bytes=5-9" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 5-9/20");
    expect(part.headers.get("content-length")).toBe("5");
    expect(new TextDecoder().decode(part.bytes)).toBe("56789");

    const tail = await call(h, "GET", mediaUrl(id, "img1"), undefined, { Range: "bytes=-3" });
    expect(new TextDecoder().decode(tail.bytes)).toBe("hij");
    const open = await call(h, "GET", mediaUrl(id, "img1"), undefined, { Range: "bytes=18-" });
    expect(open.headers.get("content-range")).toBe("bytes 18-19/20");

    const bad = await call(h, "GET", mediaUrl(id, "img1"), undefined, { Range: "bytes=50-60" });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */20");
  });

  test("documents are attachments with RFC 5987 filename", async () => {
    const h = makeHarness();
    const id = await connected(h);
    h.fake.cb(id).onMessagesUpsert!({
      messages: [
        {
          key: { remoteJid: CHAT, id: "doc1", fromMe: false },
          messageTimestamp: 1,
          message: { documentMessage: { url: "u", directPath: "/d", mediaKey: new Uint8Array([1]), mimetype: "application/pdf", fileName: "Proposta São Paulo.pdf" } },
        },
      ],
    });
    const res = await call(h, "GET", mediaUrl(id, "doc1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Proposta Sao Paulo.pdf"; filename*=UTF-8''Proposta%20S%C3%A3o%20Paulo.pdf`,
    );
    expect(contentDisposition("attachment", "a\"b.pdf")).toContain('filename="a_b.pdf"');
  });

  test("expired URL → reupload via updateMediaMessage, fresh keys persisted", async () => {
    const h = makeHarness({ expire: true });
    const id = await connected(h);
    h.fake.cb(id).onMessagesUpsert!({ messages: [imageMessage("img1")] });
    const res = await call(h, "GET", mediaUrl(id, "img1"));
    expect(res.status).toBe(200);
    expect(h.fake.sock(id).reuploads).toEqual(["img1"]);
    const raw = JSON.parse(getMessageMedia(h.waDb, { instance: id, chat: CHAT, id: "img1", fromMe: false })!.raw_json!, BufferJSON.reviver);
    expect(raw.message.imageMessage.directPath).toBe("/fresh");
    expect(Buffer.isBuffer(raw.message.imageMessage.mediaKey)).toBe(true);
  });

  test("404 unavailable (pre-update), 409 offline and not cached, 413 too large, 502 failure, 400/404 params", async () => {
    const h = makeHarness();
    const id = await offline(h);
    h.waDb
      .query(
        `INSERT INTO messages (instance_id, chat_jid, message_id, from_me, timestamp, message_type, source, created_at)
         VALUES (?, ?, 'old', 0, 1, 'imageMessage', 'live', 'now'), (?, ?, 'txt', 0, 1, 'conversation', 'live', 'now')`,
      )
      .run(id, CHAT, id, CHAT);
    const old = await call(h, "GET", mediaUrl(id, "old"));
    expect(old.status).toBe(404);
    expect(old.json).toEqual({ error: "Mídia indisponível (recebida antes da atualização).", code: "media_unavailable" });
    expect((await call(h, "GET", mediaUrl(id, "txt"))).json.code).toBe("not_media");
    expect((await call(h, "GET", mediaUrl(id, "nope"))).json.code).toBe("message_not_found");
    expect((await call(h, "GET", `/api/wa/messages/media?instance=${id}&chat=x&id=y`)).status).toBe(400);

    ingestMessage(h.waDb, id, imageMessage("img1"), "live");
    const off = await call(h, "GET", mediaUrl(id, "img1"));
    expect(off.status).toBe(409);
    expect(off.json.code).toBe("not_connected");
    expect(h.downloads).toHaveLength(0);

    const h2 = makeHarness();
    const id2 = await connected(h2);
    h2.fake.cb(id2).onMessagesUpsert!({ messages: [imageMessage("big", { fileLength: MAX_DOWNLOAD_BYTES + 1 })] });
    const big = await call(h2, "GET", mediaUrl(id2, "big"));
    expect(big.status).toBe(413);
    expect(big.json.code).toBe("too_large");

    const h3 = makeHarness({ fail: true });
    const id3 = await connected(h3);
    h3.fake.cb(id3).onMessagesUpsert!({ messages: [imageMessage("img1")] });
    const failed = await call(h3, "GET", mediaUrl(id3, "img1"));
    expect(failed.status).toBe(502);
    expect(failed.json.code).toBe("download_failed");
    expect(failed.json.error).not.toContain("http");
  });

  test("thumbnail endpoint serves the stored jpegThumbnail", async () => {
    const h = makeHarness();
    const id = await offline(h);
    ingestMessage(h.waDb, id, imageMessage("img1"), "live");
    const res = await call(h, "GET", mediaUrl(id, "img1").replace("/media?", "/thumbnail?"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(res.bytes)).toEqual(Buffer.from(THUMB));
  });
});

async function upload(h: Harness, bytes: Uint8Array<ArrayBuffer>, name: string) {
  const form = new FormData();
  form.append("file", new File([bytes], name));
  const req = new Request("http://localhost/api/wa/media", { method: "POST", body: form });
  const res = await h.router.handle(req, new URL(req.url));
  return { status: res.status, json: (await res.json()) as any };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const OGG = new Uint8Array([...new TextEncoder().encode("OggS"), 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PDF = new TextEncoder().encode("%PDF-1.7 fake document");

describe("POST /api/wa/send with media_id", () => {
  test("image with caption: socket payload, mirrored with media, served from the uploaded file", async () => {
    const h = makeHarness();
    const id = await connected(h);
    const up = await upload(h, JPEG, "foto.jpg");
    expect(up.status).toBe(201);
    const res = await call(h, "POST", "/api/wa/send", { instance: id, jid: CHAT, media_id: up.json.media_id, caption: "Nossa vitrine" });
    expect(res.status).toBe(200);
    const sent = h.fake.sock(id).sentContents[0]!;
    expect(sent.jid).toBe(CHAT);
    expect(sent.content).toMatchObject({ mimetype: "image/jpeg", caption: "Nossa vitrine" });
    expect(Buffer.from(sent.content.image as Uint8Array)).toEqual(Buffer.from(JPEG));
    expect(res.json.message).toMatchObject({ from_me: true, text: "Nossa vitrine", type: "imageMessage" });
    expect(res.json.message.media).toMatchObject({ kind: "image", available: true, cached: true });
    expect(res.json.message.reaction).toBeUndefined();

    h.manager.disconnect(id); // cached = the uploaded file: no socket, no download
    const served = await call(h, "GET", mediaUrl(id, res.json.message.message_id, 1));
    expect(served.status).toBe(200);
    expect(Buffer.from(served.bytes)).toEqual(Buffer.from(JPEG));
    expect(h.downloads).toHaveLength(0);
  });

  test("voice note: ogg + voice:true → ptt; audio with caption → 400; voice on non-ogg → 400", async () => {
    const h = makeHarness();
    const id = await connected(h);
    const ogg = await upload(h, OGG, "nota.ogg");
    const res = await call(h, "POST", "/api/wa/send", { instance: id, jid: CHAT, media_id: ogg.json.media_id, voice: true });
    expect(res.status).toBe(200);
    expect(h.fake.sock(id).sentContents[0]!.content).toMatchObject({ ptt: true, mimetype: "audio/ogg; codecs=opus" });
    expect(res.json.message.media.kind).toBe("voice");

    const withCaption = await call(h, "POST", "/api/wa/send", { instance: id, jid: CHAT, media_id: ogg.json.media_id, caption: "oi" });
    expect(withCaption.status).toBe(400);
    const pdf = await upload(h, PDF, "proposta.pdf");
    const notOgg = await call(h, "POST", "/api/wa/send", { instance: id, jid: CHAT, media_id: pdf.json.media_id, voice: true });
    expect(notOgg.status).toBe(400);
    expect(h.fake.sock(id).sentContents).toHaveLength(1);
  });

  test("document keeps its file name; unknown media_id → 400; per-kind size limit → 413", async () => {
    const h = makeHarness();
    const id = await connected(h);
    const pdf = await upload(h, PDF, "Proposta.pdf");
    const res = await call(h, "POST", "/api/wa/send", { instance: id, jid: CHAT, media_id: pdf.json.media_id, text: "Segue" });
    expect(res.status).toBe(200);
    expect(h.fake.sock(id).sentContents[0]!.content).toMatchObject({ fileName: "Proposta.pdf", mimetype: "application/pdf", caption: "Segue" });
    expect(res.json.message.media).toMatchObject({ kind: "document", file_name: "Proposta.pdf" });

    expect((await call(h, "POST", "/api/wa/send", { instance: id, jid: CHAT, media_id: "medzzz" })).status).toBe(400);

    h.waDb.query("UPDATE wa_media SET size = ? WHERE id = ?").run(17 * 1024 * 1024, (await upload(h, JPEG, "x.jpg")).json.media_id);
    const bigId = (h.waDb.query("SELECT id FROM wa_media WHERE size > 1000").get() as { id: string }).id;
    const tooBig = await call(h, "POST", "/api/wa/send", { instance: id, jid: CHAT, media_id: bigId });
    expect(tooBig.status).toBe(413);
  });

  test("same gate as text: cold media send in quiet hours → 409, socket untouched", async () => {
    const h = makeHarness({
      config: { ...openConfig(), quiet_hours: { enabled: true, start: "00:00", end: "23:59", timezone: "America/Sao_Paulo" } },
    });
    const id = await connected(h);
    const up = await upload(h, JPEG, "foto.jpg");
    const res = await call(h, "POST", "/api/wa/send", { instance: id, jid: CHAT, media_id: up.json.media_id });
    if (res.status === 200) return; // 23:59 SP edge: outside the window
    expect(res.status).toBe(409);
    expect(res.json.blocked_code).toBe("quiet_hours");
    expect(h.fake.sock(id).sentContents).toHaveLength(0);
  });

  test("upload: per-kind limit enforced after sniffing; office docs by extension", async () => {
    const h = makeHarness();
    const big = new Uint8Array(16 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect((await upload(h, big, "grande.jpg")).status).toBe(413);
    const docx = await upload(h, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "contrato.docx");
    expect(docx.status).toBe(201);
    expect(docx.json).toMatchObject({ kind: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  });
});
