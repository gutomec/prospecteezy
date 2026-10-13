// Standalone WhatsApp validation jobs (validate-backend phase). Wraps the
// EXISTING validateLeadsCore (src/whatsapp/validate.ts) — the exact same logic
// the campaign uses in validatePending — in an async, persisted job so the grid
// "Validar WhatsApp" button can run it over selected leads and poll progress.
// The onWhatsApp lookups are account-touching, so validateLeadsCore runs them
// behind the gate (rate limit / jitter / quiet hours). AMBIGUOUS (ninth-digit,
// both accounts exist) is preserved: validateLeadsCore never writes a guess.
import type { Database } from "bun:sqlite";
import { WA_CONFIG, validationRateLimit, type WaConfig } from "./config.ts";
import { nowIso } from "./db.ts";
import { LOOKUP_ACTION_KINDS, msUntilRateLimitClears } from "./gate.ts";
import type { OnWhatsAppSocket } from "./resolver.ts";
import { validateLeadsCore, type LeadValidationDetail } from "./validate.ts";
import type { WaEvent } from "./manager.ts";

/** Floor for a resume sleep — never busy-spin on a near-zero computed wait. */
const MIN_RESUME_MS = 500;

export type ValidateJobStatus = "queued" | "running" | "done" | "paused" | "failed";
export type ValidateResultStatus =
  | "queued"
  | "is_whatsapp"
  | "not_whatsapp"
  | "ambiguous"
  | "failed"
  | "skipped";

export interface ValidateResultRow {
  lead_id: number;
  phone: string | null;
  status: ValidateResultStatus;
  jid: string | null;
  reason: string | null;
}

export interface ValidateJobView {
  job_id: string;
  instance: string;
  status: ValidateJobStatus;
  total: number;
  checked: number;
  is_whatsapp: number;
  not_whatsapp: number;
  ambiguous: number;
  failed: number;
  reason: string | null;
  /** Rough remaining time while draining (null when nothing is pending). */
  eta_seconds: number | null;
  results: Array<{ lead_id: number; phone: string | null; is_whatsapp: boolean | null; jid?: string; reason?: string }>;
}

