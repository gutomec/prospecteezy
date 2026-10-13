// PT-BR formatting and safe-value helpers shared by every view.
import type { AiEnrichment, Lead } from "./api/types";

const intFormatter = new Intl.NumberFormat("pt-BR");

export function formatInt(value: number | null | undefined): string {
  return intFormatter.format(Math.round(Number(value) || 0));
}

export function formatRating(value: number | null | undefined): string {
  return value == null ? "—" : Number(value).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function formatPercent(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : "—";
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(date)
    .replace(" de ", " ")
    .replace(".,", ",");
}

export function formatTime(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

/** "1 lead" / "3 leads" style plurals. */
export function plural(count: number, one: string, many: string): string {
  return `${formatInt(count)} ${count === 1 ? one : many}`;
}

/** Absolute http(s) URL or null — blocks javascript:, data:, relative and malformed values. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function phoneDigits(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "");
}

export function parseSocials(lead: Pick<Lead, "socials_json">): Record<string, string> {
  if (!lead.socials_json) return {};
  try {
    const value = JSON.parse(lead.socials_json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
}

export function parseAiEnrichment(lead: Pick<Lead, "ai_enrichment_json">): AiEnrichment | null {
  if (typeof lead.ai_enrichment_json !== "string" || !lead.ai_enrichment_json) return null;
  try {
    const value = JSON.parse(lead.ai_enrichment_json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as AiEnrichment) : null;
  } catch {
    return null;
  }
}

/** Trimmed text from an unknown JSON value (strings and numbers only). */
export function textOf(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

export type WhatsAppState = "yes" | "no" | "pending" | "ambiguous";

export function whatsappState(lead: Pick<Lead, "id" | "is_whatsapp">, ambiguous?: ReadonlySet<number>): WhatsAppState {
  if (lead.is_whatsapp === 1) return "yes";
  if (lead.is_whatsapp === 0) return "no";
  return ambiguous?.has(lead.id) ? "ambiguous" : "pending";
}

export const WHATSAPP_LABELS: Record<WhatsAppState, string> = {
  yes: "No WhatsApp",
  no: "Sem WhatsApp",
  pending: "Não validado",
  ambiguous: "Ambíguo",
};
