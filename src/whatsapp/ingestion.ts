// Baileys events → SQLite mirror (chats, messages, contacts), scoped by
// instance_id. Pure functions over (db, instanceId, payload) so tests run with
// no socket. Text-extraction and unwrap logic ported from the squad template
// lib/ingest.ts (~/squads is READ-ONLY). Media messages store their row (type +
// caption) plus, since the wa-media phase, a message_media row with what is
// needed to download the file later (media.ts); replies keep the quoted id/text
// and reactions are attached to their target (message_reactions).
import type { Database } from "bun:sqlite";
import { nowIso } from "./db.ts";
import { extractMedia, getMessageMedia, mediaView, upsertMessageMedia, type MediaView } from "./media.ts";

type AnyMessage = Record<string, unknown>;

/** A mirrored message, shaped for the API and the SSE `message` event. */
export interface MirroredMessage {
  chat_jid: string;
  message_id: string;
  from_me: boolean;
  text: string | null;
  /** Stored message_type (conversation, imageMessage, ...). */
  type: string | null;
  ts: number;
  status: string | null;
  /** Media descriptor (null for non-media messages). */
  media?: MediaView | null;
  /** Reply context: the quoted message id and a short text (null when not a reply). */
  quoted?: QuotedRef | null;
  /** Set on reactionMessage rows: the target message and the emoji ("" = removed). */
  reaction?: { target_id: string; emoji: string; from_me: boolean } | null;
}

export interface QuotedRef {
  id: string;
  text: string | null;
  type: string | null;
}

function asObject(value: unknown): AnyMessage | null {
  return value && typeof value === "object" ? (value as AnyMessage) : null;
}

/** Unwraps message envelopes (ephemeral/viewOnce/deviceSent/edited/…) down to
 *  the renderable content. Same iterative walk as the squad, with a guard. */
export function unwrapContent(message: unknown): AnyMessage | null {
  let cur = asObject(message);
  if (!cur) return null;
  for (let guard = 0; guard < 6; guard++) {
    const next =
      asObject(cur.ephemeralMessage)?.message ??
      asObject(cur.viewOnceMessage)?.message ??
      asObject(cur.viewOnceMessageV2)?.message ??
      asObject(cur.viewOnceMessageV2Extension)?.message ??
      asObject(cur.deviceSentMessage)?.message ??
      asObject(cur.documentWithCaptionMessage)?.message ??
      asObject(cur.editedMessage)?.message ??
      asObject(cur.protocolMessage)?.editedMessage ??
      null;
    const nextObj = asObject(next);
    if (!nextObj) break;
    cur = nextObj;
  }
  return cur;
}

/** Best-effort text of a message content (conversation / captions / extended
 *  text). Non-text types return null — the row is still stored. */
export function extractText(content: unknown): string | null {
  const inner = unwrapContent(content);
  if (!inner) return null;
  const extended = asObject(inner.extendedTextMessage);
  const image = asObject(inner.imageMessage);
  const video = asObject(inner.videoMessage);
  const doc = asObject(inner.documentMessage);
  const direct =
    (typeof inner.conversation === "string" ? inner.conversation : null) ??
    (typeof extended?.text === "string" ? extended.text : null) ??
    (typeof image?.caption === "string" ? image.caption : null) ??
    (typeof video?.caption === "string" ? video.caption : null) ??
    (typeof doc?.caption === "string" ? doc.caption : null);
  return direct ?? null;
}

/** Keys that ride along the real content and must never name its type. In
 *  groups, senderKeyDistributionMessage often comes FIRST on a normal text. */
const AUXILIARY_KEYS = new Set(["messageContextInfo", "senderKeyDistributionMessage"]);

/** First real content key, used as the stored message_type. A message that
 *  carries ONLY an auxiliary key keeps it (a pure system message). */
export function contentType(content: unknown): string | null {
  const inner = unwrapContent(content);
  if (!inner) return null;
  const keys = Object.keys(inner).filter((k) => k !== "messageContextInfo");
  return keys.find((k) => !AUXILIARY_KEYS.has(k)) ?? keys[0] ?? null;
}

/** Phone number (digits) of a `@s.whatsapp.net` jid, device suffix dropped. */
export function phoneOfPnJid(jid: unknown): string | null {
  if (typeof jid !== "string" || !jid.endsWith("@s.whatsapp.net")) return null;
  return jid.split("@")[0]!.split(":")[0]! || null;
}

