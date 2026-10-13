import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../db/index.ts";
import type { WaConfig } from "../config.ts";
import { registerLeadContactsCore, type ContactPushSocket } from "../contacts.ts";
import { openWaDb } from "../db.ts";

const MIDDAY_SP = new Date("2026-08-19T15:00:00Z"); // 12:00 America/Sao_Paulo
const QUIET_SP = new Date("2026-08-19T01:00:00Z"); // 22:00 America/Sao_Paulo

const config: WaConfig = {
  quiet_hours: { enabled: true, start: "21:00", end: "08:00", timezone: "America/Sao_Paulo" },
  rate_limit: { max_per_minute: 1000, max_per_hour: 1000, min_interval_seconds: 0, jitter_seconds: 0 },
  validation: { max_batch_size: 20 },
};

function seedCoreDb(): Database {
  const db = openDb(":memory:");
  db.query(
    `INSERT INTO searches (query_normalized, niche, city, gl, hl, created_at)
     VALUES ('teste', 'teste', 'Teste', 'br', 'pt-br', ?)`,
  ).run(new Date().toISOString());
  return db;
}

function seedValidatedLead(db: Database, name: string, jid: string): number {
  const res = db
    .query(
      `INSERT INTO leads (search_id, place_id, name, phone, is_whatsapp, whatsapp_jid, source, collected_at)
       VALUES (1, ?, ?, '+55 11 99999-9999', 1, ?, 'serper:places', ?)`,
    )
    .run(`place-${name}`, name, jid, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

function seedUnvalidatedLead(db: Database, name: string): number {
  const res = db
    .query(
      `INSERT INTO leads (search_id, place_id, name, source, collected_at)
       VALUES (1, ?, ?, 'serper:places', ?)`,
    )
    .run(`place-${name}`, name, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

describe("registerLeadContactsCore — CRM registry (default, local)", () => {
  test("validated lead becomes a CRM entity; unvalidated is skipped; idempotent", async () => {
    const coreDb = seedCoreDb();
    const waDb = openWaDb(":memory:");
    const ok = seedValidatedLead(coreDb, "Escritório Válido", "5511987654321@s.whatsapp.net");
    const pending = seedUnvalidatedLead(coreDb, "Escritório Pendente");

    const report = await registerLeadContactsCore([ok, pending], { coreDb, waDb, config });
    expect(report.registered).toBe(1);
    expect(report.skipped).toBe(1);

    const entity = waDb
      .query("SELECT entity_type, name, contact_jid, lead_id FROM wa_entities WHERE lead_id = ?")
      .get(ok) as { entity_type: string; name: string; contact_jid: string; lead_id: number };
    expect(entity.entity_type).toBe("lead");
    expect(entity.contact_jid).toBe("5511987654321@s.whatsapp.net");

    const event = coreDb
      .query("SELECT event, payload_json FROM lead_events WHERE lead_id = ? AND event = 'whatsapp_contact_added'")
      .get(ok) as { event: string; payload_json: string };
    expect(JSON.parse(event.payload_json).via).toBe("crm");

    // Second run: idempotent, no duplicate entity, no duplicate event.
    const again = await registerLeadContactsCore([ok], { coreDb, waDb, config });
    expect(again.registered).toBe(0);
    expect(again.already_registered).toBe(1);
    const count = waDb.query("SELECT count(*) AS c FROM wa_entities").get() as { c: number };
    expect(count.c).toBe(1);
  });
});

describe("registerLeadContactsCore — push path (addOrEditContact, gated)", () => {
  test("pushes with the lead name, marks pushed_at, never re-pushes", async () => {
    const coreDb = seedCoreDb();
    const waDb = openWaDb(":memory:");
    const id = seedValidatedLead(coreDb, "Silva & Associados", "5511987654321@s.whatsapp.net");

    const pushes: { jid: string; contact: Record<string, unknown> }[] = [];
    const sock: ContactPushSocket = {
      addOrEditContact: async (jid, contact) => {
        pushes.push({ jid, contact });
      },
    };

    const report = await registerLeadContactsCore([id], {
      coreDb,
      waDb,
      config,
      push: true,
      sock,
      now: () => MIDDAY_SP,
      sleep: async () => {},
    });
    expect(report.pushed).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.jid).toBe("5511987654321@s.whatsapp.net");
    expect(pushes[0]!.contact.fullName).toBe("Silva & Associados");
    expect(pushes[0]!.contact.saveOnPrimaryAddressbook).toBe(true);

    const entity = waDb.query("SELECT attributes FROM wa_entities WHERE lead_id = ?").get(id) as {
      attributes: string;
    };
    expect(JSON.parse(entity.attributes).pushed_at).toBeTruthy();

    // Second run with push: already in the address book, no new call.
    const again = await registerLeadContactsCore([id], {
      coreDb,
      waDb,
      config,
      push: true,
      sock,
      now: () => MIDDAY_SP,
      sleep: async () => {},
    });
    expect(again.pushed).toBe(0);
    expect(pushes).toHaveLength(1);
  });

  test("quiet hours block the push (CRM registry still succeeds)", async () => {
    const coreDb = seedCoreDb();
    const waDb = openWaDb(":memory:");
    const id = seedValidatedLead(coreDb, "Escritório Noturno", "5511987654321@s.whatsapp.net");

    let pushCount = 0;
    const sock: ContactPushSocket = {
      addOrEditContact: async () => {
        pushCount++;
      },
    };

    const report = await registerLeadContactsCore([id], {
      coreDb,
      waDb,
      config,
      push: true,
      sock,
      now: () => QUIET_SP,
      sleep: async () => {},
    });
    expect(pushCount).toBe(0);
    expect(report.registered).toBe(1); // local registry is safe at any hour
    expect(report.pushed).toBe(0);
    expect(report.stopped_reason).toContain("quiet hours");
  });
});
