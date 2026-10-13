import type { Database } from "bun:sqlite";
import type { UIMessage } from "ai";
import { nowIso } from "../db/index.ts";

/** Server-side state of one /api/chat conversation (AI SDK UIMessage[]). */
export interface Chat {
  id: string;
  title: string | null;
  messages: UIMessage[];
  credits_used: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface ChatSummary {
  id: string;
  title: string | null;
  credits_used: number;
  created_at: string;
  updated_at: string;
}

const TITLE_MAX = 80;
const LIST_LIMIT = 100;

export function loadChat(db: Database, id: string): Chat | null {
  const row = db.query("SELECT * FROM ai_chats WHERE id = ?").get(id) as {
    id: string;
    title: string | null;
    messages_json: string;
    credits_used: number;
    created_at: string;
    updated_at: string;
  } | null;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    messages: JSON.parse(row.messages_json) as UIMessage[],
    credits_used: row.credits_used,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function loadOrCreateChat(db: Database, id: string): Chat {
  return loadChat(db, id) ?? { id, title: null, messages: [], credits_used: 0, created_at: null, updated_at: null };
}

/** Text of a UI message (its text parts). */
export function uiMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** Title = the first user message, clipped. */
function deriveTitle(messages: UIMessage[]): string | null {
  const first = messages.find((m) => m.role === "user");
  const text = first ? uiMessageText(first).replace(/\s+/g, " ") : "";
  if (!text) return null;
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

export function saveChat(db: Database, chat: Chat): void {
  const now = nowIso();
  chat.title ??= deriveTitle(chat.messages);
  db.query(
    `INSERT INTO ai_chats (id, title, messages_json, credits_used, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       messages_json = excluded.messages_json,
       credits_used = excluded.credits_used,
       updated_at = excluded.updated_at`,
  ).run(chat.id, chat.title, JSON.stringify(chat.messages), chat.credits_used, chat.created_at ?? now, now);
}

export function listChats(db: Database): ChatSummary[] {
  return db
    .query("SELECT id, title, credits_used, created_at, updated_at FROM ai_chats ORDER BY updated_at DESC LIMIT ?")
    .all(LIST_LIMIT) as ChatSummary[];
}

export function deleteChat(db: Database, id: string): boolean {
  return db.query("DELETE FROM ai_chats WHERE id = ?").run(id).changes > 0;
}
