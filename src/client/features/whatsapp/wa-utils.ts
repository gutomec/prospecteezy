// Pure helpers of the WhatsApp feature (no React, no DOM): labels, dates,
// WhatsApp text formatting, message merging, upload limits, send errors and
// campaign templates. Covered by tests/whatsapp.test.ts.
import { ApiError } from "@/lib/api/client";
import type {
  Lead,
  WaChat,
  WaMedia,
  WaMediaJob,
  WaMediaKind,
  WaMediaRecoverResult,
  WaMediaSummary,
  WaMessage,
  WaMirroredMessage,
  WaReaction,
  WaRecipientStatus,
} from "@/lib/api/types";
import { formatTime, safeUrl } from "@/lib/format";

/* ---------------- labels ---------------- */

/** What a message "is" for previews and icons. */
export type WaContentKind = WaMediaKind | "location" | "contact" | "poll" | "text" | "other";

const TYPE_KINDS: Record<string, WaContentKind> = {
  conversation: "text",
  extendedTextMessage: "text",
  imageMessage: "image",
  videoMessage: "video",
  ptvMessage: "video",
  audioMessage: "audio",
  pttMessage: "voice",
  documentMessage: "document",
  documentWithCaptionMessage: "document",
  stickerMessage: "sticker",
  locationMessage: "location",
  liveLocationMessage: "location",
  contactMessage: "contact",
  contactsArrayMessage: "contact",
  pollCreationMessage: "poll",
  pollCreationMessageV2: "poll",
  pollCreationMessageV3: "poll",
};

export const CONTENT_LABELS: Record<WaContentKind, string> = {
  image: "Foto",
  video: "Vídeo",
  audio: "Áudio",
  voice: "Áudio",
  document: "Documento",
  sticker: "Figurinha",
  location: "Localização",
  contact: "Contato",
  poll: "Enquete",
  text: "Mensagem",
  other: "Mensagem",
};

export function contentKindOfType(type: string | null | undefined): WaContentKind {
  if (!type) return "other";
  return TYPE_KINDS[type] ?? "other";
}

