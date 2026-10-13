// Multi-instance runtime for the WhatsApp HTTP backend (wa-backend phase).
// Holds one live Baileys socket per instance in-process, renders the rotating
// QR to a PNG data URL, mirrors ingested messages into SQLite and fans events
// out to the SSE bus. Sending goes through the gate (gate.ts) — the ONLY path
// to the socket. Every collaborator (the connection factory, the QR renderer,
// the clock) is injectable so the whole manager runs offline in tests.
import type { Database } from "bun:sqlite";
import * as QRCode from "qrcode";
import { WA_CONFIG, type WaConfig } from "./config.ts";
import {
  createWaConnection,
  type ConnectionCallbacks,
  type ConnectionHandle,
  type ConnectionOptions,
} from "./connection.ts";
import { clearInstanceAuth, isPaired } from "./auth-state.ts";
import { listInstances, instanceExists, setInstancePhone } from "./instances.ts";
import {
  handleContactsSet,
  handleHistorySetChunked,
  handleMessagesUpdate,
  handleMessagesUpsert,
  ingestMessage,
  messageTimestampSeconds,
  upsertContact,
  type MirroredMessage,
} from "./ingestion.ts";
import { getState, setState } from "./db.ts";
import { reserveSend, type GateResult } from "./gate.ts";
import { getMessageMedia, mediaView, setMediaCache, type MediaSocket } from "./media.ts";
import { listChatMedia } from "./media-jobs.ts";
import type { OnWhatsAppSocket } from "./resolver.ts";
import type { ContactPushSocket } from "./contacts.ts";

export type WaStatus = "connecting" | "qr" | "connected" | "disconnected" | "logged_out";

export interface WaEvent {
  type: "qr" | "status" | "message" | "message_status" | "reaction" | "campaign" | "validate";
  instance: string;
  data: Record<string, unknown>;
}

export type WaSubscriber = (event: WaEvent) => void;

/** Connection factory shape — the real one is `createWaConnection`. */
export type ConnectFn = (
  db: Database,
  callbacks: ConnectionCallbacks,
  options: ConnectionOptions,
) => ConnectionHandle;

/** One media attachment for a campaign send (loaded once, reused per recipient). */
export interface CampaignMedia {
  kind: "image" | "video" | "document";
  mime: string | null;
  filename: string | null;
  data: Uint8Array;
}

/** One media for a 1:1 send (POST /api/wa/send with media_id). */
export interface OutgoingMedia {
  kind: "image" | "video" | "document" | "audio";
  mime: string;
  filename: string | null;
  data: Uint8Array;
  caption?: string;
  /** Voice note (ptt). Only for audio/ogg (opus). */
  voice?: boolean;
  /** File already on disk: recorded as the mirrored message's cached download. */
  localPath?: string;
}

/** Baileys AnyMessageContent for a 1:1 media send. */
export function outgoingMediaPayload(media: OutgoingMedia): Record<string, unknown> {
  const caption = media.caption && media.caption.length > 0 ? media.caption : undefined;
  const data = Buffer.from(media.data);
  if (media.kind === "image") return { image: data, mimetype: media.mime, caption };
  if (media.kind === "video") return { video: data, mimetype: media.mime, caption };
  if (media.kind === "audio") {
    return media.voice
      ? { audio: data, mimetype: "audio/ogg; codecs=opus", ptt: true }
      : { audio: data, mimetype: media.mime, ptt: false };
  }
  return { document: data, mimetype: media.mime, fileName: media.filename ?? "arquivo", caption };
}

/** Local mirror content for a media send whose socket returned nothing. */
function fallbackMediaContent(media: OutgoingMedia): Record<string, unknown> {
  const node: Record<string, unknown> = {
    mimetype: media.voice ? "audio/ogg; codecs=opus" : media.mime,
    fileLength: media.data.length,
  };
  if (media.caption) node.caption = media.caption;
  if (media.kind === "document") return { documentMessage: { ...node, fileName: media.filename ?? "arquivo" } };
  if (media.kind === "audio") return { audioMessage: { ...node, ptt: Boolean(media.voice) } };
  return { [`${media.kind}Message`]: node };
}

