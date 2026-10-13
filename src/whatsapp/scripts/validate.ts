// CLI for batch WhatsApp validation.
//
// Usage:
//   bun run wa:validate --search 1              # pending leads of a search
//   bun run wa:validate --leads 12,13,14        # explicit lead ids
//   bun run wa:validate --search 1 --limit 10   # smaller batch
//
// Small, spaced batches by design (anti-ban). The gate stops the run inside
// quiet hours (21h–08h America/Sao_Paulo) or past the rate limits; re-run
// later to continue — validated leads are never re-queried (is_whatsapp set).
import { parseArgs } from "node:util";
import { openDb } from "../../db/index.ts";
import { WA_CONFIG } from "../config.ts";
import { connectAndWaitOpen, NotPairedError } from "../connection.ts";
import { CORE_DB_PATH, openWaDb } from "../db.ts";
import { validateLeadsCore } from "../validate.ts";

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    search: { type: "string" },
    leads: { type: "string" },
    limit: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (flags.help || (!flags.search && !flags.leads)) {
  console.log(
    [
      "wa:validate — valida em lote se os leads têm WhatsApp (gateado, anti-ban)",
      "",
      "  --search <id>    Valida os leads pendentes (is_whatsapp IS NULL) da pesquisa",
      "  --leads 1,2,3    Valida ids específicos",
      `  --limit <n>      Tamanho do lote (default ${WA_CONFIG.validation.max_batch_size})`,
      "",
      "Requer número dedicado pareado (bun run wa:pair).",
    ].join("\n"),
  );
  process.exit(flags.help ? 0 : 2);
}

const limit = Math.max(1, Number(flags.limit) || WA_CONFIG.validation.max_batch_size);
const coreDb = openDb(CORE_DB_PATH);

let leadIds: number[];
if (flags.leads) {
  leadIds = flags.leads
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, limit);
} else {
  const rows = coreDb
    .query(
      `SELECT id FROM leads
       WHERE search_id = ? AND phone IS NOT NULL AND is_whatsapp IS NULL
       ORDER BY id LIMIT ?`,
    )
    .all(Number(flags.search), limit) as { id: number }[];
  leadIds = rows.map((r) => r.id);
}

if (leadIds.length === 0) {
  console.log("Nenhum lead pendente de validação para esse critério.");
  coreDb.close();
  process.exit(0);
}

console.log(`Validando ${leadIds.length} lead(s) — lotes pequenos, com jitter entre consultas...`);

const waDb = openWaDb();
try {
  const { handle, sock, meJid } = await connectAndWaitOpen(waDb);
  console.log(`Conectado como ${meJid}.`);
  try {
    const report = await validateLeadsCore(leadIds, {
      sock,
      coreDb,
      waDb,
      log: (message) => console.log(`  ${message}`),
    });
    console.log("");
    console.log(
      `Resultado: ${report.validated} validado(s), ${report.ambiguous} ambíguo(s) (decisão humana), ` +
        `${report.skipped} pulado(s), ${report.failed} falha(s) de consulta.`,
    );
    if (report.stopped_reason) {
      console.log(`Lote interrompido pelo gate: ${report.stopped_reason}`);
      console.log("Rode novamente mais tarde para continuar de onde parou.");
    }
  } finally {
    handle.close();
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
