// Real-connection smoke for the multi-instance QR path (revision 1). The mock
// test suite cannot exercise Baileys itself; this script does: it creates an
// instance through the SAME router the HTTP mount uses, opens a REAL socket and
// asserts a rotating QR reaches /qr as a PNG data URL within the timeout. It
// then logs out + deletes the instance so the real data/whatsapp.db is left
// clean. Run: `bun run wa:smoke-qr` (needs network to reach WhatsApp).
import { createWaRouter } from "../routes.ts";

const TIMEOUT_MS = 20_000;
const POLL_MS = 1000;

const router = createWaRouter();

async function call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://localhost${path}`, init);
  const res = await router.handle(req, new URL(req.url));
  return (await res.json()) as Record<string, unknown>;
}

const created = await call("POST", "/api/wa/instances", { name: "smoke-qr" });
const id = String(created.id);
console.log(`[smoke] instância criada: ${id} — abrindo socket real...`);

const deadline = Date.now() + TIMEOUT_MS;
let ok = false;
while (Date.now() < deadline) {
  await Bun.sleep(POLL_MS);
  const qr = await call("GET", `/api/wa/instances/${id}/qr`);
  const status = String(qr.status);
  const dataUrl = typeof qr.qr === "string" ? qr.qr : null;
  const len = dataUrl ? dataUrl.length : 0;
  console.log(`[smoke] t=${Math.round((TIMEOUT_MS - (deadline - Date.now())) / 1000)}s status=${status} qr_len=${len}`);
  if (status === "qr" && dataUrl && dataUrl.startsWith("data:image/png;base64,")) {
    console.log(`[smoke] OK — QR emitido como data URL PNG (${len} bytes). expires_at=${qr.expires_at}`);
    ok = true;
    break;
  }
}

console.log("[smoke] limpando a instância de teste (logout + delete)...");
await call("DELETE", `/api/wa/instances/${id}`);

if (!ok) {
  console.error(
    "[smoke] FALHOU — QR não emitiu no prazo. Verifique rede e a versão do WA Web " +
      "(FALLBACK_WA_VERSION em connection.ts) e o log por 'error in validating connection'.",
  );
  process.exit(1);
}
console.log("[smoke] concluído — instância de teste removida, data/whatsapp.db limpo.");
process.exit(0);