/** Socket surface the manager needs beyond the connection lifecycle. Content is
 *  a Baileys AnyMessageContent ({text} or {image|video|document, caption, ...}). */
interface SendableSocket {
  sendMessage: (jid: string, content: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  logout: () => Promise<void>;
  onWhatsApp: (...jids: string[]) => Promise<Array<{ jid: string; exists: boolean }> | undefined>;
  fetchMessageHistory: (
    count: number,
    oldestMsgKey: { remoteJid: string; id: string; fromMe: boolean },
    oldestMsgTimestamp: number,
  ) => Promise<string>;
}

/** Outcome of a lazy-load fetch trigger — the route maps this to has_more/fetching. */
export type FetchOlderStatus = "triggered" | "pending" | "exhausted" | "not_connected" | "empty";

const HISTORY_FETCH_COUNT = 50;
const HISTORY_FETCH_SETTLE_MS = 8000;
/** Media recovery: on-demand history pages asked per run, and the overall wait. */
const RECOVER_MAX_REQUESTS = 6;
const RECOVER_TIMEOUT_MS = 45_000;

/** Result of a media recovery run (POST /api/wa/chats/:jid/media/recover). */
export interface RecoverMediaResult {
  /** On-demand history requests sent to the phone. */
  requested: number;
  /** Media messages that went from "no keys" to downloadable. */
  recovered: number;
  still_unavailable: number;
}

/** A history batch ingested for a chat (what a recovery waits for). */
interface HistoryArrival {
  instance: string;
  /** Messages of the payload, by chat jid. */
  byChat: Map<string, HistoryKey[]>;
  sessionId: string | null;
}

interface HistoryKey {
  id: string;
  fromMe: boolean;
  ts: number;
}

type HistoryWaiter = (arrival: HistoryArrival) => void;

interface Live {
  handle: ConnectionHandle | null;
  status: WaStatus;
  /** PT-BR explanation of the current status (terminal close, QR cap...). */
  reason: string | null;
  qrDataUrl: string | null;
  qrExpiresAt: number | null;
  meJid: string | null;
  /** Bumped on every start/disconnect/remove: callbacks from an older socket
   *  carry a stale generation and are ignored (no resurrection, no flip). */
  gen: number;
  removed: boolean;
}

export interface SendResult {
  ok: boolean;
  gate: GateResult;
  message?: MirroredMessage;
  error?: string;
}

export interface WaManagerDeps {
  db: Database; // data/whatsapp.db
  config?: WaConfig;
  connect?: ConnectFn;
  renderQr?: (qr: string) => Promise<string>;
  now?: () => number;
}

const QR_TTL_MS = 60_000;
/** Default spacing between boot-time reconnects (never a burst of sockets). */
const AUTOSTART_STAGGER_MS = 1000;
const MANUAL_DISCONNECT_REASON = "Desconectado manualmente.";

/** runtime_state key holding why an instance must NOT be auto-started on boot
 *  (terminal close or manual disconnect). Empty/absent = eligible. The `@<id>`
 *  suffix is covered by deleteInstance's per-instance cleanup. */
function autostartBlockKey(id: string): string {
  return `autostart_block@${id}`;
}

async function defaultRenderQr(qr: string): Promise<string> {
  return QRCode.toDataURL(qr, { margin: 1, width: 320 });
}

/** Builds a Baileys AnyMessageContent: plain text, or media with the (already
 *  substituted) text as caption. Empty caption is omitted (media-only send). */
export function campaignPayload(text: string, media?: CampaignMedia): Record<string, unknown> {
  if (!media) return { text };
  const caption = text.length > 0 ? text : undefined;
  if (media.kind === "image") return { image: media.data, caption };
  if (media.kind === "video") return { video: media.data, caption };
  return {
    document: media.data,
    mimetype: media.mime ?? "application/octet-stream",
    fileName: media.filename ?? "arquivo",
    caption,
  };
}

export class WaManager {
  private readonly db: Database;
  private readonly config: WaConfig;
  private readonly connect: ConnectFn;
  private readonly renderQr: (qr: string) => Promise<string>;
  private readonly now: () => number;
  private readonly live = new Map<string, Live>();
  private readonly subscribers = new Set<WaSubscriber>();
  private readonly historyWaiters = new Set<HistoryWaiter>();

