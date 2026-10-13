import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../db/index.ts";
import type { WaConfig } from "../config.ts";
import { openWaDb } from "../db.ts";
import { recordAction } from "../gate.ts";
import type { OnWhatsAppSocket } from "../resolver.ts";
import { validateLeadsCore } from "../validate.ts";

const MIDDAY_SP = new Date("2026-08-19T15:00:00Z"); // 12:00 America/Sao_Paulo
const QUIET_SP = new Date("2026-08-19T01:00:00Z"); // 22:00 America/Sao_Paulo

/** Test config: quiet hours real, rate limits wide open unless overridden. */
function testConfig(overrides: Partial<WaConfig["rate_limit"]> = {}): WaConfig {
  return {
    quiet_hours: { enabled: true, start: "21:00", end: "08:00", timezone: "America/Sao_Paulo" },
    rate_limit: {
      max_per_minute: 1000,
      max_per_hour: 1000,
      min_interval_seconds: 0,
      jitter_seconds: 0,
      ...overrides,
    },
    validation: { max_batch_size: 20 },
  };
}

function seedCoreDb(): Database {
  const db = openDb(":memory:");
  db.query(
    `INSERT INTO searches (query_normalized, niche, city, gl, hl, created_at)
     VALUES ('escritorios de advocacia sao paulo-sp', 'escritórios de advocacia', 'São Paulo-SP', 'br', 'pt-br', ?)`,
  ).run(new Date().toISOString());
  return db;
}

