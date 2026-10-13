// Pure helpers of the AI chat (no React): tool part parsing, approval states,
// error classification, tool output guards and link extraction. Tested in
// tests/ai-chat-logic.test.ts.
import { isToolUIPart } from "ai";
import { NETWORK_ERROR_MESSAGE } from "@/lib/api/client";
import type { AiChatMessage, AiErrorCode, AiLeadRow, ApprovalDescriptor, MessageDraftOutput } from "@/lib/api/types";
import { safeUrl } from "@/lib/format";

export type ChatPart = AiChatMessage["parts"][number];
export type ToolPart = Extract<ChatPart, { toolCallId: string }>;

export const SUGGESTIONS = [
  "Buscar 30 dentistas em Curitiba-PR",
  "Quais leads têm WhatsApp e e-mail?",
  "Redija uma mensagem para o lead #",
] as const;

/** Server text of approvals refused because the user moved on (src/ai/chat.ts). */
export const AUTO_DENY_REASON = "O usuário seguiu a conversa sem decidir.";

/** Tools whose results change leads: refresh the table afterwards. */
export const LEAD_MUTATING_TOOLS = new Set(["save_lead_enrichment", "send_whatsapp_message", "start_prospect_search"]);

export const TOOL_LABELS: Record<string, string> = {
  get_company_profile: "Perfil da empresa",
  list_searches: "Pesquisas anteriores",
  query_leads: "Consulta de leads",
  get_lead: "Dados do lead",
  lead_stats: "Totais da base",
  present_message_draft: "Rascunho de mensagem",
  start_prospect_search: "Nova prospecção",
  serper_search: "Busca no Google (Serper)",
  scrape_webpage: "Leitura de página",
  crawl_lead_website: "Visita ao site do lead",
  save_lead_enrichment: "Salvar enriquecimento",
  send_whatsapp_message: "Envio pelo WhatsApp",
};

export function isToolPart(part: ChatPart): part is ToolPart {
  return isToolUIPart(part as never);
}

