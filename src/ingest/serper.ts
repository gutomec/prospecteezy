import type { Database } from "bun:sqlite";
import {
  getCursor,
  insertLeadIfNew,
  saveCursor,
  type LeadInput,
  type SearchRow,
} from "../db/repository.ts";

const SERPER_PLACES_URL = "https://google.serper.dev/places";
export const SOURCE_SERPER = "serper:places";

/** Shape of one Serper Places result (fields we consume). */
export interface SerperPlace {
  position?: number;
  title: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  rating?: number;
  ratingCount?: number;
  category?: string;
  type?: string;
  phoneNumber?: string;
  website?: string;
  cid?: string;
  placeId?: string;
}

/** Fetches one page of places for a query. Injectable for tests. */
export type PlacesFetcher = (
  query: string,
  page: number,
  num: number,
  location?: string,
) => Promise<SerperPlace[]>;

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "SERPER_API_KEY ausente. Cadastre sua chave em Configurações → Serper, ou adicione-a no arquivo .env (SERPER_API_KEY=sua_chave) e reinicie o servidor.",
    );
    this.name = "MissingApiKeyError";
  }
}

const RETRYABLE_STATUS = (status: number) => status === 429 || status >= 500;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 30_000;

/** Retry-After (seconds or HTTP date) in ms, capped; null when absent/invalid. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/**
 * Real Serper.dev fetcher. Retries 429/5xx with exponential backoff.
 * `fetchImpl` and `sleep` are injectable for tests.
 */
