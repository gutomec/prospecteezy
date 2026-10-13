import { describe, expect, test } from "bun:test";
import { openDb } from "../../db/index.ts";
import { WA_CONFIG } from "../config.ts";
import { openWaDb } from "../db.ts";
import { setActiveInstance } from "../instances.ts";
import { WaManager } from "../manager.ts";
import { createWaRouter } from "../routes.ts";
import { sendTextToLead } from "../send-to-lead.ts";
import { makeFakeConnect } from "./_fakes.ts";

const JID = "5581999990000@s.whatsapp.net";
// 15:00 and 23:00 in America/Sao_Paulo (UTC-3): outside / inside quiet hours.
const DAY = new Date("2026-10-12T18:00:00Z");
const NIGHT = new Date("2026-10-13T02:00:00Z");

async function harness(options: { connect?: boolean; validated?: boolean } = {}) {
  const waDb = openWaDb(":memory:");
  const coreDb = openDb(":memory:");
  const fake = makeFakeConnect();
  const manager = new WaManager({ db: waDb, config: WA_CONFIG, connect: fake.connect });
  const router = createWaRouter({ waDb, coreDb, config: WA_CONFIG, manager });
  coreDb
    .query(
      `INSERT INTO searches (query_normalized, niche, city, gl, hl, created_at)
       VALUES ('x', 'padarias', 'Recife', 'br', 'pt-br', ?)`,
    )
    .run(new Date().toISOString());
  const validated = options.validated ?? true;
  coreDb
    .query(
      `INSERT INTO leads (search_id, place_id, name, phone, is_whatsapp, whatsapp_jid, source, collected_at)
       VALUES (1, 'p1', 'Padaria', '+55 81 99999-0000', ?, ?, 'serper:places', ?)`,
    )
    .run(validated ? 1 : null, validated ? JID : null, new Date().toISOString());
  let instance: string | null = null;
  if (options.connect ?? true) {
    const req = new Request("http://localhost/api/wa/instances", { method: "POST" });
    instance = ((await (await router.handle(req, new URL(req.url))).json()) as { id: string }).id;
    fake.cb(instance).onOpen!("5511@s.whatsapp.net");
    setActiveInstance(waDb, instance);
  }
  return { waDb, coreDb, manager, fake, instance };
}

describe("sendTextToLead (AI send path)", () => {
  test("sends through the gated manager path to the validated jid", async () => {
    const h = await harness();
    const result = await sendTextToLead({ ...h, now: () => DAY }, 1, "Olá!");
    expect(result).toEqual({ ok: true, jid: JID, instance: h.instance! });
    expect(h.fake.sock(h.instance!).sentMessages).toEqual([{ jid: JID, text: "Olá!" }]);
  });

  test("refuses leads not validated as WhatsApp and unknown leads", async () => {
    const h = await harness({ validated: false });
    expect(await sendTextToLead({ ...h, now: () => DAY }, 1, "Olá!")).toMatchObject({ ok: false, code: "not_whatsapp" });
    expect(await sendTextToLead({ ...h, now: () => DAY }, 99, "Olá!")).toMatchObject({ ok: false, code: "lead_not_found" });
  });

  test("refuses without an active instance", async () => {
    const h = await harness({ connect: false });
    expect(await sendTextToLead({ ...h, now: () => DAY }, 1, "Olá!")).toMatchObject({ ok: false, code: "no_instance" });
  });

  test("cold message respects quiet hours; a reply waives them (same rule as /api/wa/send)", async () => {
    const h = await harness();
    const cold = await sendTextToLead({ ...h, now: () => NIGHT }, 1, "Boa noite");
    expect(cold).toMatchObject({ ok: false, code: "blocked" });
    expect(cold.ok ? "" : cold.reason).toContain("quiet hours");
    h.waDb
      .query(
        `INSERT INTO messages (instance_id, chat_jid, message_id, from_me, timestamp, message_type, text_content, source, created_at)
         VALUES (?, ?, 'in-1', 0, 1, 'conversation', 'oi', 'live', 'now')`,
      )
      .run(h.instance!, JID);
    expect(await sendTextToLead({ ...h, now: () => NIGHT }, 1, "Boa noite")).toMatchObject({ ok: true });
  });
});
