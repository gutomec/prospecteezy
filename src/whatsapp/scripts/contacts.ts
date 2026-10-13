// CLI: validated leads become WhatsApp contacts.
//
// Usage:
//   bun run wa:contacts --search 1          # CRM registry (default, local, seguro)
//   bun run wa:contacts --leads 12,13
//   bun run wa:contacts --search 1 --push   # também salva na agenda in-app (gateado)
//
// Default path is the squad CRM-graph registry: local, zero server
// interaction, the lead's canonical JID is directly messageable. --push
// additionally writes into the account's address book via Baileys
// addOrEditContact — account-touching, so it runs behind the anti-ban gate.
import { parseArgs } from "node:util";
import { openDb } from "../../db/index.ts";
import { registerLeadContactsCore, type ContactPushSocket } from "../contacts.ts";
import { connectAndWaitOpen, NotPairedError } from "../connection.ts";
import { CORE_DB_PATH, openWaDb } from "../db.ts";

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    search: { type: "string" },
    leads: { type: "string" },
    push: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (flags.help || (!flags.search && !flags.leads)) {
  console.log(
    [
      "wa:contacts — registra leads validados como contatos do WhatsApp",
      "",
      "  --search <id>    Todos os leads validados (is_whatsapp = 1) da pesquisa",
      "  --leads 1,2,3    Ids específicos",
      "  --push           Também salva na agenda in-app (addOrEditContact, gateado)",
      "",
      "Sem --push é 100% local (registro CRM) e pode rodar a qualquer hora.",
    ].join("\n"),
  );
  process.exit(flags.help ? 0 : 2);
}

const coreDb = openDb(CORE_DB_PATH);

let leadIds: number[];
if (flags.leads) {
  leadIds = flags.leads
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
} else {
  const rows = coreDb
    .query("SELECT id FROM leads WHERE search_id = ? AND is_whatsapp = 1 ORDER BY id")
    .all(Number(flags.search)) as { id: number }[];
  leadIds = rows.map((r) => r.id);
}

if (leadIds.length === 0) {
  console.log("Nenhum lead validado (is_whatsapp = 1) para esse critério. Rode wa:validate antes.");
  coreDb.close();
  process.exit(0);
}

const waDb = openWaDb();
try {
  let report;
  if (flags.push) {
    const { handle, sock, meJid } = await connectAndWaitOpen(waDb);
    console.log(`Conectado como ${meJid}. Registrando e salvando na agenda (gateado)...`);
    try {
      report = await registerLeadContactsCore(leadIds, {
        coreDb,
        waDb,
        push: true,
        sock: sock as unknown as ContactPushSocket,
        log: (message) => console.log(`  ${message}`),
      });
    } finally {
      handle.close();
    }
  } else {
    console.log(`Registrando ${leadIds.length} lead(s) como contatos CRM (local)...`);
    report = await registerLeadContactsCore(leadIds, {
      coreDb,
      waDb,
      log: (message) => console.log(`  ${message}`),
    });
  }
  console.log("");
  console.log(
    `Resultado: ${report.registered} registrado(s), ${report.already_registered} já registrado(s), ` +
      `${report.pushed} salvo(s) na agenda, ${report.skipped} pulado(s).`,
  );
  if (report.stopped_reason) {
    console.log(`Push interrompido pelo gate: ${report.stopped_reason}`);
    console.log("Rode novamente mais tarde para continuar.");
  }
} catch (err) {
  if (err instanceof NotPairedError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
} finally {
  coreDb.close();
  waDb.close();
}
process.exit(0);