/** An edit (protocolMessage MESSAGE_EDIT) found through the usual envelopes:
 *  the ORIGINAL message id and the new content. Null for anything else. */
function findEdit(message: unknown): { targetId: string; content: unknown } | null {
  let cur = asObject(message);
  for (let guard = 0; cur && guard < 6; guard++) {
    const proto = asObject(cur.protocolMessage);
    const targetId = asObject(proto?.key)?.id;
    if (proto?.editedMessage && typeof targetId === "string") {
      return { targetId, content: proto.editedMessage };
    }
    cur =
      asObject(asObject(cur.ephemeralMessage)?.message) ??
      asObject(asObject(cur.editedMessage)?.message) ??
      asObject(asObject(cur.deviceSentMessage)?.message) ??
      null;
  }
  return null;
}

const QUOTED_TEXT_MAX = 200;

/** Reply context of an unwrapped content: contextInfo.stanzaId + quoted text. */
function quotedOf(inner: AnyMessage | null, type: string | null): QuotedRef | null {
  if (!inner || !type) return null;
  const ctx = asObject(asObject(inner[type])?.contextInfo);
  const id = ctx?.stanzaId;
  if (typeof id !== "string" || !id) return null;
  const text = extractText(ctx?.quotedMessage);
  return {
    id,
    text: text ? (text.length > QUOTED_TEXT_MAX ? `${text.slice(0, QUOTED_TEXT_MAX)}…` : text) : null,
    type: contentType(ctx?.quotedMessage),
  };
}

/** Records (or removes, on empty emoji) one reactor's reaction on a target message. */
function applyReaction(
  db: Database,
  instanceId: string,
  chatJid: string,
  node: AnyMessage,
  reactor: { jid: string; fromMe: boolean },
  timestamp: number,
): { target_id: string; emoji: string; from_me: boolean } | null {
  const targetId = asObject(node.key)?.id;
  if (typeof targetId !== "string" || !targetId) return null;
  const emoji = typeof node.text === "string" ? node.text : "";
  if (emoji === "") {
    db.query(
      "DELETE FROM message_reactions WHERE instance_id = ? AND chat_jid = ? AND target_id = ? AND reactor = ?",
    ).run(instanceId, chatJid, targetId, reactor.jid);
  } else {
    db.query(
      `INSERT INTO message_reactions (instance_id, chat_jid, target_id, reactor, from_me, emoji, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (instance_id, chat_jid, target_id, reactor) DO UPDATE SET
         emoji = excluded.emoji, timestamp = excluded.timestamp
       WHERE excluded.timestamp >= message_reactions.timestamp`,
    ).run(instanceId, chatJid, targetId, reactor.jid, reactor.fromMe ? 1 : 0, emoji, timestamp);
  }
  return { target_id: targetId, emoji, from_me: reactor.fromMe };
}

