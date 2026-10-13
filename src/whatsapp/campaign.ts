// Personalized mass-send campaigns (campaign-backend phase). A campaign is an
// async job over selected leads. The runner: validates pending leads (gated,
// reusing validate.ts), skips non-WhatsApp, renders {{column}} placeholders per
// lead, and sends through the gate — SPACED, never a loop. The gate is the only
// path to the socket and the rate limit is NOT relaxed here (on a mass send the
// throttle is the anti-ban protection). One optional media per campaign, sent
// with the substituted text as its caption. Store lives in data/whatsapp.db.
import type { Database } from "bun:sqlite";
import { getLead, type LeadRow } from "../db/repository.ts";
import type { WaConfig } from "./config.ts";
import { nowIso } from "./db.ts";
import { jitterMs, minSpacingMs, msUntilRateLimitClears, SEND_ACTION_KINDS } from "./gate.ts";
import type { CampaignMedia, SendResult, WaEvent } from "./manager.ts";

// ---------------------------------------------------------------------------
// Placeholder substitution
// ---------------------------------------------------------------------------

/** Lead columns usable as `{{column}}` in a campaign template. */
export const PLACEHOLDER_COLUMNS = [
  "name",
  "category",
  "address",
  "phone",
  "website",
  "rating",
  "email",
] as const;

const PLACEHOLDER_SET = new Set<string>(PLACEHOLDER_COLUMNS);

/**
 * Substitutes `{{column}}` (case-insensitive, whitespace-tolerant) with that
 * lead's value. A missing/null value resolves to an empty string; an
 * unsupported column resolves to an empty string too (only PLACEHOLDER_COLUMNS
 * are substituted). The substitution is server-side — the core DB holds the
 * authoritative values.
 */
export function renderTemplate(template: string, lead: LeadRow): string {
  return template.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_match, raw: string) => {
    const key = raw.toLowerCase();
    if (!PLACEHOLDER_SET.has(key)) return "";
    const value = (lead as unknown as Record<string, unknown>)[key];
    return value == null ? "" : String(value);
  });
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