  constructor(deps: WaManagerDeps) {
    this.db = deps.db;
    this.config = deps.config ?? WA_CONFIG;
    this.connect = deps.connect ?? createWaConnection;
    this.renderQr = deps.renderQr ?? defaultRenderQr;
    this.now = deps.now ?? Date.now;
  }

  subscribe(fn: WaSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private broadcast(event: WaEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* a slow/broken subscriber never blocks ingestion */
      }
    }
  }

  /** A reaction updates its target (event `reaction`); anything else is a `message`. */
  private broadcastMessage(id: string, m: MirroredMessage): void {
    if (m.reaction) {
      this.broadcast({ type: "reaction", instance: id, data: { chat_jid: m.chat_jid, ...m.reaction, removed: m.reaction.emoji === "" } });
      return;
    }
    const { reaction: _reaction, ...rest } = m;
    this.broadcast({ type: "message", instance: id, data: { ...rest } });
  }

  private ensure(id: string): Live {
    let entry = this.live.get(id);
    if (!entry) {
      entry = {
        handle: null,
        status: "disconnected",
        reason: null,
        qrDataUrl: null,
        qrExpiresAt: null,
        meJid: null,
        gen: 0,
        removed: false,
      };
      this.live.set(id, entry);
    }
    return entry;
  }

  private setStatus(id: string, status: WaStatus, reason: string | null = null): void {
    const entry = this.ensure(id);
    if (entry.status === status && entry.reason === reason) return;
    entry.status = status;
    entry.reason = reason;
    this.broadcast({ type: "status", instance: id, data: { status, me_jid: entry.meJid, reason } });
  }

  /** Opens (or reopens) the socket for an instance and wires all callbacks. */
  start(id: string, opts: { repairOnLoggedOut?: boolean } = {}): void {
    const entry = this.ensure(id);
    if (entry.handle) {
      try {
        entry.handle.close();
      } catch {
        /* best-effort */
      }
      entry.handle = null;
    }
    entry.removed = false;
    const gen = ++entry.gen;
    entry.qrDataUrl = null;
    entry.qrExpiresAt = null;
    this.setStatus(id, "connecting");

    // The live entry, only while this socket is still the current one.
    const current = (): Live | null => {
      const e = this.live.get(id);
      return e && !e.removed && e.gen === gen ? e : null;
    };

    entry.handle = this.connect(
      this.db,
      {
        onQr: (qr) => {
          if (!current()) return;
          void this.renderQr(qr)
            .then((dataUrl) => {
              const e = current();
              if (!e) return;
              e.qrDataUrl = dataUrl;
              e.qrExpiresAt = this.now() + QR_TTL_MS;
              e.status = "qr";
              e.reason = null;
              this.broadcast({ type: "status", instance: id, data: { status: "qr" } });
              this.broadcast({ type: "qr", instance: id, data: { qr: dataUrl, expires_at: e.qrExpiresAt } });
            })
            .catch((error) => console.error(`[wa:${id}] falha ao renderizar o QR: ${String(error)}`));
        },
        onOpen: (meJid) => {
          const e = current();
          if (!e) return;
          e.meJid = meJid;
          e.qrDataUrl = null;
          e.qrExpiresAt = null;
          if (meJid) setInstancePhone(this.db, id, meJid.split(":")[0]!.split("@")[0]!);
          this.setAutostartBlock(id, null); // a working session is eligible again
          this.setStatus(id, "connected");
        },
        onClose: (_reason, willReconnect, statusCode, detail) => {
          if (!current()) return; // late close of a replaced/removed socket
          if (willReconnect) {
            this.setStatus(id, "connecting", detail ?? null);
            return;
          }
          // Terminal close (440/403/411/401, QR cap): never auto-start it on
          // the next boot — reconnecting would fight another session or
          // hammer a restricted account. A manual reconnect that opens clears it.
          this.setAutostartBlock(id, detail ?? `conexão encerrada (${statusCode ?? "desconhecido"})`);
          if (statusCode === 401) {
            // Saved session is logged out (device unlinked on the phone). The
            // connection layer already wiped this instance's auth, so a new
            // pairing works without deleting the DB. When asked (reconnect
            // path), reopen right away so a fresh QR is emitted — chats and
            // contacts are preserved.
            clearInstanceAuth(this.db, id);
            if (opts.repairOnLoggedOut) {
              this.start(id); // fresh (unauthenticated) socket → QR
              return;
            }
            this.setStatus(id, "logged_out", detail ?? null);
            return;
          }
          this.setStatus(id, "disconnected", detail ?? null);
        },
        onMessagesUpsert: (payload) => {
          if (!current()) return;
          const rows = handleMessagesUpsert(this.db, id, payload as { messages?: Record<string, unknown>[] });
          for (const m of rows) this.broadcastMessage(id, m);
        },
        onHistorySet: (payload) => {
          if (!current()) return;
          // Non-blocking: the initial backfill can be large; ingest in chunks
          // and let the event loop breathe. The UI polls to see what landed.
          const history = payload as {
            chats?: Record<string, unknown>[];
            contacts?: Record<string, unknown>[];
            messages?: Record<string, unknown>[];
          };
          void handleHistorySetChunked(this.db, id, history)
            .then(() => this.notifyHistory(id, payload))
            .catch((error) => {
              // backfill is best-effort; a bad batch never kills the connection
              console.error(`[wa:${id}] falha no backfill do histórico: ${String(error)}`);
            });
        },
        onMessagesUpdate: (updates) => {
          if (!current()) return;
          handleMessagesUpdate(this.db, id, updates as Array<{ key?: Record<string, unknown> }>, (change) =>
            this.broadcast({ type: "message_status", instance: id, data: { ...change } }),
          );
        },
        onContactsUpsert: (contacts) => {
          if (!current()) return;
          for (const c of (contacts as Array<{ id?: string }>) ?? []) {
            if (c && typeof c.id === "string") upsertContact(this.db, id, c as { id: string });
          }
        },
        onContactsSet: (contacts) => {
          if (!current()) return;
          handleContactsSet(this.db, id, (contacts as Record<string, unknown>[]) ?? []);
        },
      },
      { instanceId: id },
    );
  }