export function createSerperFetcher(options: {
  apiKey: string | undefined;
  gl?: string;
  hl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): PlacesFetcher {
  const { apiKey, gl = "br", hl = "pt-br" } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  if (!apiKey) throw new MissingApiKeyError();

  return async (query, page, num, location) => {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(SERPER_PLACES_URL, {
          method: "POST",
          headers: {
            "X-API-KEY": apiKey,
            "Content-Type": "application/json",
          },
          // `location` refines geographic precision (Serper canonical
          // location string). Additive: `q` still carries niche + city.
          body: JSON.stringify({
            q: query,
            gl,
            hl,
            page,
            num,
            ...(location ? { location } : {}),
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_ATTEMPTS) await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      if (response.ok) {
        const body = (await response.json()) as { places?: SerperPlace[] };
        return body.places ?? [];
      }
      if (!RETRYABLE_STATUS(response.status)) {
        throw new Error(
          `Serper respondeu ${response.status} para a página ${page}: ${await response.text()}`,
        );
      }
      lastError = new Error(`Serper HTTP ${response.status} (página ${page})`);
      if (attempt < MAX_ATTEMPTS) {
        const retryAfter =
          response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : null;
        await sleep(retryAfter ?? BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
    throw new Error(
      `Serper indisponível após ${MAX_ATTEMPTS} tentativas: ${lastError?.message}`,
    );
  };
}

export interface CollectResult {
  collectedNew: number;
  duplicatesSkipped: number;
  pagesConsumed: number;
  lastPage: number;
  exhausted: boolean; // Serper stopped returning results before the target
}

export interface CollectOptions {
  db: Database;
  search: SearchRow;
  fetcher: PlacesFetcher;
  targetNew: number;
  pageSize?: number;
  /** Optional cap of pages per run (tests); by default there is none. */
  maxPagesPerRun?: number;
  onProgress?: (message: string) => void;
}

function placeToLead(place: SerperPlace, searchId: number): LeadInput {
  return {
    search_id: searchId,
    place_id: place.placeId ?? null,
    cid: place.cid ?? null,
    position: place.position ?? null,
    name: place.title,
    category: place.category ?? place.type ?? null,
    address: place.address ?? null,
    latitude: place.latitude ?? null,
    longitude: place.longitude ?? null,
    phone: place.phoneNumber ?? null,
    website: place.website ?? null,
    rating: place.rating ?? null,
    rating_count: place.ratingCount ?? null,
    source: SOURCE_SERPER,
  };
}

/**
 * Cursor-based collection (core requirement):
 * resumes from the persisted cursor of this search and keeps fetching pages
 * until `targetNew` NEW unique leads (dedup by place_id, fallback cid) are
 * stored. Every fetched lead is persisted (credit already spent); the cursor
 * advances to the last fetched page, so a later "+N of the same query"
 * continues after everything already seen.
 */
export async function collectPlaces(options: CollectOptions): Promise<CollectResult> {
  const { db, search, fetcher, targetNew, onProgress } = options;
  const pageSize = options.pageSize ?? 10;
  const maxPagesPerRun = options.maxPagesPerRun ?? Number.POSITIVE_INFINITY;
  const serperQuery = `${search.niche} em ${search.city}`;
  const location = search.city;

  const cursor = getCursor(db, search.id);
  let page = cursor.last_page;
  let totalCollected = cursor.total_collected;
  let collectedNew = 0;
  let duplicatesSkipped = 0;
  let pagesConsumed = 0;
  let exhausted = false;
  // Identity of the previous page: Google sometimes answers later pages with
  // the very same page again, which would otherwise spend credit forever.
  let previousPage: string | null = null;

  while (collectedNew < targetNew && pagesConsumed < maxPagesPerRun) {
    page += 1;
    const places = await fetcher(serperQuery, page, pageSize, location);
    pagesConsumed += 1;

    if (places.length === 0) {
      exhausted = true;
      page -= 1; // page had nothing; don't advance the cursor past real data
      break;
    }

    const pageIdentity = places.map((p) => p.placeId ?? p.cid ?? p.title).join("|");
    if (pageIdentity === previousPage) {
      // Same page as the previous one: the source is looping, there is nothing beyond.
      exhausted = true;
      page -= 1;
      onProgress?.("O Google Maps repetiu a página anterior: não há mais resultados para esta busca.");
      break;
    }
    previousPage = pageIdentity;

    for (const place of places) {
      const inserted = insertLeadIfNew(db, placeToLead(place, search.id));
      if (inserted) {
        collectedNew += 1;
        totalCollected += 1;
      } else {
        duplicatesSkipped += 1;
      }
    }

    saveCursor(db, search.id, page, totalCollected);
    onProgress?.(
      `Página ${page} processada: ${collectedNew}/${targetNew} novos leads (${duplicatesSkipped} duplicados ignorados).`,
    );

    // A page smaller than the requested size means the source has no more
    // results: this partial page is already persisted and is the last one.
    // Stop here (no extra empty request), cursor at the last real page.
    if (places.length < pageSize) {
      exhausted = true;
      break;
    }
  }

  saveCursor(db, search.id, page, totalCollected);
  console.log(
    `[serper] query="${serperQuery}" pages_consumed=${pagesConsumed} new=${collectedNew} dup=${duplicatesSkipped} cursor_page=${page} (crédito Serper: ${pagesConsumed} requisições)`,
  );

  return { collectedNew, duplicatesSkipped, pagesConsumed, lastPage: page, exhausted };
}

/** Generic Serper call result: the parsed JSON body plus billed credits. */
export interface SerperResponse {
  body: Record<string, unknown>;
  /** From the response's `credits` field when present, else the estimate. */
  credits: number;
}

/**
 * One generic Serper request (any endpoint type). `webpage` goes to
 * scrape.serper.dev, the rest to google.serper.dev/<type>. Retries 429/5xx
 * like the Places fetcher; a non-retryable status throws a PT-BR error.
 */
export async function serperRequest(options: {
  apiKey: string;
  type: string;
  body: Record<string, unknown>;
  estimatedCredits: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<SerperResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const url =
    options.type === "webpage"
      ? "https://scrape.serper.dev/"
      : `https://google.serper.dev/${options.type}`;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "X-API-KEY": options.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(options.body),
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
    } catch (err) {
      if (options.signal?.aborted) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }
    if (response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      const credits = typeof body.credits === "number" ? body.credits : options.estimatedCredits;
      return { body, credits };
    }
    if (!RETRYABLE_STATUS(response.status)) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Serper respondeu ${response.status} (${options.type}): ${detail}`);
    }
    lastError = new Error(`Serper HTTP ${response.status} (${options.type})`);
    if (attempt < MAX_ATTEMPTS) {
      const retryAfter =
        response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : null;
      await sleep(retryAfter ?? BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  throw new Error(`Serper indisponível após ${MAX_ATTEMPTS} tentativas: ${lastError?.message}`);
}
