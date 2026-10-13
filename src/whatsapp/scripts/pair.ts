// Pairing script — ported from the agentic-whatsapp-nirvana squad's
// template/scripts/pair.ts (stream mode). Protocol rule preserved: the QR is
// bound to the ephemeral keys of the socket that produced it — the socket
// stays OPEN until it pairs or times out, and every rotation (~20-60s) is
// emitted the moment it happens. Never "capture the QR and close".
//
// Usage:
//   bun run wa:pair                      # QR in the terminal (default)
//   bun run wa:pair --method code --phone +5511999999999
//   bun run wa:pair --timeout 600
//   bun run wa:pair --force              # discard the saved session, pair again
//
// Pairing is a HUMAN action: this script only produces the QR / code; the
// confirmation happens on the dedicated phone (WhatsApp > Dispositivos
// conectados > Conectar dispositivo).
import { parseArgs } from "node:util";
import qrcode from "qrcode-terminal";
import { clearInstanceAuth, isPaired } from "../auth-state.ts";
import { createWaConnection, refreshWaWebVersion } from "../connection.ts";
import { nowIso, openWaDb, setState } from "../db.ts";

const QR_FIRST_TTL_S = 60; // first QR (Baileys socket)
const QR_NEXT_TTL_S = 20; // subsequent rotations
const CODE_READY_TIMEOUT_MS = 20_000;

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    method: { type: "string", default: "qr" },
    phone: { type: "string" },
    timeout: { type: "string", default: "300" },
    force: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (flags.help) {
  console.log(
    [
      "wa:pair — pareia o número dedicado (QR ou pairing code)",
      "",
      "  --method qr|code   Método (default: qr)",
      "  --phone +55...     Telefone E.164 (obrigatório com --method code)",
      "  --timeout 300      Espera máxima em segundos (default: 300)",
      "  --force            Descarta a sessão salva (só a desta conta) e pareia de novo",
      "",
      "No aparelho dedicado: WhatsApp > Dispositivos conectados > Conectar dispositivo.",
    ].join("\n"),
  );
  process.exit(0);
}

const method = flags.method === "code" ? "code" : "qr";
if (method === "code" && !flags.phone) {
  console.error("Erro: --phone é obrigatório com --method code (ex.: --phone +5511999999999).");
  process.exit(2);
}
const timeoutMs = Math.max(30, Number(flags.timeout) || 300) * 1000;

const db = openWaDb();
const existing = isPaired(db);
if (existing.paired && !flags.force) {
  console.log(`Conta já pareada como ${existing.meJid}. Para trocar de número, rode com --force.`);
  process.exit(0);
}
if (flags.force) {
  // Only this session's credentials (the default instance): other instances,
  // chats, contacts and campaigns are untouched.
  clearInstanceAuth(db);
  console.error("[wa:pair] --force: sessão anterior descartada; gerando um QR novo.");
}

console.error("[wa:pair] buscando a versão atual do protocolo WhatsApp Web...");
await refreshWaWebVersion(); // stale version ⇒ the server drops the handshake and no QR appears

let paired = false;
let meJid: string | null = null;
let sessionDead = false;
let qrSeq = 0;
let socketReady = false;

const handle = createWaConnection(db, {
  onQr: (qr) => {
    socketReady = true;
    qrSeq += 1;
    const ttl = qrSeq === 1 ? QR_FIRST_TTL_S : QR_NEXT_TTL_S;
    console.log(JSON.stringify({ event: "qr", seq: qrSeq, qr_string: qr, expires_hint_s: ttl }));
    if (method === "qr") {
      console.error(`\n[wa:pair] QR #${qrSeq} (expira em ~${ttl}s — o próximo aparece sozinho):\n`);
      qrcode.generate(qr, { small: true });
      console.error("[wa:pair] No aparelho dedicado: WhatsApp > Dispositivos conectados > Conectar dispositivo.");
    }
  },
  onOpen: (jid) => {
    paired = true;
    meJid = jid;
  },
  onClose: (_reason, willReconnect) => {
    if (!willReconnect && !paired) sessionDead = true;
  },
});

if (method === "code") {
  // The socket must be live (first QR emitted) before requesting the code.
  const deadline = Date.now() + CODE_READY_TIMEOUT_MS;
  while (!socketReady && !sessionDead && Date.now() < deadline) {
    await Bun.sleep(250);
  }
  if (!socketReady) {
    console.error("Erro: socket não ficou pronto para o pairing code (rede indisponível?).");
    handle.close();
    process.exit(1);
  }
  try {
    const phone = String(flags.phone).replace(/^\+/, "").replace(/\D/g, "");
    const code = await handle.getSocket().requestPairingCode(phone);
    console.log(JSON.stringify({ event: "pairing_code", pairing_code: code, phone }));
    console.error(
      `\n[wa:pair] Código de pareamento: ${code}\n` +
        "No aparelho dedicado: WhatsApp > Dispositivos conectados > Conectar dispositivo > Conectar com número de telefone.",
    );
  } catch (err) {
    console.error(`Erro ao pedir o pairing code: ${err instanceof Error ? err.message : String(err)}`);
    handle.close();
    process.exit(1);
  }
}

const startedAt = Date.now();
while (!paired && !sessionDead && Date.now() - startedAt < timeoutMs) {
  await Bun.sleep(250);
}
handle.close();

if (paired) {
  setState(db, "paired_at", nowIso());
  console.log(JSON.stringify({ event: "result", paired: true, me_jid: meJid, method, qr_seq: qrSeq }));
  console.error(`\n[wa:pair] Pareado com sucesso como ${meJid}. Sessão salva em data/whatsapp.db.`);
  process.exit(0);
}

console.log(JSON.stringify({ event: "result", paired: false, me_jid: null, method, qr_seq: qrSeq }));
console.error(
  sessionDead
    ? "\n[wa:pair] Sessão encerrada pelo servidor antes de parear. Rode de novo para gerar um QR novo."
    : `\n[wa:pair] Pareamento não concluiu em ${Math.round(timeoutMs / 1000)}s (QRs emitidos: ${qrSeq}). Rode de novo.`,
);
process.exit(1);
