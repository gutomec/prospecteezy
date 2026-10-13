// Offline test doubles for the WhatsApp backend: a fake connection factory that
// captures the manager's callbacks per instance so a test can drive Baileys
// events (onQr/onOpen/onClose/onMessagesUpsert), plus a fake socket recording
// sends and logout. No network, no real Baileys.
import type { WASocket } from "baileys";
import type { ConnectFn } from "../manager.ts";
import type { ConnectionCallbacks, ConnectionHandle } from "../connection.ts";

export interface FakeSocket {
  /** `text` is the text (or caption) sent. */
  sentMessages: Array<{ jid: string; text: string }>;
  /** Full AnyMessageContent of every send (media payloads included). */
  sentContents: Array<{ jid: string; content: Record<string, unknown> }>;
  loggedOut: boolean;
  sendMessage: (jid: string, content: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Reupload requests (expired media URL) — returns the message with a fresh url. */
  reuploads: string[];
  updateMediaMessage: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
  logout: () => Promise<void>;
  historyFetches: Array<{ count: number; key: { remoteJid: string; id: string; fromMe: boolean }; ts: number }>;
  fetchMessageHistory: (
    count: number,
    key: { remoteJid: string; id: string; fromMe: boolean },
    ts: number,
  ) => Promise<string>;
  /** `user` strings (number before @) that exist on WhatsApp — configure in tests. */
  onWhatsAppRegistry: Set<string>;
  onWhatsAppCalls: string[][];
  onWhatsApp: (...numbers: string[]) => Promise<Array<{ jid: string; exists: boolean }>>;
  failSend?: boolean;
}

export interface FakeInstanceState {
  callbacks: ConnectionCallbacks;
  sock: FakeSocket;
  closed: boolean;
}

export interface FakeConnect {
  connect: ConnectFn;
  instances: Map<string, FakeInstanceState>;
  /** Latest captured callbacks for an instance (throws if never connected). */
  cb: (id: string) => ConnectionCallbacks;
  sock: (id: string) => FakeSocket;
}

export function makeFakeConnect(): FakeConnect {
  const instances = new Map<string, FakeInstanceState>();

  const connect: ConnectFn = (_db, callbacks, options) => {
    const id = options.instanceId ?? "main";
    const sock: FakeSocket = {
      sentMessages: [],
      loggedOut: false,
      historyFetches: [],
      reuploads: [],
      sentContents: [],
      sendMessage: async (jid, content) => {
        if (sock.failSend) throw new Error("network down");
        const text = String(content.text ?? content.caption ?? "");
        sock.sentMessages.push({ jid, text });
        sock.sentContents.push({ jid, content });
        return {
          key: { remoteJid: jid, fromMe: true, id: `srv-${sock.sentMessages.length}` },
          message: fakeSentContent(content),
          messageTimestamp: 1_700_000_000,
          status: "sent",
        };
      },
      updateMediaMessage: async (message) => {
        const key = message.key as { id: string };
        sock.reuploads.push(key.id);
        const msg = message.message as Record<string, Record<string, unknown>>;
        const type = Object.keys(msg)[0]!;
        return { ...message, message: { [type]: { ...msg[type], url: "https://mmg.example/fresh", directPath: "/fresh" } } };
      },
      logout: async () => {
        sock.loggedOut = true;
      },
      fetchMessageHistory: async (count, key, ts) => {
        sock.historyFetches.push({ count, key, ts });
        return `req-${sock.historyFetches.length}`;
      },
      onWhatsAppRegistry: new Set<string>(),
      onWhatsAppCalls: [],
      // Baileys semantics: only existing numbers come back in the array (absent
      // ≠ exists:false). Matched by jid, never by index.
      onWhatsApp: async (...numbers) => {
        sock.onWhatsAppCalls.push(numbers);
        return numbers
          .filter((n) => sock.onWhatsAppRegistry.has(n))
          .map((n) => ({ jid: `${n}@s.whatsapp.net`, exists: true }));
      },
    };
    const state: FakeInstanceState = { callbacks, sock, closed: false };
    instances.set(id, state);
    const handle: ConnectionHandle = {
      getSocket: () => sock as unknown as WASocket,
      close: () => {
        state.closed = true;
      },
    };
    return handle;
  };

  return {
    connect,
    instances,
    cb: (id) => {
      const s = instances.get(id);
      if (!s) throw new Error(`fake: instance '${id}' never connected`);
      return s.callbacks;
    },
    sock: (id) => {
      const s = instances.get(id);
      if (!s) throw new Error(`fake: instance '${id}' never connected`);
      return s.sock;
    },
  };
}

/** What Baileys would mirror for a sent content: text, or a media node with keys. */
function fakeSentContent(content: Record<string, unknown>): Record<string, unknown> {
  if (typeof content.text === "string") return { conversation: content.text };
  const kind = (["image", "video", "audio", "document"] as const).find((k) => content[k] !== undefined);
  if (!kind) return { conversation: "" };
  const data = content[kind] as Uint8Array;
  return {
    [`${kind}Message`]: {
      url: "https://mmg.example/sent",
      directPath: "/sent",
      mediaKey: new Uint8Array([1, 2, 3, 4]),
      mimetype: content.mimetype,
      fileLength: data.length,
      ...(content.caption ? { caption: content.caption } : {}),
      ...(content.fileName ? { fileName: content.fileName } : {}),
      ...(kind === "audio" ? { ptt: content.ptt === true } : {}),
    },
  };
}

/** Flushes pending tasks so async QR rendering settles before assertions. */
export function tick(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Seeds a paired-looking credentials row for an instance (isPaired → true). */
export function seedPairedCreds(
  db: import("bun:sqlite").Database,
  instanceId: string,
  meJid = "5511999999999:1@s.whatsapp.net",
): void {
  const prefix = instanceId === "main" ? "" : `i:${instanceId}:`;
  db.query(
    `INSERT INTO auth_state (category, key_id, value, updated_at)
     VALUES (?, '', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (category, key_id) DO UPDATE SET value = excluded.value`,
  ).run(`${prefix}creds`, JSON.stringify({ registered: true, me: { id: meJid } }));
}