  /** Closes the socket but PRESERVES the auth state (reconnect needs no QR). */
  disconnect(id: string): void {
    const entry = this.live.get(id);
    if (entry) entry.gen++; // the closing socket's late events are now stale
    if (entry?.handle) {
      try {
        entry.handle.close();
      } catch {
        /* best-effort */
      }
      entry.handle = null;
    }
    entry && (entry.qrDataUrl = null);
    // The user chose to go offline: a restart/hot reload must not undo it.
    this.setAutostartBlock(id, MANUAL_DISCONNECT_REASON);
    this.setStatus(id, "disconnected");
  }

  private autostartBlock(id: string): string | null {
    const value = getState(this.db, autostartBlockKey(id));
    return value && value.length > 0 ? value : null;
  }

  private setAutostartBlock(id: string, reason: string | null): void {
    if (reason === null && !this.autostartBlock(id)) return;
    setState(this.db, autostartBlockKey(id), reason ?? "");
  }

  /**
   * Boot-time reconnect: starts every PAIRED instance (stored credentials) that
   * has no live entry yet and is not blocked (terminal close or manual
   * disconnect), one every `staggerMs`. Unpaired instances are never started
   * (that would open QR sockets nobody asked for). Each start re-checks the
   * conditions, so a click/delete meanwhile wins. Returns the scheduled ids.
   */
  autoStartPaired(opts: { staggerMs?: number } = {}): string[] {
    const staggerMs = opts.staggerMs ?? AUTOSTART_STAGGER_MS;
    const eligible = (id: string): boolean =>
      !this.live.has(id) && instanceExists(this.db, id) && isPaired(this.db, id).paired && !this.autostartBlock(id);
    const ids = listInstances(this.db)
      .map((row) => row.id)
      .filter(eligible);
    ids.forEach((id, index) => {
      setTimeout(() => {
        if (!eligible(id)) return;
        try {
          this.start(id);
        } catch (error) {
          console.error(`[wa:${id}] falha ao reconectar no boot: ${String(error)}`);
        }
      }, index * staggerMs);
    });
    return ids;
  }

