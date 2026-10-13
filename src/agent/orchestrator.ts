import type { Database } from "bun:sqlite";
import {
  findOrCreateSearch,
  getMostRecentSearch,
  listLeadsToEnrich,
  listLeadsWithWebsiteByIds,
  listSearches,
  markEnriched,
  setSearchExhausted,
  touchSearch,
  type LeadRow,
  type SearchListRow,
  type SearchRow,
} from "../db/repository.ts";
import { addSearchTags, getTagsBySearch } from "../db/tags.ts";
import { collectPlaces, type CollectResult, type PlacesFetcher } from "../ingest/serper.ts";
import { enrichLead, type HostResolver } from "../ingest/email-crawler.ts";
import { parseProspectRequest } from "./parser.ts";
import {
  addStep,
  completeJob,
  createJob,
  failJob,
  getRunningJobForSearch,
  type Job,
} from "./jobs.ts";

export interface OrchestratorDeps {
  db: Database;
  fetcher: PlacesFetcher;
  crawlerFetch?: typeof fetch;
  /** DNS resolution used by the crawler's SSRF guard (tests). */
  crawlerResolveHost?: HostResolver;
  /** Skip the e-mail enrichment stage (tests). */
  skipEnrichment?: boolean;
}

export type EnrichDeps = Pick<OrchestratorDeps, "db" | "crawlerFetch" | "crawlerResolveHost">;

export class RequestParseError extends Error {}

const ENRICH_CONCURRENCY = 5;
const ENRICH_PROGRESS_EVERY = 10;

/**
 * Crawls the leads' websites with bounded concurrency. A lead whose crawl
 * throws is still marked enriched (no e-mail) so it is not retried forever.
 * Returns how many e-mails were found.
 */
