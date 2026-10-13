// Batch WhatsApp validation of leads — implements the contract documented by
// the core in src/whatsapp/README.md: for each lead with a phone, resolve the
// ninth-digit variants via sock.onWhatsApp (squad recipient-resolver logic:
// absent from array ≠ exists:false, match by jid never by index, AMBIGUOUS ⇒
// human decision) and persist is_whatsapp / whatsapp_jid + a lead_events row.
// Every lookup passes the anti-ban gate: a silent onWhatsApp lookup messages
// no one, so it SKIPS quiet hours (like the 1:1 human-reply send) but stays
// under the rate limits + jitter (volume is what protects the number).
import type { Database } from "bun:sqlite";
import { openDb } from "../db/index.ts";
import { addLeadEvent, getLead, type LeadRow } from "../db/repository.ts";
import { WA_CONFIG, validationRateLimit, type WaConfig } from "./config.ts";
import { CORE_DB_PATH, openWaDb } from "./db.ts";
import { jitterMs, LOOKUP_ACTION_KINDS, msUntilRateLimitClears, reserveLookup } from "./gate.ts";
import { phoneToUser, resolveRecipient, type OnWhatsAppSocket } from "./resolver.ts";

export type LeadValidationStatus =
  | "exists"
  | "not_registered"
  | "ambiguous"
  | "skipped"
  | "lookup_failed";

export interface LeadValidationDetail {
  lead_id: number;
  phone: string | null;
  status: LeadValidationStatus;
  jid?: string;
  candidates?: string[];
  reason?: string;
}

/** Contract shape (validated/ambiguous/skipped) plus operational extras. */
export interface ValidationReport {
  validated: number; // definitive result (has WhatsApp or not)
  ambiguous: number; // AMBIGUOUS → human decision, jid NOT written
  skipped: number; // no phone / invalid phone / lead not found
  failed: number; // lookup did not answer (retry later)
  stopped_reason: string | null; // gate stop (quiet hours / rate limit)
  /** Why the batch stopped early: the gate (volume) or a lost connection. */
  stopped_code: "rate_limit" | "quiet_hours" | "connection" | null;
  details: LeadValidationDetail[];
}

export interface ValidateDeps {
  sock: OnWhatsAppSocket;
  coreDb: Database; // data/prospecteezy.db (leads, lead_events)
  waDb: Database; // data/whatsapp.db (wa_actions accounting)
  config?: WaConfig;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
  log?: (message: string) => void;
}

function persistResult(
  coreDb: Database,
  leadId: number,
  isWhatsapp: number | null,
  jid: string | null,
): void {
  coreDb
    .query("UPDATE leads SET is_whatsapp = ?, whatsapp_jid = ? WHERE id = ?")
    .run(isWhatsapp, jid, leadId);
}

/**
 * Core loop with injectable dependencies (socket, clock, sleep) so tests run
 * without network. One onWhatsApp round-trip per lead (all ninth-digit
 * variants together), gate-checked and jitter-spaced.
 */