/** "tool-query_leads" → "query_leads"; dynamic tools carry `toolName`. */
export function toolNameOf(part: ToolPart): string {
  if (part.type === "dynamic-tool") return (part as { toolName: string }).toolName;
  return part.type.slice("tool-".length);
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validated approval card data, or null when the server sent none/garbage. */
export function readDescriptor(value: unknown): ApprovalDescriptor | null {
  if (!isObject(value) || typeof value.title !== "string") return null;
  const params = Array.isArray(value.params)
    ? value.params
        .filter((p): p is { label: unknown; value: unknown } => isObject(p))
        .map((p) => ({ label: String(p.label ?? ""), value: String(p.value ?? "") }))
        .filter((p) => p.label)
    : [];
  const credits = Number(value.estimated_credits);
  return {
    title: value.title,
    description: typeof value.description === "string" ? value.description : "",
    params,
    estimated_credits: Number.isFinite(credits) && credits > 0 ? credits : 0,
  };
}

export type ApprovalView =
  | "pending" // waiting for Aprovar / Recusar
  | "sending" // answered here, waiting for the server
  | "stale" // the user moved on: refused by the server
  | "approved"
  | "denied"
  | "failed"; // approved, but the action failed or was interrupted

/**
 * Card state of a tool part that went through approval (null = no approval).
 * A request outside the last message is stale: the server already refused it.
 */
export function approvalView(part: ToolPart, isLastMessage: boolean, resolved?: ReadonlySet<string>): ApprovalView | null {
  const approval = (part as { approval?: { id: string; approved?: boolean; reason?: string } }).approval;
  if (!approval) return null;
  switch (part.state) {
    case "approval-requested":
      return isLastMessage && !resolved?.has(approval.id) ? "pending" : "stale";
    case "approval-responded":
      if (resolved?.has(approval.id)) return "stale";
      return approval.approved ? "sending" : "denied";
    case "output-denied":
      return approval.reason === AUTO_DENY_REASON ? "stale" : "denied";
    case "output-error":
      return "failed";
    case "output-available":
      return "approved";
    default:
      return null;
  }
}

/** Approval ids still waiting in the last message. */
export function pendingApprovalIds(messages: AiChatMessage[]): string[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return [];
  return last.parts
    .filter(isToolPart)
    .filter((p) => p.state === "approval-requested")
    .map((p) => (p as { approval: { id: string } }).approval.id);
}

/** Approval ids answered locally but not yet confirmed (state approval-responded). */
export function respondedApprovalIds(messages: AiChatMessage[]): string[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return [];
  return last.parts
    .filter(isToolPart)
    .filter((p) => p.state === "approval-responded")
    .map((p) => (p as { approval: { id: string } }).approval.id);
}

/* ---------------- errors ---------------- */

export interface ChatErrorInfo {
  /** HTTP status of a JSON error before the stream (400/409/503…), null for stream/network errors. */
  status: number | null;
  /** `code` from the JSON body (ai_disabled) or the data-error part (llm_*). */
  code: string | null;
  message: string;
}

/**
 * Classifies a useChat error. Pre-stream HTTP errors arrive as APICallError
 * with `statusCode` + `responseBody` (`{ error, code }`); stream `error`
 * chunks arrive as Error(errorText); fetch failures as TypeError.
 */
export function parseChatError(error: unknown, dataError?: { code: string; message: string } | null): ChatErrorInfo {
  if (dataError) return { status: null, code: dataError.code, message: dataError.message };
  const record = (isObject(error) || error instanceof Error ? error : {}) as Record<string, unknown>;
  const status = typeof record.statusCode === "number" ? record.statusCode : null;
  if (status !== null) {
    let code: string | null = null;
    let message = "";
    if (typeof record.responseBody === "string" && record.responseBody) {
      try {
        const body = JSON.parse(record.responseBody) as unknown;
        if (isObject(body)) {
          if (typeof body.error === "string") message = body.error;
          if (typeof body.code === "string") code = body.code;
        }
      } catch {
        // non-JSON body (proxy page)
      }
    }
    return { status, code, message: message || `Erro ${status} ao falar com o assistente.` };
  }
  if (error instanceof TypeError) return { status: null, code: "network", message: NETWORK_ERROR_MESSAGE };
  const message = error instanceof Error && error.message ? error.message : "Algo deu errado. Tente de novo.";
  return { status: null, code: null, message };
}

export type ErrorAction = "retry" | "settings" | "classic";

/** Which buttons the error card offers. */
export function errorActions(info: ChatErrorInfo): ErrorAction[] {
  if (info.code === "ai_disabled") return ["classic"];
  if (info.status === 400) return []; // invalid request / replayed approval: nothing to retry
  const actions: ErrorAction[] = ["retry"];
  if (info.code === "llm_auth" || info.code === "llm_quota") actions.push("settings");
  actions.push("classic");
  return actions;
}

export const AI_ERROR_TITLES: Record<AiErrorCode | "network" | "ai_disabled", string> = {
  llm_auth: "O provedor de IA recusou a chave",
  llm_quota: "Limite ou saldo do provedor de IA esgotado",
  llm_unavailable: "Provedor de IA indisponível",
  llm_error: "O assistente não conseguiu responder",
  network: "Sem conexão com o servidor",
  ai_disabled: "A IA foi desativada",
};

export function errorTitle(info: ChatErrorInfo): string {
  return (info.code && AI_ERROR_TITLES[info.code as keyof typeof AI_ERROR_TITLES]) || "Não foi possível concluir";
}

/* ---------------- messages ---------------- */

export function messageText(message: AiChatMessage): string {
  return message.parts
    .filter((p): p is Extract<ChatPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** Text of the last user message (for "Usar modo clássico"). */
export function lastUserText(messages: AiChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user") return messageText(message);
  }
  return "";
}

/** Serper credits of the conversation, from the latest stored data-credits part. */
export function creditsFromMessages(messages: AiChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]!.parts;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!;
      if (part.type === "data-credits") {
        const value = Number((part as { data: { credits_thread?: unknown } }).data?.credits_thread);
        if (Number.isFinite(value)) return value;
      }
    }
  }
  return null;
}

/** Tool names with a final output in a message (to refresh leads after mutating tools). */
export function completedToolNames(message: AiChatMessage | undefined): string[] {
  if (!message) return [];
  return message.parts.filter(isToolPart).filter((p) => p.state === "output-available").map(toolNameOf);
}

export function creditsLabel(credits: number): string {
  return credits === 1 ? "1 crédito Serper nesta conversa" : `${credits.toLocaleString("pt-BR")} créditos Serper nesta conversa`;
}

/* ---------------- tool outputs (guards: outputs are untrusted JSON) ---------------- */

export function asQueryLeads(output: unknown): { total: number; leads: AiLeadRow[] } | null {
  if (!isObject(output) || !Array.isArray(output.leads)) return null;
  const leads = output.leads.filter(
    (l): l is AiLeadRow => isObject(l) && typeof l.id === "number" && typeof l.name === "string",
  );
  return { total: typeof output.total === "number" ? output.total : leads.length, leads };
}

export function asDraft(output: unknown): MessageDraftOutput | null {
  if (!isObject(output) || typeof output.lead_id !== "number" || typeof output.text !== "string") return null;
  return {
    lead_id: output.lead_id,
    lead_name: typeof output.lead_name === "string" ? output.lead_name : `Lead #${output.lead_id}`,
    text: output.text,
    can_send_whatsapp: output.can_send_whatsapp === true,
    reason: typeof output.reason === "string" ? output.reason : undefined,
  };
}