/** "0:12", "1:05:03". */
export function formatDuration(totalSeconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`;
}

/** Chat list preview: kind (for the icon) + text. Media without caption shows its label. */
export function chatPreview(chat: Pick<WaChat, "last_message" | "last_type">): { kind: WaContentKind; text: string } {
  const kind = contentKindOfType(chat.last_type);
  const text = chat.last_message?.trim() ?? "";
  if (kind === "text" || kind === "other") return { kind: text ? "text" : kind, text: text || (chat.last_type ? CONTENT_LABELS.other : "") };
  return { kind, text: text || CONTENT_LABELS[kind] };
}

/** "+55 41 99900-0000"-ish display of a jid/number; LID chats have no number in the jid. */
export function phoneFromJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  const digits = jid.split("@")[0]!.split(":")[0]!;
  return digits ? `+${digits}` : null;
}

export function formatPhone(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  // Lead phones come from Google Maps in national form, e.g. "(45) 99900-0000":
  // 10–11 digits = DDD + number, without the +55 country code.
  const national =
    digits.startsWith("55") && (digits.length === 12 || digits.length === 13)
      ? digits.slice(2)
      : !String(raw).trim().startsWith("+") && (digits.length === 10 || digits.length === 11)
        ? digits
        : null;
  if (national) {
    const ddd = national.slice(0, 2);
    const rest = national.slice(2);
    const split = rest.length - 4;
    return `+55 ${ddd} ${rest.slice(0, split)}-${rest.slice(split)}`;
  }
  return `+${digits}`;
}

/** Name to show for a chat: resolved name, else the real number, else a generic label. */
export function chatTitle(chat: Pick<WaChat, "jid" | "name" | "phone">): string {
  const name = chat.name?.trim();
  const phone = chat.phone ? formatPhone(chat.phone) : phoneFromJid(chat.jid);
  if (name && !/^\d+$/.test(name)) return name;
  return phone || (name ? formatPhone(name) : "") || "Contato";
}

export function chatSubtitle(chat: Pick<WaChat, "jid" | "phone">): string {
  if (chat.phone) return formatPhone(chat.phone);
  return phoneFromJid(chat.jid) ?? "Número oculto pelo WhatsApp";
}

export function initialsOf(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "#";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)![0] ?? "") : "";
  return (first + last).toUpperCase() || "#";
}

/* ---------------- dates ---------------- */

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function dayKey(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Day separator: "Hoje", "Ontem", weekday (last 7 days) or "12 de outubro de 2026". */
export function dayLabel(tsSeconds: number, now = new Date()): string {
  const date = new Date(tsSeconds * 1000);
  const diff = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Ontem";
  if (diff > 1 && diff < 7) {
    const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "long" }).format(date);
    return weekday.charAt(0).toUpperCase() + weekday.slice(1);
  }
  return new Intl.DateTimeFormat("pt-BR", {
    day: "numeric",
    month: "long",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
}

/** Chat list timestamp: time today, "Ontem", short weekday this week, else dd/mm/aa. */
export function listTime(tsSeconds: number | null | undefined, now = new Date()): string {
  if (!tsSeconds) return "";
  const date = new Date(tsSeconds * 1000);
  const diff = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (diff <= 0) return formatTime(date);
  if (diff === 1) return "Ontem";
  if (diff < 7) {
    const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(date).replace(".", "");
    return weekday.charAt(0).toUpperCase() + weekday.slice(1);
  }
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(date);
}

export function messageTime(tsSeconds: number): string {
  return formatTime(new Date(tsSeconds * 1000));
}

/* ---------------- WhatsApp text formatting ---------------- */

export type TextNode =
  | { type: "text"; text: string }
  | { type: "link"; href: string; text: string }
  | { type: "bold" | "italic" | "strike"; children: TextNode[] }
  | { type: "code"; text: string }
  | { type: "codeblock"; text: string };

const INLINE_MARKERS: Record<string, "bold" | "italic" | "strike" | "code"> = { "*": "bold", _: "italic", "~": "strike", "`": "code" };
const URL_RE = /https?:\/\/[^\s<>"]+/gi;
// A marker opens after start/space/punctuation and closes before end/space/punctuation.
const BOUNDARY = /[\s.,;:!?()[\]{}"'«»…\-/*_~`]/;

function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || BOUNDARY.test(ch);
}

/** Splits plain text into text + safe http(s) links (trailing punctuation stays out of the link). */
export function linkify(text: string): TextNode[] {
  const out: TextNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    let raw = match[0];
    const trailing = /[.,;:!?)\]}'"…]+$/.exec(raw);
    if (trailing) raw = raw.slice(0, -trailing[0].length);
    const start = match.index ?? 0;
    const href = safeUrl(raw);
    if (!href || !raw) continue;
    if (start > last) out.push({ type: "text", text: text.slice(last, start) });
    out.push({ type: "link", href, text: raw });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

function parseInline(text: string, depth = 0): TextNode[] {
  if (depth > 4) return linkify(text);
  const out: TextNode[] = [];
  let buffer = "";
  let i = 0;
  const flush = () => {
    if (buffer) out.push(...linkify(buffer));
    buffer = "";
  };
  while (i < text.length) {
    const ch = text[i]!;
    const kind = INLINE_MARKERS[ch];
    if (kind && isBoundary(text[i - 1]) && text[i + 1] !== undefined && !/\s/.test(text[i + 1]!) && text[i + 1] !== ch) {
      // Find the closing marker on the same line.
      let j = i + 1;
      let close = -1;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === ch && !/\s/.test(text[j - 1]!) && isBoundary(text[j + 1])) {
          close = j;
          break;
        }
        j++;
      }
      if (close > i + 1) {
        flush();
        const inner = text.slice(i + 1, close);
        if (kind === "code") out.push({ type: "code", text: inner });
        else out.push({ type: kind, children: parseInline(inner, depth + 1) });
        i = close + 1;
        continue;
      }
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}

/** WhatsApp formatting (*bold*, _italic_, ~strike~, `code`, ```block```) + autolinks, as a tree (never HTML). */
export function parseWaText(text: string): TextNode[] {
  const out: TextNode[] = [];
  const parts = text.split("```");
  // Odd segments are inside ``` … ``` (only when the fence is closed).
  parts.forEach((part, index) => {
    const inside = index % 2 === 1 && index < parts.length - 1;
    if (inside) out.push({ type: "codeblock", text: part.replace(/^\n/, "") });
    else if (part) out.push(...parseInline(index % 2 === 1 ? "```" + part : part));
  });
  return out;
}

/* ---------------- messages ---------------- */

/** Normalizes an SSE/send echo into a thread message (reactions kept from the existing copy). */
export function fromMirrored(m: WaMirroredMessage, previous?: WaMessage): WaMessage {
  return {
    id: m.message_id,
    from_me: Boolean(m.from_me),
    text: m.text ?? previous?.text ?? null,
    type: m.type ?? previous?.type ?? null,
    ts: m.ts || previous?.ts || Math.floor(Date.now() / 1000),
    status: m.status ?? previous?.status ?? null,
    media: m.media !== undefined ? m.media : (previous?.media ?? null),
    quoted: m.quoted !== undefined ? m.quoted : (previous?.quoted ?? null),
    reactions: previous?.reactions ?? [],
  };
}

/** Upsert by id (edits/re-deliveries replace the bubble) and keep ascending order. */
export function mergeMessages<T extends WaMessage>(current: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  let appendOnly = true;
  const lastTs = current.at(-1)?.ts ?? -Infinity;
  for (const m of incoming) {
    if (byId.has(m.id) || m.ts < lastTs) appendOnly = false;
    byId.set(m.id, m);
  }
  if (appendOnly) return [...current, ...incoming.filter((m, i, list) => list.findIndex((x) => x.id === m.id) === i)];
  const order = new Map<string, number>();
  [...current, ...incoming].forEach((m, i) => {
    if (!order.has(m.id)) order.set(m.id, i);
  });
  return [...byId.values()].sort((a, b) => a.ts - b.ts || order.get(a.id)! - order.get(b.id)!);
}

/** Applies a reaction event: one reaction per side (1:1 chats), empty emoji removes it. */
export function applyReaction(reactions: WaReaction[], event: { emoji: string; from_me: boolean; removed: boolean }): WaReaction[] {
  const rest = reactions.filter((r) => r.from_me !== event.from_me);
  return event.removed || !event.emoji ? rest : [...rest, { emoji: event.emoji, from_me: event.from_me }];
}

/** Applies a live delivery tick (SSE message_status). Same array when nothing matches. */
export function applyMessageStatus<T extends WaMessage>(
  messages: T[],
  event: { message_id: string; from_me: boolean; status: string },
): T[] {
  const index = messages.findIndex((m) => m.id === event.message_id && m.from_me === event.from_me);
  if (index === -1 || messages[index]!.status === event.status) return messages;
  const next = messages.slice();
  next[index] = { ...messages[index]!, status: event.status };
  return next;
}

/** Groups equal emojis: [{emoji, count, mine}]. */
export function groupReactions(reactions: WaReaction[]): Array<{ emoji: string; count: number; mine: boolean }> {
  const map = new Map<string, { emoji: string; count: number; mine: boolean }>();
  for (const r of reactions) {
    const entry = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
    entry.count++;
    entry.mine ||= r.from_me;
    map.set(r.emoji, entry);
  }
  return [...map.values()];
}

/* ---------------- attachments ---------------- */

export type AttachmentKind = "image" | "video" | "audio" | "document";

const MB = 1024 * 1024;
/** WhatsApp limits enforced by the backend (src/whatsapp/media.ts SEND_LIMITS). */
export const SEND_LIMITS: Record<AttachmentKind, number> = { image: 16 * MB, video: 64 * MB, audio: 16 * MB, document: 100 * MB };

const KIND_NAMES: Record<AttachmentKind, string> = { image: "imagem", video: "vídeo", audio: "áudio", document: "documento" };

export function attachmentKind(file: Pick<File, "type" | "name">): AttachmentKind {
  const type = file.type.toLowerCase();
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (type.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  if (type.startsWith("video/") || ["mp4", "mov", "3gp"].includes(ext)) return "video";
  if (type.startsWith("audio/") || ["ogg", "opus", "mp3", "m4a", "aac"].includes(ext)) return "audio";
  return "document";
}

/** PT-BR error when the file exceeds its type's limit (checked before uploading), else null. */
export function attachmentLimitError(file: Pick<File, "type" | "name" | "size">): string | null {
  if (file.size === 0) return `“${file.name}” está vazio.`;
  const kind = attachmentKind(file);
  if (file.size <= SEND_LIMITS[kind]) return null;
  return `“${file.name}” tem ${formatBytes(file.size)}: o limite do WhatsApp para ${KIND_NAMES[kind]} é ${SEND_LIMITS[kind] / MB} MB.`;
}

export type DocCategory = "pdf" | "sheet" | "slides" | "text" | "archive" | "audio" | "video" | "image" | "file";

export function docCategory(mimetype: string | null | undefined, fileName: string | null | undefined): DocCategory {
  const mime = (mimetype ?? "").toLowerCase();
  const ext = (fileName ?? "").toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.includes("spreadsheet") || mime.includes("excel") || ["xls", "xlsx", "csv", "ods"].includes(ext)) return "sheet";
  if (mime.includes("presentation") || mime.includes("powerpoint") || ["ppt", "pptx", "odp", "key"].includes(ext)) return "slides";
  if (mime.includes("word") || mime.startsWith("text/") || ["doc", "docx", "odt", "txt", "rtf", "md"].includes(ext)) return "text";
  if (mime.includes("zip") || mime.includes("compressed") || ["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  return "file";
}

export function fileExtension(fileName: string | null | undefined, mimetype: string | null | undefined): string {
  const ext = (fileName ?? "").includes(".") ? (fileName ?? "").split(".").pop()! : (mimetype ?? "").split("/").pop() ?? "";
  return ext.slice(0, 5).toUpperCase();
}

/* ---------------- media on demand ---------------- */

/** How a media bubble shows: the file itself, a "Baixar" prompt, or the unavailable placeholder. */
export type MediaDisplay = "cached" | "download" | "unavailable";

export function mediaDisplay(media: Pick<WaMedia, "available" | "cached">, downloadedHere = false): MediaDisplay {
  if (media.cached || downloadedHere) return "cached";
  return media.available ? "download" : "unavailable";
}

/** "~12 MB" (or "~800 KB") for an estimate. */
export function approxSize(bytes: number): string {
  return `~${formatBytes(bytes)}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;
}

/** Text of the "Carregar arquivos" dialog for a chat's media summary. */
export function mediaSummaryText(s: WaMediaSummary): string {
  if (s.total === 0) return "Esta conversa não tem arquivos de mídia.";
  const parts = [`Esta conversa tem ${plural(s.total, "arquivo de mídia", "arquivos de mídia")}.`];
  if (s.cached > 0) parts.push(`${plural(s.cached, "já está", "já estão")} neste computador.`);
  if (s.downloadable > 0) {
    const known = s.downloadable - s.unknown_size_count;
    const size =
      known > 0
        ? ` (${approxSize(s.downloadable_bytes)}${s.unknown_size_count > 0 ? `, mais ${s.unknown_size_count} de tamanho desconhecido` : ""})`
        : "";
    parts.push(`${plural(s.downloadable, "pode ser baixado", "podem ser baixados")} agora${size}.`);
  } else {
    parts.push("Nenhum arquivo para baixar agora.");
  }
  if (s.unavailable > 0) {
    parts.push(
      `${plural(s.unavailable, "é antigo e só pode ser recuperado", "são antigos e só podem ser recuperados")} pedindo o histórico ao seu celular (ele precisa estar online).`,
    );
  }
  parts.push("Os arquivos ficam salvos neste computador, na pasta data/wa-media, e ocupam espaço em disco.");
  return parts.join(" ");
}

/** State of the "Carregar arquivos" flow (dialog). */
export type MediaLoadState =
  | { phase: "loading" }
  | { phase: "ready"; summary: WaMediaSummary }
  | { phase: "recovering"; summary: WaMediaSummary }
  | {
      phase: "downloading";
      summary: WaMediaSummary;
      recover: WaMediaRecoverResult | null;
      recoverError: string | null;
      jobId: string | null;
      job: WaMediaJob | null;
    }
  | {
      phase: "finished";
      summary: WaMediaSummary;
      recover: WaMediaRecoverResult | null;
      recoverError: string | null;
      job: WaMediaJob;
    }
  | { phase: "error"; message: string; summary: WaMediaSummary | null };

export type MediaLoadAction =
  | { type: "summary_loaded"; summary: WaMediaSummary }
  | { type: "start"; recover: boolean }
  | { type: "recovered"; result: WaMediaRecoverResult }
  | { type: "recover_failed"; message: string }
  | { type: "job_started"; jobId: string }
  | { type: "job_progress"; job: WaMediaJob }
  | { type: "failed"; message: string }
  | { type: "reset" };

export const MEDIA_LOAD_INITIAL: MediaLoadState = { phase: "loading" };

function summaryOf(state: MediaLoadState): WaMediaSummary | null {
  return "summary" in state ? state.summary : null;
}

export function mediaLoadReducer(state: MediaLoadState, action: MediaLoadAction): MediaLoadState {
  switch (action.type) {
    case "reset":
      return MEDIA_LOAD_INITIAL;
    case "failed":
      return { phase: "error", message: action.message, summary: summaryOf(state) };
    case "summary_loaded":
      return state.phase === "loading" ? { phase: "ready", summary: action.summary } : state;
    case "start":
      if (state.phase !== "ready") return state;
      if (action.recover && state.summary.unavailable > 0) return { phase: "recovering", summary: state.summary };
      return { phase: "downloading", summary: state.summary, recover: null, recoverError: null, jobId: null, job: null };
    case "recovered":
    case "recover_failed":
      if (state.phase !== "recovering") return state;
      return {
        phase: "downloading",
        summary: state.summary,
        recover: action.type === "recovered" ? action.result : null,
        recoverError: action.type === "recover_failed" ? action.message : null,
        jobId: null,
        job: null,
      };
    case "job_started":
      return state.phase === "downloading" ? { ...state, jobId: action.jobId } : state;
    case "job_progress":
      if (state.phase !== "downloading") return state;
      if (action.job.status === "running") return { ...state, job: action.job };
      return { phase: "finished", summary: state.summary, recover: state.recover, recoverError: state.recoverError, job: action.job };
  }
}

/** 0–100 progress of a bulk download job (an empty job is complete). */
export function mediaJobPercent(job: Pick<WaMediaJob, "total" | "done" | "failed"> | null): number {
  if (!job) return 0;
  if (job.total === 0) return 100;
  return Math.min(100, Math.round(((job.done + job.failed) / job.total) * 100));
}

/** Final numbers of a finished flow. */
export function mediaLoadOutcome(state: Extract<MediaLoadState, { phase: "finished" }>): {
  downloaded: number;
  failed: number;
  recovered: number;
  stillUnavailable: number;
} {
  return {
    downloaded: state.job.done,
    failed: state.job.failed,
    recovered: state.recover?.recovered ?? 0,
    stillUnavailable: state.recover ? state.recover.still_unavailable : state.summary.unavailable,
  };
}

/* ---------------- errors ---------------- */

/** PT-BR message of a media endpoint failure ({error, code}); `null` code when unknown. */
export function mediaErrorMessage(status: number, body: unknown): string {
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  const text = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (code === "not_connected" || status === 409) return "WhatsApp desconectado: reconecte a conta para baixar esta mídia.";
  if (code === "download_failed" || status === 502) return "O WhatsApp não entregou o arquivo. Tente de novo.";
  if (code === "too_large" || status === 413) return "Arquivo grande demais para baixar (acima de 100 MB).";
  if (code === "media_unavailable") return "Mídia indisponível (recebida antes da atualização).";
  if (typeof text === "string" && text) return text;
  if (status === 0) return "Sem conexão com o servidor local.";
  return `Não consegui carregar a mídia (erro ${status}).`;
}

/** PT-BR message for a failed POST /api/wa/send (409 quiet hours, 429 rate limit, 413, 415, 400…). */
export function sendErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Não foi possível enviar. Tente de novo.";
  const body = (error.body ?? {}) as { blocked_code?: string | null; reason?: string | null; error?: string };
  const reason = body.reason?.trim();
  if (error.status === 409 && body.blocked_code === "quiet_hours") {
    const span = reason?.replace(/^hor[aá]rio de sil[eê]ncio\s*/i, "").replace(/^\((.*)\)$/, "$1");
    return `Bloqueado pelo horário de silêncio${span ? ` (${span})` : ""}. A primeira mensagem para um contato só sai fora dessa janela; respostas a quem já escreveu passam.`;
  }
  if (error.status === 429 || body.blocked_code === "rate_limit") {
    return `Limite de envios atingido (proteção anti-banimento). Aguarde alguns minutos.${reason ? ` (${reason})` : ""}`;
  }
  if (error.status === 409) return reason ? `Envio bloqueado: ${reason}.` : error.message.startsWith("Erro ") ? "Envio bloqueado: a conta não está conectada." : error.message;
  if (error.status === 413) return body.error ?? "Arquivo acima do limite do WhatsApp.";
  if (error.status === 415) return body.error ?? "Tipo de arquivo não suportado.";
  return error.message;
}

/* ---------------- campaigns ---------------- */

/** Placeholder columns accepted by the campaign template (backend PLACEHOLDER_COLUMNS). */
export const PLACEHOLDERS: Array<{ column: string; label: string }> = [
  { column: "name", label: "Nome do lead" },
  { column: "category", label: "Categoria" },
  { column: "address", label: "Endereço" },
  { column: "phone", label: "Telefone" },
  { column: "website", label: "Site" },
  { column: "rating", label: "Nota" },
  { column: "email", label: "E-mail" },
];
const PLACEHOLDER_SET = new Set(PLACEHOLDERS.map((p) => p.column));
const TOKEN_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Placeholders the backend would refuse (400 unknown_placeholders). */
export function unknownPlaceholders(template: string, valid: ReadonlySet<string> = PLACEHOLDER_SET): string[] {
  const out = new Set<string>();
  for (const match of template.matchAll(TOKEN_RE)) {
    const column = match[1]!.toLowerCase();
    if (!valid.has(column)) out.add(match[1]!);
  }
  return [...out];
}

/** Placeholders used in the template that are empty for this lead (the backend skips that recipient). */
export function emptyPlaceholders(template: string, lead: Partial<Lead>): string[] {
  const out = new Set<string>();
  for (const match of template.matchAll(TOKEN_RE)) {
    const column = match[1]!.toLowerCase();
    if (!PLACEHOLDER_SET.has(column)) continue;
    const value = lead[column as keyof Lead];
    if (value == null || String(value).trim() === "") out.add(column);
  }
  return [...out];
}

/** Mirrors the backend substitution (case-insensitive columns). */
export function renderTemplate(template: string, lead: Partial<Lead>): string {
  return template.replace(TOKEN_RE, (_, raw: string) => {
    const column = raw.toLowerCase();
    if (!PLACEHOLDER_SET.has(column)) return "";
    const value = lead[column as keyof Lead];
    if (value == null) return "";
    return column === "rating" && typeof value === "number" ? value.toLocaleString("pt-BR") : String(value);
  });
}

const RECIPIENT_REASONS: Record<string, string> = {
  not_whatsapp: "Sem WhatsApp",
  not_validated: "Não validado",
  empty_message: "Mensagem vazia",
  lead_not_found: "Lead não encontrado",
  quiet_hours: "Horário de silêncio",
  rate_limit: "Limite de envios",
};

export function recipientStatusText(r: { status: WaRecipientStatus; reason: string | null }): string {
  if (r.status === "sent") return "Enviada";
  if (r.status === "queued") return r.reason ? `Na fila · ${RECIPIENT_REASONS[r.reason] ?? r.reason}` : "Na fila";
  const reason = r.reason ? (RECIPIENT_REASONS[r.reason] ?? r.reason) : null;
  if (r.status === "failed") return reason ? `Falhou: ${reason}` : "Falhou";
  return reason ? `Pulado: ${reason}` : "Pulado";
}
