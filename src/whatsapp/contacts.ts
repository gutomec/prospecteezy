// Validated leads become WhatsApp-addressable contacts. Two paths, both
// ported from the agentic-whatsapp-nirvana squad:
//
// (a) DEFAULT — CRM graph registry (squad lib/crm.ts pattern, local-only):
//     the lead is upserted as an entity with its canonical contact_jid in
//     data/whatsapp.db. A JID is directly messageable on WhatsApp — no
//     address-book write, zero server interaction, zero ban surface. This is
//     the safe default; the squad itself does not gate local CRM upserts.
//
// (b) OPT-IN (--push) — Baileys addOrEditContact(jid, {...}): writes the
//     contact into the account's in-app address book (app-state sync). This
//     TOUCHES the account, so every push passes the anti-ban gate (quiet
//     hours, rate limits) and is jitter-spaced, like any other account action.
import type { Database } from "bun:sqlite";
import { openDb } from "../db/index.ts";
import { addLeadEvent, getLead, type LeadRow } from "../db/repository.ts";
import { WA_CONFIG, type WaConfig } from "./config.ts";
import { CORE_DB_PATH, nowIso, openWaDb } from "./db.ts";
import { evaluateActionGate, jitterMs, recordAction } from "./gate.ts";

/** Minimal socket surface for the push path (fake in tests). */
export interface ContactPushSocket {
  addOrEditContact: (
    jid: string,
    contact: { fullName?: string | null; firstName?: string | null; saveOnPrimaryAddressbook?: boolean | null },
  ) => Promise<void>;
}

export interface ContactRegistrationDetail {
  lead_id: number;
  status: "registered" | "already_registered" | "pushed" | "skipped";
  jid?: string;
  reason?: string;
}

export interface ContactReport {
  registered: number; // new CRM registry entries
  already_registered: number;
  pushed: number; // address-book writes (push path)
  skipped: number; // not validated / no jid
  stopped_reason: string | null; // gate stop during the push path
  details: ContactRegistrationDetail[];
}

export interface ContactDeps {
  coreDb: Database;
  waDb: Database;
  config?: WaConfig;
  push?: boolean;
  sock?: ContactPushSocket; // required when push=true
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
  log?: (message: string) => void;
}

/** Squad crm.ts slug, suffixed with the lead id (lead names collide). */
export function contactSlug(name: string, leadId: number): string {
  const base =
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "lead";
  return `${base}-${leadId}`;
}

interface WaEntityRow {
  id: number;
  attributes: string;
}

function upsertLeadEntity(
  waDb: Database,
  lead: LeadRow,
  jid: string,
): { created: boolean; row: WaEntityRow } {
  const existing = waDb
    .query("SELECT id, attributes FROM wa_entities WHERE lead_id = ?")
    .get(lead.id) as WaEntityRow | null;
  const attributes = {
    phone: lead.phone,
    category: lead.category,
    address: lead.address,
    website: lead.website,
    email: lead.email,
  };
  if (existing) {
    const merged = { ...JSON.parse(existing.attributes || "{}"), ...attributes };
    waDb
      .query(
        "UPDATE wa_entities SET name = ?, contact_jid = ?, attributes = ?, updated_at = ? WHERE id = ?",
      )
      .run(lead.name, jid, JSON.stringify(merged), nowIso(), existing.id);
    return { created: false, row: { id: existing.id, attributes: JSON.stringify(merged) } };
  }
  const res = waDb
    .query(
      `INSERT INTO wa_entities (entity_type, name, slug, contact_jid, lead_id, attributes, source, created_at, updated_at)
       VALUES ('lead', ?, ?, ?, ?, ?, 'prospecteezy:lead', ?, ?)`,
    )
    .run(
      lead.name,
      contactSlug(lead.name, lead.id),
      jid,
      lead.id,
      JSON.stringify(attributes),
      nowIso(),
      nowIso(),
    );
  return {
    created: true,
    row: { id: Number(res.lastInsertRowid), attributes: JSON.stringify(attributes) },
  };
}

