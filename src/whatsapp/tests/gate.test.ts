import { describe, expect, test } from "bun:test";
import type { WaConfig } from "../config.ts";
import { openWaDb } from "../db.ts";
import { evaluateActionGate, isWithinQuietHours, jitterMs, recordAction } from "../gate.ts";

const config: WaConfig = {
  quiet_hours: { enabled: true, start: "21:00", end: "08:00", timezone: "America/Sao_Paulo" },
  rate_limit: { max_per_minute: 2, max_per_hour: 20, min_interval_seconds: 15, jitter_seconds: 10 },
  validation: { max_batch_size: 20 },
};

// America/Sao_Paulo is UTC-3 (no DST since 2019).
const at = (utcIso: string) => new Date(utcIso);

describe("isWithinQuietHours (21h–08h America/Sao_Paulo)", () => {
  test("22:00 SP is inside the window", () => {
    expect(isWithinQuietHours(config, at("2026-08-19T01:00:00Z"))).toBe(true); // 22:00 SP
  });
  test("21:00 SP sharp is inside", () => {
    expect(isWithinQuietHours(config, at("2026-08-19T00:00:00Z"))).toBe(true); // 21:00 SP
  });
  test("07:59 SP is still inside", () => {
    expect(isWithinQuietHours(config, at("2026-08-19T10:59:00Z"))).toBe(true); // 07:59 SP
  });
  test("08:00 SP is outside", () => {
    expect(isWithinQuietHours(config, at("2026-08-19T11:00:00Z"))).toBe(false); // 08:00 SP
  });
  test("midday SP is outside", () => {
    expect(isWithinQuietHours(config, at("2026-08-19T15:00:00Z"))).toBe(false); // 12:00 SP
  });
  test("disabled config never blocks", () => {
    const off = { ...config, quiet_hours: { ...config.quiet_hours, enabled: false } };
    expect(isWithinQuietHours(off, at("2026-08-19T01:00:00Z"))).toBe(false);
  });
});

describe("evaluateActionGate", () => {
  const midday = at("2026-08-19T15:00:00Z"); // 12:00 SP — outside quiet hours

  test("quiet hours block with structured code", () => {
    const db = openWaDb(":memory:");
    const result = evaluateActionGate(db, config, at("2026-08-19T01:00:00Z"));
    expect(result.allowed).toBe(false);
    expect(result.blocked_code).toBe("quiet_hours");
  });

  test("per-minute rate limit blocks after max_per_minute actions", () => {
    const db = openWaDb(":memory:");
    recordAction(db, "onwhatsapp_lookup", "a", new Date(midday.getTime() - 10_000));
    recordAction(db, "onwhatsapp_lookup", "b", new Date(midday.getTime() - 5_000));
    const result = evaluateActionGate(db, config, midday);
    expect(result.allowed).toBe(false);
    expect(result.blocked_code).toBe("rate_limit");
  });

  test("per-hour rate limit blocks after max_per_hour actions", () => {
    const db = openWaDb(":memory:");
    for (let i = 0; i < 20; i++) {
      recordAction(db, "onwhatsapp_lookup", `n${i}`, new Date(midday.getTime() - (i + 2) * 120_000));
    }
    const result = evaluateActionGate(db, config, midday);
    expect(result.allowed).toBe(false);
    expect(result.blocked_code).toBe("rate_limit");
  });

  test("actions outside the windows do not count", () => {
    const db = openWaDb(":memory:");
    recordAction(db, "onwhatsapp_lookup", "old", new Date(midday.getTime() - 2 * 3600_000));
    const result = evaluateActionGate(db, config, midday);
    expect(result.allowed).toBe(true);
    expect(result.blocked_code).toBeNull();
  });
});

describe("jitterMs", () => {
  test("bounds: min_interval .. min_interval + jitter (seconds → ms)", () => {
    expect(jitterMs(config, () => 0)).toBe(15_000);
    expect(jitterMs(config, () => 0.999)).toBe(25_000);
  });
});