/** Distinct placeholder names used in a template (lowercased, in order). */
export function templatePlaceholders(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const key = m[1]!.toLowerCase();
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** Placeholders a template uses that are NOT lead columns (would render empty). */
export function unknownPlaceholders(template: string): string[] {
  return templatePlaceholders(template).filter((k) => !PLACEHOLDER_SET.has(k));
}

/** Known placeholders of the template whose value is empty for this lead. */
export function emptyPlaceholders(template: string, lead: LeadRow): string[] {
  return templatePlaceholders(template).filter((k) => {
    if (!PLACEHOLDER_SET.has(k)) return false;
    const value = (lead as unknown as Record<string, unknown>)[k];
    return value == null || String(value).trim() === "";
  });
}

// ---------------------------------------------------------------------------
// Media store (metadata in wa_media; bytes on disk)
// ---------------------------------------------------------------------------

export interface WaMediaRow {
  id: string;
  kind: "image" | "video" | "document";
  mime: string | null;
  filename: string | null;
  size: number;
  file_path: string;
  created_at: string;
}

export function saveMedia(db: Database, row: Omit<WaMediaRow, "created_at">): void {
  db.query(
    `INSERT INTO wa_media (id, kind, mime, filename, size, file_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.kind, row.mime, row.filename, row.size, row.file_path, nowIso());
}

export function getMedia(db: Database, id: string): WaMediaRow | null {
  return db.query("SELECT * FROM wa_media WHERE id = ?").get(id) as WaMediaRow | null;
}

/** Maps a MIME type to a Baileys media kind. Default: document. */
export function kindFromMime(mime: string | null | undefined): "image" | "video" | "document" {
  if (!mime) return "document";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

// ---------------------------------------------------------------------------
// Campaign store
// ---------------------------------------------------------------------------

export type CampaignStatus = "queued" | "running" | "done" | "paused" | "failed";
export type RecipientStatus = "queued" | "sent" | "failed" | "skipped";

export interface CampaignRecipient {
  lead_id: number;
  phone: string | null;
  status: RecipientStatus;
  reason: string | null;
  message_id: string | null;
}

export interface CampaignView {
  job_id: string;
  instance: string;
  status: CampaignStatus;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  reason: string | null;
  recipients: CampaignRecipient[];
}

interface CampaignRow {
  id: string;
  instance_id: string;
  template: string;
  media_id: string | null;
  status: CampaignStatus;
}

export function generateCampaignId(): string {
  return `cmp${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Creates a campaign + one recipient row per (deduplicated) lead id. */
export function createCampaign(
  db: Database,
  coreDb: Database,
  input: { instanceId: string; template: string; mediaId: string | null; leadIds: number[] },
): string {
  const id = generateCampaignId();
  const leadIds = [...new Set(input.leadIds)];
  const at = nowIso();
  db.transaction(() => {
    db.query(
      `INSERT INTO campaigns (id, instance_id, template, media_id, status, total, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(id, input.instanceId, input.template, input.mediaId, leadIds.length, at, at);
    leadIds.forEach((leadId, seq) => {
      const lead = getLead(coreDb, leadId);
      db.query(
        `INSERT INTO campaign_recipients (campaign_id, lead_id, seq, phone, jid, status, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
      ).run(id, leadId, seq, lead?.phone ?? null, lead?.whatsapp_jid ?? null, at);
    });
  })();
  return id;
}

function getCampaignRow(db: Database, id: string): CampaignRow | null {
  return db
    .query("SELECT id, instance_id, template, media_id, status FROM campaigns WHERE id = ?")
    .get(id) as CampaignRow | null;
}

/** The campaign's media handle (null when text only or unknown campaign). */
export function getCampaignMediaId(db: Database, id: string): string | null {
  return getCampaignRow(db, id)?.media_id ?? null;
}

export function getCampaign(db: Database, id: string): CampaignView | null {
  const row = db.query("SELECT * FROM campaigns WHERE id = ?").get(id) as
    | (CampaignRow & { total: number; sent: number; failed: number; skipped: number; reason: string | null })
    | null;
  if (!row) return null;
  const recipients = db
    .query(
      `SELECT lead_id, phone, status, reason, message_id
       FROM campaign_recipients WHERE campaign_id = ? ORDER BY seq`,
    )
    .all(id) as CampaignRecipient[];
  return {
    job_id: row.id,
    instance: row.instance_id,
    status: row.status,
    total: row.total,
    sent: row.sent,
    failed: row.failed,
    skipped: row.skipped,
    reason: row.reason,
    recipients,
  };
}

function updateRecipient(
  db: Database,
  campaignId: string,
  leadId: number,
  patch: { status: RecipientStatus; reason?: string | null; jid?: string | null; messageId?: string | null },
): void {
  db.query(
    `UPDATE campaign_recipients
     SET status = ?, reason = ?, jid = coalesce(?, jid), message_id = coalesce(?, message_id), updated_at = ?
     WHERE campaign_id = ? AND lead_id = ?`,
  ).run(patch.status, patch.reason ?? null, patch.jid ?? null, patch.messageId ?? null, nowIso(), campaignId, leadId);
  recomputeCounts(db, campaignId);
}

function recomputeCounts(db: Database, id: string): void {
  db.query(
    `UPDATE campaigns SET
       sent    = (SELECT count(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'sent'),
       failed  = (SELECT count(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed'),
       skipped = (SELECT count(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'skipped'),
       updated_at = ?
     WHERE id = ?`,
  ).run(id, id, id, nowIso(), id);
}

export function setCampaignStatus(
  db: Database,
  id: string,
  status: CampaignStatus,
  reason: string | null = null,
): void {
  db.query("UPDATE campaigns SET status = ?, reason = ?, updated_at = ? WHERE id = ?").run(
    status,
    reason,
    nowIso(),
    id,
  );
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface CampaignRunnerDeps {
  waDb: Database;
  coreDb: Database;
  config: WaConfig;
  /** Gated send (manager.sendCampaignMessage). The ONLY path to the socket. */
  send: (jid: string, content: { text: string; media?: CampaignMedia }) => Promise<SendResult>;
  /** Runs gated validation for the pending leads (updates coreDb is_whatsapp).
   *  Must wait out the validation rate limit rather than give up. */
  validatePending: (leadIds: number[]) => Promise<void>;
  /** Live-socket probe; false ⇒ the campaign pauses with the rest still
   *  queued. Default: always connected (the send result still reports it). */
  isConnected?: () => boolean;
  /** Loads the campaign media once (null when text only). */
  loadMedia: () => Promise<CampaignMedia | null>;
  publish?: (event: WaEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
}

/** Floor for a resume sleep — never busy-spin on a near-zero computed wait. */
const MIN_RESUME_MS = 500;
/** A JID that got a campaign message this recently is not messaged again. */
const RECENT_SEND_WINDOW_MS = 7 * 24 * 3600_000;
const NOT_CONNECTED = "instância não conectada";

/** Was this JID sent a message by ANOTHER campaign within the window? */
function sentRecentlyByOtherCampaign(db: Database, jid: string, campaignId: string, at: Date): boolean {
  const since = new Date(at.getTime() - RECENT_SEND_WINDOW_MS).toISOString();
  return Boolean(
    db
      .query(
        `SELECT 1 FROM campaign_recipients
         WHERE jid = ? AND status = 'sent' AND campaign_id <> ? AND updated_at >= ? LIMIT 1`,
      )
      .get(jid, campaignId, since),
  );
}

/**
 * Drives one campaign to completion. Validation of pending leads first (gated),
 * then a SPACED pass over the still-queued recipients: render, skip empties and
 * duplicates, send through the gate. A rate-limit block is waited out (sleep
 * until the window frees, then retry the same recipient). Quiet hours or a
 * lost socket pause the campaign with the rest still `queued` — never forced.
 * Any unexpected error marks it `failed` (never left `running`).
 */
export async function runCampaign(campaignId: string, deps: CampaignRunnerDeps): Promise<void> {
  try {
    await driveCampaign(campaignId, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wa] campanha ${campaignId} falhou: ${msg}`);
    try {
      setCampaignStatus(deps.waDb, campaignId, "failed", `erro inesperado: ${msg}`);
      const view = getCampaign(deps.waDb, campaignId);
      if (view) deps.publish?.({ type: "campaign", instance: view.instance, data: { job_id: campaignId, status: "failed", reason: view.reason } });
    } catch {
      /* the DB itself is failing: nothing more to record */
    }
  }
}

async function driveCampaign(campaignId: string, deps: CampaignRunnerDeps): Promise<void> {
  const { waDb, coreDb, config } = deps;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => new Date());
  const publish = deps.publish ?? (() => {});
  const isConnected = deps.isConnected ?? (() => true);

  const campaign = getCampaignRow(waDb, campaignId);
  if (!campaign) return;

  const emit = (recipient?: CampaignRecipient): void => {
    const view = getCampaign(waDb, campaignId);
    if (!view) return;
    publish({
      type: "campaign",
      instance: campaign.instance_id,
      data: {
        job_id: view.job_id,
        status: view.status,
        total: view.total,
        sent: view.sent,
        failed: view.failed,
        skipped: view.skipped,
        ...(recipient ? { recipient } : {}),
      },
    });
  };
  const skip = (leadId: number, phone: string | null, reason: string): void => {
    updateRecipient(waDb, campaignId, leadId, { status: "skipped", reason });
    emit({ lead_id: leadId, phone, status: "skipped", reason, message_id: null });
  };
  const pause = (reason: string | null): void => {
    setCampaignStatus(waDb, campaignId, "paused", reason);
    emit();
  };

  setCampaignStatus(waDb, campaignId, "running");
  emit();

  // Only recipients still queued: a resumed/re-run campaign never re-sends.
  const recipients = waDb
    .query("SELECT lead_id, phone FROM campaign_recipients WHERE campaign_id = ? AND status = 'queued' ORDER BY seq")
    .all(campaignId) as Array<{ lead_id: number; phone: string | null }>;

  // 1. Validate pending leads (is_whatsapp NULL) — gated, before any send.
  const pending = recipients
    .map((r) => getLead(coreDb, r.lead_id))
    .filter((l): l is LeadRow => Boolean(l) && (l as LeadRow).is_whatsapp == null)
    .map((l) => l.id);
  if (pending.length > 0) {
    try {
      await deps.validatePending(pending);
    } catch {
      /* validation best-effort: leads still NULL fall through to skipped:not_validated */
    }
  }

  // Without a socket nothing below can be validated or sent: pause, keep queued.
  if (!isConnected()) {
    pause(NOT_CONNECTED);
    return;
  }

  const media = await deps.loadMedia();
  let spacedAfterSend = false;
  // Spacing never lets a steady loop exceed max_per_minute (2/min ⇒ ≥ 30 s),
  // whatever the jitter config says; jitter only adds on top.
  const spacingMs = (): number => Math.max(jitterMs(config, random), minSpacingMs(config.rate_limit));
  // One message per WhatsApp account per campaign, even when two leads share it.
  const seenJids = new Set(
    (
      waDb
        .query("SELECT jid FROM campaign_recipients WHERE campaign_id = ? AND status = 'sent' AND jid IS NOT NULL")
        .all(campaignId) as Array<{ jid: string }>
    ).map((row) => row.jid),
  );

  for (const r of recipients) {
    const lead = getLead(coreDb, r.lead_id);
    if (!lead) {
      skip(r.lead_id, r.phone, "lead_not_found");
      continue;
    }
    if (lead.is_whatsapp !== 1 || !lead.whatsapp_jid) {
      skip(r.lead_id, lead.phone, lead.is_whatsapp === 0 ? "not_whatsapp" : "not_validated");
      continue;
    }
    const jid = lead.whatsapp_jid;
    if (seenJids.has(jid)) {
      skip(r.lead_id, lead.phone, "mesmo WhatsApp de outro lead desta campanha");
      continue;
    }
    if (sentRecentlyByOtherCampaign(waDb, jid, campaignId, now())) {
      skip(r.lead_id, lead.phone, "já recebeu mensagem de outra campanha nos últimos 7 dias");
      continue;
    }
    const text = renderTemplate(campaign.template, lead);
    if (text.length === 0 && !media) {
      skip(r.lead_id, lead.phone, "empty_message");
      continue;
    }
    const empty = emptyPlaceholders(campaign.template, lead);
    if (empty.length > 0) {
      skip(r.lead_id, lead.phone, `campo vazio para este lead: ${empty.map((k) => `{{${k}}}`).join(", ")}`);
      continue;
    }

    // Human spacing between consecutive real sends — the throttle (jitter).
    if (spacedAfterSend) await sleep(spacingMs());

    let res: SendResult;
    while (true) {
      if (!isConnected()) {
        pause(NOT_CONNECTED);
        return;
      }
      res = await deps.send(jid, { text, media: media ?? undefined });
      if (res.ok || res.gate.blocked_code !== "rate_limit") break;
      // Volume block: wait until the send window frees, then retry this same
      // recipient. Guard: nothing to wait for (the gate disagrees with the
      // accounting) ⇒ pause instead of spinning.
      const wait = msUntilRateLimitClears(waDb, config.rate_limit, now(), SEND_ACTION_KINDS);
      if (wait <= 0) {
        updateRecipient(waDb, campaignId, r.lead_id, { status: "queued", jid, reason: res.gate.blocked_code });
        emit({ lead_id: r.lead_id, phone: lead.phone, status: "queued", reason: res.gate.blocked_code, message_id: null });
        pause(res.gate.blocked_reason);
        return;
      }
      setCampaignStatus(waDb, campaignId, "running", "aguardando janela do rate limit — retoma automaticamente");
      emit();
      await sleep(Math.max(wait, MIN_RESUME_MS));
    }
    seenJids.add(jid);
    if (res.ok) {
      updateRecipient(waDb, campaignId, r.lead_id, {
        status: "sent",
        jid,
        messageId: res.message?.message_id ?? null,
      });
      setCampaignStatus(waDb, campaignId, "running");
      emit({ lead_id: r.lead_id, phone: lead.phone, status: "sent", reason: null, message_id: res.message?.message_id ?? null });
      spacedAfterSend = true;
    } else if (res.gate.blocked_code) {
      // Quiet hours → do NOT force. Leave queued and pause the campaign.
      updateRecipient(waDb, campaignId, r.lead_id, { status: "queued", jid, reason: res.gate.blocked_code });
      setCampaignStatus(waDb, campaignId, "paused", res.gate.blocked_reason);
      emit({ lead_id: r.lead_id, phone: lead.phone, status: "queued", reason: res.gate.blocked_code, message_id: null });
      return;
    } else if (res.error === NOT_CONNECTED || !isConnected()) {
      // The socket dropped between the probe and the send: keep it queued.
      pause(NOT_CONNECTED);
      return;
    } else {
      updateRecipient(waDb, campaignId, r.lead_id, { status: "failed", jid, reason: res.error ?? "send_failed" });
      emit({ lead_id: r.lead_id, phone: lead.phone, status: "failed", reason: res.error ?? "send_failed", message_id: null });
      spacedAfterSend = true;
    }
  }

  setCampaignStatus(waDb, campaignId, "done");
  emit();
}