function markPushed(waDb: Database, entityId: number, attributesJson: string): void {
  const attrs = { ...JSON.parse(attributesJson || "{}"), pushed_at: nowIso() };
  waDb
    .query("UPDATE wa_entities SET attributes = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(attrs), nowIso(), entityId);
}

export async function registerLeadContactsCore(
  leadIds: number[],
  deps: ContactDeps,
): Promise<ContactReport> {
  const config = deps.config ?? WA_CONFIG;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const log = deps.log ?? (() => {});
  if (deps.push && !deps.sock) {
    throw new Error("push=true exige um socket conectado (sessão pareada).");
  }

  const report: ContactReport = {
    registered: 0,
    already_registered: 0,
    pushed: 0,
    skipped: 0,
    stopped_reason: null,
    details: [],
  };

  let performedPush = false;
  for (const leadId of leadIds) {
    const lead = getLead(deps.coreDb, leadId);
    if (!lead || lead.is_whatsapp !== 1 || !lead.whatsapp_jid) {
      report.skipped++;
      report.details.push({
        lead_id: leadId,
        status: "skipped",
        reason: !lead
          ? "lead não encontrado"
          : "lead sem validação de WhatsApp (rode wa:validate antes)",
      });
      continue;
    }
    const jid = lead.whatsapp_jid;

    // (a) CRM registry — local, idempotent, ungated by design (no server I/O).
    const { created, row } = upsertLeadEntity(deps.waDb, lead, jid);
    if (created) {
      addLeadEvent(deps.coreDb, leadId, "whatsapp_contact_added", { via: "crm", jid });
      report.registered++;
      report.details.push({ lead_id: leadId, status: "registered", jid });
      log(`Lead ${leadId} (${lead.name}): registrado como contato CRM → ${jid}`);
    } else {
      report.already_registered++;
      report.details.push({ lead_id: leadId, status: "already_registered", jid });
    }

    // (b) Push to the in-app address book — account-touching, fully gated.
    if (deps.push && deps.sock) {
      const attrs = JSON.parse(row.attributes || "{}") as { pushed_at?: string };
      if (attrs.pushed_at) continue; // already in the address book

      const gate = evaluateActionGate(deps.waDb, config, now());
      if (!gate.allowed) {
        report.stopped_reason = gate.blocked_reason;
        log(`Gate bloqueou o push (${gate.blocked_code}): ${gate.blocked_reason}`);
        break;
      }
      if (performedPush) {
        await sleep(jitterMs(config, random));
      }
      recordAction(deps.waDb, "contact_push", jid, now());
      performedPush = true;
      await deps.sock.addOrEditContact(jid, {
        fullName: lead.name,
        firstName: lead.name.split(/\s+/)[0] ?? lead.name,
        saveOnPrimaryAddressbook: true,
      });
      markPushed(deps.waDb, row.id, row.attributes);
      addLeadEvent(deps.coreDb, leadId, "whatsapp_contact_added", { via: "addressbook", jid });
      report.pushed++;
      report.details.push({ lead_id: leadId, status: "pushed", jid });
      log(`Lead ${leadId} (${lead.name}): salvo na agenda in-app → ${jid}`);
    }
  }

  return report;
}

/**
 * Public entry point. Default (push=false) is fully local — no socket, no
 * network, safe to run any time. With push=true it connects the paired
 * session and writes into the in-app address book behind the gate.
 */
export async function registerLeadContacts(
  leadIds: number[],
  opts: { push?: boolean } = {},
): Promise<ContactReport> {
  const coreDb = openDb(CORE_DB_PATH);
  const waDb = openWaDb();
  if (!opts.push) {
    try {
      return await registerLeadContactsCore(leadIds, { coreDb, waDb });
    } finally {
      coreDb.close();
      waDb.close();
    }
  }
  const { connectAndWaitOpen } = await import("./connection.ts");
  const { handle, sock } = await connectAndWaitOpen(waDb);
  try {
    return await registerLeadContactsCore(leadIds, {
      coreDb,
      waDb,
      push: true,
      sock: sock as unknown as ContactPushSocket,
    });
  } finally {
    handle.close();
    coreDb.close();
    waDb.close();
  }
}

// ---------------------------------------------------------------------------
// Save contacts to the phone's address book (wa-quality-backend). Individual
// (1 jid) and bulk (N jids) go through the SAME endpoint. Already-saved jids
// are skipped WITHOUT touching Baileys; the rest are written via
// addOrEditContact behind the anti-ban gate. No message is ever sent here.
// ---------------------------------------------------------------------------

export type SaveContactStatus = "saved" | "skipped_already_saved" | "failed";

export interface SaveContactResult {
  jid: string;
  status: SaveContactStatus;
  name?: string;
  reason?: string;
}

export interface SaveContactsReport {
  results: SaveContactResult[];
  saved: number;
  skipped: number;
  failed: number;
}

export interface SaveContactsDeps {
  waDb: Database;
  coreDb: Database;
  instanceId: string;
  /** Live socket of the instance; absent ⇒ not connected ⇒ non-saved jids fail. */
  sock?: ContactPushSocket;
  config?: WaConfig;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
}

/** Address-book name for a jid: '@s.whatsapp.net' → the number; else the id part. */
function numberFromJid(jid: string): string {
  return jid.split("@")[0] ?? jid;
}

/** The saved-in-address-book signal is display_name IS NOT NULL. */
function savedDisplayName(waDb: Database, instanceId: string, jid: string): string | null {
  const row = waDb
    .query("SELECT display_name FROM contacts WHERE instance_id = ? AND jid = ?")
    .get(instanceId, jid) as { display_name: string | null } | null;
  return row?.display_name ?? null;
}

/**
 * Name to save for a jid: the prospecteezy lead name when the jid matches a
 * lead's whatsapp_jid; else the contact's notify_name (pushName); else the
 * plain number. Documented in the phase _SUMMARY.
 */
function resolveContactName(waDb: Database, coreDb: Database, instanceId: string, jid: string): string {
  const lead = coreDb.query("SELECT name FROM leads WHERE whatsapp_jid = ? LIMIT 1").get(jid) as
    | { name: string }
    | null;
  if (lead?.name) return lead.name;
  const contact = waDb
    .query("SELECT notify_name FROM contacts WHERE instance_id = ? AND jid = ?")
    .get(instanceId, jid) as { notify_name: string | null } | null;
  if (contact?.notify_name) return contact.notify_name;
  return numberFromJid(jid);
}

function markContactSaved(waDb: Database, instanceId: string, jid: string, name: string): void {
  const phone = jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0]! : null;
  const at = nowIso();
  waDb
    .query(
      `INSERT INTO contacts (instance_id, jid, phone_number, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (instance_id, jid) DO UPDATE SET
         display_name = excluded.display_name, updated_at = excluded.updated_at`,
    )
    .run(instanceId, jid, phone, name, at, at);
}

