import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { openDb } from "./db/index.ts";
import {
  addLeadEvent,
  deleteLeads,
  findOrCreateSearch,
  getLead,
  getLeadWithTags,
  getSearch,
  listLeads,
  normalizeQuery,
  type SearchRow,
} from "./db/repository.ts";
import { addSearchTags, listTags, parseTagList, setSearchTags, updateLeadTags, type TagsMode } from "./db/tags.ts";
import {
  createSerperFetcher,
  MissingApiKeyError,
  type PlacesFetcher,
} from "./ingest/serper.ts";
import { getJob, getRunningJobForSearch } from "./agent/jobs.ts";
import {
  isRecentlyExhausted,
  launchForSearch,
  listSearchesWithStatus,
  RequestParseError,
  startEnrichJob,
  startProspectJob,
} from "./agent/orchestrator.ts";
import type { HostResolver } from "./ingest/email-crawler.ts";
import { handleWaRequest, initWaBackend } from "./whatsapp/routes.ts";
import { sendTextToLead, type SendToLeadResult } from "./whatsapp/send-to-lead.ts";
import { createSecretBox, type SecretBox } from "./settings/secrets.ts";
import { getSerperApiKey } from "./settings/repo.ts";
import { createSettingsRoutes } from "./settings/routes.ts";
import { createAiRoutes } from "./ai/routes.ts";
import { createLanguageModel, type ModelFactory } from "./ai/model-factory.ts";
import appIndex from "./client/index.html";
import { APP_PATHS } from "./client/routes.ts";

const DEFAULT_DB_PATH = join(import.meta.dir, "..", "data", "prospecteezy.db");
const DEFAULT_MASTER_KEY_PATH = join(import.meta.dir, "..", "data", ".master.key");

// Local-only tool: loopback bind, no CORS. Browsers block cross-origin reads,
// and the guard below rejects cross-origin writes and DNS-rebinding hosts.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SEARCH_EXHAUSTED_MESSAGE =
  "Esta busca já esgotou os resultados do Google Maps nas últimas 24 horas. Tente outro termo ou outra cidade.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorJson(message: string, status: number): Response {
  return json({ error: message }, status);
}

/** Positive integer count (no upper limit), else null. */
function parseSearchCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/** Trimmed text of 2..200 chars (same bounds as the AI tool), else null. */
function parseSearchText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  return text.length >= 2 && text.length <= 200 ? text : null;
}

/**
 * Optional `tags` of a request body: absent → [], else the parsed list or a
 * 400 response.
 */
function optionalTags(value: unknown): string[] | Response {
  if (value === undefined || value === null) return [];
  const parsed = parseTagList(value);
  return "error" in parsed ? errorJson(parsed.error, 400) : parsed.tags;
}

/**
 * 403 unless Host is loopback on our port (blocks DNS rebinding) and, for
 * state-changing methods, any Origin header is our own (blocks CSRF).
 */
function rejectForeignRequest(req: Request, port: number): Response | null {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const match = host.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  const hostOk =
    match !== null &&
    LOOPBACK_HOSTNAMES.has(match[1]!) &&
    (match[2] === undefined ? port === 80 : Number(match[2]) === port);
  if (!hostOk) {
    return errorJson("Acesso negado: o prospecteezy só aceita requisições locais (localhost).", 403);
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    if (origin !== null && !allowedOrigins(port).has(origin.toLowerCase())) {
      return errorJson("Acesso negado: origem não autorizada.", 403);
    }
  }
  return null;
}

function allowedOrigins(port: number): Set<string> {
  const suffix = port === 80 ? "" : `:${port}`;
  return new Set([...LOOPBACK_HOSTNAMES].map((h) => `http://${h}${suffix}`));
}