  /**
   * Reopens from the saved session. A valid session reconnects with NO QR; an
   * invalid one (needs re-registration) emits a QR naturally; a logged-out
   * session (401) auto-repairs (wipe auth + reopen) so it also ends in a QR —
   * chats/contacts are always preserved.
   */
  reconnect(id: string): void {
    this.start(id, { repairOnLoggedOut: true });
  }

  /**
   * Repair an EXISTING account whose session died: wipe ONLY this instance's
   * auth (the `i:<id>:*` credential keys) and reopen to emit a fresh QR. Keeps
   * the instance row, chats and contacts (unlike DELETE, which removes them).
   * Use when reconnect can no longer restore the session (status logged_out).
   */
  repair(id: string): void {
    const entry = this.live.get(id);
    if (entry?.handle) {
      try {
        entry.handle.close();
      } catch {
        /* best-effort: the socket may already be down */
      }
      entry.handle = null;
    }
    clearInstanceAuth(this.db, id); // ONLY auth_state (i:<id>:*) — never chats/contacts
    this.start(id); // fresh (unauthenticated) socket → QR
  }

  /** Logs out at the socket AND wipes this instance's auth (next connect = new QR). */
  async remove(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (entry) {
      // Mark removed BEFORE logout: the logout's own close event (and any late
      // event) must not resurrect the entry or touch its status.
      entry.removed = true;
      entry.gen++;
    }
    if (entry?.handle) {
      const sock = entry.handle.getSocket() as unknown as SendableSocket | undefined;
      try {
        await sock?.logout();
      } catch {
        /* the socket may already be down — clearing auth below still forces a new QR */
      }
      try {
        entry.handle.close();
      } catch {
        /* best-effort */
      }
    }
    clearInstanceAuth(this.db, id);
    this.broadcast({ type: "status", instance: id, data: { status: "logged_out", me_jid: entry?.meJid ?? null, reason: null } });
    this.live.delete(id);
  }

  /** Live runtime view of an instance (for GET /instances and /qr). */
  runtime(id: string): {
    status: WaStatus;
    reason: string | null;
    qrDataUrl: string | null;
    qrExpiresAt: number | null;
    meJid: string | null;
  } {
    const entry = this.live.get(id);
    if (entry) {
      return {
        status: entry.status,
        reason: entry.reason,
        qrDataUrl: entry.qrDataUrl,
        qrExpiresAt: entry.qrExpiresAt,
        meJid: entry.meJid,
      };
    }
    // No live socket: paired means a session exists on disk but is offline.
    // The reason survives restarts: why it was not auto-started on boot.
    const paired = isPaired(this.db, id);
    return { status: "disconnected", reason: this.autostartBlock(id), qrDataUrl: null, qrExpiresAt: null, meJid: paired.meJid };
  }

  /**
   * Sends a text message through the gate — the only path to the socket. Blocks
   * with a structured gate result, or mirrors the sent message and fans it out.
   */
  async sendText(
    id: string,
    jid: string,
    text: string,
    opts: { at?: Date; overrideQuietHours?: boolean } = {},
  ): Promise<SendResult> {
    const entry = this.live.get(id);
    if (!entry?.handle || entry.status !== "connected") {
      const gate: GateResult = { allowed: false, blocked_code: null, blocked_reason: "instância não conectada" };
      return { ok: false, gate, error: "instância não conectada" };
    }
    // Check + reserve the slot atomically, BEFORE awaiting the socket.
    const gate = reserveSend(this.db, this.config, jid, {
      at: opts.at,
      overrideQuietHours: opts.overrideQuietHours ?? true,
    });
    if (!gate.allowed) return { ok: false, gate };

    const sock = entry.handle.getSocket() as unknown as SendableSocket;
    let sent: Record<string, unknown> | undefined;
    try {
      sent = await sock.sendMessage(jid, { text });
    } catch (error) {
      return { ok: false, gate, error: error instanceof Error ? error.message : String(error) };
    }

    const waMessage: Record<string, unknown> = sent ?? {
      key: { remoteJid: jid, fromMe: true, id: `local-${crypto.randomUUID()}` },
      message: { conversation: text },
      messageTimestamp: Math.floor((opts.at?.getTime() ?? this.now()) / 1000),
      status: "sent",
    };
    const message = ingestMessage(this.db, id, waMessage, "sent") ?? undefined;
    if (message) this.broadcastMessage(id, message);
    return { ok: true, gate, message };
  }

