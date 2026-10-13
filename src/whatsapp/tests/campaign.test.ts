import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../db/index.ts";
import { getLead } from "../../db/repository.ts";
import type { WaConfig } from "../config.ts";
import { openWaDb } from "../db.ts";
import {
  campaignPayload,
  WaManager,
  type CampaignMedia,
  type SendResult,
  type WaEvent,
} from "../manager.ts";
import { createInstance } from "../instances.ts";
import { formatSse, parseSseStream } from "../routes.ts";
import { createCampaign, getCampaign, renderTemplate, runCampaign, type CampaignRunnerDeps } from "../campaign.ts";
import { makeFakeConnect } from "./_fakes.ts";

const AT = () => new Date("2026-08-19T15:00:00Z"); // midday SP — outside quiet hours

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

function seedLead(
  db: Database,
  o: { name: string; phone?: string | null; category?: string | null; email?: string | null; is_whatsapp?: number | null; jid?: string | null },
): number {
  const res = db
    .query(
      `INSERT INTO leads (search_id, place_id, name, category, phone, email, is_whatsapp, whatsapp_jid, source, collected_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'serper:places', ?)`,
    )
    .run(
      `p-${o.name}-${Math.random()}`,
      o.name,
      o.category ?? null,
      o.phone ?? null,
      o.email ?? null,
      o.is_whatsapp ?? null,
      o.jid ?? null,
      new Date().toISOString(),
    );
  return Number(res.lastInsertRowid);
}

interface RunHarness {
  deps: CampaignRunnerDeps;
  sent: Array<{ jid: string; content: { text: string; media?: CampaignMedia } }>;
  events: WaEvent[];
  sleeps: number[];
}

function makeDeps(waDb: Database, coreDb: Database, overrides: Partial<CampaignRunnerDeps> = {}): RunHarness {
  const sent: RunHarness["sent"] = [];
  const events: WaEvent[] = [];
  const sleeps: number[] = [];
  const deps: CampaignRunnerDeps = {
    waDb,
    coreDb,
    config: openConfig(),
    send: async (jid, content) => {
      sent.push({ jid, content });
      return {
        ok: true,
        gate: { allowed: true, blocked_code: null, blocked_reason: null },
        message: { chat_jid: jid, message_id: `m${sent.length}`, from_me: true, text: content.text, type: "conversation", ts: 1, status: "sent" },
      } satisfies SendResult;
    },
    validatePending: async () => {},
    loadMedia: async () => null,
    publish: (e) => events.push(e),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: AT,
    random: () => 0,
    ...overrides,
  };
  return { deps, sent, events, sleeps };
}

describe("renderTemplate (per-row placeholder substitution)", () => {
  test("substitutes known columns, case-insensitive and whitespace-tolerant", () => {
    const core = seedCore();
    const id = seedLead(core, { name: "Ana", category: "clínica", email: "a@x.com" });
    const lead = getLead(core, id)!;
    expect(renderTemplate("Oi {{name}}, tudo? ({{ Category }}) {{EMAIL}}", lead)).toBe("Oi Ana, tudo? (clínica) a@x.com");
  });
  test("missing value → empty string; unsupported placeholder → empty string", () => {
    const core = seedCore();
    const id = seedLead(core, { name: "Bia" }); // no email/category
    const lead = getLead(core, id)!;
    expect(renderTemplate("{{name}}|{{email}}|{{foo}}", lead)).toBe("Bia||");
  });
});

describe("campaignPayload (media → caption)", () => {
  test("plain text has no media", () => {
    expect(campaignPayload("oi", undefined)).toEqual({ text: "oi" });
  });
  test("image carries the substituted text as caption", () => {
    const media: CampaignMedia = { kind: "image", mime: "image/png", filename: "x.png", data: new Uint8Array([1, 2]) };
    expect(campaignPayload("Olá Ana", media)).toEqual({ image: media.data, caption: "Olá Ana" });
  });
  test("document carries mimetype + fileName + caption", () => {
    const media: CampaignMedia = { kind: "document", mime: "application/pdf", filename: "f.pdf", data: new Uint8Array([1]) };
    expect(campaignPayload("cap", media)).toEqual({
      document: media.data,
      mimetype: "application/pdf",
      fileName: "f.pdf",
      caption: "cap",
    });
  });
});

