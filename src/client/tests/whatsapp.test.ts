import { describe, expect, test } from "bun:test";
import { ApiError } from "../lib/api/client";
import { waMediaUrl } from "../lib/api/endpoints";
import type { WaMessage } from "../lib/api/types";
import {
  applyMessageStatus,
  applyReaction,
  attachmentKind,
  attachmentLimitError,
  chatPreview,
  chatTitle,
  dayLabel,
  docCategory,
  emptyPlaceholders,
  formatBytes,
  formatDuration,
  fromMirrored,
  groupReactions,
  linkify,
  listTime,
  mediaErrorMessage,
  mergeMessages,
  parseWaText,
  recipientStatusText,
  renderTemplate,
  sendErrorMessage,
  unknownPlaceholders,
} from "../features/whatsapp/wa-utils";

function message(id: string, ts: number, overrides: Partial<WaMessage> = {}): WaMessage {
  return { id, from_me: false, text: id, type: "conversation", ts, status: null, media: null, quoted: null, reactions: [], ...overrides };
}

describe("WhatsApp text formatting", () => {
  test("bold, italic, strike, inline code and code blocks", () => {
    expect(parseWaText("*oi* _tudo_ ~bem~ `x`")).toEqual([
      { type: "bold", children: [{ type: "text", text: "oi" }] },
      { type: "text", text: " " },
      { type: "italic", children: [{ type: "text", text: "tudo" }] },
      { type: "text", text: " " },
      { type: "strike", children: [{ type: "text", text: "bem" }] },
      { type: "text", text: " " },
      { type: "code", text: "x" },
    ]);
    expect(parseWaText("a ```\nconst x = *1*;``` b")).toEqual([
      { type: "text", text: "a " },
      { type: "codeblock", text: "const x = *1*;" },
      { type: "text", text: " b" },
    ]);
  });

  test("markers inside words or with spaces stay literal", () => {
    expect(parseWaText("2*3*4 e snake_case_name")).toEqual([{ type: "text", text: "2*3*4 e snake_case_name" }]);
    expect(parseWaText("* não é negrito *")).toEqual([{ type: "text", text: "* não é negrito *" }]);
    expect(parseWaText("```sem fechar")).toEqual([{ type: "text", text: "```sem fechar" }]);
  });

  test("nesting", () => {
    expect(parseWaText("*_ambos_*")).toEqual([{ type: "bold", children: [{ type: "italic", children: [{ type: "text", text: "ambos" }] }] }]);
  });

  test("autolinks only http(s) and keeps trailing punctuation out", () => {
    expect(linkify("veja https://exemplo.com.br/a?b=1. ok")).toEqual([
      { type: "text", text: "veja " },
      { type: "link", href: "https://exemplo.com.br/a?b=1", text: "https://exemplo.com.br/a?b=1" },
      { type: "text", text: ". ok" },
    ]);
    expect(linkify("javascript:alert(1) data:text/html,x")).toEqual([{ type: "text", text: "javascript:alert(1) data:text/html,x" }]);
    // HTML is just text: the renderer never injects markup.
    expect(parseWaText("<img src=x onerror=alert(1)>")).toEqual([{ type: "text", text: "<img src=x onerror=alert(1)>" }]);
  });
});

