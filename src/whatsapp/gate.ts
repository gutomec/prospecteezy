// Anti-ban gate — adaptation of the agentic-whatsapp-nirvana squad's
// template/lib/gate.ts for this project's account-touching actions
// (onWhatsApp lookups, contact pushes). No action reaches the socket without
// passing here: quiet hours (21:00–08:00 America/Sao_Paulo) and rate limits
// with human cadence (sliding windows counted over wa_actions).
import type { Database } from "bun:sqlite";
import type { WaConfig, WaRateLimit } from "./config.ts";
import { nowIso } from "./db.ts";

export type GateBlockedCode = "quiet_hours" | "rate_limit";

export interface GateResult {
  allowed: boolean;
  blocked_code: GateBlockedCode | null;
  blocked_reason: string | null;
}

function minutesOfDay(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Minutes of day in the policy timezone (IANA); UTC fallback when invalid. */
function minutesInTimezone(at: Date, timezone: string): number {
  try {
    const formatted = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(at);
    return minutesOfDay(formatted);
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}

export function isWithinQuietHours(config: WaConfig, at: Date): boolean {
  const qh = config.quiet_hours;
  if (!qh.enabled) return false;
  const start = minutesOfDay(qh.start);
  const end = minutesOfDay(qh.end);
  const now = minutesInTimezone(at, qh.timezone);
  if (start === end) return false;
  // Window crossing midnight (e.g. 21:00 → 08:00)
  if (start > end) return now >= start || now < end;
  return now >= start && now < end;
}

/** wa_actions kinds that spend the SEND budget (config.rate_limit). */
export const SEND_ACTION_KINDS = ["message_send"] as const;
/** wa_actions kinds that spend the VALIDATION budget (validationRateLimit). */
export const LOOKUP_ACTION_KINDS = ["onwhatsapp_lookup"] as const;

/** Optional `kind IN (...)` filter; undefined = every kind (account-wide). */
function kindFilter(kinds: readonly string[] | undefined): { sql: string; params: string[] } {
  if (!kinds || kinds.length === 0) return { sql: "", params: [] };
  return { sql: ` AND kind IN (${kinds.map(() => "?").join(", ")})`, params: [...kinds] };
}

/** Account actions recorded in the window [at - windowMs, at]. */
function actionsInWindow(db: Database, at: Date, windowMs: number, kinds?: readonly string[]): number {
  const windowStart = new Date(at.getTime() - windowMs).toISOString();
  const filter = kindFilter(kinds);
  const row = db
    .query(`SELECT count(*) AS c FROM wa_actions WHERE created_at >= ? AND created_at <= ?${filter.sql}`)
    .get(windowStart, at.toISOString(), ...filter.params) as { c: number };
  return row.c;
}

/**
 * Rules, in order:
 * 1. Quiet hours block the intended time (schedule outside the window) —
 *    UNLESS overrideQuietHours is set. A SILENT lookup (onWhatsApp) sends no
 *    message to anyone, so the night-time messaging guard doesn't apply; only
 *    the volume rules below protect the number. Mirrors evaluateSendGate's
 *    overrideQuietHours (the 1:1 human-reply path).
 * 2. Hourly rate limit (human cadence).
 * 3. Per-minute rate limit.
 * `kinds` restricts which recorded actions count (undefined = all of them).
 */
export function evaluateActionGate(
  db: Database,
  config: WaConfig,
  at: Date = new Date(),
  overrideQuietHours = false,
  rateLimit: WaRateLimit = config.rate_limit,
  kinds?: readonly string[],
): GateResult {
  if (!overrideQuietHours && isWithinQuietHours(config, at)) {
    const qh = config.quiet_hours;
    return {
      allowed: false,
      blocked_code: "quiet_hours",
      blocked_reason: `horário dentro das quiet hours (${qh.start}–${qh.end} ${qh.timezone}): rode fora da janela`,
    };
  }
  const hourCount = actionsInWindow(db, at, 3600_000, kinds);
  if (hourCount >= rateLimit.max_per_hour) {
    return {
      allowed: false,
      blocked_code: "rate_limit",
      blocked_reason: `rate limit atingido (${hourCount}/${rateLimit.max_per_hour} ações na última hora)`,
    };
  }
  const minuteCount = actionsInWindow(db, at, 60_000, kinds);
  if (minuteCount >= rateLimit.max_per_minute) {
    return {
      allowed: false,
      blocked_code: "rate_limit",
      blocked_reason: `rate limit atingido (${minuteCount}/${rateLimit.max_per_minute} ações no último minuto)`,
    };
  }
  return { allowed: true, blocked_code: null, blocked_reason: null };
}

/** Oldest wa_actions timestamp (ms epoch) inside [at - windowMs, at], or null. */
function oldestActionMs(db: Database, at: Date, windowMs: number, kinds?: readonly string[]): number | null {
  const windowStart = new Date(at.getTime() - windowMs).toISOString();
  const filter = kindFilter(kinds);
  const row = db
    .query(`SELECT min(created_at) AS oldest FROM wa_actions WHERE created_at >= ? AND created_at <= ?${filter.sql}`)
    .get(windowStart, at.toISOString(), ...filter.params) as { oldest: string | null };
  return row.oldest ? new Date(row.oldest).getTime() : null;
}

/**
 * Milliseconds until at least one slot frees under `rateLimit`, so the caller
 * can SLEEP that long and resume instead of pausing forever. Zero when nothing
 * is blocking. The auto-drain validation runner uses this to self-pace: a full
 * per-minute or per-hour window clears once its oldest action ages out.
 */
export function msUntilRateLimitClears(
  db: Database,
  rateLimit: WaRateLimit,
  at: Date,
  kinds?: readonly string[],
): number {
  // +1 ms: the window is inclusive (created_at >= windowStart), so the oldest
  // action must fall STRICTLY outside it before a slot frees.
  let wait = 0;
  if (actionsInWindow(db, at, 60_000, kinds) >= rateLimit.max_per_minute) {
    const oldest = oldestActionMs(db, at, 60_000, kinds);
    if (oldest != null) wait = Math.max(wait, oldest + 60_000 - at.getTime() + 1);
  }
  if (actionsInWindow(db, at, 3600_000, kinds) >= rateLimit.max_per_hour) {
    const oldest = oldestActionMs(db, at, 3600_000, kinds);
    if (oldest != null) wait = Math.max(wait, oldest + 3600_000 - at.getTime() + 1);
  }
  return Math.max(0, wait);
}

export interface SendGateOptions {
  at?: Date;
  /**
   * Interactive 1:1 human reply inside an open conversation. When true, quiet
   * hours are skipped (a person answering a customer at night is legitimate and
   * low-risk) but the rate limit stays ON — it protects the NUMBER from bursts
   * and is what keeps mass-send off this path. Default false (full policy).
   */
  overrideQuietHours?: boolean;
}

/**
 * The single gate every message send passes through (routes.ts / manager.ts).
 * Reuses the sliding-window rate limit and quiet-hours logic of the action
 * gate; the only difference is the human-reply quiet-hours override. Only
 * SENDS (`kind="message_send"`) count here: silent validation lookups have
 * their own budget and must not starve a campaign.
 */
export function evaluateSendGate(
  db: Database,
  config: WaConfig,
  opts: SendGateOptions = {},
): GateResult {
  const at = opts.at ?? new Date();
  if (!opts.overrideQuietHours && isWithinQuietHours(config, at)) {
    const qh = config.quiet_hours;
    return {
      allowed: false,
      blocked_code: "quiet_hours",
      blocked_reason: `horário dentro das quiet hours (${qh.start}–${qh.end} ${qh.timezone})`,
    };
  }
  const hourCount = actionsInWindow(db, at, 3600_000, SEND_ACTION_KINDS);
  if (hourCount >= config.rate_limit.max_per_hour) {
    return {
      allowed: false,
      blocked_code: "rate_limit",
      blocked_reason: `rate limit atingido (${hourCount}/${config.rate_limit.max_per_hour} ações na última hora)`,
    };
  }
  const minuteCount = actionsInWindow(db, at, 60_000, SEND_ACTION_KINDS);
  if (minuteCount >= config.rate_limit.max_per_minute) {
    return {
      allowed: false,
      blocked_code: "rate_limit",
      blocked_reason: `rate limit atingido (${minuteCount}/${config.rate_limit.max_per_minute} ações no último minuto)`,
    };
  }
  return { allowed: true, blocked_code: null, blocked_reason: null };
}

/** Records an account-touching action for the sliding-window accounting. */
export function recordAction(
  db: Database,
  kind: string,
  target: string | null,
  at: Date = new Date(),
): void {
  db.query("INSERT INTO wa_actions (kind, target, created_at) VALUES (?, ?, ?)").run(
    kind,
    target,
    at ? at.toISOString() : nowIso(),
  );
}

/**
 * Atomic check-and-reserve for a send: evaluates the send gate and, when
 * allowed, records the action in the SAME immediate transaction, BEFORE the
 * caller awaits the socket. With no await between check and record, two
 * concurrent senders (in-process or another process on the same file) can
 * never both pass on the last free slot. A send that then fails keeps its
 * reservation: conservative, the budget errs on the safe side.
 */
export function reserveSend(
  db: Database,
  config: WaConfig,
  target: string | null,
  opts: SendGateOptions = {},
): GateResult {
  const at = opts.at ?? new Date();
  return db
    .transaction(() => {
      const gate = evaluateSendGate(db, config, { ...opts, at });
      if (gate.allowed) recordAction(db, "message_send", target, at);
      return gate;
    })
    .immediate();
}

/**
 * Atomic check-and-reserve for a silent onWhatsApp lookup: quiet hours do not
 * apply, only the validation budget counts (lookups only), and the slot is
 * recorded before the network call.
 */
export function reserveLookup(
  db: Database,
  config: WaConfig,
  rateLimit: WaRateLimit,
  target: string | null,
  at: Date = new Date(),
): GateResult {
  return db
    .transaction(() => {
      const gate = evaluateActionGate(db, config, at, true, rateLimit, LOOKUP_ACTION_KINDS);
      if (gate.allowed) recordAction(db, "onwhatsapp_lookup", target, at);
      return gate;
    })
    .immediate();
}

/**
 * Minimum spacing between consecutive actions so a steady loop never exceeds
 * `max_per_minute` (60 s / max_per_minute), in milliseconds.
 */
export function minSpacingMs(rateLimit: WaRateLimit): number {
  return Math.ceil(60_000 / Math.max(1, rateLimit.max_per_minute));
}

/**
 * Human jitter between consecutive actions (milliseconds):
 * min_interval + random(0..jitter) seconds. Injectable random for tests.
 */
export function jitterMs(
  config: WaConfig,
  random: () => number = Math.random,
  rateLimit: WaRateLimit = config.rate_limit,
): number {
  const { min_interval_seconds, jitter_seconds } = rateLimit;
  return (min_interval_seconds + Math.floor(random() * (jitter_seconds + 1))) * 1000;
}