  /**
   * Campaign send: same single-path-to-the-socket discipline as sendText, but
   * the gate is applied WITHOUT the quiet-hours override — on a mass send the
   * throttle IS the anti-ban protection and must not be relaxed. Supports an
   * optional media carried with the (already substituted) text as caption.
   */
  async sendCampaignMessage(
    id: string,
    jid: string,
    content: { text: string; media?: CampaignMedia },
    opts: { at?: Date } = {},
  ): Promise<SendResult> {
    const entry = this.live.get(id);
    if (!entry?.handle || entry.status !== "connected") {
      const gate: GateResult = { allowed: false, blocked_code: null, blocked_reason: "instância não conectada" };
      return { ok: false, gate, error: "instância não conectada" };
    }
    const gate = reserveSend(this.db, this.config, jid, { at: opts.at, overrideQuietHours: false });
    if (!gate.allowed) return { ok: false, gate };

    const sock = entry.handle.getSocket() as unknown as SendableSocket;
    let sent: Record<string, unknown> | undefined;
    try {
      sent = await sock.sendMessage(jid, campaignPayload(content.text, content.media));
    } catch (error) {
      return { ok: false, gate, error: error instanceof Error ? error.message : String(error) };
    }

    const waMessage: Record<string, unknown> = sent ?? {
      key: { remoteJid: jid, fromMe: true, id: `local-${crypto.randomUUID()}` },
      message: { conversation: content.text },
      messageTimestamp: Math.floor((opts.at?.getTime() ?? this.now()) / 1000),
      status: "sent",
    };
    const message = ingestMessage(this.db, id, waMessage, "sent") ?? undefined;
    if (message) this.broadcastMessage(id, message);
    return { ok: true, gate, message };
  }

  /**
   * Media send (1:1): same gate as sendText (quiet-hours override only for a
   * reply, decided by the caller). The sent message is mirrored WITH its media
   * row, and the local file is recorded as its cached download.
   */
  async sendMedia(
    id: string,
    jid: string,
    media: OutgoingMedia,
    opts: { at?: Date; overrideQuietHours?: boolean } = {},
  ): Promise<SendResult> {
    const entry = this.live.get(id);
    if (!entry?.handle || entry.status !== "connected") {
      const gate: GateResult = { allowed: false, blocked_code: null, blocked_reason: "instância não conectada" };
      return { ok: false, gate, error: "instância não conectada" };
    }
    const gate = reserveSend(this.db, this.config, jid, {
      at: opts.at,
      overrideQuietHours: opts.overrideQuietHours ?? true,
    });
    if (!gate.allowed) return { ok: false, gate };

    const sock = entry.handle.getSocket() as unknown as SendableSocket;
    let sent: Record<string, unknown> | undefined;
    try {
      sent = await sock.sendMessage(jid, outgoingMediaPayload(media));
    } catch (error) {
      return { ok: false, gate, error: error instanceof Error ? error.message : String(error) };
    }

    const waMessage: Record<string, unknown> = sent ?? {
      key: { remoteJid: jid, fromMe: true, id: `local-${crypto.randomUUID()}` },
      message: fallbackMediaContent(media),
      messageTimestamp: Math.floor((opts.at?.getTime() ?? this.now()) / 1000),
      status: "sent",
    };
    const message = ingestMessage(this.db, id, waMessage, "sent") ?? undefined;
    if (message && media.localPath) {
      const key = { instance: id, chat: message.chat_jid, id: message.message_id, fromMe: true };
      setMediaCache(this.db, key, media.localPath, null);
      message.media = mediaView(getMessageMedia(this.db, key), message.type);
    }
    if (message) this.broadcastMessage(id, message);
    return { ok: true, gate, message };
  }

  /** The connected instance's reupload surface for media downloads, or null. */
  mediaSocket(id: string): MediaSocket | null {
    const entry = this.live.get(id);
    if (!entry?.handle || entry.status !== "connected") return null;
    const sock = entry.handle.getSocket();
    return sock ? (sock as unknown as MediaSocket) : null;
  }

