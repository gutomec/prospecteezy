// WhatsApp media (wa-media phase): what to persist at ingestion so a media
// message can be downloaded later, the lazy download + on-disk cache, and the
// HTTP serving (Content-Type/Length/Disposition + Range). Pure helpers over
// (db, payload) plus an injectable downloader, so tests run with no socket.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { BufferJSON, downloadMediaMessage, type WAMessage } from "baileys";
import { nowIso, PROJECT_ROOT, WA_MEDIA_DIR } from "./db.ts";

// WhatsApp size ceilings (outgoing). Incoming downloads share the document cap.
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = MAX_DOCUMENT_BYTES;
/** Stored raw WAMessage JSON larger than this is dropped (media not downloadable). */
export const MAX_RAW_JSON_CHARS = 32 * 1024;
/** jpegThumbnail larger than this (base64 chars) is not stored. */
export const MAX_THUMBNAIL_B64_CHARS = 96 * 1024;

export type MediaKind = "image" | "video" | "audio" | "voice" | "document" | "sticker";

/** Media descriptor exposed by the messages list and the SSE `message` event. */
export interface MediaView {
  kind: MediaKind;
  mimetype: string | null;
  file_name: string | null;
  file_size: number | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  has_thumbnail: boolean;
  /** Downloadable now or later: keys stored, or the file is already cached. */
  available: boolean;
  /** The file is already on disk: serving it downloads nothing. */
  cached: boolean;
}

/** Content keys that carry downloadable media. */
const MEDIA_TYPES = new Set(["imageMessage", "videoMessage", "ptvMessage", "audioMessage", "documentMessage", "stickerMessage"]);

export function isMediaType(type: string | null | undefined): boolean {
  return typeof type === "string" && MEDIA_TYPES.has(type);
}

/** Kind of a stored message_type (ptt audio → voice). */
export function kindOfType(type: string, ptt = false): MediaKind {
  switch (type) {
    case "imageMessage":
      return "image";
    case "videoMessage":
    case "ptvMessage":
      return "video";
    case "audioMessage":
      return ptt ? "voice" : "audio";
    case "stickerMessage":
      return "sticker";
    default:
      return "document";
  }
}

type AnyObj = Record<string, unknown>;

function asObj(v: unknown): AnyObj | null {
  return v && typeof v === "object" ? (v as AnyObj) : null;
}

/** protobuf Long | number | numeric string → number (null otherwise). */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  const o = asObj(v);
  if (o) {
    if (typeof o.toNumber === "function") return (o.toNumber as () => number)();
    if (typeof o.low === "number" && typeof o.high === "number") return o.high * 2 ** 32 + (o.low >>> 0);
  }
  return null;
}

function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string" && v.length > 0) return Buffer.from(v, "base64");
  const o = asObj(v);
  if (o?.type === "Buffer" && typeof o.data === "string") return Buffer.from(o.data, "base64");
  if (o?.type === "Buffer" && Array.isArray(o.data)) return Buffer.from(o.data as number[]);
  return null;
}

// Whitelisted node fields: what download/reupload/rendering need. Everything
// else (contextInfo with quoted payloads, scans, waveform…) is dropped.
const BYTE_FIELDS = ["mediaKey", "fileEncSha256", "fileSha256", "thumbnailSha256", "thumbnailEncSha256"] as const;
const SCALAR_FIELDS = ["url", "directPath", "mimetype", "fileName", "caption", "title", "thumbnailDirectPath"] as const;
const NUMBER_FIELDS = ["fileLength", "seconds", "width", "height", "mediaKeyTimestamp", "pageCount"] as const;
const BOOL_FIELDS = ["ptt", "gifPlayback", "isAnimated"] as const;

function storableNode(node: AnyObj): AnyObj {
  const out: AnyObj = {};
  for (const f of BYTE_FIELDS) {
    const b = toBytes(node[f]);
    if (b && b.length > 0) out[f] = Buffer.from(b);
  }
  for (const f of SCALAR_FIELDS) if (typeof node[f] === "string" && node[f]) out[f] = node[f];
  for (const f of NUMBER_FIELDS) {
    const n = toNumber(node[f]);
    if (n !== null) out[f] = n;
  }
  for (const f of BOOL_FIELDS) if (typeof node[f] === "boolean") out[f] = node[f];
  return out;
}