async function enrichLeads(deps: EnrichDeps, job: Job, leads: LeadRow[]): Promise<number> {
  const crawlerDeps = { fetchImpl: deps.crawlerFetch, resolveHost: deps.crawlerResolveHost };
  let next = 0;
  let done = 0;
  let found = 0;
  const worker = async () => {
    while (next < leads.length) {
      const lead = leads[next++]!;
      try {
        const result = await enrichLead(deps.db, lead, crawlerDeps);
        if (result.email) found += 1;
      } catch (error) {
        console.warn(`[enrich] lead ${lead.id} falhou:`, error);
        try {
          markEnriched(deps.db, lead.id, null, {});
        } catch {
          /* lead deleted meanwhile — nothing to mark */
        }
      }
      done += 1;
      if (done % ENRICH_PROGRESS_EVERY === 0 && done < leads.length) {
        addStep(
          job,
          `Enriquecimento em andamento: ${done}/${leads.length} sites visitados (${found} e-mails encontrados).`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(ENRICH_CONCURRENCY, leads.length) }, worker),
  );
  return found;
}

/**
 * Parses the PT-BR request, resolves the target search (new query creates
 * one; a repeated query or "mais N" resumes the persisted cursor) and starts
 * the async pipeline: search → paginate → persist → enrich.
 *
 * Returns the job immediately; progress is polled via GET /api/progress/:job.
 * When the search already has a running job, that job is returned instead.
 */
export function startProspectJob(
  deps: OrchestratorDeps,
  text: string,
  tags: string[] = [],
): { job: Job; alreadyRunning: boolean } {
  const parsed = parseProspectRequest(text);
  if (parsed.kind === "unknown") throw new RequestParseError(parsed.message);

  let search: SearchRow;
  if (parsed.kind === "more") {
    const recent = getMostRecentSearch(deps.db);
    if (!recent) {
      throw new RequestParseError(
        'Ainda não há nenhuma pesquisa para continuar. Faça um pedido completo primeiro, por exemplo: "Busque os 100 principais escritórios de advocacia de São Paulo-SP".',
      );
    }
    search = recent;
  } else {
    search = findOrCreateSearch(deps.db, parsed.niche, parsed.city);
  }

  // Tags go on the search (and from it to its leads, old and new).
  addSearchTags(deps.db, search.id, tags);
  return launchForSearch(deps, search, parsed.count);
}

/**
 * Structured variant used by the AI agent (niche/city/count already known):
 * same search identity, cursor, dedup and enrichment as the chat flow.
 */
export function startStructuredProspectJob(
  deps: OrchestratorDeps,
  request: { niche: string; city: string; count: number; tags?: string[] },
): LaunchResult {
  const search = findOrCreateSearch(deps.db, request.niche, request.city);
  addSearchTags(deps.db, search.id, request.tags ?? []);
  return launchForSearch(deps, search, request.count);
}

export interface LaunchResult {
  job: Job;
  alreadyRunning: boolean;
  /** Resolves when the Serper collection phase ends (before e-mail enrichment); absent when alreadyRunning. */
  collected?: Promise<CollectResult>;
}

export const EXHAUSTED_TTL_MS = 24 * 60 * 60 * 1000;

/** True when the search's last collection ran the source dry within the TTL (searches.exhausted_at). */
export function isRecentlyExhausted(db: Database, searchId: number, now = Date.now()): boolean {
  const row = db.query("SELECT exhausted_at FROM searches WHERE id = ?").get(searchId) as {
    exhausted_at: string | null;
  } | null;
  return isExhaustedAt(row?.exhausted_at ?? null, now);
}

function isExhaustedAt(at: string | null, now: number): boolean {
  if (!at) return false;
  const time = Date.parse(at);
  return Number.isFinite(time) && now - time < EXHAUSTED_TTL_MS;
}

export type SearchStatus = "running" | "exhausted" | "idle";

export type SearchWithStatus = SearchListRow & {
  /** Tag names, inherited by the leads this search collects. */
  tags: string[];
  status: SearchStatus;
  /** Id of the job collecting for this search right now (in-memory registry). */
  running_job_id: string | null;
};

/** GET /api/searches: every search plus its live status. */
export function listSearchesWithStatus(db: Database, now = Date.now()): SearchWithStatus[] {
  const tags = getTagsBySearch(db);
  return listSearches(db).map((search) => {
    const running = getRunningJobForSearch(search.id);
    const status: SearchStatus = running
      ? "running"
      : isExhaustedAt(search.exhausted_at, now)
        ? "exhausted"
        : "idle";
    return { ...search, tags: tags.get(search.id) ?? [], status, running_job_id: running?.id ?? null };
  });
}

/**
 * Starts (or joins) the collection of N more leads for an existing search,
 * resuming its cursor. Callers check isRecentlyExhausted first when needed.
 */
export function launchForSearch(
  deps: OrchestratorDeps,
  search: SearchRow,
  count: number,
): LaunchResult {
  // One collection per search at a time: a second one would race the cursor
  // (double Serper credit, wrong totals). Hand back the running job instead.
  const running = getRunningJobForSearch(search.id);
  if (running) return { job: running, alreadyRunning: true };

  touchSearch(deps.db, search.id);
  const job = createJob();
  job.search_id = search.id;
  addStep(
    job,
    `Pedido entendido: ${count} leads de "${search.niche}" em ${search.city}.`,
  );

  const collected = Promise.withResolvers<CollectResult>();
  // Callers that never await it must not trigger an unhandled rejection.
  collected.promise.catch(() => {});
  void runPipeline(deps, job, search, count, collected);
  return { job, alreadyRunning: false, collected: collected.promise };
}

async function runPipeline(
  deps: OrchestratorDeps,
  job: Job,
  search: SearchRow,
  targetNew: number,
  collected?: PromiseWithResolvers<CollectResult>,
): Promise<void> {
  try {
    addStep(job, "Buscando no Google Places via Serper (paginação com cursor)...");
    const collect = await collectPlaces({
      db: deps.db,
      search,
      fetcher: deps.fetcher,
      targetNew,
      onProgress: (message) => addStep(job, message),
    });
    if (collect.exhausted) setSearchExhausted(deps.db, search.id, new Date().toISOString());
    else if (collect.collectedNew > 0) setSearchExhausted(deps.db, search.id, null);
    collected?.resolve(collect);

    if (collect.exhausted && collect.collectedNew < targetNew) {
      addStep(
        job,
        `A fonte esgotou os resultados: ${collect.collectedNew} novos leads coletados (pedido: ${targetNew}).`,
      );
    } else {
      addStep(job, `Coleta concluída: ${collect.collectedNew} novos leads salvos.`);
    }

    let enriched = 0;
    if (!deps.skipEnrichment) {
      const pending = listLeadsToEnrich(deps.db, search.id);
      if (pending.length > 0) {
        addStep(
          job,
          `Enriquecendo e-mails: visitando o site de ${pending.length} leads...`,
        );
        enriched = await enrichLeads(deps, job, pending);
        addStep(job, `Enriquecimento concluído: ${enriched} e-mails encontrados.`);
      }
    }

    completeJob(job, {
      collected_new: collect.collectedNew,
      duplicates_skipped: collect.duplicatesSkipped,
      pages_consumed: collect.pagesConsumed,
      enriched,
      exhausted: collect.exhausted,
    });
    addStep(job, "Pronto! Os leads já estão disponíveis na grid.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collected?.reject(error);
    failJob(job, message);
    addStep(job, `Falha na coleta: ${message}`);
  }
}

/**
 * Manual enrichment of selected leads (POST /api/leads/enrich): re-crawls
 * every given lead that has a website, regardless of previous enrichment.
 * Tracked like prospect jobs (same progress shape, search_id null).
 */
export function startEnrichJob(deps: EnrichDeps, ids: number[]): Job {
  const job = createJob();
  addStep(job, `Enriquecimento solicitado para ${ids.length} leads selecionados.`);
  void runEnrichment(deps, job, ids);
  return job;
}

async function runEnrichment(deps: EnrichDeps, job: Job, ids: number[]): Promise<void> {
  try {
    const leads = listLeadsWithWebsiteByIds(deps.db, ids);
    const skipped = ids.length - leads.length;
    if (skipped > 0) {
      addStep(job, `${skipped} leads ignorados (sem site ou inexistentes).`);
    }
    let enriched = 0;
    if (leads.length > 0) {
      addStep(job, `Enriquecendo e-mails: visitando o site de ${leads.length} leads...`);
      enriched = await enrichLeads(deps, job, leads);
    }
    addStep(job, `Enriquecimento concluído: ${enriched} e-mails encontrados.`);
    completeJob(job, {
      collected_new: 0,
      duplicates_skipped: 0,
      pages_consumed: 0,
      enriched,
      exhausted: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failJob(job, message);
    addStep(job, `Falha no enriquecimento: ${message}`);
  }
}