export function generateValidateJobId(): string {
  return `val${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Creates a validation job + one result row (queued) per deduplicated lead. */
export function createValidateJob(
  waDb: Database,
  coreDb: Database,
  input: { instanceId: string; leadIds: number[] },
): string {
  const id = generateValidateJobId();
  const leadIds = [...new Set(input.leadIds)];
  const at = nowIso();
  waDb.transaction(() => {
    waDb
      .query(
        "INSERT INTO validate_jobs (id, instance_id, status, total, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)",
      )
      .run(id, input.instanceId, leadIds.length, at, at);
    leadIds.forEach((leadId, seq) => {
      const lead = coreDb.query("SELECT phone FROM leads WHERE id = ?").get(leadId) as { phone: string | null } | null;
      waDb
        .query(
          "INSERT INTO validate_results (job_id, lead_id, seq, phone, status, updated_at) VALUES (?, ?, ?, ?, 'queued', ?)",
        )
        .run(id, leadId, seq, lead?.phone ?? null, at);
    });
  })();
  return id;
}

interface JobRow {
  id: string;
  instance_id: string;
  status: ValidateJobStatus;
  total: number;
  reason: string | null;
}

function getJobRow(waDb: Database, id: string): JobRow | null {
  return waDb
    .query("SELECT id, instance_id, status, total, reason FROM validate_jobs WHERE id = ?")
    .get(id) as JobRow | null;
}

export function setValidateJobStatus(
  waDb: Database,
  id: string,
  status: ValidateJobStatus,
  reason: string | null = null,
): void {
  waDb
    .query("UPDATE validate_jobs SET status = ?, reason = ?, updated_at = ? WHERE id = ?")
    .run(status, reason, nowIso(), id);
}

function updateResult(
  waDb: Database,
  jobId: string,
  leadId: number,
  patch: { status: ValidateResultStatus; jid?: string | null; reason?: string | null },
): void {
  waDb
    .query(
      "UPDATE validate_results SET status = ?, jid = coalesce(?, jid), reason = ? , updated_at = ? WHERE job_id = ? AND lead_id = ?",
    )
    .run(patch.status, patch.jid ?? null, patch.reason ?? null, nowIso(), jobId, leadId);
}

/** Maps a validateLeadsCore detail to the job's per-lead result. */
function mapDetail(detail: LeadValidationDetail): { status: ValidateResultStatus; jid?: string | null; reason?: string | null } {
  switch (detail.status) {
    case "exists":
      return { status: "is_whatsapp", jid: detail.jid ?? null };
    case "not_registered":
      return { status: "not_whatsapp" };
    case "ambiguous":
      return { status: "ambiguous", reason: detail.reason ?? "duas contas distintas — decisão humana" };
    case "lookup_failed":
      return { status: "failed", reason: detail.reason ?? "lookup_failed" };
    case "skipped":
      return { status: "skipped", reason: detail.reason ?? "sem telefone" };
  }
}

export function getValidateJob(waDb: Database, id: string): ValidateJobView | null {
  const row = getJobRow(waDb, id);
  if (!row) return null;
  const results = waDb
    .query("SELECT lead_id, phone, status, jid, reason FROM validate_results WHERE job_id = ? ORDER BY seq")
    .all(id) as ValidateResultRow[];
  const count = (s: ValidateResultStatus): number => results.filter((r) => r.status === s).length;
  const pending = results.filter((r) => r.status === "queued").length;
  // Estimate from the dedicated validation ceiling (production config). It's a
  // hint for the UI, not a promise — actual pace depends on the live window.
  const perMinute = validationRateLimit(WA_CONFIG).max_per_minute;
  const etaSeconds =
    pending > 0 && (row.status === "running" || row.status === "queued")
      ? Math.ceil((pending * 60) / Math.max(1, perMinute))
      : null;
  return {
    job_id: row.id,
    instance: row.instance_id,
    status: row.status,
    total: row.total,
    checked: results.filter((r) => r.status !== "queued").length,
    is_whatsapp: count("is_whatsapp"),
    not_whatsapp: count("not_whatsapp"),
    ambiguous: count("ambiguous"),
    failed: count("failed"),
    reason: row.reason,
    eta_seconds: etaSeconds,
    results: results.map((r) => ({
      lead_id: r.lead_id,
      phone: r.phone,
      is_whatsapp: r.status === "is_whatsapp" ? true : r.status === "not_whatsapp" ? false : null,
      ...(r.jid ? { jid: r.jid } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    })),
  };
}

export interface ValidateRunnerDeps {
  waDb: Database;
  coreDb: Database;
  config: WaConfig;
  /** onWhatsApp socket of the instance; null ⇒ not connected. */
  getSocket: () => OnWhatsAppSocket | null;
  publish?: (event: WaEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
}

/**
 * Drives a validation job to completion in the BACKGROUND, auto-draining. It
 * processes the still-queued leads in batches of config.validation.max_batch_size,
 * calling validateLeadsCore (which gates + jitters each onWhatsApp lookup at the
 * dedicated validation ceiling and writes is_whatsapp/whatsapp_jid + lead_events
 * to the core db). When the anti-ban gate blocks on VOLUME, the job is NOT
 * paused: it sleeps exactly until the rate-limit window frees, then resumes —
 * so a job of N leads reaches `done` on its own over time, no manual re-trigger.
 * A `paused` state means the run genuinely cannot proceed (the instance
 * disconnected mid-drain); the remaining leads stay `queued` so POST
 * /validate/:job/resume picks them up. An unexpected error marks the job
 * `failed` (never left `running`). AMBIGUOUS is recorded, never guessed.
 */
export async function runValidateJob(jobId: string, deps: ValidateRunnerDeps): Promise<void> {
  try {
    await drainValidateJob(jobId, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wa] job de validação ${jobId} falhou: ${msg}`);
    try {
      setValidateJobStatus(deps.waDb, jobId, "failed", `erro inesperado: ${msg}`);
      const view = getValidateJob(deps.waDb, jobId);
      if (view) deps.publish?.({ type: "validate", instance: view.instance, data: { job_id: jobId, status: "failed", reason: view.reason } });
    } catch {
      /* the DB itself is failing: nothing more to record */
    }
  }
}

