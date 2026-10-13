// HTTP router for the WhatsApp backend, mounted surgically under /api/wa/* by
// src/server.ts (one import + one dispatch). Every route is a thin adapter over
// the instance registry (instances.ts), the runtime manager (manager.ts) and
// the SQLite mirror. This file is the SOURCE OF TRUTH for the JSON contract the
// wa-ui phase consumes — see outputs/_SUMMARY.md.
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/index.ts";
import { getTagsForLeads } from "../db/tags.ts";
import { WA_CONFIG, type WaConfig } from "./config.ts";
import { CORE_DB_PATH, openWaDb, WA_MEDIA_DIR } from "./db.ts";
import {
  createInstance,
  deleteInstance,
  getActiveInstance,
  getInstance,
  instanceExists,
  listInstances,
  setActiveInstance,
} from "./instances.ts";
import { WaManager, type CampaignMedia, type OutgoingMedia, type WaEvent } from "./manager.ts";
import { MediaJobRegistry, mediaSummary } from "./media-jobs.ts";
import {
  baileysDownloader,
  contentDisposition,
  ensureMediaCached,
  serveFile,
  getMessageMedia,
  isMediaType,
  MAX_AUDIO_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MEDIA_UNAVAILABLE_MESSAGE,
  MediaError,
  mediaView,
  resolveStoredPath,
  toStoredPath,
  type MediaDownloader,
  type MessageMediaRow,
} from "./media.ts";
import {
  createCampaign,
  getCampaign,
  getCampaignMediaId,
  getMedia,
  PLACEHOLDER_COLUMNS,
  runCampaign,
  saveMedia,
  unknownPlaceholders,
  type CampaignRunnerDeps,
} from "./campaign.ts";
import { isWithinQuietHours } from "./gate.ts";
import { validateUntilDone } from "./validate.ts";
import { saveContactsCore } from "./contacts.ts";
import {
  createValidateJob,
  getValidateJob,
  runValidateJob,
  type ValidateRunnerDeps,
} from "./validate-job.ts";

const MESSAGES_LIMIT_DEFAULT = 200;
const MESSAGES_LIMIT_MAX = 500;
const CHATS_LIMIT = 200;
// Upload ceiling = the largest WhatsApp kind (document, 100 MB); each kind is
// then held to its own limit after sniffing (image 16, video 64, audio 16).
const MEDIA_MAX_BYTES = MAX_DOCUMENT_BYTES;
// Multipart framing (boundaries, part headers) on top of the file itself.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
// System messages with no conversation value — excluded from bubbles and previews.
const SYSTEM_MESSAGE_TYPES = ["protocolMessage", "senderKeyDistributionMessage", "reactionMessage"] as const;
const SYSTEM_TYPES_SQL = SYSTEM_MESSAGE_TYPES.map((t) => `'${t}'`).join(", ");

/** Phone fallback for a name: the number part of an @s.whatsapp.net jid. */
function phoneFromJid(jid: string): string {
  return jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0]! : jid.split("@")[0]!;
}

// No CORS headers: the UI is served same-origin by src/server.ts, and a
// wildcard origin would let any website drive this local API.
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorJson(message: string, status: number): Response {
  return json({ error: message }, status);
}

/** True when the request declares a JSON body (charset etc. tolerated). */
function isJsonRequest(req: Request): boolean {
  const ct = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  return ct === "application/json";
}

/** JSON POST bodies must say so: a cross-site form/text POST (a "simple"
 *  request, no preflight) is refused before it can trigger anything. */
function unsupportedMediaType(): Response {
  return errorJson("Content-Type deve ser application/json.", 415);
}

type SniffedMedia = { kind: "image" | "video" | "document"; mime: string };

const OFFICE_MIME_BY_EXT: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * Media type from the file's magic bytes — never trust the client's
 * `file.type`. Audio goes as a document (campaign media is image/video/document);
 * a 1:1 send turns audio/* into an audio message (see sendKindOf). A ZIP
 * container is a document; its mime comes from the extension only for the
 * Office formats (docx/xlsx/pptx), else application/zip.
 */
