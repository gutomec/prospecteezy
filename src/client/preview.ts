// UI preview server (development only): `bun run dev:ui` → http://localhost:3090
//
// Serves the React app with HMR and forwards /api/* to the real backend on
// http://localhost:3000 — READ-ONLY by default, because that backend holds
// real leads and a live WhatsApp account:
//   - GET/HEAD are proxied;
//   - POST/PUT/PATCH/DELETE get 503 "bloqueado no preview" unless
//     PREVIEW_ALLOW_WRITES=1 is set explicitly.
// PREVIEW_MOCK=1 swaps the proxy for an in-memory fake backend (all methods),
// to exercise write flows safely: `bun run dev:ui:mock`.
import index from "./index.html";
import { APP_PATHS } from "./routes";
import { createMockBackend } from "./dev/mock-backend";

const PORT = Number(Bun.env.PREVIEW_PORT ?? 3090);
const BACKEND = Bun.env.PREVIEW_BACKEND ?? "http://localhost:3000";
const MOCK = Bun.env.PREVIEW_MOCK === "1";
const ALLOW_WRITES = Bun.env.PREVIEW_ALLOW_WRITES === "1";

const backendUrl = new URL(BACKEND);
const mock = MOCK ? createMockBackend() : null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

const BLOCKED_MESSAGE =
  "Bloqueado no preview: escritas no servidor real estão desativadas (dados reais e WhatsApp ao vivo). Use PREVIEW_MOCK=1 para testar com dados falsos, ou PREVIEW_ALLOW_WRITES=1 por sua conta e risco.";

async function proxy(req: Request, url: URL): Promise<Response> {
  const readOnly = req.method === "GET" || req.method === "HEAD";
  if (!readOnly && !ALLOW_WRITES) return json({ error: BLOCKED_MESSAGE }, 503);

  const target = new URL(url.pathname + url.search, backendUrl);
  const headers = new Headers(req.headers);
  // The backend only accepts its own Host/Origin (DNS-rebinding/CSRF guard).
  headers.set("host", backendUrl.host);
  if (headers.has("origin")) headers.set("origin", backendUrl.origin);
  headers.delete("referer");
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: readOnly ? undefined : await req.arrayBuffer(),
      redirect: "manual",
      signal: req.signal,
    });
    const out = new Headers(upstream.headers);
    out.delete("content-encoding"); // fetch already decoded the body
    out.delete("content-length");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  } catch {
    return json({ error: `Preview: não consegui falar com o backend em ${BACKEND}. Ele está rodando? (bun run start)` }, 502);
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255, // SSE (/api/wa/stream) stays open
  routes: Object.fromEntries(APP_PATHS.map((path) => [path, index])),
  development: { hmr: true, console: true },
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return mock ? mock.handle(req, url) : proxy(req, url);
    return json({ error: "Não encontrado." }, 404);
  },
});

const mode = MOCK ? "backend FALSO em memória" : `proxy para ${BACKEND} (${ALLOW_WRITES ? "ESCRITAS LIBERADAS" : "somente leitura"})`;
console.log(`Preview da UI em http://localhost:${server.port} · ${mode}`);