function seedLead(db: Database, name: string, phone: string | null): number {
  const res = db
    .query(
      `INSERT INTO leads (search_id, place_id, name, phone, source, collected_at)
       VALUES (1, ?, ?, ?, 'serper:places', ?)`,
    )
    .run(`place-${name}`, name, phone, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

function getLeadRow(db: Database, id: number): { is_whatsapp: number | null; whatsapp_jid: string | null } {
  return db.query("SELECT is_whatsapp, whatsapp_jid FROM leads WHERE id = ?").get(id) as {
    is_whatsapp: number | null;
    whatsapp_jid: string | null;
  };
}

function getEvents(db: Database, leadId: number): { event: string; payload: Record<string, unknown> }[] {
  const rows = db
    .query("SELECT event, payload_json FROM lead_events WHERE lead_id = ? ORDER BY id")
    .all(leadId) as { event: string; payload_json: string | null }[];
  return rows.map((r) => ({ event: r.event, payload: JSON.parse(r.payload_json ?? "{}") }));
}

describe("validateLeadsCore", () => {
  test("full batch: partial-array jid mapping, ninth digit, AMBIGUOUS, skip, failure", async () => {
    const coreDb = seedCoreDb();
    const waDb = openWaDb(":memory:");

    // A: mobile typed with 9, but the ACCOUNT lives on the 12-digit form —
    //    server answers a PARTIAL array (one element, second candidate).
    const leadA = seedLead(coreDb, "Escritório A", "+55 11 98765-4321");
    // B: landline, no variant, not on WhatsApp (empty array = absent).
    const leadB = seedLead(coreDb, "Escritório B", "(11) 3333-4444");
    // C: BOTH variants exist → AMBIGUOUS → human decision.
    const leadC = seedLead(coreDb, "Escritório C", "+55 21 99876-5432");
    // D: no phone → skipped.
    const leadD = seedLead(coreDb, "Escritório D", null);
    // E: server does not answer → lookup_failed, lead untouched.
    const leadE = seedLead(coreDb, "Escritório E", "+55 31 91234-5678");

    const lookups: string[][] = [];
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async (...numbers) => {
        lookups.push(numbers);
        const first = numbers[0]!;
        if (first === "5511987654321") {
          // Partial array: only the 12-digit account exists. Matching by index
          // would bind it to the 13-digit candidate — the incident this squad
          // logic exists to prevent.
          return [{ jid: "551187654321@s.whatsapp.net", exists: true }];
        }
        if (first === "551133334444") return [];
        if (first === "5521998765432") {
          return [
            { jid: "5521998765432@s.whatsapp.net", exists: true },
            { jid: "552198765432@s.whatsapp.net", exists: true },
          ];
        }
        return undefined; // leadE
      },
    };

    const sleeps: number[] = [];
    const report = await validateLeadsCore([leadA, leadB, leadC, leadD, leadE], {
      sock,
      coreDb,
      waDb,
      config: testConfig(),
      now: () => MIDDAY_SP,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(report.validated).toBe(2); // A (exists) + B (not registered)
    expect(report.ambiguous).toBe(1); // C
    expect(report.skipped).toBe(1); // D
    expect(report.failed).toBe(1); // E
    expect(report.stopped_reason).toBeNull();

    // A: canonical jid from the SERVER response (12-digit), not the requested form.
    const rowA = getLeadRow(coreDb, leadA);
    expect(rowA.is_whatsapp).toBe(1);
    expect(rowA.whatsapp_jid).toBe("551187654321@s.whatsapp.net");
    const eventsA = getEvents(coreDb, leadA);
    expect(eventsA.at(-1)?.event).toBe("whatsapp_validated");
    expect(eventsA.at(-1)?.payload.result).toBe("exists");
    expect(eventsA.at(-1)?.payload.corrected_from).toBe("5511987654321@s.whatsapp.net");

    // Ninth-digit variants were sent together, in one round-trip.
    expect(lookups[0]).toEqual(["5511987654321", "551187654321"]);

    // B: definitive "no".
    const rowB = getLeadRow(coreDb, leadB);
    expect(rowB.is_whatsapp).toBe(0);
    expect(rowB.whatsapp_jid).toBeNull();

    // C: AMBIGUOUS — nothing written, flagged for a human.
    const rowC = getLeadRow(coreDb, leadC);
    expect(rowC.is_whatsapp).toBeNull();
    expect(rowC.whatsapp_jid).toBeNull();
    const eventsC = getEvents(coreDb, leadC);
    expect(eventsC.at(-1)?.payload.result).toBe("ambiguous");
    expect(eventsC.at(-1)?.payload.requires_human_decision).toBe(true);

    // D: skipped with audit trail.
    expect(getEvents(coreDb, leadD).at(-1)?.payload.result).toBe("skipped");

    // E: untouched in leads, failure audited.
    const rowE = getLeadRow(coreDb, leadE);
    expect(rowE.is_whatsapp).toBeNull();
    expect(getEvents(coreDb, leadE).at(-1)?.payload.result).toBe("lookup_failed");

    // Jitter spacing between consecutive lookups (4 lookups → 3 sleeps).
    expect(lookups.length).toBe(4);
    expect(sleeps.length).toBe(3);
  });

  test("quiet hours: silent lookup PROCEEDS (override), lead validated", async () => {
    const coreDb = seedCoreDb();
    const waDb = openWaDb(":memory:");
    const leadId = seedLead(coreDb, "Escritório Noturno", "+55 11 98765-4321");

    let lookupCount = 0;
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async (...numbers) => {
        lookupCount++;
        return [{ jid: `${numbers[0]}@s.whatsapp.net`, exists: true }];
      },
    };

    const report = await validateLeadsCore([leadId], {
      sock,
      coreDb,
      waDb,
      config: testConfig(),
      now: () => QUIET_SP, // 22:00 SP — inside quiet hours
      random: () => 0,
      sleep: async () => {},
    });

    // A silent onWhatsApp lookup messages no one, so quiet hours do NOT stop it.
    expect(lookupCount).toBe(1);
    expect(report.validated).toBe(1);
    expect(report.stopped_reason).toBeNull();
    expect(getLeadRow(coreDb, leadId).is_whatsapp).toBe(1);
  });

  test("quiet hours + saturated window: rate limit STILL pauses (override is quiet-hours only)", async () => {
    const coreDb = seedCoreDb();
    const waDb = openWaDb(":memory:");
    const leadId = seedLead(coreDb, "Escritório Noturno", "+55 11 98765-4321");
    // Fill the per-minute window at the same (quiet-hours) instant.
    recordAction(waDb, "onwhatsapp_lookup", "a", new Date(QUIET_SP.getTime() - 10_000));
    recordAction(waDb, "onwhatsapp_lookup", "b", new Date(QUIET_SP.getTime() - 5_000));

    let lookupCount = 0;
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => {
        lookupCount++;
        return [];
      },
    };

    const report = await validateLeadsCore([leadId], {
      sock,
      coreDb,
      waDb,
      config: testConfig({ max_per_minute: 2 }),
      now: () => QUIET_SP,
      sleep: async () => {},
    });

    // Volume still guards the number, even at night — override is quiet-hours only.
    expect(lookupCount).toBe(0);
    expect(report.stopped_reason).toContain("rate limit");
    expect(getLeadRow(coreDb, leadId).is_whatsapp).toBeNull();
  });

  test("rate limit: stops the batch once the window is full", async () => {
    const coreDb = seedCoreDb();
    const waDb = openWaDb(":memory:");
    const ids = [
      seedLead(coreDb, "L1", "+55 11 91111-1111"),
      seedLead(coreDb, "L2", "+55 11 92222-2222"),
      seedLead(coreDb, "L3", "+55 11 93333-3333"),
    ];

    let lookupCount = 0;
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async (...numbers) => {
        lookupCount++;
        return [{ jid: `${numbers[0]}@s.whatsapp.net`, exists: true }];
      },
    };

    const report = await validateLeadsCore(ids, {
      sock,
      coreDb,
      waDb,
      config: testConfig({ max_per_minute: 2 }),
      now: () => MIDDAY_SP,
      sleep: async () => {},
    });

    expect(lookupCount).toBe(2); // third blocked by the per-minute limit
    expect(report.validated).toBe(2);
    expect(report.stopped_reason).toContain("rate limit");
    expect(getLeadRow(coreDb, ids[2]!).is_whatsapp).toBeNull();
  });

  test("pre-existing lookups count against the validation window", async () => {
    const coreDb = seedCoreDb();
    const waDb = openWaDb(":memory:");
    const leadId = seedLead(coreDb, "L1", "+55 11 91111-1111");
    recordAction(waDb, "onwhatsapp_lookup", "x", new Date(MIDDAY_SP.getTime() - 10_000));
    recordAction(waDb, "onwhatsapp_lookup", "y", new Date(MIDDAY_SP.getTime() - 20_000));

    let lookupCount = 0;
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => {
        lookupCount++;
        return [];
      },
    };
    const report = await validateLeadsCore([leadId], {
      sock,
      coreDb,
      waDb,
      config: testConfig({ max_per_minute: 2 }),
      now: () => MIDDAY_SP,
      sleep: async () => {},
    });
    expect(lookupCount).toBe(0);
    expect(report.stopped_reason).toContain("rate limit");
  });

  test("sends do NOT spend the validation budget (separate budgets)", async () => {
    const coreDb = seedCoreDb();
    const waDb = openWaDb(":memory:");
    const leadId = seedLead(coreDb, "L1", "+55 11 91111-1111");
    recordAction(waDb, "message_send", "x", new Date(MIDDAY_SP.getTime() - 10_000));
    recordAction(waDb, "message_send", "y", new Date(MIDDAY_SP.getTime() - 20_000));

    let lookupCount = 0;
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => {
        lookupCount++;
        return [];
      },
    };
    const report = await validateLeadsCore([leadId], {
      sock,
      coreDb,
      waDb,
      config: testConfig({ max_per_minute: 2 }),
      now: () => MIDDAY_SP,
      sleep: async () => {},
    });
    expect(lookupCount).toBe(1);
    expect(report.stopped_reason).toBeNull();
  });

  test("max_batch_size caps the run", async () => {
    const coreDb = seedCoreDb();
    const waDb = openWaDb(":memory:");
    const ids = [
      seedLead(coreDb, "B1", "+55 11 91111-1111"),
      seedLead(coreDb, "B2", "+55 11 92222-2222"),
      seedLead(coreDb, "B3", "+55 11 93333-3333"),
    ];
    const config = testConfig();
    config.validation = { max_batch_size: 2 };

    let lookupCount = 0;
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => {
        lookupCount++;
        return [];
      },
    };
    await validateLeadsCore(ids, {
      sock,
      coreDb,
      waDb,
      config,
      now: () => MIDDAY_SP,
      sleep: async () => {},
    });
    expect(lookupCount).toBe(2);
  });
});