export async function validateLeadsCore(
  leadIds: number[],
  deps: ValidateDeps,
): Promise<ValidationReport> {
  const config = deps.config ?? WA_CONFIG;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const log = deps.log ?? (() => {});

  const report: ValidationReport = {
    validated: 0,
    ambiguous: 0,
    skipped: 0,
    failed: 0,
    stopped_reason: null,
    stopped_code: null,
    details: [],
  };

  const batch = leadIds.slice(0, config.validation.max_batch_size);
  if (leadIds.length > batch.length) {
    log(
      `Lote limitado a ${batch.length} leads (max_batch_size); ` +
        `${leadIds.length - batch.length} ficam para a próxima rodada.`,
    );
  }

  let performedLookup = false;
  for (const leadId of batch) {
    const lead: LeadRow | null = getLead(deps.coreDb, leadId);
    if (!lead) {
      report.skipped++;
      report.details.push({ lead_id: leadId, phone: null, status: "skipped", reason: "lead não encontrado" });
      continue;
    }
    const user = lead.phone ? phoneToUser(lead.phone) : null;
    if (!user) {
      report.skipped++;
      report.details.push({
        lead_id: leadId,
        phone: lead.phone,
        status: "skipped",
        reason: lead.phone ? "telefone inválido" : "sem telefone",
      });
      addLeadEvent(deps.coreDb, leadId, "whatsapp_validated", {
        result: "skipped",
        phone: lead.phone,
        reason: lead.phone ? "telefone inválido" : "sem telefone",
      });
      continue;
    }

    // Human spacing between consecutive lookups (jitter), BEFORE the gate:
    // the gate check and the slot reservation then happen together with no
    // await in between, so concurrent runners can't both take the last slot.
    const rateLimit = validationRateLimit(config);
    if (performedLookup) {
      await sleep(jitterMs(config, random, rateLimit));
    }

    // Anti-ban gate BEFORE every lookup. Quiet hours are OVERRIDDEN here: the
    // lookup is silent (no message sent), so the night guard doesn't apply. The
    // rate limit uses the dedicated validation ceiling (validationRateLimit),
    // counted over lookups only — faster than sends, still human. Blocked by
    // volume ⇒ stop the batch (remaining leads stay untouched); the auto-drain
    // runners sleep until the window frees and resume.
    const gate = reserveLookup(deps.waDb, config, rateLimit, user, now());
    if (!gate.allowed) {
      report.stopped_reason = gate.blocked_reason;
      report.stopped_code = gate.blocked_code;
      log(`Gate bloqueou (${gate.blocked_code}): ${gate.blocked_reason}`);
      break;
    }
    performedLookup = true;

    let result;
    try {
      result = await resolveRecipient(deps.sock, `${user}@s.whatsapp.net`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.stopped_reason = `conexão perdida (${msg})`;
      report.stopped_code = "connection";
      log(`Erro de conexão no lead ${leadId}: ${msg}`);
      break;
    }
    if (result.ok) {
      persistResult(deps.coreDb, leadId, 1, result.jid);
      addLeadEvent(deps.coreDb, leadId, "whatsapp_validated", {
        result: "exists",
        jid: result.jid,
        corrected_from: result.corrected_from ?? null,
        phone: lead.phone,
      });
      report.validated++;
      report.details.push({ lead_id: leadId, phone: lead.phone, status: "exists", jid: result.jid });
      log(`Lead ${leadId} (${lead.name}): tem WhatsApp → ${result.jid}`);
      continue;
    }

    switch (result.code) {
      case "NOT_REGISTERED":
        persistResult(deps.coreDb, leadId, 0, null);
        addLeadEvent(deps.coreDb, leadId, "whatsapp_validated", {
          result: "not_registered",
          candidates: result.candidates ?? [],
          phone: lead.phone,
        });
        report.validated++;
        report.details.push({
          lead_id: leadId,
          phone: lead.phone,
          status: "not_registered",
          candidates: result.candidates,
        });
        log(`Lead ${leadId} (${lead.name}): sem WhatsApp`);
        break;
      case "AMBIGUOUS":
        // Two distinct accounts exist for the variants: writing either jid
        // could point at a stranger. is_whatsapp stays NULL, jid is NOT
        // written — the lead_events row flags the human decision.
        persistResult(deps.coreDb, leadId, null, null);
        addLeadEvent(deps.coreDb, leadId, "whatsapp_validated", {
          result: "ambiguous",
          candidates: result.candidates ?? [],
          requires_human_decision: true,
          phone: lead.phone,
        });
        report.ambiguous++;
        report.details.push({
          lead_id: leadId,
          phone: lead.phone,
          status: "ambiguous",
          candidates: result.candidates,
          reason: result.message,
        });
        log(`Lead ${leadId} (${lead.name}): AMBÍGUO — decisão humana necessária (${(result.candidates ?? []).join(", ")})`);
        break;
      case "LOOKUP_FAILED":
        addLeadEvent(deps.coreDb, leadId, "whatsapp_validated", {
          result: "lookup_failed",
          phone: lead.phone,
        });
        report.failed++;
        report.details.push({
          lead_id: leadId,
          phone: lead.phone,
          status: "lookup_failed",
          reason: result.message,
        });
        log(`Lead ${leadId} (${lead.name}): lookup falhou — tente novamente depois`);
        break;
    }
  }

  return report;
}

/** Floor for a resume sleep — never busy-spin on a near-zero computed wait. */
const MIN_RESUME_MS = 500;

/**
 * Validates ALL the given leads, in max_batch_size chunks, waiting out the
 * validation rate-limit window between chunks instead of giving up (used by
 * the campaign runner before sending). Returns early only when the socket is
 * gone or the connection fails; leads left unvalidated keep is_whatsapp NULL.
 */
export async function validateUntilDone(
  leadIds: number[],
  deps: Omit<ValidateDeps, "sock"> & { getSocket: () => OnWhatsAppSocket | null },
): Promise<{ complete: boolean }> {
  const config = deps.config ?? WA_CONFIG;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? (() => new Date());
  let remaining = [...leadIds];
  while (remaining.length > 0) {
    const sock = deps.getSocket();
    if (!sock) return { complete: false };
    const report = await validateLeadsCore(remaining, { ...deps, sock, config });
    const handled = new Set(report.details.map((d) => d.lead_id));
    remaining = remaining.filter((id) => !handled.has(id));
    if (!report.stopped_code) continue;
    if (report.stopped_code === "connection") return { complete: false };
    const wait = msUntilRateLimitClears(deps.waDb, validationRateLimit(config), now(), LOOKUP_ACTION_KINDS);
    if (wait <= 0 && handled.size === 0) return { complete: false }; // no progress, nothing to wait for
    await sleep(Math.max(wait, MIN_RESUME_MS));
  }
  return { complete: true };
}

/**
 * Contract entry point (src/whatsapp/README.md): opens both databases,
 * connects the paired session, validates and closes. Requires a previously
 * paired dedicated number (`bun run wa:pair`).
 */
export async function validateLeads(leadIds: number[]): Promise<ValidationReport> {
  const { connectAndWaitOpen } = await import("./connection.ts");
  const coreDb = openDb(CORE_DB_PATH);
  const waDb = openWaDb();
  const { handle, sock } = await connectAndWaitOpen(waDb);
  try {
    return await validateLeadsCore(leadIds, { sock, coreDb, waDb });
  } finally {
    handle.close();
    coreDb.close();
    waDb.close();
  }
}
