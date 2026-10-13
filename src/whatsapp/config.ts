/**
 * Anti-ban policy for every operation that touches the WhatsApp account.
 * Defaults ported from the agentic-whatsapp-nirvana squad config
 * (rate_limits + quiet_hours). Edit here to tune; keep values conservative —
 * this module talks to a real WhatsApp account on a dedicated number.
 */
export interface WaRateLimit {
  max_per_minute: number;
  max_per_hour: number;
  /** Minimum spacing between consecutive account actions (seconds). */
  min_interval_seconds: number;
  /** Random extra spacing added on top of min_interval (0..jitter seconds). */
  jitter_seconds: number;
}

export interface WaQuietHours {
  enabled: boolean;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  timezone: string; // IANA
}

export interface WaConfig {
  quiet_hours: WaQuietHours;
  /** Budget for message SENDS (campaign/1:1). The strict, ban-sensitive path. */
  rate_limit: WaRateLimit;
  /**
   * Dedicated budget for silent onWhatsApp validation lookups. Optional: when
   * absent, validation falls back to `rate_limit` (see validationRateLimit).
   * A presence lookup delivers NO message, so it carries far less ban risk than
   * a send and earns a faster, separate ceiling.
   */
  validation_rate?: WaRateLimit;
  validation: {
    /** Hard cap of leads processed per run — small, spaced batches. */
    max_batch_size: number;
  };
}

/**
 * The rate limit that governs validation lookups: the dedicated
 * `validation_rate` when configured, otherwise the send `rate_limit` (the old
 * behavior). Single source of truth so the gate, the jitter, and the auto-drain
 * runner never drift apart.
 */
export function validationRateLimit(config: WaConfig): WaRateLimit {
  return config.validation_rate ?? config.rate_limit;
}

export const WA_CONFIG: WaConfig = {
  quiet_hours: {
    enabled: true,
    start: "21:00",
    end: "08:00",
    timezone: "America/Sao_Paulo",
  },
  rate_limit: {
    max_per_minute: 2,
    max_per_hour: 20,
    min_interval_seconds: 15,
    jitter_seconds: 10,
  },
  // Validation lookups (onWhatsApp presence) get their own, faster ceiling.
  // Rationale (anti-ban): a presence lookup is SILENT — it delivers no message,
  // so WhatsApp's abuse heuristics (spam reports, message volume to strangers)
  // don't apply to it the way they do to sends. What still matters is looking
  // human, not like a bulk scraper: 10/min with 3–7s human jitter and a 200/h
  // ceiling stays well under any automated-scraping threshold while letting a
  // 100-lead validation finish in ~10 min instead of ~5h under the send budget.
  // Sends keep the stricter 2/min · 20/h — a delivered message is what bans.
  // The two budgets are separate: lookups (kind onwhatsapp_lookup) count only
  // here and sends (kind message_send) count only against rate_limit, so a
  // validation run never starves a campaign of its 2/min send slots.
  validation_rate: {
    max_per_minute: 10,
    max_per_hour: 200,
    min_interval_seconds: 3,
    jitter_seconds: 4,
  },
  validation: {
    max_batch_size: 20,
  },
};