export function messageTimestampSeconds(msg: AnyMessage): number {
  const ts = msg.messageTimestamp;
  if (typeof ts === "number") return ts;
  if (ts && typeof ts === "object" && typeof (ts as { toNumber?: () => number }).toNumber === "function") {
    return (ts as { toNumber: () => number }).toNumber();
  }
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? n : Math.floor(Date.now() / 1000);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

export function upsertContact(
  db: Database,
  instanceId: string,
  contact: { id: string; name?: string; notify?: string; verifiedName?: string; [k: string]: unknown },
): void {
  // A LID contact (`@lid`) has no number in its id; Baileys 7 may carry the
  // phone-number jid in `phoneNumber` — keep it so the chat can show a phone.
  const phone = phoneOfPnJid(contact.id) ?? phoneOfPnJid(contact.phoneNumber);
  const at = nowIso();
  // Three DISTINCT names (wa-quality-backend): display_name is ONLY the phone's
  // address-book name (contact.name) — the canonical "saved in address book"
  // signal; notify_name is the pushName; verified_name is the WhatsApp Business
  // verified name. Never collapse them (a verified name is not a saved contact).
  db.query(
    `INSERT INTO contacts (instance_id, jid, phone_number, display_name, notify_name, verified_name, raw_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (instance_id, jid) DO UPDATE SET
       phone_number  = coalesce(excluded.phone_number, contacts.phone_number),
       display_name  = coalesce(excluded.display_name, contacts.display_name),
       notify_name   = coalesce(excluded.notify_name, contacts.notify_name),
       verified_name = coalesce(excluded.verified_name, contacts.verified_name),
       raw_json      = excluded.raw_json,
       updated_at    = excluded.updated_at`,
  ).run(
    instanceId,
    contact.id,
    phone,
    contact.name ?? null,
    contact.notify ?? null,
    contact.verifiedName ?? null,
    safeJson(contact),
    at,
    at,
  );
}

export function ensureChat(
  db: Database,
  instanceId: string,
  jid: string,
  patch: { name?: string | null; lastMessageAt?: number | null; lastMessageText?: string | null } = {},
): void {
  const isGroup = jid.endsWith("@g.us") ? 1 : 0;
  const at = nowIso();
  db.query(
    `INSERT INTO chats (instance_id, jid, name, is_group, last_message_at, last_message_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (instance_id, jid) DO UPDATE SET
       name              = coalesce(excluded.name, chats.name),
       last_message_at   = max(coalesce(excluded.last_message_at, 0), coalesce(chats.last_message_at, 0)),
       -- An older message (history re-sync) never replaces the newer preview.
       last_message_text = CASE
         WHEN excluded.last_message_text IS NOT NULL
          AND coalesce(excluded.last_message_at, 0) >= coalesce(chats.last_message_at, 0)
         THEN excluded.last_message_text ELSE chats.last_message_text END,
       updated_at        = excluded.updated_at`,
  ).run(
    instanceId,
    jid,
    patch.name ?? null,
    isGroup,
    patch.lastMessageAt ?? null,
    patch.lastMessageText ?? null,
    at,
    at,
  );
}

/** Ingests one WAMessage into the mirror. Returns the mirrored row for SSE, or
 *  null when the message carries no addressable chat (e.g. status@broadcast). */
export function ingestMessage(
  db: Database,
  instanceId: string,
  waMessage: AnyMessage,
  source: "live" | "history" | "sent",
): MirroredMessage | null {
  const key = asObject(waMessage.key) ?? {};
  const chatJid = typeof key.remoteJid === "string" ? key.remoteJid : undefined;
  const messageId = typeof key.id === "string" ? key.id : undefined;
  if (!chatJid || !messageId || chatJid === "status@broadcast") return null;

  const fromMe = key.fromMe ? 1 : 0;
  const isGroup = chatJid.endsWith("@g.us");
  const senderJid = fromMe
    ? null
    : ((typeof key.participant === "string" ? key.participant : null) ?? (isGroup ? null : chatJid));
  const timestamp = messageTimestampSeconds(waMessage);
  const content = waMessage.message ?? null;

  // An edit rewrites the ORIGINAL message (by protocolMessage.key.id) instead
  // of becoming a new bubble. Unknown original → nothing to rewrite.
  const edit = findEdit(content);
  if (edit) {
    const editText = extractText(edit.content);
    const editType = contentType(edit.content);
    const original = db
      .query(
        `SELECT from_me, timestamp, status FROM messages
         WHERE instance_id = ? AND chat_jid = ? AND message_id = ? LIMIT 1`,
      )
      .get(instanceId, chatJid, edit.targetId) as { from_me: number; timestamp: number; status: string | null } | null;
    if (!original) return null;
    db.query(
      `UPDATE messages SET text_content = coalesce(?, text_content), message_type = coalesce(?, message_type)
       WHERE instance_id = ? AND chat_jid = ? AND message_id = ?`,
    ).run(editText, editType, instanceId, chatJid, edit.targetId);
    const row = db
      .query("SELECT text_content, message_type FROM messages WHERE instance_id = ? AND chat_jid = ? AND message_id = ? LIMIT 1")
      .get(instanceId, chatJid, edit.targetId) as { text_content: string | null; message_type: string | null };
    return {
      chat_jid: chatJid,
      message_id: edit.targetId,
      from_me: original.from_me === 1,
      text: row.text_content,
      type: row.message_type,
      ts: original.timestamp,
      status: original.status,
    };
  }

  const text = extractText(content);
  const type = contentType(content);
  const pushName = fromMe ? null : (typeof waMessage.pushName === "string" ? waMessage.pushName : null);

  ensureChat(db, instanceId, chatJid, {
    name: isGroup ? null : pushName,
    lastMessageAt: timestamp,
    lastMessageText: text,
  });
  if (senderJid && !fromMe) {
    // participantAlt / remoteJidAlt carry the phone-number form of a LID.
    const alt = key.participant ? key.participantAlt : key.remoteJidAlt;
    upsertContact(db, instanceId, {
      id: senderJid,
      notify: pushName ?? undefined,
      ...(phoneOfPnJid(alt) ? { phoneNumber: alt as string } : {}),
    });
  }
  // Own message in a LID chat: the sender upsert above did not run, so record
  // the chat's phone number on its contact row here.
  if (fromMe && !isGroup && phoneOfPnJid(key.remoteJidAlt) && !phoneOfPnJid(chatJid)) {
    upsertContact(db, instanceId, { id: chatJid, phoneNumber: key.remoteJidAlt as string });
  }

  const status = fromMe ? (typeof waMessage.status === "string" ? waMessage.status : "sent") : null;
  const inner = unwrapContent(content);
  const quoted = quotedOf(inner, type);
  // A re-delivery (e.g. the decrypted retry of a message first stored as an
  // undecryptable stub) fills in what the first version lacked.
  db.query(
    `INSERT INTO messages (instance_id, chat_jid, message_id, from_me, sender_jid, timestamp,
                           message_type, text_content, status, source, created_at,
                           quoted_id, quoted_text, quoted_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (instance_id, chat_jid, message_id, from_me) DO UPDATE SET
       message_type = coalesce(excluded.message_type, messages.message_type),
       text_content = coalesce(excluded.text_content, messages.text_content),
       quoted_id    = coalesce(excluded.quoted_id, messages.quoted_id),
       quoted_text  = coalesce(excluded.quoted_text, messages.quoted_text),
       quoted_type  = coalesce(excluded.quoted_type, messages.quoted_type)`,
  ).run(
    instanceId,
    chatJid,
    messageId,
    fromMe,
    senderJid,
    timestamp,
    type,
    text,
    status,
    source,
    nowIso(),
    quoted?.id ?? null,
    quoted?.text ?? null,
    quoted?.type ?? null,
  );

  const mediaKey = { instance: instanceId, chat: chatJid, id: messageId, fromMe: Boolean(fromMe) };
  const extracted = extractMedia(inner, type, key, timestamp);
  if (extracted) upsertMessageMedia(db, mediaKey, extracted);
  const media = extracted ? mediaView(getMessageMedia(db, mediaKey), type) : null;

  let reaction: MirroredMessage["reaction"] = null;
  if (type === "reactionMessage" && inner) {
    const node = asObject(inner.reactionMessage);
    if (node) {
      reaction = applyReaction(
        db,
        instanceId,
        chatJid,
        node,
        { jid: fromMe ? "me" : (senderJid ?? chatJid), fromMe: Boolean(fromMe) },
        timestamp,
      );
    }
  }

  return {
    chat_jid: chatJid,
    message_id: messageId,
    from_me: Boolean(fromMe),
    text,
    type,
    ts: timestamp,
    status,
    media,
    quoted,
    reaction,
  };
}

export function handleMessagesUpsert(
  db: Database,
  instanceId: string,
  payload: { messages?: AnyMessage[] },
): MirroredMessage[] {
  const out: MirroredMessage[] = [];
  const tx = db.transaction(() => {
    for (const msg of payload.messages ?? []) {
      const r = ingestMessage(db, instanceId, msg, "live");
      if (r) out.push(r);
    }
  });
  tx();
  return out;
}

export function handleHistorySet(
  db: Database,
  instanceId: string,
  payload: { chats?: AnyMessage[]; contacts?: AnyMessage[]; messages?: AnyMessage[] },
): { chats: number; contacts: number; messages: number } {
  let chats = 0;
  let contacts = 0;
  let messages = 0;
  const tx = db.transaction(() => {
    for (const c of payload.contacts ?? []) {
      if (typeof c.id === "string") {
        upsertContact(db, instanceId, c as { id: string });
        contacts++;
      }
    }
    for (const c of payload.chats ?? []) {
      if (typeof c.id === "string") {
        ensureChat(db, instanceId, c.id, {
          name: typeof c.name === "string" ? c.name : null,
          lastMessageAt: Number(c.conversationTimestamp ?? 0) || null,
        });
        chats++;
      }
    }
    for (const m of payload.messages ?? []) {
      if (ingestMessage(db, instanceId, m, "history")) messages++;
    }
  });
  tx();
  return { chats, contacts, messages };
}

/** Ingests an initial address book (`contacts.set`), idempotently — same column
 *  split as upsertContact (display_name/notify_name/verified_name). */
export function handleContactsSet(db: Database, instanceId: string, contacts: AnyMessage[]): number {
  let n = 0;
  const tx = db.transaction(() => {
    for (const c of contacts ?? []) {
      if (c && typeof c.id === "string") {
        upsertContact(db, instanceId, c as { id: string });
        n++;
      }
    }
  });
  tx();
  return n;
}

/**
 * Non-blocking history ingestion: same result as handleHistorySet but the
 * (potentially large) message list is processed in chunks, each in its own
 * transaction, yielding to the event loop between chunks so the socket and the
 * server stay responsive during the initial backfill. Contacts/chats first
 * (so names are available immediately), then messages in chunks.
 */
export async function handleHistorySetChunked(
  db: Database,
  instanceId: string,
  payload: { chats?: AnyMessage[]; contacts?: AnyMessage[]; messages?: AnyMessage[] },
  opts: { chunkSize?: number; yield?: () => Promise<void> } = {},
): Promise<{ chats: number; contacts: number; messages: number }> {
  const chunkSize = opts.chunkSize && opts.chunkSize > 0 ? opts.chunkSize : 200;
  const yieldToLoop = opts.yield ?? (() => Bun.sleep(0));

  const contactsN = handleContactsSet(db, instanceId, payload.contacts ?? []);

  let chatsN = 0;
  const chatsTx = db.transaction(() => {
    for (const c of payload.chats ?? []) {
      if (typeof c.id === "string") {
        ensureChat(db, instanceId, c.id, {
          name: typeof c.name === "string" ? c.name : null,
          lastMessageAt: Number(c.conversationTimestamp ?? 0) || null,
        });
        chatsN++;
      }
    }
  });
  chatsTx();

  let messagesN = 0;
  const messages = payload.messages ?? [];
  for (let i = 0; i < messages.length; i += chunkSize) {
    const slice = messages.slice(i, i + chunkSize);
    const tx = db.transaction(() => {
      for (const m of slice) {
        if (ingestMessage(db, instanceId, m, "history")) messagesN++;
      }
    });
    tx();
    if (i + chunkSize < messages.length) await yieldToLoop();
  }
  return { chats: chatsN, contacts: contactsN, messages: messagesN };
}

// proto.WebMessageInfo.Status: 0 ERROR, 1 PENDING, 2 SERVER_ACK, 3 DELIVERY_ACK, 4 READ, 5 PLAYED.
const STATUS_MAP: Record<number, string> = {
  0: "error",
  1: "pending",
  2: "sent",
  3: "delivered",
  4: "read",
  5: "played",
};

/** A delivery status written to the mirror (pushed as SSE `message_status`). */
export interface MessageStatusChange {
  chat_jid: string;
  message_id: string;
  from_me: boolean;
  status: string;
}

export function handleMessagesUpdate(
  db: Database,
  instanceId: string,
  updates: Array<{ key?: AnyMessage; update?: AnyMessage }>,
  onChange?: (change: MessageStatusChange) => void,
): number {
  let touched = 0;
  for (const { key, update } of updates) {
    const remoteJid = key && typeof key.remoteJid === "string" ? key.remoteJid : null;
    const id = key && typeof key.id === "string" ? key.id : null;
    if (!remoteJid || !id) continue;
    const rawStatus = update && typeof update.status === "number" ? update.status : null;
    const status = rawStatus != null ? STATUS_MAP[rawStatus] ?? null : null;
    if (!status) continue;
    const fromMe = key?.fromMe ? 1 : 0;
    const res = db
      .query("UPDATE messages SET status = ? WHERE instance_id = ? AND chat_jid = ? AND message_id = ? AND from_me = ?")
      .run(status, instanceId, remoteJid, id, fromMe);
    touched += res.changes;
    // Only rows we mirror: an update for an unknown message is not pushed.
    if (res.changes > 0) onChange?.({ chat_jid: remoteJid, message_id: id, from_me: fromMe === 1, status });
  }
  return touched;
}