describe("thread merging", () => {
  test("message_status updates the tick of the matching outgoing message only", () => {
    const out = message("m1", 1, { from_me: true, status: "sent" });
    const inbound = message("m2", 2);
    const list = [out, inbound];
    const next = applyMessageStatus(list, { message_id: "m1", from_me: true, status: "read" });
    expect(next[0]!.status).toBe("read");
    expect(next[1]).toBe(inbound);
    expect(list[0]!.status).toBe("sent"); // not mutated
    // Unknown id, wrong direction or same status: same array (no re-render).
    expect(applyMessageStatus(list, { message_id: "nope", from_me: true, status: "read" })).toBe(list);
    expect(applyMessageStatus(list, { message_id: "m1", from_me: false, status: "read" })).toBe(list);
    expect(applyMessageStatus(list, { message_id: "m1", from_me: true, status: "sent" })).toBe(list);
  });

  test("appends, dedupes and replaces edits by id", () => {
    const a = message("a", 1);
    const b = message("b", 2);
    expect(mergeMessages([a], [b]).map((m) => m.id)).toEqual(["a", "b"]);
    const edited = { ...a, text: "editada" };
    const merged = mergeMessages([a, b], [edited]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b"]);
    expect(merged[0]!.text).toBe("editada");
    expect(mergeMessages([b], [a, a]).map((m) => m.id)).toEqual(["a", "b"]);
  });

  test("prepended older pages keep ascending order", () => {
    const merged = mergeMessages([message("c", 3), message("d", 4)], [message("a", 1), message("b", 2)]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  test("SSE echo keeps reactions and falls back to previous fields", () => {
    const previous = message("x", 5, { reactions: [{ emoji: "👍", from_me: true }], text: "oi" });
    const next = fromMirrored({ chat_jid: "j", message_id: "x", from_me: false, text: null, type: null, ts: 5, status: "read" }, previous);
    expect(next.reactions).toEqual([{ emoji: "👍", from_me: true }]);
    expect(next.text).toBe("oi");
    expect(next.status).toBe("read");
  });

  test("reactions: one per side, empty removes", () => {
    let r = applyReaction([], { emoji: "👍", from_me: false, removed: false });
    r = applyReaction(r, { emoji: "❤️", from_me: false, removed: false });
    expect(r).toEqual([{ emoji: "❤️", from_me: false }]);
    r = applyReaction(r, { emoji: "❤️", from_me: true, removed: false });
    expect(groupReactions(r)).toEqual([{ emoji: "❤️", count: 2, mine: true }]);
    expect(applyReaction(r, { emoji: "", from_me: true, removed: true })).toEqual([{ emoji: "❤️", from_me: false }]);
  });
});

describe("labels and dates", () => {
  test("chat preview uses media labels when there is no caption", () => {
    expect(chatPreview({ last_message: null, last_type: "imageMessage" })).toEqual({ kind: "image", text: "Foto" });
    expect(chatPreview({ last_message: null, last_type: "pttMessage" })).toEqual({ kind: "voice", text: "Áudio" });
    expect(chatPreview({ last_message: "legenda", last_type: "videoMessage" })).toEqual({ kind: "video", text: "legenda" });
    expect(chatPreview({ last_message: "oi", last_type: "conversation" })).toEqual({ kind: "text", text: "oi" });
  });

  test("chat title falls back to the real phone for LID chats", () => {
    expect(chatTitle({ jid: "123@lid", name: null, phone: "5511987654321" })).toBe("+55 11 98765-4321");
    expect(chatTitle({ jid: "123@lid", name: "5511987654321", phone: null })).toBe("+55 11 98765-4321");
    expect(chatTitle({ jid: "123@lid", name: null, phone: null })).toBe("Contato");
    expect(chatTitle({ jid: "5541999990000@s.whatsapp.net", name: "Ana", phone: null })).toBe("Ana");
  });

  test("durations, sizes and day labels", () => {
    expect(formatDuration(12)).toBe("0:12");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatBytes(182_311)).toBe("178 KB");
    const now = new Date(2026, 9, 12, 15, 0);
    const ts = (d: Date) => Math.floor(d.getTime() / 1000);
    expect(dayLabel(ts(new Date(2026, 9, 12, 9, 0)), now)).toBe("Hoje");
    expect(dayLabel(ts(new Date(2026, 9, 11, 23, 0)), now)).toBe("Ontem");
    expect(dayLabel(ts(new Date(2026, 8, 1, 10, 0)), now)).toBe("1 de setembro");
    expect(listTime(ts(new Date(2026, 9, 11, 9, 0)), now)).toBe("Ontem");
    expect(listTime(null, now)).toBe("");
  });

  test("document categories", () => {
    expect(docCategory("application/pdf", "a.pdf")).toBe("pdf");
    expect(docCategory(null, "orçamento.xlsx")).toBe("sheet");
    expect(docCategory("application/zip", null)).toBe("archive");
  });

  test("media URL carries the message key", () => {
    expect(waMediaUrl("thumbnail", { instance: "wa1", chat: "1@lid", id: "3EB0", fromMe: true })).toBe(
      "/api/wa/messages/thumbnail?instance=wa1&chat=1%40lid&id=3EB0&from_me=1",
    );
  });
});

describe("attachments and errors", () => {
  const file = (name: string, type: string, size: number) => ({ name, type, size });

  test("per-type limits before upload", () => {
    expect(attachmentKind(file("a.ogg", "", 1))).toBe("audio");
    expect(attachmentLimitError(file("foto.jpg", "image/jpeg", 15 * 1024 * 1024))).toBeNull();
    expect(attachmentLimitError(file("foto.jpg", "image/jpeg", 17 * 1024 * 1024))).toContain("16 MB");
    expect(attachmentLimitError(file("v.mp4", "video/mp4", 65 * 1024 * 1024))).toContain("64 MB");
    expect(attachmentLimitError(file("d.pdf", "application/pdf", 99 * 1024 * 1024))).toBeNull();
    expect(attachmentLimitError(file("vazio.pdf", "application/pdf", 0))).toContain("vazio");
  });

  test("send errors in PT-BR", () => {
    const quiet = new ApiError("Erro 409 na API.", 409, { ok: false, blocked_code: "quiet_hours", reason: "horário de silêncio (21:00–08:00)" });
    expect(sendErrorMessage(quiet)).toContain("horário de silêncio (21:00–08:00)");
    const rate = new ApiError("Erro 429 na API.", 429, { ok: false, blocked_code: "rate_limit", reason: "limite de 2/min" });
    expect(sendErrorMessage(rate)).toContain("Limite de envios");
    const off = new ApiError("Erro 409 na API.", 409, { ok: false, blocked_code: null, reason: "instância não conectada" });
    expect(sendErrorMessage(off)).toBe("Envio bloqueado: instância não conectada.");
    expect(sendErrorMessage(new ApiError("Tipo não suportado.", 415, { error: "Tipo não suportado." }))).toBe("Tipo não suportado.");
  });

  test("media endpoint errors", () => {
    expect(mediaErrorMessage(409, { code: "not_connected" })).toContain("reconecte");
    expect(mediaErrorMessage(502, { code: "download_failed", error: "x" })).toContain("Tente de novo");
    expect(mediaErrorMessage(413, { code: "too_large" })).toContain("100 MB");
  });
});

describe("campaign templates", () => {
  const lead = { name: "Padaria Pão Bom", category: "Padaria", email: null, rating: 4.5 };

  test("render mirrors the backend (case-insensitive, unknown → empty)", () => {
    expect(renderTemplate("Olá {{ Name }}, {{category}} nota {{rating}}{{foo}}", lead)).toBe("Olá Padaria Pão Bom, Padaria nota 4,5");
  });

  test("unknown and empty placeholders", () => {
    expect(unknownPlaceholders("{{name}} {{cidade}} {{Email}}")).toEqual(["cidade"]);
    expect(emptyPlaceholders("{{name}} {{email}}", lead)).toEqual(["email"]);
  });

  test("recipient status text", () => {
    expect(recipientStatusText({ status: "skipped", reason: "not_whatsapp" })).toBe("Pulado: Sem WhatsApp");
    expect(recipientStatusText({ status: "queued", reason: "quiet_hours" })).toBe("Na fila · Horário de silêncio");
    expect(recipientStatusText({ status: "sent", reason: null })).toBe("Enviada");
  });
});

describe("lead list fixes", () => {
  test("formatPhone adds +55 to national lead phones from Google Maps", async () => {
    const { formatPhone } = await import("../features/whatsapp/wa-utils");
    expect(formatPhone("(54) 99900-0001")).toBe("+55 54 99900-0001");
    expect(formatPhone("(45) 3000-0002")).toBe("+55 45 3000-0002");
    expect(formatPhone("5545999000003")).toBe("+55 45 99900-0003");
    expect(formatPhone("+54 9 11 2345 6789")).toBe("+5491123456789");
  });

  test("leadAsChat keeps the lead's own name when several leads share a WhatsApp", async () => {
    const { leadAsChat } = await import("../features/whatsapp/chat-list");
    const chat = {
      jid: "554599900004@s.whatsapp.net",
      name: "Clínica Exemplo",
      phone: null,
      last_message: "Oi",
      last_type: "conversation",
      last_ts: 1,
      unread: 2,
      saved: true,
    };
    const lead = { lead_id: 250, name: "Dra. Ana Exemplo", phone: "(45) 99900-0004", jid: chat.jid, category: null, tags: ["Médicos"] };
    const row = leadAsChat(lead, chat as never);
    expect(row.name).toBe("Dra. Ana Exemplo");
    expect(row.phone).toBe("(45) 99900-0004");
    expect(row.unread).toBe(2);
  });
});