describe("runCampaign", () => {
  test("only-whatsapp: sends to is_whatsapp=1, skips non-WA and empty message", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const yes = seedLead(coreDb, { name: "Ana", is_whatsapp: 1, jid: "5511@s.whatsapp.net" });
    const no = seedLead(coreDb, { name: "Bia", is_whatsapp: 0 });
    const empty = seedLead(coreDb, { name: "", is_whatsapp: 1, jid: "5599@s.whatsapp.net" });
    const job = createCampaign(waDb, coreDb, {
      instanceId: "waalpha",
      template: "{{name}}",
      mediaId: null,
      leadIds: [yes, no, empty],
    });
    const { deps, sent } = makeDeps(waDb, coreDb);
    await runCampaign(job, deps);

    expect(sent.map((s) => s.jid)).toEqual(["5511@s.whatsapp.net"]);
    const view = getCampaign(waDb, job)!;
    expect(view.status).toBe("done");
    expect(view).toMatchObject({ sent: 1, skipped: 2, failed: 0, total: 3 });
    const byLead = Object.fromEntries(view.recipients.map((r) => [r.lead_id, r]));
    expect(byLead[no]!.reason).toBe("not_whatsapp");
    expect(byLead[empty]!.reason).toBe("empty_message");
  });

  test("with media, empty rendered text still sends (media only) and text-with-media is the caption", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const id = seedLead(coreDb, { name: "Ana", is_whatsapp: 1, jid: "5511@s.whatsapp.net" });
    const media: CampaignMedia = { kind: "image", mime: "image/png", filename: "x.png", data: new Uint8Array([9]) };
    const job = createCampaign(waDb, coreDb, {
      instanceId: "waalpha",
      template: "Promo p/ {{name}}",
      mediaId: "med1",
      leadIds: [id],
    });
    const { deps, sent } = makeDeps(waDb, coreDb, { loadMedia: async () => media });
    await runCampaign(job, deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content.text).toBe("Promo p/ Ana");
    expect(sent[0]!.content.media).toEqual(media);
  });

  test("pending leads are validated (gated) before sending", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const pend = seedLead(coreDb, { name: "Ana", phone: "11999990000", is_whatsapp: null });
    const job = createCampaign(waDb, coreDb, {
      instanceId: "waalpha",
      template: "oi {{name}}",
      mediaId: null,
      leadIds: [pend],
    });
    let validated: number[] = [];
    const { deps, sent } = makeDeps(waDb, coreDb, {
      validatePending: async (leadIds) => {
        validated = leadIds;
        coreDb.query("UPDATE leads SET is_whatsapp=1, whatsapp_jid='5511@s.whatsapp.net' WHERE id=?").run(pend);
      },
    });
    await runCampaign(job, deps);
    expect(validated).toEqual([pend]);
    expect(sent).toHaveLength(1); // validated → WhatsApp → sent
    expect(getCampaign(waDb, job)!.sent).toBe(1);
  });

  test("throttle: N recipients → N gated sends via the manager (each recorded), spaced", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const fake = makeFakeConnect();
    const manager = new WaManager({ db: waDb, config: openConfig(), connect: fake.connect });
    const inst = createInstance(waDb);
    manager.start(inst.id);
    fake.cb(inst.id).onOpen!("5511@s.whatsapp.net");

    const ids = [1, 2, 3].map((n) => seedLead(coreDb, { name: `L${n}`, is_whatsapp: 1, jid: `55${n}@s.whatsapp.net` }));
    const job = createCampaign(waDb, coreDb, { instanceId: inst.id, template: "oi {{name}}", mediaId: null, leadIds: ids });

    const sleeps: number[] = [];
    await runCampaign(job, {
      waDb,
      coreDb,
      config: openConfig(),
      send: (jid, content) => manager.sendCampaignMessage(inst.id, jid, content),
      validatePending: async () => {},
      loadMedia: async () => null,
      publish: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: AT,
      random: () => 0,
    });

    expect(fake.sock(inst.id).sentMessages).toHaveLength(3); // each reached the socket
    const actions = waDb.query("SELECT count(*) c FROM wa_actions WHERE kind='message_send'").get() as { c: number };
    expect(actions.c).toBe(3); // recorded only AFTER passing the gate
    expect(sleeps.length).toBe(2); // spacing between the 3 sends (N-1), not immediate
    expect(getCampaign(waDb, job)!.sent).toBe(3);
  });

  test("gate block pauses the campaign (queued, never forced)", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const a = seedLead(coreDb, { name: "A", is_whatsapp: 1, jid: "551@s.whatsapp.net" });
    const b = seedLead(coreDb, { name: "B", is_whatsapp: 1, jid: "552@s.whatsapp.net" });
    const job = createCampaign(waDb, coreDb, { instanceId: "waalpha", template: "oi {{name}}", mediaId: null, leadIds: [a, b] });
    const { deps, sent } = makeDeps(waDb, coreDb, {
      send: async () => ({ ok: false, gate: { allowed: false, blocked_code: "rate_limit", blocked_reason: "cheio" } }),
    });
    await runCampaign(job, deps);
    expect(sent).toHaveLength(0);
    const view = getCampaign(waDb, job)!;
    expect(view.status).toBe("paused");
    expect(view.recipients[0]!.status).toBe("queued");
    expect(view.recipients[0]!.reason).toBe("rate_limit");
  });

  test("campaign events serialize through the SSE bus", async () => {
    const coreDb = seedCore();
    const waDb = openWaDb(":memory:");
    const id = seedLead(coreDb, { name: "Ana", is_whatsapp: 1, jid: "5511@s.whatsapp.net" });
    const job = createCampaign(waDb, coreDb, { instanceId: "waalpha", template: "oi {{name}}", mediaId: null, leadIds: [id] });
    const frames: string[] = [];
    const { deps } = makeDeps(waDb, coreDb, { publish: (e) => frames.push(formatSse(e)) });
    await runCampaign(job, deps);
    const parsed = parseSseStream(frames.join("")).filter((p) => p.event === "campaign");
    expect(parsed.length).toBeGreaterThan(0);
    const last = parsed[parsed.length - 1]!;
    expect(last.data).toMatchObject({ job_id: job, status: "done", sent: 1 });
  });
});