  /** The connected instance's `onWhatsApp` surface, for gated lead validation
   *  (reuses validate.ts). Returns null when the instance is not connected. */
  onWhatsAppSocket(id: string): OnWhatsAppSocket | null {
    const entry = this.live.get(id);
    if (!entry?.handle || entry.status !== "connected") return null;
    const sock = entry.handle.getSocket();
    if (!sock) return null;
    const ws = (sock as unknown as { ws?: { isOpen?: boolean } }).ws;
    if (ws && ws.isOpen === false) return null;
    return sock as unknown as OnWhatsAppSocket;
  }

  /** The connected instance's `addOrEditContact` surface, for saving contacts
   *  (reuses contacts.ts). Returns null when the instance is not connected. */
  contactPushSocket(id: string): ContactPushSocket | null {
    const entry = this.live.get(id);
    if (!entry?.handle || entry.status !== "connected") return null;
    const sock = entry.handle.getSocket();
    if (!sock) return null;
    const ws = (sock as unknown as { ws?: { isOpen?: boolean } }).ws;
    if (ws && ws.isOpen === false) return null;
    return sock as unknown as ContactPushSocket;
  }

  /** Fans an event out to the SSE subscribers (used by the campaign runner). */
  publish(event: WaEvent): void {
    this.broadcast(event);
  }

  /**
   * Lazy-load: ask WhatsApp for messages OLDER than the local mirror's oldest
   * for a chat, via Baileys `fetchMessageHistory` (arrivals come back through
   * `messaging-history.set` and get ingested). Anchored on the mirror's oldest
   * key/timestamp. Idempotent per anchor: a repeat on the SAME oldest that has
   * had time to settle means WhatsApp returned nothing more → `exhausted`.
   */
  fetchOlderHistory(id: string, jid: string): FetchOlderStatus {
    const entry = this.live.get(id);
    if (!entry?.handle || entry.status !== "connected") return "not_connected";
    const oldest = this.db
      .query(
        `SELECT message_id, from_me, timestamp FROM messages
         WHERE instance_id = ? AND chat_jid = ? ORDER BY timestamp ASC, rowid ASC LIMIT 1`,
      )
      .get(id, jid) as { message_id: string; from_me: number; timestamp: number } | null;
    if (!oldest) return "empty";

    const anchorKey = `hist_anchor:${id}:${jid}`;
    const nowMs = this.now();
    const prev = getState(this.db, anchorKey); // "<ts>:<atMs>"
    if (prev) {
      const [prevTs, prevAt] = prev.split(":");
      if (prevTs === String(oldest.timestamp)) {
        // No older message has arrived since we last anchored here.
        return nowMs - Number(prevAt ?? 0) >= HISTORY_FETCH_SETTLE_MS ? "exhausted" : "pending";
      }
    }
    setState(this.db, anchorKey, `${oldest.timestamp}:${nowMs}`);
    const sock = entry.handle.getSocket() as unknown as SendableSocket;
    try {
      void sock
        .fetchMessageHistory(
          HISTORY_FETCH_COUNT,
          { remoteJid: jid, id: oldest.message_id, fromMe: oldest.from_me === 1 },
          oldest.timestamp,
        )
        .catch(() => {
          /* on-demand fetch is best-effort; the next page retries */
        });
    } catch {
      /* socket variant without fetchMessageHistory — treat as best-effort no-op */
    }
    return "triggered";
  }

  /** Tells pending recoveries that a history batch was ingested. */
  private notifyHistory(id: string, payload: unknown): void {
    if (this.historyWaiters.size === 0) return;
    const p = (payload ?? {}) as { messages?: Array<Record<string, unknown>>; peerDataRequestSessionId?: unknown };
    const byChat = new Map<string, HistoryKey[]>();
    for (const m of p.messages ?? []) {
      const key = (m.key ?? {}) as { remoteJid?: unknown; id?: unknown; fromMe?: unknown };
      if (typeof key.remoteJid !== "string" || typeof key.id !== "string") continue;
      const list = byChat.get(key.remoteJid) ?? [];
      list.push({ id: key.id, fromMe: Boolean(key.fromMe), ts: messageTimestampSeconds(m) });
      byChat.set(key.remoteJid, list);
    }
    const arrival: HistoryArrival = {
      instance: id,
      byChat,
      sessionId: typeof p.peerDataRequestSessionId === "string" ? p.peerDataRequestSessionId : null,
    };
    for (const waiter of [...this.historyWaiters]) waiter(arrival);
  }