export function asJobStart(output: unknown): { job_id: string; already_running: boolean } | null {
  if (!isObject(output) || typeof output.job_id !== "string") return null;
  return { job_id: output.job_id, already_running: output.already_running === true };
}

export interface ToolStatusSummary {
  ok: boolean;
  text: string;
}

/** One-line result of tools that act (save / send / crawl). */
export function actionSummary(toolName: string, output: unknown): ToolStatusSummary | null {
  if (!isObject(output)) return null;
  if (toolName === "save_lead_enrichment") {
    if (output.saved !== true) return { ok: false, text: "O enriquecimento não foi salvo." };
    return {
      ok: true,
      text: `Enriquecimento salvo no lead #${output.lead_id}${output.email_saved ? " (e-mail gravado)" : ""}.`,
    };
  }
  if (toolName === "send_whatsapp_message") {
    return output.sent === true
      ? { ok: true, text: `Mensagem enviada pelo WhatsApp ao lead #${output.lead_id}.` }
      : { ok: false, text: typeof output.reason === "string" ? output.reason : "A mensagem não foi enviada." };
  }
  if (toolName === "crawl_lead_website") {
    const found = [typeof output.email === "string" && output.email ? `e-mail ${output.email}` : null]
      .concat(isObject(output.socials) ? Object.keys(output.socials) : [])
      .filter(Boolean);
    const pages = typeof output.pages_visited === "number" ? output.pages_visited : 0;
    return {
      ok: true,
      text: found.length
        ? `Site visitado (${pages} páginas): ${found.join(", ")}.`
        : `Site visitado (${pages} páginas): nenhum contato novo encontrado.`,
    };
  }
  return null;
}

export interface LeadStatsSummary {
  total: number;
  with_email: number;
  with_website: number;
  whatsapp: { yes: number; no: number; unknown: number };
  with_ai_enrichment: number;
}

export function asLeadStats(output: unknown): LeadStatsSummary | null {
  if (!isObject(output) || typeof output.total !== "number") return null;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const wa = isObject(output.whatsapp) ? output.whatsapp : {};
  return {
    total: output.total,
    with_email: n(output.with_email),
    with_website: n(output.with_website),
    whatsapp: { yes: n(wa.yes), no: n(wa.no), unknown: n(wa.unknown) },
    with_ai_enrichment: n(output.with_ai_enrichment),
  };
}

export function asLeadDetail(output: unknown): { id: number; name: string; category: string | null; address: string | null; phone: string | null; email: string | null; website: string | null; is_whatsapp: 0 | 1 | null; summary: string | null; events: number } | null {
  if (!isObject(output) || !isObject(output.lead)) return null;
  const lead = output.lead;
  if (typeof lead.id !== "number" || typeof lead.name !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const enrichment = isObject(lead.ai_enrichment) ? lead.ai_enrichment : null;
  return {
    id: lead.id,
    name: lead.name,
    category: str(lead.category),
    address: str(lead.address),
    phone: str(lead.phone),
    email: str(lead.email),
    website: str(lead.website),
    is_whatsapp: lead.is_whatsapp === 1 ? 1 : lead.is_whatsapp === 0 ? 0 : null,
    summary: enrichment ? str(enrichment.summary) : null,
    events: Array.isArray(output.events) ? output.events.length : 0,
  };
}

export interface WebLink {
  url: string;
  title: string;
  snippet?: string;
}

const MAX_LINKS = 12;

/**
 * Safe http(s) links from serper_search / scrape_webpage outputs: organic,
 * news, places (website), etc. Anything else (javascript:, data:) is dropped.
 */
export function extractLinks(toolName: string, output: unknown): WebLink[] {
  if (!isObject(output)) return [];
  const links: WebLink[] = [];
  const seen = new Set<string>();
  const push = (rawUrl: unknown, title: unknown, snippet?: unknown) => {
    const url = safeUrl(rawUrl);
    if (!url || seen.has(url) || links.length >= MAX_LINKS) return;
    seen.add(url);
    links.push({
      url,
      title: typeof title === "string" && title.trim() ? title.trim() : url,
      ...(typeof snippet === "string" && snippet.trim() ? { snippet: snippet.trim() } : {}),
    });
  };
  if (toolName === "scrape_webpage") {
    const metadata = isObject(output.metadata) ? output.metadata : {};
    push(output.url, metadata.title ?? metadata["og:title"]);
    return links;
  }
  const results = isObject(output.results) ? output.results : {};
  for (const value of Object.values(results)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!isObject(item)) continue;
      push(item.link ?? item.website ?? item.url, item.title ?? item.name, item.snippet ?? item.address);
    }
  }
  return links;
}

/** "12 de out., 14:03" style label for the history list. */
export function chatDateLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat("pt-BR", sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "short" })
    .format(date)
    .replace(" de ", " ");
}
