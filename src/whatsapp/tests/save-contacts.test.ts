import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../db/index.ts";
import type { WaConfig } from "../config.ts";
import { WA_CONFIG } from "../config.ts";
import { openWaDb } from "../db.ts";
import { recordAction } from "../gate.ts";
import { upsertContact } from "../ingestion.ts";
import { saveContactsCore, type ContactPushSocket } from "../contacts.ts";

const MIDDAY = new Date("2026-08-19T15:00:00Z"); // 12:00 SP — outside quiet hours

function openConfig(): WaConfig {
  return {
    quiet_hours: { enabled: false, start: "21:00", end: "08:00", timezone: "America/Sao_Paulo" },
    rate_limit: { max_per_minute: 1000, max_per_hour: 1000, min_interval_seconds: 0, jitter_seconds: 0 },
    validation: { max_batch_size: 20 },
  };
}

function seedCore(): Database {
  const db = openDb(":memory:");
  db.query(
    `INSERT INTO searches (query_normalized, niche, city, gl, hl, created_at) VALUES ('x','n','c','br','pt-br',?)`,
  ).run(new Date().toISOString());
  return db;
}

function seedLead(db: Database, name: string, jid: string): void {
  db.query(
    `INSERT INTO leads (search_id, place_id, name, phone, is_whatsapp, whatsapp_jid, source, collected_at)
     VALUES (1, ?, ?, '11999990000', 1, ?, 'serper:places', ?)`,
  ).run(`p-${name}`, name, jid, new Date().toISOString());
}

function spySocket(): { sock: ContactPushSocket; calls: Array<{ jid: string; contact: any }> } {
  const calls: Array<{ jid: string; contact: any }> = [];
  return {
    calls,
    sock: {
      addOrEditContact: async (jid, contact) => {
        calls.push({ jid, contact });
      },
    },
  };
}

const noSleep = { sleep: async () => {}, now: () => MIDDAY, random: () => 0 };

describe("saveContactsCore", () => {
  test("already-saved jid is skipped WITHOUT calling addOrEditContact", async () => {
    const waDb = openWaDb(":memory:");
    const coreDb = seedCore();
    upsertContact(waDb, "inst", { id: "55A@s.whatsapp.net", name: "Já Salvo" }); // display_name set
    const { sock, calls } = spySocket();

    const report = await saveContactsCore(["55A@s.whatsapp.net"], {
      waDb,
      coreDb,
      instanceId: "inst",
      sock,
      config: openConfig(),
      ...noSleep,
    });
    expect(calls).toHaveLength(0);
    expect(report).toMatchObject({ saved: 0, skipped: 1, failed: 0 });
    expect(report.results[0]).toEqual({ jid: "55A@s.whatsapp.net", status: "skipped_already_saved", name: "Já Salvo" });
  });

  test("non-saved jid is saved via the gate and marks display_name; lead name wins", async () => {
    const waDb = openWaDb(":memory:");
    const coreDb = seedCore();
    seedLead(coreDb, "Lead Bravo", "55B@s.whatsapp.net");
    const { sock, calls } = spySocket();

    const report = await saveContactsCore(["55B@s.whatsapp.net"], {
      waDb,
      coreDb,
      instanceId: "inst",
      sock,
      config: openConfig(),
      ...noSleep,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.contact).toMatchObject({ fullName: "Lead Bravo", firstName: "Lead", saveOnPrimaryAddressbook: true });
    expect(report.results[0]).toMatchObject({ jid: "55B@s.whatsapp.net", status: "saved", name: "Lead Bravo" });
    // display_name written → now "saved"
    const row = waDb.query("SELECT display_name FROM contacts WHERE jid = ?").get("55B@s.whatsapp.net") as {
      display_name: string;
    };
    expect(row.display_name).toBe("Lead Bravo");
    // action recorded on the anti-ban budget
    const actions = waDb.query("SELECT count(*) c FROM wa_actions WHERE kind = 'contact_save'").get() as { c: number };
    expect(actions.c).toBe(1);
  });

  test("name falls back to notify_name, then to the number", async () => {
    const waDb = openWaDb(":memory:");
    const coreDb = seedCore();
    upsertContact(waDb, "inst", { id: "55C@s.whatsapp.net", notify: "Push Charlie" }); // notify only, not saved
    const { sock } = spySocket();

    const report = await saveContactsCore(["55C@s.whatsapp.net", "55D@s.whatsapp.net"], {
      waDb,
      coreDb,
      instanceId: "inst",
      sock,
      config: openConfig(),
      ...noSleep,
    });
    const byJid = Object.fromEntries(report.results.map((r) => [r.jid, r]));
    expect(byJid["55C@s.whatsapp.net"]!.name).toBe("Push Charlie");
    expect(byJid["55D@s.whatsapp.net"]!.name).toBe("55D"); // unknown → number
  });

  test("bulk: mix of saved + new, each with its own status", async () => {
    const waDb = openWaDb(":memory:");
    const coreDb = seedCore();
    upsertContact(waDb, "inst", { id: "55A@s.whatsapp.net", name: "Já Salvo" });
    const { sock, calls } = spySocket();

    const report = await saveContactsCore(["55A@s.whatsapp.net", "55B@s.whatsapp.net"], {
      waDb,
      coreDb,
      instanceId: "inst",
      sock,
      config: openConfig(),
      ...noSleep,
    });
    expect(report).toMatchObject({ saved: 1, skipped: 1, failed: 0 });
    expect(calls.map((c) => c.jid)).toEqual(["55B@s.whatsapp.net"]); // only the new one touched Baileys
  });

  test("no connected socket → non-saved jids fail", async () => {
    const waDb = openWaDb(":memory:");
    const coreDb = seedCore();
    const report = await saveContactsCore(["55X@s.whatsapp.net"], {
      waDb,
      coreDb,
      instanceId: "inst",
      sock: undefined,
      config: openConfig(),
      ...noSleep,
    });
    expect(report.results[0]).toMatchObject({ status: "failed", reason: "instância não conectada" });
  });

  test("gate block → failed with gate reason, addOrEditContact NOT called", async () => {
    const waDb = openWaDb(":memory:");
    const coreDb = seedCore();
    // saturate the per-minute window of the real config (max_per_minute = 2)
    recordAction(waDb, "contact_save", "a", new Date(MIDDAY.getTime() - 10_000));
    recordAction(waDb, "contact_save", "b", new Date(MIDDAY.getTime() - 5_000));
    const { sock, calls } = spySocket();

    const report = await saveContactsCore(["55Y@s.whatsapp.net"], {
      waDb,
      coreDb,
      instanceId: "inst",
      sock,
      config: WA_CONFIG,
      sleep: async () => {},
      now: () => MIDDAY,
      random: () => 0,
    });
    expect(calls).toHaveLength(0);
    expect(report.results[0]!.status).toBe("failed");
    expect(report.results[0]!.reason).toContain("rate limit");
  });
});