  /**
   * Media recovery: messages received before the media update have no keys.
   * Asks the phone for this chat's history again (on-demand history sync,
   * anchored at the NEWEST stored message, then page by page backwards) so the
   * re-delivered messages store their media keys (ingestMessage upserts
   * message_media even for messages already mirrored). Stops when every
   * unavailable media is inside the fetched range, when the phone stops
   * answering, after `maxRequests` pages or after `timeoutMs` overall.
   */
  async recoverChatMedia(
    id: string,
    jid: string,
    opts: { maxRequests?: number; timeoutMs?: number; count?: number } = {},
  ): Promise<RecoverMediaResult | "not_connected"> {
    const entry = this.live.get(id);
    if (!entry?.handle || entry.status !== "connected") return "not_connected";
    const maxRequests = opts.maxRequests ?? RECOVER_MAX_REQUESTS;
    const count = Math.min(opts.count ?? HISTORY_FETCH_COUNT, HISTORY_FETCH_COUNT);
    const deadline = Date.now() + (opts.timeoutMs ?? RECOVER_TIMEOUT_MS);

    const unavailable = () => listChatMedia(this.db, id, jid).filter((m) => m.state === "unavailable");
    const before = unavailable();
    if (before.length === 0) return { requested: 0, recovered: 0, still_unavailable: 0 };
    const oldestMissingTs = Math.min(...before.map((m) => m.ts));

    let anchor = this.db
      .query(
        `SELECT message_id, from_me, timestamp FROM messages
         WHERE instance_id = ? AND chat_jid = ? AND message_id NOT LIKE 'local-%'
         ORDER BY timestamp DESC, rowid DESC LIMIT 1`,
      )
      .get(id, jid) as { message_id: string; from_me: number; timestamp: number } | null;

    let requested = 0;
    while (anchor && requested < maxRequests && Date.now() < deadline) {
      const current = this.live.get(id);
      if (!current?.handle || current.status !== "connected") break;
      const sock = current.handle.getSocket() as unknown as SendableSocket;

      // Registered BEFORE the request: the answer can arrive very fast.
      let requestId: string | null = null;
      let settle: (batch: HistoryKey[] | null) => void = () => {};
      const arrived = new Promise<HistoryKey[] | null>((resolve) => (settle = resolve));
      const waiter: HistoryWaiter = (a) => {
        if (a.instance !== id) return;
        const batch = a.byChat.get(jid);
        if (batch?.length) settle(batch);
        else if (requestId !== null && a.sessionId === requestId) settle([]); // answered, nothing older
      };
      this.historyWaiters.add(waiter);
      const timer = setTimeout(() => settle(null), Math.max(0, deadline - Date.now()));
      try {
        requestId = await sock.fetchMessageHistory(
          count,
          { remoteJid: jid, id: anchor.message_id, fromMe: anchor.from_me === 1 },
          // historySyncOnDemandRequest.oldestMsgTimestampMs is in milliseconds.
          anchor.timestamp * 1000,
        );
        requested++;
      } catch (error) {
        console.error(`[wa:${id}] pedido de histórico sob demanda falhou: ${String(error)}`);
        settle(null);
      }
      const batch = await arrived;
      clearTimeout(timer);
      this.historyWaiters.delete(waiter);
      if (!batch || batch.length === 0) break;

      // Next page: anchored at the oldest message of this batch.
      const oldest = batch.reduce((a, b) => (b.ts < a.ts ? b : a));
      if (oldest.ts >= anchor.timestamp) break; // no progress backwards
      if (unavailable().length === 0 || oldest.ts <= oldestMissingTs) break;
      anchor = { message_id: oldest.id, from_me: oldest.fromMe ? 1 : 0, timestamp: oldest.ts };
    }

    const after = new Set(unavailable().map((m) => `${m.id}|${m.fromMe ? 1 : 0}`));
    const recovered = before.filter((m) => !after.has(`${m.id}|${m.fromMe ? 1 : 0}`)).length;
    return { requested, recovered, still_unavailable: after.size };
  }
}