export interface ExtractedMedia {
  kind: MediaKind;
  mimetype: string | null;
  fileName: string | null;
  fileSize: number | null;
  durationS: number | null;
  width: number | null;
  height: number | null;
  thumbnailB64: string | null;
  /** BufferJSON WAMessage for downloadMediaMessage/updateMediaMessage, or null. */
  rawJson: string | null;
}

/**
 * Media metadata + the storable WAMessage of an (already unwrapped) content.
 * `key` is the original WAMessage key. Null for non-media content.
 */
export function extractMedia(
  inner: AnyObj | null,
  type: string | null,
  key: AnyObj,
  timestamp: number,
): ExtractedMedia | null {
  if (!inner || !type || !isMediaType(type)) return null;
  const node = asObj(inner[type]);
  if (!node) return null;
  const stored = storableNode(node);
  const downloadable = Boolean(stored.mediaKey) && Boolean(stored.directPath || stored.url);
  let rawJson: string | null = null;
  if (downloadable) {
    const msgKey: AnyObj = {};
    for (const f of ["remoteJid", "fromMe", "id", "participant", "remoteJidAlt", "participantAlt"]) {
      if (key[f] !== undefined && key[f] !== null) msgKey[f] = key[f];
    }
    const json = JSON.stringify({ key: msgKey, message: { [type]: stored }, messageTimestamp: timestamp }, BufferJSON.replacer);
    rawJson = json.length <= MAX_RAW_JSON_CHARS ? json : null;
  }
  const thumb = toBytes(node.jpegThumbnail);
  const thumbB64 = thumb && thumb.length > 0 ? Buffer.from(thumb).toString("base64") : null;
  return {
    kind: kindOfType(type, node.ptt === true),
    mimetype: typeof stored.mimetype === "string" ? stored.mimetype : null,
    fileName: typeof stored.fileName === "string" ? stored.fileName : null,
    fileSize: (stored.fileLength as number | undefined) ?? null,
    durationS: (stored.seconds as number | undefined) ?? null,
    width: (stored.width as number | undefined) ?? null,
    height: (stored.height as number | undefined) ?? null,
    thumbnailB64: thumbB64 && thumbB64.length <= MAX_THUMBNAIL_B64_CHARS ? thumbB64 : null,
    rawJson,
  };
}

export interface MediaKey {
  instance: string;
  chat: string;
  id: string;
  fromMe: boolean;
}

/** Upserts the media row; a re-delivery never erases keys/thumbnail/cache already stored. */
export function upsertMessageMedia(db: Database, k: MediaKey, m: ExtractedMedia): void {
  db.query(
    `INSERT INTO message_media (instance_id, chat_jid, message_id, from_me, kind, mimetype, file_name, file_size,
                                duration_s, width, height, thumbnail_b64, raw_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (instance_id, chat_jid, message_id, from_me) DO UPDATE SET
       kind          = excluded.kind,
       mimetype      = coalesce(excluded.mimetype, message_media.mimetype),
       file_name     = coalesce(excluded.file_name, message_media.file_name),
       file_size     = coalesce(excluded.file_size, message_media.file_size),
       duration_s    = coalesce(excluded.duration_s, message_media.duration_s),
       width         = coalesce(excluded.width, message_media.width),
       height        = coalesce(excluded.height, message_media.height),
       thumbnail_b64 = coalesce(excluded.thumbnail_b64, message_media.thumbnail_b64),
       raw_json      = coalesce(excluded.raw_json, message_media.raw_json),
       updated_at    = excluded.updated_at`,
  ).run(
    k.instance,
    k.chat,
    k.id,
    k.fromMe ? 1 : 0,
    m.kind,
    m.mimetype,
    m.fileName,
    m.fileSize,
    m.durationS,
    m.width,
    m.height,
    m.thumbnailB64,
    m.rawJson,
    nowIso(),
  );
}