export function sniffMedia(bytes: Uint8Array, fileName?: string | null): SniffedMedia | null {
  const at = (offset: number, sig: number[]): boolean => sig.every((b, i) => bytes[offset + i] === b);
  const ascii = (offset: number, text: string): boolean => at(offset, [...text].map((c) => c.charCodeAt(0)));
  if (at(0, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png" };
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return { kind: "image", mime: "image/webp" };
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return { kind: "image", mime: "image/gif" };
  if (ascii(4, "ftypM4A")) return { kind: "document", mime: "audio/mp4" };
  if (ascii(4, "ftyp")) return { kind: "video", mime: "video/mp4" };
  if (at(0, [0x50, 0x4b, 0x03, 0x04])) {
    const ext = fileName?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? "";
    return { kind: "document", mime: OFFICE_MIME_BY_EXT[ext] ?? "application/zip" };
  }
  if (ascii(0, "%PDF-")) return { kind: "document", mime: "application/pdf" };
  if (ascii(0, "OggS")) return { kind: "document", mime: "audio/ogg" };
  if (ascii(0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) {
    return { kind: "document", mime: "audio/mpeg" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// SSE wire format (exported for tests): `event:`/`data:` frames per the spec.
// ---------------------------------------------------------------------------
export function formatSse(event: WaEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify({ instance: event.instance, ...event.data })}\n\n`;
}

export interface ParsedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Parses an SSE text stream into its events (test-side of `formatSse`). */
export function parseSseStream(raw: string): ParsedSseEvent[] {
  const out: ParsedSseEvent[] = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n");
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    try {
      out.push({ event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
    } catch {
      /* skip comment/heartbeat frames */
    }
  }
  return out;
}

/** How a stored upload is sent 1:1: audio/* becomes an audio message. */
export function sendKindOf(row: { kind: string; mime: string | null }): OutgoingMedia["kind"] {
  if ((row.mime ?? "").startsWith("audio/")) return "audio";
  return row.kind === "image" || row.kind === "video" ? row.kind : "document";
}

const SEND_LIMITS: Record<OutgoingMedia["kind"], number> = {
  image: MAX_IMAGE_BYTES,
  video: MAX_VIDEO_BYTES,
  audio: MAX_AUDIO_BYTES,
  document: MAX_DOCUMENT_BYTES,
};

/** `from_me` query flag: 1/true or 0/false; null when invalid. */
function parseFromMe(raw: string | null): boolean | null {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return null;
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

export interface WaRouterDeps {
  waDb?: Database;
  coreDb?: Database;
  config?: WaConfig;
  manager?: WaManager;
  /** Reconnect paired instances on init (boot). Off by default so tests never
   *  open sockets; the server singleton (`initWaBackend`) turns it on. */
  autoStart?: boolean | { staggerMs?: number };
  /** Clock for the resume quiet-hours check (tests). */
  now?: () => Date;
  /** Root for uploads and the download cache (tests use a temp dir). */
  mediaDir?: string;
  /** Media downloader (tests inject a fake). Default: Baileys downloadMediaMessage. */
  downloader?: MediaDownloader;
}

export interface WaRouter {
  handle: (req: Request, url: URL) => Promise<Response>;
  manager: WaManager;
  waDb: Database;
}

export function createWaRouter(deps: WaRouterDeps = {}): WaRouter {
  const waDb = deps.waDb ?? openWaDb();
  const coreDb = deps.coreDb ?? openDb(CORE_DB_PATH);
  const config = deps.config ?? WA_CONFIG;
  const manager = deps.manager ?? new WaManager({ db: waDb, config });
  const now = deps.now ?? (() => new Date());
  const mediaDir = deps.mediaDir ?? WA_MEDIA_DIR;
  const downloader = deps.downloader ?? baileysDownloader;

  // Jobs left 'queued'/'running' by a previous process have no runner anymore
  // (the async loop died with it): surface them as paused, never stuck.
  const RESTART_REASON = "servidor reiniciado";
  waDb
    .query("UPDATE campaigns SET status = 'paused', reason = ?, updated_at = ? WHERE status IN ('queued', 'running')")
    .run(RESTART_REASON, new Date().toISOString());
  waDb
    .query("UPDATE validate_jobs SET status = 'paused', reason = ?, updated_at = ? WHERE status IN ('queued', 'running')")
    .run(RESTART_REASON, new Date().toISOString());

  // In-process job registry: one campaign and one validation job at a time per
  // instance, and a job id is never driven by two runners at once.
  const runningCampaignByInstance = new Map<string, string>();
  const runningValidateByInstance = new Map<string, string>();
  const runningValidateJobs = new Set<string>();
  // Per-chat media: one bulk download and one history recovery at a time.
  const mediaJobs = new MediaJobRegistry();
  const recoveringChats = new Set<string>();

  if (deps.autoStart) {
    manager.autoStartPaired(typeof deps.autoStart === "object" ? deps.autoStart : {});
  }

  function launchCampaign(instance: string, jobId: string, mediaId: string | null): void {
    runningCampaignByInstance.set(instance, jobId);
    void runCampaign(jobId, campaignRunnerDeps(instance, mediaId)).finally(() => {
      if (runningCampaignByInstance.get(instance) === jobId) runningCampaignByInstance.delete(instance);
    });
  }

  function launchValidate(instance: string, jobId: string): void {
    runningValidateByInstance.set(instance, jobId);
    runningValidateJobs.add(jobId);
    void runValidateJob(jobId, validateRunnerDeps(instance)).finally(() => {
      runningValidateJobs.delete(jobId);
      if (runningValidateByInstance.get(instance) === jobId) runningValidateByInstance.delete(instance);
    });
  }

  function instanceView(id: string, name: string | null, phone: string | null, active: string | null) {
    const rt = manager.runtime(id);
    return { id, name, phone, status: rt.status, status_reason: rt.reason, is_active: id === active };
  }

  async function handle(req: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(/\/+$/, "");

    // GET /api/wa/stream (SSE)
    if (path === "/api/wa/stream" && req.method === "GET") return streamResponse();

    // /api/wa/instances collection
    if (path === "/api/wa/instances") {
      if (req.method === "POST") {
        // The body is optional here, but if one is declared it must be JSON.
        if (req.headers.get("content-type") && !isJsonRequest(req)) return unsupportedMediaType();
        let name: string | null = null;
        try {
          const body = (await req.json()) as { name?: string };
          name = body?.name?.trim() || null;
        } catch {
          /* empty body is fine */
        }
        const instance = createInstance(waDb, { name });
        manager.start(instance.id);
        return json({ id: instance.id }, 201);
      }
      if (req.method === "GET") {
        const active = getActiveInstance(waDb);
        return json({
          instances: listInstances(waDb).map((r) => instanceView(r.id, r.name, r.phone, active)),
        });
      }
    }

    // /api/wa/instances/:id[/action]
    const inst = /^\/api\/wa\/instances\/([^/]+)(?:\/(qr|select|disconnect|reconnect|repair))?$/.exec(path);
    if (inst) {
      const id = decodeURIComponent(inst[1]!);
      const action = inst[2];
      if (!instanceExists(waDb, id)) return errorJson("Instância não encontrada.", 404);

      if (!action && req.method === "DELETE") {
        await manager.remove(id);
        deleteInstance(waDb, id);
        return json({ ok: true });
      }
      if (action === "qr" && req.method === "GET") {
        const rt = manager.runtime(id);
        return json({ qr: rt.qrDataUrl, expires_at: rt.qrExpiresAt, status: rt.status, status_reason: rt.reason });
      }
      if (action === "select" && req.method === "POST") {
        setActiveInstance(waDb, id);
        return json({ ok: true, active_instance: id });
      }
      if (action === "disconnect" && req.method === "POST") {
        manager.disconnect(id);
        return json({ ok: true, status: manager.runtime(id).status });
      }
      if (action === "reconnect" && req.method === "POST") {
        manager.reconnect(id);
        return json({ ok: true, status: manager.runtime(id).status });
      }
      if (action === "repair" && req.method === "POST") {
        // Fresh QR for an EXISTING account: wipes only its auth, keeps chats/contacts.
        manager.repair(id);
        return json({ ok: true, status: manager.runtime(id).status });
      }
    }

    // GET /api/wa/chats?instance=:id
    if (path === "/api/wa/chats" && req.method === "GET") {
      const instance = url.searchParams.get("instance");
      if (!instance || !instanceExists(waDb, instance)) return errorJson("Parâmetro 'instance' inválido.", 400);
      // Name resolution (squad pattern): chat name, then the address-book name,
      // then pushName, then verified name, then the phone number (JS fallback).
      // The preview (last_message / last_type) ignores system messages so a
      // protocolMessage/keydist/reaction never becomes the conversation preview.
      const rows = waDb
        .query(
          `SELECT c.jid AS jid,
                  c.name AS chat_name,
                  ct.display_name AS display_name,
                  ct.notify_name  AS notify_name,
                  ct.verified_name AS verified_name,
                  ct.phone_number AS phone_number,
                  c.last_message_at AS last_ts,
                  c.unread AS unread,
                  (SELECT m.text_content FROM messages m
                     WHERE m.instance_id = c.instance_id AND m.chat_jid = c.jid
                       AND (m.message_type IS NULL OR m.message_type NOT IN (${SYSTEM_TYPES_SQL}))
                     ORDER BY m.timestamp DESC, m.rowid DESC LIMIT 1) AS last_text,
                  (SELECT m.message_type FROM messages m
                     WHERE m.instance_id = c.instance_id AND m.chat_jid = c.jid
                       AND (m.message_type IS NULL OR m.message_type NOT IN (${SYSTEM_TYPES_SQL}))
                     ORDER BY m.timestamp DESC, m.rowid DESC LIMIT 1) AS last_type
           FROM chats c
           LEFT JOIN contacts ct ON ct.jid = c.jid AND ct.instance_id = c.instance_id
           WHERE c.instance_id = ?
           ORDER BY c.last_message_at DESC NULLS LAST LIMIT ?`,
        )
        .all(instance, CHATS_LIMIT) as Array<{
        jid: string;
        chat_name: string | null;
        display_name: string | null;
        notify_name: string | null;
        verified_name: string | null;
        phone_number: string | null;
        last_ts: number | null;
        unread: number;
        last_text: string | null;
        last_type: string | null;
      }>;
      return json({
        chats: rows.map((r) => ({
          jid: r.jid,
          name:
            r.chat_name ??
            r.display_name ??
            r.notify_name ??
            r.verified_name ??
            r.phone_number ??
            phoneFromJid(r.jid),
          // Real phone number when known (a LID chat's jid is not a number).
          phone: r.phone_number ?? (r.jid.endsWith("@s.whatsapp.net") ? phoneFromJid(r.jid) : null),
          last_message: r.last_text,
          last_type: r.last_type,
          last_ts: r.last_ts,
          unread: r.unread,
          saved: r.display_name != null, // canonical "saved in the address book" signal
        })),
      });
    }

    // GET /api/wa/chats/:jid/media-summary?instance=:id — what the chat holds
    // (nothing is downloaded by default; the UI asks before downloading).
    const summary = /^\/api\/wa\/chats\/([^/]+)\/media-summary$/.exec(path);
    if (summary && req.method === "GET") {
      const jid = decodeURIComponent(summary[1]!);
      const instance = url.searchParams.get("instance");
      if (!instance || !instanceExists(waDb, instance)) return errorJson("Parâmetro 'instance' inválido.", 400);
      return json(mediaSummary(waDb, instance, jid));
    }

    // POST /api/wa/chats/:jid/media/download|recover {instance}
    const chatMedia = /^\/api\/wa\/chats\/([^/]+)\/media\/(download|recover)$/.exec(path);
    if (chatMedia && req.method === "POST") {
      if (!isJsonRequest(req)) return unsupportedMediaType();
      const jid = decodeURIComponent(chatMedia[1]!);
      let body: { instance?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return errorJson('Corpo inválido. Envie JSON: {"instance"}.', 400);
      }
      const instance = typeof body?.instance === "string" ? body.instance : "";
      if (!instance || !instanceExists(waDb, instance)) return errorJson("Instância inválida.", 400);
      if (!manager.mediaSocket(instance)) {
        return json({ error: "WhatsApp desconectado: conecte a conta para baixar ou recuperar arquivos.", code: "not_connected" }, 409);
      }
      const chatKey = `${instance}|${jid}`;

      if (chatMedia[2] === "download") {
        const running = mediaJobs.running(instance, jid);
        if (running) {
          return json({ error: "Já existe um download em andamento nesta conversa.", code: "job_running", job_id: running.id }, 409);
        }
        const job = mediaJobs.start(instance, jid, {
          db: waDb,
          socket: () => manager.mediaSocket(instance),
          downloader,
          mediaDir,
        });
        return json({ job_id: job.id }, 202);
      }

      if (recoveringChats.has(chatKey)) {
        return json({ error: "Já estou pedindo o histórico desta conversa ao celular. Aguarde.", code: "recover_running" }, 409);
      }
      recoveringChats.add(chatKey);
      try {
        const result = await manager.recoverChatMedia(instance, jid);
        if (result === "not_connected") {
          return json({ error: "WhatsApp desconectado: conecte a conta para recuperar arquivos.", code: "not_connected" }, 409);
        }
        return json(result);
      } finally {
        recoveringChats.delete(chatKey);
      }
    }

    // GET /api/wa/media-jobs/:id — bulk download progress.
    const mediaJob = /^\/api\/wa\/media-jobs\/([^/]+)$/.exec(path);
    if (mediaJob && req.method === "GET") {
      const job = mediaJobs.get(decodeURIComponent(mediaJob[1]!));
      if (!job) return errorJson("Job de mídia não encontrado.", 404);
      const { status, total, done, failed, bytes, errors } = job;
      return json({ status, total, done, failed, bytes, errors });
    }

    // GET /api/wa/chats/:jid/messages?instance=:id&limit=&before=&before_id=
    // Paginated lazy-load. No cursor → the most recent `limit` messages; with a
    // cursor → the `limit` messages just BEFORE it. Always ascending (for the
    // UI to prepend). System messages excluded. When the mirror is exhausted, a
    // WhatsApp fetch is triggered (async) and `fetching`/`has_more` reflect it.
    const msg = /^\/api\/wa\/chats\/([^/]+)\/messages$/.exec(path);
    if (msg && req.method === "GET") {
      const jid = decodeURIComponent(msg[1]!);
      const instance = url.searchParams.get("instance");
      if (!instance || !instanceExists(waDb, instance)) return errorJson("Parâmetro 'instance' inválido.", 400);
      const limitRaw = Number(url.searchParams.get("limit") ?? MESSAGES_LIMIT_DEFAULT);
      const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : MESSAGES_LIMIT_DEFAULT, MESSAGES_LIMIT_MAX);

      // Resolve an exclusive upper-bound cursor. before_id (precise, tie-safe)
      // wins over before (a unix-second timestamp).
      const beforeId = url.searchParams.get("before_id");
      const beforeTs = url.searchParams.get("before");
      let cursor: { ts: number; rowid: number | null } | null = null;
      if (beforeId) {
        const anchor = waDb
          .query("SELECT timestamp, rowid FROM messages WHERE instance_id = ? AND chat_jid = ? AND message_id = ? LIMIT 1")
          .get(instance, jid, beforeId) as { timestamp: number; rowid: number } | null;
        cursor = anchor ? { ts: anchor.timestamp, rowid: anchor.rowid } : { ts: 0, rowid: 0 };
      } else if (beforeTs != null && /^\d+$/.test(beforeTs)) {
        cursor = { ts: Number(beforeTs), rowid: null };
      }

      let where = `instance_id = ? AND chat_jid = ? AND (message_type IS NULL OR message_type NOT IN (${SYSTEM_TYPES_SQL}))`;
      const params: (string | number)[] = [instance, jid];
      if (cursor) {
        if (cursor.rowid == null) {
          where += " AND timestamp < ?";
          params.push(cursor.ts);
        } else {
          where += " AND (timestamp < ? OR (timestamp = ? AND rowid < ?))";
          params.push(cursor.ts, cursor.ts, cursor.rowid);
        }
      }
      // Fetch limit+1 (descending) to detect whether the mirror has more older.
      const rows = waDb
        .query(
          `SELECT message_id, from_me, text_content, message_type, timestamp, status, quoted_id, quoted_text, quoted_type
           FROM messages WHERE ${where} ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
        )
        .all(...params, limit + 1) as Array<{
        message_id: string;
        from_me: number;
        text_content: string | null;
        message_type: string | null;
        timestamp: number;
        status: string | null;
        quoted_id: string | null;
        quoted_text: string | null;
        quoted_type: string | null;
      }>;
      const mirrorHasMore = rows.length > limit;
      const page = rows.slice(0, limit).reverse(); // ascending, ready to prepend

      let fetching = false;
      let hasMore = mirrorHasMore;
      if (!mirrorHasMore) {
        // Mirror exhausted for this cursor → ask WhatsApp for older messages.
        const status = manager.fetchOlderHistory(instance, jid);
        fetching = status === "triggered" || status === "pending";
        hasMore = fetching; // more may arrive; real end (exhausted/not_connected) → false
      }

      // Media rows and reactions for this page, one query each.
      const ids = page.map((r) => r.message_id);
      const marks = ids.map(() => "?").join(", ");
      const mediaRows = ids.length
        ? (waDb
            .query(`SELECT * FROM message_media WHERE instance_id = ? AND chat_jid = ? AND message_id IN (${marks})`)
            .all(instance, jid, ...ids) as MessageMediaRow[])
        : [];
      const mediaByKey = new Map(mediaRows.map((m) => [`${m.message_id}|${m.from_me}`, m]));
      const reactionRows = ids.length
        ? (waDb
            .query(
              `SELECT target_id, emoji, from_me FROM message_reactions
               WHERE instance_id = ? AND chat_jid = ? AND target_id IN (${marks}) ORDER BY timestamp ASC`,
            )
            .all(instance, jid, ...ids) as Array<{ target_id: string; emoji: string; from_me: number }>)
        : [];
      const reactionsByTarget = new Map<string, Array<{ emoji: string; from_me: boolean }>>();
      for (const r of reactionRows) {
        const list = reactionsByTarget.get(r.target_id) ?? [];
        list.push({ emoji: r.emoji, from_me: r.from_me === 1 });
        reactionsByTarget.set(r.target_id, list);
      }

      return json({
        messages: page.map((r) => ({
          id: r.message_id,
          from_me: r.from_me === 1,
          text: r.text_content,
          type: r.message_type,
          ts: r.timestamp,
          status: r.status,
          media: mediaView(mediaByKey.get(`${r.message_id}|${r.from_me}`) ?? null, r.message_type),
          quoted: r.quoted_id ? { id: r.quoted_id, text: r.quoted_text, type: r.quoted_type } : null,
          reactions: reactionsByTarget.get(r.message_id) ?? [],
        })),
        has_more: hasMore,
        fetching,
      });
    }

    // GET /api/wa/messages/media|thumbnail?instance=&chat=&id=&from_me=
    // Lazy media download (cached on disk) and the stored jpegThumbnail.
    const mediaPath = /^\/api\/wa\/messages\/(media|thumbnail)$/.exec(path);
    if (mediaPath && (req.method === "GET" || req.method === "HEAD")) {
      const instance = url.searchParams.get("instance");
      if (!instance || !instanceExists(waDb, instance)) return errorJson("Parâmetro 'instance' inválido.", 400);
      const chat = url.searchParams.get("chat") ?? "";
      const id = url.searchParams.get("id") ?? "";
      const fromMe = parseFromMe(url.searchParams.get("from_me"));
      if (!chat || !id || fromMe === null) {
        return errorJson("Parâmetros obrigatórios: instance, chat, id e from_me (0 ou 1).", 400);
      }
      const key = { instance, chat, id, fromMe };
      const exists = waDb
        .query("SELECT message_type FROM messages WHERE instance_id = ? AND chat_jid = ? AND message_id = ? AND from_me = ?")
        .get(instance, chat, id, fromMe ? 1 : 0) as { message_type: string | null } | null;
      if (!exists) return json({ error: "Mensagem não encontrada.", code: "message_not_found" }, 404);
      const row = getMessageMedia(waDb, key);
      if (!row && !isMediaType(exists.message_type)) {
        return json({ error: "Esta mensagem não tem mídia.", code: "not_media" }, 404);
      }

      if (mediaPath[1] === "thumbnail") {
        if (!row?.thumbnail_b64) return json({ error: "Miniatura indisponível.", code: "no_thumbnail" }, 404);
        const bytes = Buffer.from(row.thumbnail_b64, "base64");
        return new Response(bytes, {
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": String(bytes.length),
            "Cache-Control": "private, max-age=86400",
            "Cross-Origin-Resource-Policy": "same-origin",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (!row) return json({ error: MEDIA_UNAVAILABLE_MESSAGE, code: "media_unavailable" }, 404);
      try {
        const cached = await ensureMediaCached(waDb, key, {
          socket: manager.mediaSocket(instance),
          downloader,
          mediaDir,
        });
        const inline = cached.row.kind !== "document";
        return serveFile(req, cached.path, {
          mimetype: cached.row.mimetype,
          disposition: contentDisposition(inline ? "inline" : "attachment", cached.row.file_name),
        });
      } catch (error) {
        if (error instanceof MediaError) return json({ error: error.message, code: error.code }, error.status);
        throw error;
      }
    }

    // POST /api/wa/send {instance, jid, text?, media_id?, caption?, voice?}
    if (path === "/api/wa/send" && req.method === "POST") {
      if (!isJsonRequest(req)) return unsupportedMediaType();
      let body: { instance?: string; jid?: string; text?: string; media_id?: unknown; caption?: unknown; voice?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return errorJson('Corpo inválido. Envie JSON: {"instance","jid","text"} ou {"instance","jid","media_id","caption?"}.', 400);
      }
      const instance = body.instance || getActiveInstance(waDb);
      if (!instance || !instanceExists(waDb, instance)) return errorJson("Instância inválida.", 400);
      const jid = (body.jid ?? "").trim();
      const text = (typeof body.text === "string" ? body.text : "").trim();
      const mediaId = typeof body.media_id === "string" && body.media_id ? body.media_id : null;
      if (!jid || (!text && !mediaId)) return errorJson('Campos "jid" e "text" (ou "media_id") são obrigatórios.', 400);

      // Media: validate everything BEFORE the gate reserves a send slot.
      let outgoing: OutgoingMedia | null = null;
      if (mediaId) {
        const row = getMedia(waDb, mediaId);
        if (!row) return errorJson("media_id não encontrado.", 400);
        const kind = sendKindOf(row);
        const caption = (typeof body.caption === "string" ? body.caption : text).trim();
        const voice = body.voice === true;
        if (kind === "audio" && caption) return errorJson("Áudio não aceita legenda: envie o texto em outra mensagem.", 400);
        if (voice && !(kind === "audio" && (row.mime ?? "").startsWith("audio/ogg"))) {
          return errorJson("Mensagem de voz exige áudio OGG (Opus).", 400);
        }
        if (caption.length > 4096) return errorJson("A legenda excede 4096 caracteres.", 400);
        if (row.size > SEND_LIMITS[kind]) {
          return errorJson(`Arquivo excede o limite do WhatsApp para este tipo (${mb(SEND_LIMITS[kind])} MB).`, 413);
        }
        const localPath = resolveStoredPath(row.file_path);
        const file = Bun.file(localPath);
        if (!(await file.exists())) return errorJson("Arquivo da mídia não encontrado no disco. Envie o arquivo de novo.", 410);
        outgoing = {
          kind,
          mime: row.mime ?? "application/octet-stream",
          filename: row.filename,
          data: await file.bytes(),
          caption: caption || undefined,
          voice,
          localPath,
        };
      }

      // Quiet hours are waived only for a REPLY: the contact already wrote to
      // us in this chat. A cold first message at night respects them.
      const hasInbound = Boolean(
        waDb
          .query("SELECT 1 FROM messages WHERE instance_id = ? AND chat_jid = ? AND from_me = 0 LIMIT 1")
          .get(instance, jid),
      );
      const result = outgoing
        ? await manager.sendMedia(instance, jid, outgoing, { overrideQuietHours: hasInbound })
        : await manager.sendText(instance, jid, text, { overrideQuietHours: hasInbound });
      if (!result.ok) {
        const status = result.gate.blocked_code === "rate_limit" ? 429 : 409;
        return json({ ok: false, blocked_code: result.gate.blocked_code, reason: result.gate.blocked_reason ?? result.error }, status);
      }
      const { reaction: _reaction, ...message } = result.message ?? {};
      return json({ ok: true, message: result.message ? message : undefined });
    }

    // GET /api/wa/leads — prospected leads (is_whatsapp=1) as initiable contacts
    if (path === "/api/wa/leads" && req.method === "GET") {
      const rows = coreDb
        .query(
          `SELECT id, name, phone, whatsapp_jid, category FROM leads
           WHERE is_whatsapp = 1 AND whatsapp_jid IS NOT NULL ORDER BY name`,
        )
        .all() as Array<{
        id: number;
        name: string;
        phone: string | null;
        whatsapp_jid: string | null;
        category: string | null;
      }>;
      const tagsByLead = getTagsForLeads(coreDb, rows.map((r) => r.id));
      return json({
        leads: rows.map((r) => ({
          lead_id: r.id,
          name: r.name,
          phone: r.phone,
          jid: r.whatsapp_jid,
          category: r.category,
          tags: tagsByLead.get(r.id) ?? [],
        })),
      });
    }

    // POST /api/wa/validate {instance, lead_ids[]} — async WhatsApp validation
    if (path === "/api/wa/validate" && req.method === "POST") {
      if (!isJsonRequest(req)) return unsupportedMediaType();
      let body: { instance?: string; lead_ids?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return errorJson('Corpo inválido. Envie JSON: {"instance","lead_ids":[...]}.', 400);
      }
      const instance = body.instance || getActiveInstance(waDb);
      if (!instance || !instanceExists(waDb, instance)) return errorJson("Instância inválida.", 400);
      const leadIds = Array.isArray(body.lead_ids)
        ? body.lead_ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
        : [];
      if (leadIds.length === 0) return errorJson('Campo "lead_ids" deve ser uma lista não vazia.', 400);
      // The onWhatsApp lookups need a live socket. Fail fast (and clearly) if none.
      if (!manager.onWhatsAppSocket(instance)) {
        return errorJson("Nenhum WhatsApp conectado. Conecte uma conta antes de validar.", 409);
      }
      if (runningValidateByInstance.has(instance)) {
        return json(
          {
            error: "Já existe uma validação em andamento nesta conta. Aguarde terminar antes de iniciar outra.",
            job_id: runningValidateByInstance.get(instance),
          },
          409,
        );
      }
      const jobId = createValidateJob(waDb, coreDb, { instanceId: instance, leadIds });
      launchValidate(instance, jobId);
      return json({ job_id: jobId }, 202);
    }

    // GET /api/wa/validate/:job → aggregated + per-lead validation status
    const val = /^\/api\/wa\/validate\/([^/]+)$/.exec(path);
    if (val && req.method === "GET") {
      const view = getValidateJob(waDb, decodeURIComponent(val[1]!));
      return view ? json(view) : errorJson("Job de validação não encontrado.", 404);
    }

    // POST /api/wa/validate/:job/resume → retoma job pausado/interrompido
    const valResume = /^\/api\/wa\/validate\/([^/]+)\/resume$/.exec(path);
    if (valResume && req.method === "POST") {
      const jobId = decodeURIComponent(valResume[1]!);
      const view = getValidateJob(waDb, jobId);
      if (!view) return errorJson("Job de validação não encontrado.", 404);
      if (runningValidateJobs.has(jobId)) {
        return errorJson("Esta validação já está em andamento.", 409);
      }
      if (view.status === "done") return errorJson("Esta validação já terminou.", 409);
      const instance = view.instance || getActiveInstance(waDb);
      if (!instance || !manager.onWhatsAppSocket(instance)) {
        return errorJson("Nenhum WhatsApp conectado. Conecte uma conta antes de validar.", 409);
      }
      if (runningValidateByInstance.has(instance)) {
        return errorJson("Já existe uma validação em andamento nesta conta. Aguarde terminar antes de retomar.", 409);
      }
      launchValidate(instance, jobId);
      return json({ ok: true, job_id: jobId });
    }

    // POST /api/wa/contacts/save {instance, jids[]} — save to the address book
    if (path === "/api/wa/contacts/save" && req.method === "POST") {
      if (!isJsonRequest(req)) return unsupportedMediaType();
      let body: { instance?: string; jids?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return errorJson('Corpo inválido. Envie JSON: {"instance","jids":[...]}.', 400);
      }
      const instance = body.instance || getActiveInstance(waDb);
      if (!instance || !instanceExists(waDb, instance)) return errorJson("Instância inválida.", 400);
      const jids = Array.isArray(body.jids)
        ? body.jids.filter((j): j is string => typeof j === "string" && j.length > 0)
        : [];
      if (jids.length === 0) return errorJson('Campo "jids" deve ser uma lista não vazia.', 400);
      const report = await saveContactsCore(jids, {
        waDb,
        coreDb,
        instanceId: instance,
        sock: manager.contactPushSocket(instance) ?? undefined,
        config,
      });
      return json(report);
    }

    // GET /api/wa/contacts/status?instance=&jids=a,b,c — bulk "saved?" lookup
    if (path === "/api/wa/contacts/status" && req.method === "GET") {
      const instance = url.searchParams.get("instance");
      if (!instance || !instanceExists(waDb, instance)) return errorJson("Parâmetro 'instance' inválido.", 400);
      const jids = (url.searchParams.get("jids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const statuses: Record<string, { saved: boolean; name: string | null }> = {};
      for (const jid of jids) {
        const row = waDb
          .query("SELECT display_name FROM contacts WHERE instance_id = ? AND jid = ?")
          .get(instance, jid) as { display_name: string | null } | null;
        statuses[jid] = { saved: row?.display_name != null, name: row?.display_name ?? null };
      }
      return json({ statuses });
    }

    // POST /api/wa/media — multipart upload; returns a media handle for /campaign
    if (path === "/api/wa/media" && req.method === "POST") {
      const tooLarge = (limit = MEDIA_MAX_BYTES): Response =>
        errorJson(`Arquivo excede o limite de ${mb(limit)} MB.`, 413);
      // Refuse an oversized upload BEFORE buffering it into memory.
      const declared = Number(req.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MEDIA_MAX_BYTES + MULTIPART_OVERHEAD_BYTES) return tooLarge();
      const form = await req.formData().catch(() => null);
      if (!form) return errorJson("Envie multipart/form-data com um campo 'file'.", 400);
      const file = form.get("file");
      if (!(file instanceof File)) return errorJson("Campo 'file' obrigatório (arquivo).", 400);
      if (file.size === 0) return errorJson("Arquivo vazio.", 400);
      if (file.size > MEDIA_MAX_BYTES) return tooLarge();
      const sniffed = sniffMedia(new Uint8Array(await file.slice(0, 16).arrayBuffer()), file.name);
      if (!sniffed) {
        return errorJson(
          "Tipo de arquivo não suportado. Envie JPEG, PNG, WEBP, GIF, MP4, PDF, OGG, MP3, M4A, DOCX, XLSX, PPTX ou ZIP.",
          415,
        );
      }
      const { kind, mime } = sniffed;
      const kindLimit = SEND_LIMITS[sendKindOf({ kind, mime })];
      if (file.size > kindLimit) return tooLarge(kindLimit);
      const mediaId = `med${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const absPath = join(mediaDir, mediaId);
      mkdirSync(mediaDir, { recursive: true });
      await Bun.write(absPath, file);
      saveMedia(waDb, {
        id: mediaId,
        kind,
        mime,
        filename: file.name || null,
        size: file.size,
        file_path: toStoredPath(absPath),
      });
      return json({ media_id: mediaId, kind, mime, filename: file.name || null, size: file.size }, 201);
    }

    // POST /api/wa/campaign {instance, lead_ids[], template, media?} → {job_id}
    if (path === "/api/wa/campaign" && req.method === "POST") {
      if (!isJsonRequest(req)) return unsupportedMediaType();
      let body: { instance?: string; lead_ids?: unknown; template?: string; media?: { media_id?: string } };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return errorJson('Corpo inválido. Envie JSON: {"instance","lead_ids","template","media?"}.', 400);
      }
      const instance = body.instance || getActiveInstance(waDb);
      if (!instance || !instanceExists(waDb, instance)) return errorJson("Instância inválida.", 400);
      const leadIds = Array.isArray(body.lead_ids)
        ? body.lead_ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
        : [];
      if (leadIds.length === 0) return errorJson('Campo "lead_ids" deve ser uma lista não vazia.', 400);
      const template = typeof body.template === "string" ? body.template : "";
      const mediaId = body.media?.media_id ?? null;
      if (mediaId && !getMedia(waDb, mediaId)) return errorJson("media_id não encontrado.", 400);
      if (template.trim().length === 0 && !mediaId) {
        return errorJson("Mensagem vazia sem mídia: informe um template ou uma mídia.", 400);
      }
      const unknown = unknownPlaceholders(template);
      if (unknown.length > 0) {
        const fmt = (keys: readonly string[]): string => keys.map((k) => `{{${k}}}`).join(", ");
        return json(
          {
            error: `Campos desconhecidos no template: ${fmt(unknown)}. Campos válidos: ${fmt(PLACEHOLDER_COLUMNS)}.`,
            unknown_placeholders: unknown,
            valid_placeholders: PLACEHOLDER_COLUMNS,
          },
          400,
        );
      }
      if (!manager.onWhatsAppSocket(instance)) {
        return errorJson("Nenhum WhatsApp conectado. Conecte uma conta antes de enviar.", 409);
      }
      if (runningCampaignByInstance.has(instance)) {
        return json(
          {
            error: "Já existe uma campanha em andamento nesta conta. Aguarde terminar antes de iniciar outra.",
            job_id: runningCampaignByInstance.get(instance),
          },
          409,
        );
      }
      const jobId = createCampaign(waDb, coreDb, { instanceId: instance, template, mediaId, leadIds });
      // Async: drive the campaign in the background; respond immediately.
      launchCampaign(instance, jobId, mediaId);
      return json({ job_id: jobId }, 202);
    }

    // POST /api/wa/campaign/:job/resume → restarts a paused campaign over the
    // recipients still 'queued' (the runner never re-sends: it only drives
    // queued rows and dedupes JIDs already sent).
    const campResume = /^\/api\/wa\/campaign\/([^/]+)\/resume$/.exec(path);
    if (campResume && req.method === "POST") {
      if (req.headers.get("content-type") && !isJsonRequest(req)) return unsupportedMediaType();
      const jobId = decodeURIComponent(campResume[1]!);
      const view = getCampaign(waDb, jobId);
      if (!view) return errorJson("Campanha não encontrada.", 404);
      const instance = view.instance;
      if (runningCampaignByInstance.get(instance) === jobId) {
        return errorJson("Esta campanha já está em andamento.", 409);
      }
      if (view.status === "done") return errorJson("Esta campanha já terminou.", 409);
      if (!manager.onWhatsAppSocket(instance)) {
        return errorJson("Nenhum WhatsApp conectado. Conecte a conta desta campanha antes de retomar.", 409);
      }
      if (runningCampaignByInstance.has(instance)) {
        return json(
          {
            error: "Já existe outra campanha em andamento nesta conta. Aguarde terminar antes de retomar.",
            job_id: runningCampaignByInstance.get(instance),
          },
          409,
        );
      }
      if (runningValidateByInstance.has(instance)) {
        return json(
          {
            error: "Há uma validação em andamento nesta conta. Aguarde terminar antes de retomar a campanha.",
            job_id: runningValidateByInstance.get(instance),
          },
          409,
        );
      }
      // The runner pauses on the first send inside quiet hours (never waits
      // them out), so resuming now would only pause again: refuse up front.
      if (isWithinQuietHours(config, now())) {
        const qh = config.quiet_hours;
        return errorJson(
          `Horário de silêncio (${qh.start}–${qh.end}, ${qh.timezone}): a campanha só pode ser retomada fora dessa janela.`,
          409,
        );
      }
      launchCampaign(instance, jobId, getCampaignMediaId(waDb, jobId));
      return json({ ok: true, job_id: jobId });
    }

    // GET /api/wa/campaign/:job → aggregated + per-recipient status
    const camp = /^\/api\/wa\/campaign\/([^/]+)$/.exec(path);
    if (camp && req.method === "GET") {
      const view = getCampaign(waDb, decodeURIComponent(camp[1]!));
      return view ? json(view) : errorJson("Campanha não encontrada.", 404);
    }

    return errorJson("Rota /api/wa não encontrada.", 404);
  }

  /** Wires the campaign runner to the real manager (gated send + validation + media). */
  function campaignRunnerDeps(instance: string, mediaId: string | null): CampaignRunnerDeps {
    return {
      waDb,
      coreDb,
      config,
      send: (jid, content) => manager.sendCampaignMessage(instance, jid, content),
      // Drains every pending lead, waiting out the validation window instead
      // of giving up (a gate stop no longer skips leads as not_validated).
      validatePending: async (leadIds) => {
        await validateUntilDone(leadIds, {
          coreDb,
          waDb,
          config,
          getSocket: () => manager.onWhatsAppSocket(instance),
        });
      },
      isConnected: () => manager.onWhatsAppSocket(instance) !== null,
      loadMedia: async () => {
        if (!mediaId) return null;
        const row = getMedia(waDb, mediaId);
        if (!row) return null;
        const bytes = await Bun.file(resolveStoredPath(row.file_path)).bytes();
        const media: CampaignMedia = { kind: row.kind, mime: row.mime, filename: row.filename, data: bytes };
        return media;
      },
      publish: (event) => manager.publish(event),
    };
  }

  /** Wires the validation runner to the real manager (same onWhatsApp socket +
   *  validateLeadsCore the campaign uses). */
  function validateRunnerDeps(instance: string): ValidateRunnerDeps {
    return {
      waDb,
      coreDb,
      config,
      getSocket: () => manager.onWhatsAppSocket(instance),
      publish: (event) => manager.publish(event),
    };
  }

  function streamResponse(): Response {
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        heartbeatTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
          }
        }, 15000);
        unsubscribe = manager.subscribe((event) => {
          try {
            controller.enqueue(encoder.encode(formatSse(event)));
          } catch {
            /* client gone */
          }
        });
      },
      cancel() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        unsubscribe?.();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  return { handle, manager, waDb };
}

// Process-wide singleton used by the surgical mount in src/server.ts. Created
// eagerly at server boot (initWaBackend) so paired instances reconnect without
// waiting for the first /api/wa request; lazily otherwise.
let singleton: WaRouter | null = null;

export function initWaBackend(): WaRouter {
  singleton ??= createWaRouter({ autoStart: true });
  return singleton;
}

export function handleWaRequest(req: Request, url: URL): Promise<Response> {
  return initWaBackend().handle(req, url);
}