/** Strips CORS headers some sub-modules still emit (no cross-origin reads). */
function withoutCors(response: Response): Response {
  if (!response.headers.has("access-control-allow-origin")) return response;
  const headers = new Headers(response.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("access-control-")) headers.delete(name);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Positive integer query param; default when absent, null when invalid. */
function parsePositiveInt(raw: string | null, fallback: number | undefined): number | null | undefined {
  if (raw === null || raw === "") return fallback;
  return /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : null;
}

export interface ServerOptions {
  db?: Database;
  dbPath?: string;
  port?: number;
  /** Injectable Serper fetcher (tests). Defaults to the real client. */
  fetcher?: PlacesFetcher;
  skipEnrichment?: boolean;
  /** Injectable website fetch / DNS resolution for the e-mail crawler (tests). */
  crawlerFetch?: typeof fetch;
  crawlerResolveHost?: HostResolver;
  /** Master key file for encrypted secrets. Default: next to dbPath, else data/.master.key. */
  masterKeyPath?: string;
  /** Injectable secret box (tests). Overrides masterKeyPath. */
  secretBox?: SecretBox;
  /** fetch used for generic Serper calls (AI tools, key test). Tests inject a fake. */
  serperFetch?: typeof fetch;
  /** Test-only seam: builds the LLM (tests pass the AI SDK mock model). */
  aiModelFactory?: ModelFactory;
  /** Sends a WhatsApp text to a lead (gated). Default: the WhatsApp backend singleton. */
  waSendToLead?: (leadId: number, text: string) => Promise<SendToLeadResult>;
}

export function createServer(options: ServerOptions = {}) {
  const db = options.db ?? openDb(options.dbPath ?? DEFAULT_DB_PATH);
  const box =
    options.secretBox ??
    createSecretBox({
      keyPath:
        options.masterKeyPath ??
        (options.dbPath && options.dbPath !== ":memory:"
          ? join(dirname(options.dbPath), ".master.key")
          : DEFAULT_MASTER_KEY_PATH),
    });

  async function resolveFetcher(): Promise<PlacesFetcher> {
    if (options.fetcher) return options.fetcher;
    // Read the key at request time so a clear error reaches the chat.
    // Settings (Configurações) take precedence over SERPER_API_KEY in .env.
    return createSerperFetcher({ apiKey: (await getSerperApiKey(db, box)) ?? undefined });
  }

  // Lazily wires the WhatsApp singleton only when the agent actually sends.
  const waSendToLead =
    options.waSendToLead ??
    ((leadId: number, text: string) => {
      const wa = initWaBackend();
      return sendTextToLead({ coreDb: db, waDb: wa.waDb, manager: wa.manager }, leadId, text);
    });

  const crawlerDeps = {
    crawlerFetch: options.crawlerFetch,
    crawlerResolveHost: options.crawlerResolveHost,
  };

  /**
   * Shared tail of POST /api/searches and /api/searches/:id/more: joins a
   * running job (202), refuses a recently exhausted search (409, no Serper
   * call), needs a Serper key (503), else starts the collection (202).
   * `existing` is the known search (null = new niche+city, created by `resolve`).
   */
  async function startSearchJob(
    existing: SearchRow | null,
    count: number,
    resolve: () => SearchRow,
    tags: string[] = [],
  ): Promise<Response> {
    if (existing) {
      const running = getRunningJobForSearch(existing.id);
      if (running) {
        addSearchTags(db, existing.id, tags);
        return json(
          { job_id: running.id, search_id: existing.id, steps: running.steps, already_running: true },
          202,
        );
      }
      if (isRecentlyExhausted(db, existing.id)) {
        return json({ error: SEARCH_EXHAUSTED_MESSAGE, code: "exhausted" }, 409);
      }
    }
    let fetcher: PlacesFetcher;
    try {
      fetcher = await resolveFetcher();
    } catch (error) {
      if (error instanceof MissingApiKeyError) return errorJson(error.message, 503);
      throw error;
    }
    const search = resolve();
    // Before launching, so every lead this collection inserts inherits them.
    addSearchTags(db, search.id, tags);
    const { job, alreadyRunning } = launchForSearch(
      { db, fetcher, skipEnrichment: options.skipEnrichment, ...crawlerDeps },
      search,
      count,
    );
    return json(
      { job_id: job.id, search_id: job.search_id, steps: job.steps, already_running: alreadyRunning },
      202,
    );
  }

  // Every route handler runs behind the same Host/Origin guard as `fetch`.
  type Handler = (req: Request, srv: unknown) => Response | Promise<Response>;
  function guardRoutes<T extends object>(table: T): T {
    for (const methods of Object.values(table) as Record<string, Handler>[]) {
      for (const [method, handler] of Object.entries(methods)) {
        methods[method] = (req, srv) => rejectForeignRequest(req, server.port!) ?? handler(req, srv);
      }
    }
    return table;
  }

  const server = Bun.serve({
    port: options.port ?? Number(Bun.env.PORT ?? 3000),
    // Loopback only: the API has no auth and must not be reachable from the LAN.
    hostname: "127.0.0.1",
    idleTimeout: 255,
    // React app (src/client): Bun bundles the HTML import. Development = HMR +
    // browser console forwarding; otherwise minified and cached in memory.
    development: Bun.env.NODE_ENV === "development" ? { hmr: true, console: true } : false,
    routes: {
      // Explicit SPA paths (never "/*": it would shadow /api/wa/* in `fetch`).
      // HTML bundles take no method map, so they sit outside guardRoutes; the
      // page itself carries no data, and every /api route stays guarded.
      ...Object.fromEntries(APP_PATHS.map((path) => [path, appIndex])),
      ...guardRoutes({
        ...createSettingsRoutes({ db, box, serperFetch: options.serperFetch }),
        ...createAiRoutes({
          db,
          box,
          modelFactory: options.aiModelFactory ?? createLanguageModel,
          getSerperKey: () => getSerperApiKey(db, box),
          serperFetch: options.serperFetch,
          prospectFetcher: options.fetcher,
          skipEnrichment: options.skipEnrichment,
          crawlerFetch: options.crawlerFetch,
          crawlerResolveHost: options.crawlerResolveHost,
          sendToLead: waSendToLead,
      }),

      "/api/prospect": {
        POST: async (req: Request) => {
          let text: string;
          let rawTags: unknown;
          try {
            const body = (await req.json()) as { text?: string; tags?: unknown };
            text = (body.text ?? "").trim();
            rawTags = body.tags;
          } catch {
            return errorJson('Corpo inválido. Envie JSON: {"text": "seu pedido"}.', 400);
          }
          if (!text) {
            return errorJson('Campo "text" obrigatório com o pedido em português.', 400);
          }
          const tags = optionalTags(rawTags);
          if (tags instanceof Response) return tags;
          try {
            const fetcher = await resolveFetcher();
            const { job, alreadyRunning } = startProspectJob(
              { db, fetcher, skipEnrichment: options.skipEnrichment, ...crawlerDeps },
              text,
              tags,
            );
            return json(
              {
                job_id: job.id,
                search_id: job.search_id,
                steps: job.steps,
                already_running: alreadyRunning,
              },
              202,
            );
          } catch (error) {
            if (error instanceof MissingApiKeyError) return errorJson(error.message, 503);
            if (error instanceof RequestParseError) return errorJson(error.message, 422);
            throw error;
          }
        },
      },

      "/api/searches": {
        GET: () => json({ searches: listSearchesWithStatus(db) }),
        // Structured new search ("outra cidade / outro termo"). Body:
        // {"niche": string, "city": string, "count": >= 1}. An existing
        // niche+city resumes its cursor, like the chat flow.
        POST: async (req: Request) => {
          const invalid = `Corpo inválido. Envie JSON: {"niche": "dentistas", "city": "Cascavel-PR", "count": 20} (nicho e cidade com 2 a 200 caracteres; quantidade inteira a partir de 1).`;
          let body: { niche?: unknown; city?: unknown; count?: unknown; tags?: unknown };
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return errorJson(invalid, 400);
          }
          if (!body || typeof body !== "object") return errorJson(invalid, 400);
          const niche = parseSearchText(body.niche);
          const city = parseSearchText(body.city);
          const count = parseSearchCount(body.count);
          if (!niche) return errorJson('Campo "niche" obrigatório: o nicho da busca (2 a 200 caracteres).', 400);
          if (!city) return errorJson('Campo "city" obrigatório: a cidade da busca (2 a 200 caracteres), ex.: "Cascavel-PR".', 400);
          if (count === null) return errorJson(`Campo "count" obrigatório: um número inteiro a partir de 1.`, 400);
          const tags = optionalTags(body.tags);
          if (tags instanceof Response) return tags;
          const existing = db
            .query("SELECT * FROM searches WHERE query_normalized = ?")
            .get(normalizeQuery(niche, city)) as SearchRow | null;
          return startSearchJob(existing, count, () => findOrCreateSearch(db, niche, city), tags);
        },
      },

      // "Buscar mais" for one search: resumes its cursor. Body: {"count": >= 1}.
      "/api/searches/:id/more": {
        POST: async (req: Bun.BunRequest<"/api/searches/:id/more">) => {
          const id = Number(req.params.id);
          const search = Number.isInteger(id) && id > 0 ? getSearch(db, id) : null;
          if (!search) return errorJson("Busca não encontrada.", 404);
          let body: { count?: unknown; tags?: unknown };
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return errorJson(`Corpo inválido. Envie JSON: {"count": 20} (inteiro a partir de 1).`, 400);
          }
          const count = parseSearchCount(body?.count);
          if (count === null) return errorJson(`Campo "count" obrigatório: um número inteiro a partir de 1.`, 400);
          const tags = optionalTags(body?.tags);
          if (tags instanceof Response) return tags;
          return startSearchJob(search, count, () => search, tags);
        },
      },

      // Replaces a search's tags. Body: {"tags": string[]}. Newly added tags
      // also go to the leads the search already collected; removed ones stay
      // on the leads.
      "/api/searches/:id/tags": {
        PUT: async (req: Bun.BunRequest<"/api/searches/:id/tags">) => {
          const id = Number(req.params.id);
          const search = Number.isInteger(id) && id > 0 ? getSearch(db, id) : null;
          if (!search) return errorJson("Busca não encontrada.", 404);
          let body: { tags?: unknown };
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return errorJson('Corpo inválido. Envie JSON: {"tags": ["academia", "prioridade"]}.', 400);
          }
          const parsed = parseTagList(body?.tags);
          if ("error" in parsed) return errorJson(parsed.error, 400);
          setSearchTags(db, search.id, parsed.tags);
          const updated = listSearchesWithStatus(db).find((s) => s.id === search.id)!;
          return json({ search: updated });
        },
      },

      "/api/tags": {
        GET: () => json({ tags: listTags(db) }),
      },

      "/api/leads": {
        GET: (req: Request) => {
          const url = new URL(req.url);
          const searchId = parsePositiveInt(url.searchParams.get("search_id"), undefined);
          if (searchId === null) {
            return errorJson('Parâmetro "search_id" inválido: use um número inteiro positivo.', 400);
          }
          const tagsMode = url.searchParams.get("tags_mode") ?? "any";
          if (tagsMode !== "any" && tagsMode !== "all") {
            return errorJson('Parâmetro "tags_mode" inválido: use "any" ou "all".', 400);
          }
          const tags = (url.searchParams.get("tags") ?? "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
          return json(
            listLeads(db, {
              search_id: searchId,
              filter: url.searchParams.get("filter") ?? undefined,
              tags,
              tags_mode: tagsMode as TagsMode,
              sort: url.searchParams.get("sort") ?? undefined,
              // Invalid page/page_size fall back to the defaults.
              page: parsePositiveInt(url.searchParams.get("page"), 1) ?? 1,
              page_size: parsePositiveInt(url.searchParams.get("page_size"), 50) ?? 50,
            }),
          );
        },
        // Bulk delete. Body: {"ids": number[]}. Permanent — removes each lead
        // and its lead_events (transactional). Non-existent ids are ignored.
        DELETE: async (req: Request) => {
          let body: { ids?: unknown };
          try {
            body = (await req.json()) as { ids?: unknown };
          } catch {
            return errorJson('Corpo inválido. Envie JSON: {"ids": [1, 2, 3]}.', 400);
          }
          const ids = body.ids;
          if (
            !Array.isArray(ids) ||
            ids.some((id) => typeof id !== "number" || !Number.isInteger(id))
          ) {
            return errorJson('Campo "ids" obrigatório: um array de números (IDs dos leads).', 400);
          }
          return json({ deleted: deleteLeads(db, ids) });
        },
      },

      // Manual e-mail enrichment. Body: {"ids": number[]} (at least one). Async job,
      // polled via GET /api/progress/:job like prospect jobs.
      "/api/leads/enrich": {
        POST: async (req: Request) => {
          const invalid = `Corpo inválido. Envie JSON: {"ids": [1, 2, 3]} com pelo menos 1 ID de lead.`;
          let body: { ids?: unknown };
          try {
            body = (await req.json()) as { ids?: unknown };
          } catch {
            return errorJson(invalid, 400);
          }
          const ids = body?.ids;
          if (
            !Array.isArray(ids) ||
            ids.length < 1 ||
            ids.some((id) => typeof id !== "number" || !Number.isInteger(id))
          ) {
            return errorJson(invalid, 400);
          }
          const job = startEnrichJob({ db, ...crawlerDeps }, [...new Set(ids as number[])]);
          return json({ job_id: job.id }, 202);
        },
      },

      // Bulk tag edit. Body: {"lead_ids": number[] (at least one), "add"?: string[],
      // "remove"?: string[]}. Missing tags are created on add; remove matches
      // by name or slug. Unknown lead ids are ignored.
      "/api/leads/tags": {
        POST: async (req: Request) => {
          const invalid = `Corpo inválido. Envie JSON: {"lead_ids": [1, 2], "add": ["academia"], "remove": ["frio"]} com pelo menos 1 ID e pelo menos uma tag.`;
          let body: { lead_ids?: unknown; add?: unknown; remove?: unknown };
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return errorJson(invalid, 400);
          }
          const ids = body?.lead_ids;
          if (
            !Array.isArray(ids) ||
            ids.length < 1 ||
            ids.some((id) => typeof id !== "number" || !Number.isInteger(id))
          ) {
            return errorJson(invalid, 400);
          }
          const add = optionalTags(body.add);
          if (add instanceof Response) return add;
          const remove = optionalTags(body.remove);
          if (remove instanceof Response) return remove;
          if (add.length === 0 && remove.length === 0) return errorJson(invalid, 400);
          const result = updateLeadTags(db, [...new Set(ids as number[])], add, remove);
          return json({ updated: result.updated, tags: listTags(db) });
        },
      },

      "/api/leads/:id": {
        GET: (req: Bun.BunRequest<"/api/leads/:id">) => {
          const lead = getLeadWithTags(db, Number(req.params.id));
          return lead ? json({ lead }) : errorJson("Lead não encontrado.", 404);
        },
      },

      "/api/leads/:id/events": {
        POST: async (req: Bun.BunRequest<"/api/leads/:id/events">) => {
          const lead = getLead(db, Number(req.params.id));
          if (!lead) return errorJson("Lead não encontrado.", 404);
          let body: { event?: string; payload?: unknown };
          try {
            body = (await req.json()) as { event?: string; payload?: unknown };
          } catch {
            return errorJson('Corpo inválido. Envie JSON: {"event": "...", "payload": {}}.', 400);
          }
          if (!body.event) return errorJson('Campo "event" obrigatório.', 400);
          addLeadEvent(db, lead.id, body.event, body.payload);
          return json({ ok: true }, 201);
        },
      },

      "/api/progress/:job": {
        GET: (req: Bun.BunRequest<"/api/progress/:job">) => {
          const job = getJob(req.params.job);
          return job ? json({ job }) : errorJson("Job não encontrado.", 404);
        },
      },
      }),
    },

    // Fallback: the WhatsApp backend (/api/wa/*, mounted as one block) and
    // JSON 404s. Unknown non-API paths also 404 (the app lives at APP_PATHS).
    async fetch(req) {
      const rejected = rejectForeignRequest(req, server.port!);
      if (rejected) return rejected;
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/wa/")) {
        return withoutCors(await handleWaRequest(req, url));
      }
      if (url.pathname.startsWith("/api/")) {
        return errorJson("Rota não encontrada.", 404);
      }
      return errorJson("Não encontrado.", 404);
    },

    error(error) {
      console.error("[server] erro não tratado:", error);
      return errorJson("Erro interno no servidor. Tente novamente.", 500);
    },
  });

  return { server, db, box };
}

if (import.meta.main) {
  const { server, db, box } = createServer();
  console.log(`prospecteezy no ar em http://localhost:${server.port}`);
  // Reconnect paired WhatsApp instances now, not on the first /api/wa request.
  initWaBackend();
  if (!(await getSerperApiKey(db, box))) {
    console.warn(
      "Aviso: chave do Serper não configurada (Configurações ou SERPER_API_KEY no .env) — buscas retornarão erro 503 até você adicionar a chave.",
    );
  }
}