export async function saveContactsCore(jids: string[], deps: SaveContactsDeps): Promise<SaveContactsReport> {
  const config = deps.config ?? WA_CONFIG;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;

  const report: SaveContactsReport = { results: [], saved: 0, skipped: 0, failed: 0 };
  let performed = false;
  let gateStopped: string | null = null;

  for (const jid of jids) {
    const existing = savedDisplayName(deps.waDb, deps.instanceId, jid);
    if (existing != null) {
      report.results.push({ jid, status: "skipped_already_saved", name: existing });
      report.skipped++;
      continue;
    }
    const name = resolveContactName(deps.waDb, deps.coreDb, deps.instanceId, jid);
    if (!deps.sock) {
      report.results.push({ jid, status: "failed", name, reason: "instância não conectada" });
      report.failed++;
      continue;
    }
    if (gateStopped) {
      report.results.push({ jid, status: "failed", name, reason: gateStopped });
      report.failed++;
      continue;
    }
    const gate = evaluateActionGate(deps.waDb, config, now());
    if (!gate.allowed) {
      gateStopped = gate.blocked_reason ?? "gate bloqueou o salvamento";
      report.results.push({ jid, status: "failed", name, reason: gateStopped });
      report.failed++;
      continue;
    }
    if (performed) await sleep(jitterMs(config, random));
    try {
      recordAction(deps.waDb, "contact_save", jid, now());
      performed = true;
      await deps.sock.addOrEditContact(jid, {
        fullName: name,
        firstName: name.split(/\s+/)[0] ?? name,
        saveOnPrimaryAddressbook: true,
      });
      markContactSaved(deps.waDb, deps.instanceId, jid, name);
      report.results.push({ jid, status: "saved", name });
      report.saved++;
    } catch (error) {
      report.results.push({
        jid,
        status: "failed",
        name,
        reason: error instanceof Error ? error.message : String(error),
      });
      report.failed++;
    }
  }
  return report;
}