async function drainValidateJob(jobId: string, deps: ValidateRunnerDeps): Promise<void> {
  const { waDb, coreDb, config } = deps;
  const publish = deps.publish ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? (() => new Date());
  const job = getJobRow(waDb, jobId);
  if (!job) return;

  const emit = (result?: ValidateJobView["results"][number]): void => {
    const view = getValidateJob(waDb, jobId);
    if (!view) return;
    publish({
      type: "validate",
      instance: job.instance_id,
      data: {
        job_id: view.job_id,
        status: view.status,
        total: view.total,
        checked: view.checked,
        is_whatsapp: view.is_whatsapp,
        not_whatsapp: view.not_whatsapp,
        ambiguous: view.ambiguous,
        failed: view.failed,
        reason: view.reason,
        eta_seconds: view.eta_seconds,
        ...(result ? { result } : {}),
      },
    });
  };

  const queuedLeadIds = (): number[] =>
    (
      waDb
        .query("SELECT lead_id FROM validate_results WHERE job_id = ? AND status = 'queued' ORDER BY seq")
        .all(jobId) as Array<{ lead_id: number }>
    ).map((r) => r.lead_id);

  setValidateJobStatus(waDb, jobId, "running");
  emit();

  const chunkSize = config.validation.max_batch_size;
  const rateLimit = validationRateLimit(config);

  // Auto-drain loop: keep going until every lead leaves `queued`.
  while (true) {
    const remaining = queuedLeadIds();
    if (remaining.length === 0) break;

    const sock = deps.getSocket();
    if (!sock) {
      // Genuine stop: no live socket to look up against. Pause with a clear
      // reason and keep the rest QUEUED, so a resume continues from here.
      setValidateJobStatus(waDb, jobId, "paused", "instância não conectada");
      emit();
      return;
    }

    let report;
    try {
      report = await validateLeadsCore(remaining.slice(0, chunkSize), {
        sock,
        coreDb,
        waDb,
        config,
        sleep: deps.sleep,
        now: deps.now,
        random: deps.random,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setValidateJobStatus(waDb, jobId, "paused", `falha na conexão: ${msg}`);
      emit();
      return;
    }
    for (const detail of report.details) {
      updateResult(waDb, jobId, detail.lead_id, mapDetail(detail));
    }
    emit();

    if (report.stopped_code === "connection") {
      // Lost the connection mid-batch: pause, remaining leads stay queued.
      setValidateJobStatus(waDb, jobId, "paused", report.stopped_reason);
      emit();
      return;
    }
    if (report.stopped_reason) {
      // Silent lookups override quiet hours, so a stop here is always a VOLUME
      // block. Sleep until the window frees, then resume — never a permanent
      // pause. Guard: a stop with zero progress AND no computable wait (a
      // pathological rate limit) pauses instead of spinning.
      const rawWait = msUntilRateLimitClears(waDb, rateLimit, now(), LOOKUP_ACTION_KINDS);
      if (report.details.length === 0 && rawWait <= 0) {
        setValidateJobStatus(waDb, jobId, "paused", report.stopped_reason);
        emit();
        return;
      }
      setValidateJobStatus(
        waDb,
        jobId,
        "running",
        "aguardando janela do rate limit — retoma automaticamente",
      );
      emit();
      await sleep(Math.max(rawWait, MIN_RESUME_MS));
    }
  }

  setValidateJobStatus(waDb, jobId, "done");
  emit();
}