export interface MessageMediaRow {
  instance_id: string;
  chat_jid: string;
  message_id: string;
  from_me: number;
  kind: MediaKind;
  mimetype: string | null;
  file_name: string | null;
  file_size: number | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  thumbnail_b64: string | null;
  raw_json: string | null;
  cache_path: string | null;
  cache_sha256: string | null;
}

export function getMessageMedia(db: Database, k: MediaKey): MessageMediaRow | null {
  return db
    .query("SELECT * FROM message_media WHERE instance_id = ? AND chat_jid = ? AND message_id = ? AND from_me = ?")
    .get(k.instance, k.chat, k.id, k.fromMe ? 1 : 0) as MessageMediaRow | null;
}

export function setMediaCache(db: Database, k: MediaKey, path: string, sha256: string | null): void {
  db.query(
    `UPDATE message_media SET cache_path = ?, cache_sha256 = ?, updated_at = ?
     WHERE instance_id = ? AND chat_jid = ? AND message_id = ? AND from_me = ?`,
  ).run(toStoredPath(path), sha256, nowIso(), k.instance, k.chat, k.id, k.fromMe ? 1 : 0);
}

function setMediaRaw(db: Database, k: MediaKey, rawJson: string): void {
  db.query(
    `UPDATE message_media SET raw_json = ?, updated_at = ?
     WHERE instance_id = ? AND chat_jid = ? AND message_id = ? AND from_me = ?`,
  ).run(rawJson, nowIso(), k.instance, k.chat, k.id, k.fromMe ? 1 : 0);
}

/** API view of a media row (or of a media-typed message with no row: unavailable). */
export function mediaView(row: MessageMediaRow | null, type: string | null): MediaView | null {
  if (!row) {
    if (!isMediaType(type)) return null;
    return {
      kind: kindOfType(type!),
      mimetype: null,
      file_name: null,
      file_size: null,
      duration_s: null,
      width: null,
      height: null,
      has_thumbnail: false,
      available: false,
      cached: false,
    };
  }
  const cached = isCached(row);
  return {
    kind: row.kind,
    mimetype: row.mimetype,
    file_name: row.file_name,
    file_size: row.file_size,
    duration_s: row.duration_s,
    width: row.width,
    height: row.height,
    has_thumbnail: row.thumbnail_b64 !== null,
    available: row.raw_json !== null || cached,
    cached,
  };
}

/** True when the row's cached file exists on disk. */
export function isCached(row: Pick<MessageMediaRow, "cache_path">): boolean {
  return row.cache_path !== null && existsSync(resolveStoredPath(row.cache_path));
}

