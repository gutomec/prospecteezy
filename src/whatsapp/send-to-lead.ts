import type { Database } from "bun:sqlite";
import { getActiveInstance, instanceExists } from "./instances.ts";
import type { WaManager } from "./manager.ts";

export type SendToLeadResult =
  | { ok: true; jid: string; instance: string }
  | { ok: false; code: "lead_not_found" | "not_whatsapp" | "no_instance" | "blocked" | "send_failed"; reason: string };

/**
 * Sends a text to a prospected lead through the same gated path as
 * POST /api/wa/send: the lead must already be validated (is_whatsapp = 1,
 * whatsapp_jid set by the resolver during validation), the active instance
 * must be connected, and the anti-ban gate (rate limit + quiet hours) applies.
 * Quiet hours are waived only when the lead already wrote to us (a reply);
 * a cold first message respects them.
 */
export async function sendTextToLead(
  deps: { coreDb: Database; waDb: Database; manager: WaManager; now?: () => Date },
  leadId: number,
  text: string,
): Promise<SendToLeadResult> {
  const lead = deps.coreDb
    .query("SELECT id, is_whatsapp, whatsapp_jid FROM leads WHERE id = ?")
    .get(leadId) as { id: number; is_whatsapp: number | null; whatsapp_jid: string | null } | null;
  if (!lead) return { ok: false, code: "lead_not_found", reason: "Lead não encontrado." };
  if (lead.is_whatsapp !== 1 || !lead.whatsapp_jid) {
    return {
      ok: false,
      code: "not_whatsapp",
      reason: "O lead ainda não foi validado como WhatsApp. Valide o número na aba WhatsApp antes de enviar.",
    };
  }
  const instance = getActiveInstance(deps.waDb);
  if (!instance || !instanceExists(deps.waDb, instance)) {
    return { ok: false, code: "no_instance", reason: "Nenhuma instância de WhatsApp ativa. Conecte um número na aba WhatsApp." };
  }
  const jid = lead.whatsapp_jid;
  const hasInbound = Boolean(
    deps.waDb
      .query("SELECT 1 FROM messages WHERE instance_id = ? AND chat_jid = ? AND from_me = 0 LIMIT 1")
      .get(instance, jid),
  );
  const result = await deps.manager.sendText(instance, jid, text, {
    overrideQuietHours: hasInbound,
    at: deps.now?.(),
  });
  if (result.ok) return { ok: true, jid, instance };
  if (result.gate.blocked_code) {
    return { ok: false, code: "blocked", reason: `Envio bloqueado pela proteção anti-banimento: ${result.gate.blocked_reason}.` };
  }
  return {
    ok: false,
    code: "send_failed",
    reason: `Falha ao enviar: ${result.error ?? result.gate.blocked_reason ?? "erro desconhecido"}.`,
  };
}