/** Project-relative when inside the project (portable), absolute otherwise (tests' temp dirs). */
export function toStoredPath(abs: string): string {
  const rel = relative(PROJECT_ROOT, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? abs : rel;
}

export function resolveStoredPath(stored: string): string {
  return isAbsolute(stored) ? stored : join(PROJECT_ROOT, stored);
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "text/plain": "txt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
};

export function extensionFor(mimetype: string | null, fileName: string | null): string {
  const base = (mimetype ?? "").split(";")[0]!.trim().toLowerCase();
  if (EXT_BY_MIME[base]) return EXT_BY_MIME[base]!;
  const fromName = fileName?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  return fromName ? fromName.toLowerCase() : "bin";
}

// ---------------------------------------------------------------------------
// Download + cache
// ---------------------------------------------------------------------------

/** Socket surface the download needs (reupload of an expired media URL). */
export interface MediaSocket {
  updateMediaMessage: (message: WAMessage) => Promise<WAMessage>;
}

/** Downloads the decrypted bytes of a stored WAMessage. Injectable (tests). */
export type MediaDownloader = (
  message: WAMessage,
  ctx: { reuploadRequest: (message: WAMessage) => Promise<WAMessage> },
) => Promise<AsyncIterable<Uint8Array>>;

const silentLogger = {
  level: "silent",
  child() {
    return silentLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** WhatsApp's default media CDN host (Baileys DEF_MEDIA_HOST). */
const DEFAULT_MEDIA_HOST = "mmg.whatsapp.net";

function isDnsFailure(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/.test(String(e?.message ?? ""));
}

/** HTTP status carried by a Baileys/Boom download error, if any. */
export function httpStatusOf(error: unknown): number | null {
  const e = error as { status?: unknown; output?: { statusCode?: unknown } } | null;
  const status = e?.status ?? e?.output?.statusCode;
  return typeof status === "number" ? status : null;
}

/**
 * Real downloader: Baileys downloadMediaMessage (stream), with reupload on
 * 404/410 (handled by Baileys) and on 403, which WhatsApp's CDN now returns
 * for expired media URLs but Baileys does not treat as reupload-worthy.
 */
export function makeBaileysDownloader(downloadFn: typeof downloadMediaMessage = downloadMediaMessage): MediaDownloader {
  return async (message, ctx) => {
    const download = async (msg: WAMessage, options: { host?: string } = {}) =>
      (await downloadFn(msg, "stream", options, {
        reuploadRequest: ctx.reuploadRequest,
        logger: silentLogger as never,
      })) as unknown as AsyncIterable<Uint8Array>;
    let failure: unknown;
    try {
      return await download(message);
    } catch (error) {
      failure = error;
    }
    // Some media (notably stickers) carry a placeholder url host such as
    // a.whatsapp.net that does not resolve; retry on the default media host.
    if (isDnsFailure(failure)) {
      try {
        return await download(message, { host: DEFAULT_MEDIA_HOST });
      } catch (error) {
        failure = error;
      }
    }
    if (httpStatusOf(failure) !== 403) throw failure;
    const refreshed = await ctx.reuploadRequest(message);
    return await download(refreshed, { host: DEFAULT_MEDIA_HOST });
  };
}

export const baileysDownloader: MediaDownloader = makeBaileysDownloader();

export class MediaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const MEDIA_UNAVAILABLE_MESSAGE = "Mídia indisponível (recebida antes da atualização).";

const inflight = new Map<string, Promise<string>>();

/**
 * Absolute path of the cached file for a media message, downloading it first
 * when needed. Concurrent requests for the same message share one download.
 * Throws MediaError (404 unavailable, 409 not connected, 413 too large, 502).
 */
export async function ensureMediaCached(
  db: Database,
  k: MediaKey,
  deps: { socket: MediaSocket | null; downloader: MediaDownloader; mediaDir?: string },
): Promise<{ path: string; row: MessageMediaRow }> {
  const row = getMessageMedia(db, k);
  if (!row) throw new MediaError(404, "media_unavailable", MEDIA_UNAVAILABLE_MESSAGE);
  if (row.cache_path) {
    const abs = resolveStoredPath(row.cache_path);
    if (await Bun.file(abs).exists()) return { path: abs, row };
  }
  if (!row.raw_json) throw new MediaError(404, "media_unavailable", MEDIA_UNAVAILABLE_MESSAGE);
  if (row.file_size !== null && row.file_size > MAX_DOWNLOAD_BYTES) {
    throw new MediaError(413, "too_large", `Mídia maior que o limite de ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
  }
  if (!deps.socket) {
    throw new MediaError(409, "not_connected", "WhatsApp desconectado: conecte a conta para baixar esta mídia.");
  }
  const flightKey = `${k.instance}|${k.chat}|${k.id}|${k.fromMe ? 1 : 0}`;
  let pending = inflight.get(flightKey);
  if (!pending) {
    pending = downloadToCache(db, k, row, deps.socket, deps.downloader, deps.mediaDir ?? WA_MEDIA_DIR).finally(() =>
      inflight.delete(flightKey),
    );
    inflight.set(flightKey, pending);
  }
  const path = await pending;
  return { path, row: getMessageMedia(db, k) ?? row };
}

async function downloadToCache(
  db: Database,
  k: MediaKey,
  row: MessageMediaRow,
  socket: MediaSocket,
  downloader: MediaDownloader,
  mediaDir: string,
): Promise<string> {
  const message = JSON.parse(row.raw_json!, BufferJSON.reviver) as WAMessage;
  const dir = join(mediaDir, "in", k.instance.replace(/[^A-Za-z0-9_-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${crypto.randomUUID()}`);
  const hash = createHash("sha256");
  let size = 0;
  try {
    const source = await downloader(message, {
      // Expired URL: ask the phone to re-upload, and keep the fresh url/directPath.
      reuploadRequest: async (msg) => {
        const updated = await socket.updateMediaMessage(msg);
        try {
          const type = Object.keys(asObj(updated.message) ?? {})[0];
          const node = type ? asObj((updated.message as AnyObj)[type]) : null;
          if (type && node) {
            const json = JSON.stringify(
              { key: updated.key, message: { [type]: storableNode(node) }, messageTimestamp: toNumber(updated.messageTimestamp) },
              BufferJSON.replacer,
            );
            if (json.length <= MAX_RAW_JSON_CHARS) setMediaRaw(db, k, json);
          }
        } catch {
          /* persisting the refreshed keys is best-effort */
        }
        return updated;
      },
    });
    const writer = Bun.file(tmp).writer();
    try {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > MAX_DOWNLOAD_BYTES) {
          throw new MediaError(413, "too_large", `Mídia maior que o limite de ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
        }
        hash.update(chunk);
        writer.write(chunk);
      }
    } finally {
      await writer.end();
    }
  } catch (error) {
    rmSync(tmp, { force: true });
    if (error instanceof MediaError) throw error;
    // Never echo the raw error: Baileys embeds the signed CDN URL in it.
    const raw = error instanceof Error ? error.message : String(error);
    const detail = raw.replace(/https?:\/\/\S+/g, "[url]").slice(0, 200);
    console.error(`[wa:media] download falhou (HTTP ${httpStatusOf(error) ?? "?"}): ${detail}`);
    const status = httpStatusOf(error);
    const reason = status ? `o WhatsApp respondeu HTTP ${status}` : "erro de rede ou de descriptografia";
    throw new MediaError(502, "download_failed", `Falha ao baixar a mídia do WhatsApp (${reason}). Tente novamente.`);
  }
  const sha = hash.digest("hex");
  const finalPath = join(dir, `${sha}.${extensionFor(row.mimetype, row.file_name)}`);
  renameSync(tmp, finalPath);
  setMediaCache(db, k, finalPath, sha);
  return finalPath;
}

// ---------------------------------------------------------------------------
// HTTP serving
// ---------------------------------------------------------------------------

/** RFC 6266 + RFC 5987: ASCII fallback plus the UTF-8 encoded original name. */
export function contentDisposition(type: "inline" | "attachment", fileName: string | null): string {
  if (!fileName) return type;
  const ascii = fileName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Serves a file with Content-Type/Length/Disposition and single-range support
 * (`Range: bytes=a-b`, `a-`, `-n`) → 206/416, for audio/video seeking.
 */
export function serveFile(
  req: Request,
  path: string,
  opts: { mimetype: string | null; disposition: string; cacheControl?: string },
): Response {
  const size = statSync(path).size;
  const headers: Record<string, string> = {
    "Content-Type": opts.mimetype || "application/octet-stream",
    "Content-Disposition": opts.disposition,
    "Accept-Ranges": "bytes",
    "Cache-Control": opts.cacheControl ?? "private, max-age=86400",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  };
  const file = Bun.file(path);
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = -1;
    let end = size - 1;
    if (m && (m[1] !== "" || m[2] !== "")) {
      if (m[1] === "") {
        const suffix = Number(m[2]);
        start = Math.max(0, size - suffix);
      } else {
        start = Number(m[1]);
        if (m[2] !== "") end = Math.min(Number(m[2]), size - 1);
      }
    }
    if (!m || start < 0 || start >= size || end < start) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(file, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
}
