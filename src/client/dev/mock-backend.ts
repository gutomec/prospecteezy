// In-memory fake of the prospecteezy REST API, for the UI preview only
// (PREVIEW_MOCK=1). Mirrors the shapes in docs/api.md closely enough to drive
// every phase-1 flow: leads (list/sort/filter/delete), searches (history,
// "buscar mais", "outra cidade", 24 h exhaustion), prospect + enrich jobs,
// WhatsApp validation (incl. a pause to exercise "Retomar"), settings and AI
// providers, tags (lead tags, search tags inherited by collected leads); the
// rest of /api/wa/* lives in mock-whatsapp.ts. Never imported by the app bundle.
import type {
  AiProvider,
  CompanyProfile,
  Job,
  JobStep,
  Lead,
  ProviderKind,
  Search,
  SerperStatus,
  Tag,
  ValidateJob,
} from "../lib/api/types";
import { matchesTags, normalizeTagName, tagSlug } from "../lib/tags";
import { createMockAiChat } from "./mock-ai-chat";
import { createWaMock } from "./mock-whatsapp";

const CITIES = ["São Paulo-SP", "Campinas-SP", "Curitiba-PR", "Belo Horizonte-MG", "Recife-PE", "Porto Alegre-RS"];
const NICHES: Array<[string, string]> = [
  ["Escritório de advocacia", "Advogado"],
  ["Clínica odontológica", "Dentista"],
  ["Academia", "Academia de ginástica"],
  ["Contabilidade", "Contador"],
  ["Imobiliária", "Imobiliária"],
  ["Restaurante", "Restaurante"],
];
const SURNAMES = ["Almeida", "Souza", "Ferreira", "Oliveira", "Costa", "Ribeiro", "Martins", "Araújo", "Gonçalves", "Lima", "Barbosa", "Cardoso"];
const STREETS = ["Av. Paulista", "Rua Augusta", "Rua XV de Novembro", "Av. Afonso Pena", "Rua da Aurora", "Av. Ipiranga"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const error = (message: string, status: number) => json({ error: message }, status);
const now = () => new Date().toISOString();

function seededLeads(count: number): Lead[] {
  const leads: Lead[] = [];
  for (let i = 1; i <= count; i++) {
    const [niche, category] = NICHES[i % NICHES.length]!;
    const surname = SURNAMES[(i * 7) % SURNAMES.length]!;
    const city = CITIES[i % CITIES.length]!;
    const slug = `${niche.split(" ")[0]!.toLowerCase()}${surname.toLowerCase()}${i}`.normalize("NFD").replace(/[̀-ͯ]/g, "");
    const hasSite = i % 4 !== 0;
    const daysAgo = i % 15;
    const collected = new Date(Date.now() - daysAgo * 86_400_000 - i * 60_000).toISOString();
    leads.push({
      id: i,
      search_id: (i % 3) + 1,
      place_id: `ChIJmock${i}`,
      cid: String(1_000_000 + i),
      position: (i % 40) + 1,
      name: `${niche} ${surname}${i % 5 === 0 ? " & Associados" : ""}`,
      category,
      address: `${STREETS[i % STREETS.length]}, ${100 + i * 3} - ${city.replace("-", " - ")}`,
      latitude: -23.55 + (i % 10) * 0.01,
      longitude: -46.63 - (i % 10) * 0.01,
      phone: i % 9 === 0 ? null : `+55 11 9${String(8000_0000 + i * 137).slice(0, 4)}-${String(1000 + i).slice(-4)}`,
      website: hasSite ? (i === 3 ? "javascript:alert(1)" : `https://www.${slug}.com.br`) : null,
      rating: i % 7 === 0 ? null : Math.round((3 + ((i * 13) % 20) / 10) * 10) / 10,
      rating_count: i % 7 === 0 ? null : (i * 17) % 400,
      email: hasSite && i % 3 !== 0 ? `contato@${slug}.com.br` : null,
      socials_json: i % 5 === 0 ? JSON.stringify({ instagram: `https://instagram.com/${slug}` }) : null,
      is_whatsapp: i % 6 === 0 ? 0 : i % 2 === 0 ? 1 : null,
      whatsapp_jid: i % 2 === 0 && i % 6 !== 0 ? `55119${String(i).padStart(8, "0")}@s.whatsapp.net` : null,
      source: "serper:places",
      collected_at: collected,
      enriched_at: hasSite && i % 3 !== 2 ? collected : null,
      ai_enrichment_json:
        i === 2
          ? JSON.stringify({
              summary: "Escritório boutique focado em direito empresarial para PMEs, com atendimento remoto em todo o estado.",
              segment: "Direito empresarial",
              size_estimate: "10 a 20 funcionários",
              decision_makers: [{ name: "Marina Souza", role: "Sócia-fundadora", source_url: "https://www.linkedin.com/in/exemplo" }],
              socials: { linkedin: "https://www.linkedin.com/company/exemplo", site: "javascript:alert(2)" },
              extra_emails: ["marina@exemplo.com.br"],
              notes: "Publica artigos semanais; bom gancho para abordagem.",
              sources: ["https://www.exemplo.com.br/sobre"],
            })
          : null,
      ai_enriched_at: i === 2 ? collected : null,
      tags: [
        ...((i % 3) + 1 === 1 ? ["Advocacia"] : []),
        ...(i % 4 === 0 ? ["Prioridade"] : []),
        ...(i % 5 === 0 ? ["Quente"] : []),
        ...(i % 11 === 0 ? ["Já contatado", "Retornar em março"] : []),
      ],
    });
  }
  return leads;
}

/** A search plus how many results the fake Google Maps still has for it. */
type MockSearch = Omit<Search, "status" | "running_job_id" | "lead_count"> & { available: number };

const EXHAUSTED_TTL_MS = 24 * 60 * 60 * 1000;
const EXHAUSTED_MESSAGE = "Esta busca já esgotou os resultados do Google Maps nas últimas 24 horas. Tente outro termo ou outra cidade.";
const MISSING_KEY_MESSAGE = "SERPER_API_KEY ausente. Cadastre sua chave em Configurações → Serper, ou adicione SERPER_API_KEY ao arquivo .env.";

function mockSearch(id: number, niche: string, city: string, hoursAgo: number, extra: Partial<MockSearch> = {}): MockSearch {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return {
    id,
    query_normalized: `${niche} ${city}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""),
    niche,
    city,
    gl: "br",
    hl: "pt-br",
    created_at: at,
    last_used_at: at,
    exhausted_at: null,
    last_page: 5,
    total_collected: 46,
    available: 60,
    tags: [],
    ...extra,
  };
}

interface MockJob extends Job {
  plan: string[];
  onStep?: (index: number) => void;
}

export function createMockBackend() {
  let leads = seededLeads(137);
  let nextLeadId = leads.length + 1;
  let serper: SerperStatus = { configured: true, source: "settings", last4: "a1b2" };
  let company: CompanyProfile | null = { name: "Norte Digital", offering: "Sites e tráfego pago para escritórios", tone: "próximo e direto" };
  let providers: AiProvider[] = [
    { id: "p1", kind: "openai", label: "Minha OpenAI", model: "gpt-5-mini", base_url: null, has_key: true, last4: "9xQz", is_active: false, created_at: now() },
  ];
  // WhatsApp (instances, chats, media, send, SSE, campaigns): dev/mock-whatsapp.ts
  const wa = createWaMock(() => leads);
  const jobs = new Map<string, MockJob>();
  // Tag registry: slug → first-seen display name (ids by insertion order).
  const tagNames = new Map<string, string>();
  const registerTag = (raw: string): string | null => {
    const name = normalizeTagName(raw);
    if (!name) return null;
    const slug = tagSlug(name);
    if (!tagNames.has(slug)) tagNames.set(slug, name);
    return tagNames.get(slug)!;
  };
  const sortTags = (list: string[]) => [...list].sort((a, b) => tagSlug(a).localeCompare(tagSlug(b)));
  const addTagsTo = (lead: Lead, names: string[]): boolean => {
    const own = lead.tags ?? [];
    const fresh = names.filter((n) => !own.some((t) => tagSlug(t) === tagSlug(n)));
    if (fresh.length) lead.tags = sortTags([...own, ...fresh]);
    return fresh.length > 0;
  };
  for (const lead of leads) lead.tags = sortTags((lead.tags ?? []).map((t) => registerTag(t)!));
  const listTagsView = (): Tag[] =>
    [...tagNames.entries()]
      .map(([slug, name], index) => ({ id: index + 1, name, slug, lead_count: leads.filter((l) => (l.tags ?? []).some((t) => tagSlug(t) === slug)).length }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  /** Validates an optional `tags` body field: [] when absent, null when invalid. */
  const parseTags = (value: unknown): string[] | null => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((t) => typeof t !== "string" || !normalizeTagName(t))) return null;
    const names: string[] = [];
    for (const t of value as string[]) if (!names.some((n) => tagSlug(n) === tagSlug(t))) names.push(normalizeTagName(t)!);
    return names.length > 20 ? null : names;
  };
  const TAGS_INVALID = 'Campo "tags" inválido: envie uma lista de textos de 1 a 40 caracteres (no máximo 20 tags).';
  /** Adds tags to a search (union) and applies the new ones to its existing leads. */
  const addSearchTags = (search: MockSearch, names: string[]) => {
    const fresh = names.map((n) => registerTag(n)!).filter((n) => !search.tags.some((t) => tagSlug(t) === tagSlug(n)));
    if (!fresh.length) return;
    search.tags = sortTags([...search.tags, ...fresh]);
    for (const lead of leads) if (lead.search_id === search.id) addTagsTo(lead, fresh);
  };
  // Seeded leads use search_id 1..3. #2 ran dry 3 h ago; #3 has only 8 results left.
  const searches: MockSearch[] = [
    mockSearch(1, "escritórios de advocacia", "São Paulo-SP", 0.2, { tags: ["Advocacia"] }),
    mockSearch(2, "clínicas odontológicas", "Campinas-SP", 3, { exhausted_at: new Date(Date.now() - 3 * 3_600_000).toISOString(), available: 0 }),
    mockSearch(3, "academias", "Curitiba-PR", 50, { available: 8 }),
  ];

  const runningJobFor = (searchId: number) =>
    [...jobs.values()].find((j) => j.search_id === searchId && j.status === "running") ?? null;
  const recentlyExhausted = (search: MockSearch) =>
    search.exhausted_at !== null && Date.now() - Date.parse(search.exhausted_at) < EXHAUSTED_TTL_MS;
  const searchView = ({ available: _available, ...search }: MockSearch): Search => {
    const running = runningJobFor(search.id);
    return {
      ...search,
      lead_count: leads.filter((l) => l.search_id === search.id).length,
      status: running ? "running" : recentlyExhausted({ ...search, available: 0 }) ? "exhausted" : "idle",
      running_job_id: running?.id ?? null,
    };
  };

  /** Shared tail of POST /api/searches and /api/searches/:id/more (same order as the server). */
  function startSearchJob(search: MockSearch, n: number, tags: string[] = []): Response {
    const running = runningJobFor(search.id);
    if (running) addSearchTags(search, tags);
    if (running) return json({ job_id: running.id, search_id: search.id, steps: running.steps, already_running: true }, 202);
    if (recentlyExhausted(search)) return json({ error: EXHAUSTED_MESSAGE, code: "exhausted" }, 409);
    if (!serper.configured) return error(MISSING_KEY_MESSAGE, 503);
    addSearchTags(search, tags);
    search.last_used_at = now();
    const collect = Math.min(n, search.available);
    const exhausted = collect < n;
    const pages = Math.max(1, Math.ceil(collect / 10));
    const plan: string[] = ["Buscando no Google Places via Serper (paginação com cursor)..."];
    for (let p = 1; p <= pages; p++) plan.push(`Página ${search.last_page + p} processada: ${Math.min(p * 10, collect)}/${n} novos leads (0 duplicados ignorados).`);
    plan.push(
      exhausted
        ? `A fonte esgotou os resultados: ${collect} novos leads coletados (pedido: ${n}).`
        : `Coleta concluída: ${collect} novos leads salvos.`,
    );
    plan.push("Pronto! Os leads já estão disponíveis na grid.");
    const job = newJob(plan, search.id, { collected_new: collect, duplicates_skipped: 0, pages_consumed: pages, enriched: 0, exhausted });
    job.onStep = (i) => {
      if (i >= 1 && i <= pages) {
        const add = Math.min(10, collect - (i - 1) * 10);
        const fresh = seededLeads(add).map((l) => ({ ...l, id: nextLeadId++, search_id: search.id, name: `${l.name} (${search.city})`, collected_at: now(), tags: [...search.tags] }));
        leads.push(...fresh);
        search.available -= add;
        search.last_page += 1;
        search.total_collected += add;
      }
      if (i === pages + 1) {
        if (exhausted) search.exhausted_at = now();
        else if (collect > 0) search.exhausted_at = null;
      }
    };
    return json({ job_id: job.id, search_id: search.id, steps: [{ at: now(), message: `Pedido entendido: ${n} leads de "${search.niche}" em ${search.city}.` }], already_running: false }, 202);
  }
  const validateJobs = new Map<string, ValidateJob & { paused_once: boolean }>();

  function runJob(job: MockJob, intervalMs: number) {
    let index = 0;
    const tick = () => {
      if (index < job.plan.length) {
        job.steps.push({ at: now(), message: job.plan[index]! });
        job.onStep?.(index);
        job.updated_at = now();
        index++;
        setTimeout(tick, intervalMs);
      } else {
        job.status = "completed";
        job.updated_at = now();
      }
    };
    setTimeout(tick, intervalMs);
  }

  function newJob(plan: string[], searchId: number | null, result: Job["result"]): MockJob {
    const job: MockJob = {
      id: crypto.randomUUID(),
      status: "running",
      search_id: searchId,
      steps: [],
      result: null,
      error: null,
      created_at: now(),
      updated_at: now(),
      plan,
    };
    const finalResult = result;
    jobs.set(job.id, job);
    const originalRun = runJob;
    originalRun(job, 1100);
    // result becomes visible when completed
    const check = setInterval(() => {
      if (job.status === "completed") {
        job.result = finalResult;
        clearInterval(check);
      }
    }, 200);
    return job;
  }

  function listLeads(url: URL) {
    const filter = (url.searchParams.get("filter") ?? "").toLowerCase();
    const searchId = Number(url.searchParams.get("search_id")) || null;
    const wantedTags = (url.searchParams.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const tagsMode = url.searchParams.get("tags_mode") === "all" ? "all" : "any";
    const [col, dir] = (url.searchParams.get("sort") ?? "").split(":");
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(url.searchParams.get("page_size")) || 50));
    let rows = leads.filter(
      (l) =>
        (searchId === null || l.search_id === searchId) &&
        matchesTags(l, wantedTags, tagsMode) &&
        (!filter ? true : [l.name, l.category, l.address, l.phone, l.email, l.website].some((v) => v?.toLowerCase().includes(filter))),
    );
    const sortable = ["id", "name", "category", "rating", "rating_count", "position", "collected_at", "is_whatsapp"];
    if (col && sortable.includes(col)) {
      const sign = dir === "desc" ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const va = a[col as keyof Lead];
        const vb = b[col as keyof Lead];
        if (va == null && vb == null) return 0;
        if (va == null) return -1 * sign; // SQLite: NULLs first in ASC
        if (vb == null) return 1 * sign;
        return (typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "pt-BR")) * sign;
      });
    }
    return { leads: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, page_size: pageSize };
  }

  async function body<T>(req: Request): Promise<T | undefined> {
    try {
      return (await req.json()) as T;
    } catch {
      return undefined;
    }
  }

  const aiChat = createMockAiChat({
    getLeads: () => leads,
    aiEnabled: () => providers.some((p) => p.is_active),
    startProspect: async (text) => {
      const res = await handle(
        new Request("http://mock/api/prospect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }),
        new URL("http://mock/api/prospect"),
      );
      const data = (await res.json()) as { job_id?: string; search_id?: number; already_running?: boolean; error?: string };
      if (!res.ok || !data.job_id) throw new Error(data.error ?? "Falha ao iniciar a busca.");
      return { job_id: data.job_id, search_id: data.search_id ?? 1, already_running: Boolean(data.already_running) };
    },
  });

  async function handle(req: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(/\/+$/, "");
    const m = req.method;
    // Same 415 rule as the real WhatsApp routes: JSON writes must say so.
    // (POST /api/wa/media is multipart, like the real route.)
    if (m !== "GET" && m !== "HEAD" && path !== "/api/wa/media" && !(req.headers.get("content-type") ?? "").startsWith("application/json")) {
      return error("Content-Type deve ser application/json.", 415);
    }
    await Bun.sleep(150 + Math.random() * 200); // feel the loading states

    /* ---- leads ---- */
    if (path === "/api/leads" && m === "GET") return json(listLeads(url));
    if (path === "/api/leads" && m === "DELETE") {
      const ids = (await body<{ ids: number[] }>(req))?.ids ?? [];
      const before = leads.length;
      leads = leads.filter((l) => !ids.includes(l.id));
      return json({ deleted: before - leads.length });
    }
    if (path === "/api/tags" && m === "GET") return json({ tags: listTagsView() });
    if (path === "/api/leads/tags" && m === "POST") {
      const input = (await body<{ lead_ids?: unknown; add?: unknown; remove?: unknown }>(req)) ?? {};
      const ids = input.lead_ids;
      const add = parseTags(input.add);
      const remove = parseTags(input.remove);
      const invalid = 'Corpo inválido. Envie JSON: {"lead_ids": [1, 2], "add": ["academia"], "remove": ["frio"]} com 1 a 5000 IDs e pelo menos uma tag.';
      if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || ids.some((id) => !Number.isInteger(id))) return error(invalid, 400);
      if (add === null || remove === null) return error(TAGS_INVALID, 400);
      if (!add.length && !remove.length) return error(invalid, 400);
      const names = add.map((n) => registerTag(n)!);
      const removeSlugs = new Set(remove.map(tagSlug));
      let updated = 0;
      for (const lead of leads) {
        if (!ids.includes(lead.id)) continue;
        const before = (lead.tags ?? []).join("|");
        addTagsTo(lead, names);
        lead.tags = (lead.tags ?? []).filter((t) => !removeSlugs.has(tagSlug(t)));
        if (lead.tags.join("|") !== before) updated++;
      }
      return json({ updated, tags: listTagsView() });
    }
    if (path === "/api/leads/enrich" && m === "POST") {
      const ids = (await body<{ ids: number[] }>(req))?.ids ?? [];
      if (!ids.length || ids.length > 1000) return error('Corpo inválido. Envie JSON: {"ids": [1, 2, 3]} com 1 a 1000 IDs de leads.', 400);
      const targets = leads.filter((l) => ids.includes(l.id) && l.website);
      const plan = [
        `Enriquecimento iniciado: ${targets.length} sites para visitar (${ids.length - targets.length} sem site ignorados).`,
        `Enriquecimento em andamento: ${Math.ceil(targets.length / 2)}/${targets.length} sites visitados (1 e-mails encontrados).`,
        `Enriquecimento concluído: ${targets.length}/${targets.length} sites visitados (2 e-mails encontrados).`,
      ];
      const job = newJob(plan, null, { collected_new: 0, duplicates_skipped: 0, pages_consumed: 0, enriched: 2, exhausted: false });
      job.onStep = (i) => {
        if (i === 2) for (const l of targets.slice(0, 2)) if (!l.email) l.email = `ola@${new URL(l.website!).hostname.replace(/^www\./, "")}`;
        for (const l of targets) l.enriched_at = now();
      };
      return json({ job_id: job.id }, 202);
    }
    const leadMatch = /^\/api\/leads\/(\d+)$/.exec(path);
    if (leadMatch && m === "GET") {
      const lead = leads.find((l) => l.id === Number(leadMatch[1]));
      return lead ? json({ lead }) : error("Lead não encontrado.", 404);
    }
    /* ---- searches ---- */
    if (path === "/api/searches" && m === "GET") return json({ searches: searches.map(searchView) });
    if (path === "/api/searches" && m === "POST") {
      const input = (await body<{ niche?: unknown; city?: unknown; count?: unknown; tags?: unknown }>(req)) ?? {};
      const text = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
      const niche = text(input.niche);
      const city = text(input.city);
      const n = input.count;
      if (niche.length < 2 || niche.length > 200) return error('Campo "niche" obrigatório: o nicho da busca (2 a 200 caracteres).', 400);
      if (city.length < 2 || city.length > 200) return error('Campo "city" obrigatório: a cidade da busca (2 a 200 caracteres), ex.: "Cascavel-PR".', 400);
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 500) return error('Campo "count" obrigatório: um número inteiro de 1 a 500.', 400);
      const tags = parseTags(input.tags);
      if (tags === null) return error(TAGS_INVALID, 400);
      const key = `${niche} ${city}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const existing = searches.find((x) => x.query_normalized === key);
      if (!existing && !serper.configured) return error(MISSING_KEY_MESSAGE, 503);
      // New combos: cities containing "Vazia" have nothing; others have 35 results.
      const search =
        existing ??
        mockSearch(Math.max(0, ...searches.map((x) => x.id)) + 1, niche, city, 0, { last_page: 0, total_collected: 0, available: /vazia/i.test(city) ? 0 : 35 });
      if (!existing) searches.push(search);
      return startSearchJob(search, n, tags);
    }
    const moreMatch = /^\/api\/searches\/([^/]+)\/more$/.exec(path);
    if (moreMatch && m === "POST") {
      const search = searches.find((x) => x.id === Number(moreMatch[1]));
      if (!search) return error("Busca não encontrada.", 404);
      const input = (await body<{ count?: unknown; tags?: unknown }>(req)) ?? {};
      const n = input.count;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 500) return error('Campo "count" obrigatório: um número inteiro de 1 a 500.', 400);
      const tags = parseTags(input.tags);
      if (tags === null) return error(TAGS_INVALID, 400);
      return startSearchJob(search, n, tags);
    }
    const searchTagsMatch = /^\/api\/searches\/([^/]+)\/tags$/.exec(path);
    if (searchTagsMatch && m === "PUT") {
      const search = searches.find((x) => x.id === Number(searchTagsMatch[1]));
      if (!search) return error("Busca não encontrada.", 404);
      const tags = parseTags((await body<{ tags?: unknown }>(req))?.tags);
      if (tags === null || !Array.isArray(tags)) return error(TAGS_INVALID, 400);
      // Replace: dropped tags leave the search only (they stay on the leads).
      const keep = new Set(tags.map(tagSlug));
      search.tags = search.tags.filter((t) => keep.has(tagSlug(t)));
      addSearchTags(search, tags);
      return json({ search: searchView(search) });
    }

    /* ---- prospect / progress ---- */
    if (path === "/api/prospect" && m === "POST") {
      const prospectBody = (await body<{ text?: string; tags?: unknown }>(req)) ?? {};
      const text = (prospectBody.text ?? "").trim();
      if (!text) return error('Campo "text" obrigatório com o pedido em português.', 400);
      const prospectTags = parseTags(prospectBody.tags);
      if (prospectTags === null) return error(TAGS_INVALID, 400);
      if (!serper.configured) {
        return error("SERPER_API_KEY ausente. Cadastre sua chave em Configurações → Serper, ou adicione SERPER_API_KEY ao arquivo .env.", 503);
      }
      const more = /^mais\s+(\d+)/i.exec(text);
      const top = /(\d+)/.exec(text);
      if (!more && !/(busque|top|traga)/i.test(text)) return error("Não entendi o pedido. Tente: “Busque os 50 principais dentistas de Campinas-SP”.", 422);
      const n = Math.min(Number((more ?? top)?.[1] ?? 20), 60);
      const plan: string[] = [`Pesquisa entendida: ${n} leads.`];
      const pages = Math.max(1, Math.ceil(n / 10));
      for (let p = 1; p <= pages; p++) plan.push(`Página ${p} processada: ${Math.min(p * 10, n)}/${n} novos leads (0 duplicados ignorados).`);
      plan.push(`Enriquecimento em andamento: ${Math.ceil(n / 2)}/${n} sites visitados (3 e-mails encontrados).`);
      const job = newJob(plan, 1, { collected_new: n, duplicates_skipped: 1, pages_consumed: pages, enriched: 3, exhausted: n >= 60 });
      const target = searches.find((x) => x.id === 1)!;
      addSearchTags(target, prospectTags);
      job.onStep = (i) => {
        if (i >= 1 && i <= pages) {
          const add = Math.min(10, n - (i - 1) * 10);
          const fresh = seededLeads(add).map((l) => ({ ...l, id: nextLeadId++, search_id: 1, name: `${l.name} (novo)`, collected_at: now(), tags: [...target.tags] }));
          leads.push(...fresh);
        }
      };
      return json({ job_id: job.id, search_id: 1, steps: [{ at: now(), message: "Pedido recebido." }], already_running: false }, 202);
    }
    const progressMatch = /^\/api\/progress\/([^/]+)$/.exec(path);
    if (progressMatch && m === "GET") {
      const job = jobs.get(progressMatch[1]!);
      if (!job) return error("Job não encontrado.", 404);
      const { plan: _plan, onStep: _onStep, ...view } = job;
      return json({ job: view });
    }

    /* ---- settings ---- */
    if (path === "/api/settings" && m === "GET") return json({ serper, company_profile: company, secrets_unreadable: false });
    if (path === "/api/settings/serper" && m === "PUT") {
      const key = ((await body<{ api_key: string }>(req))?.api_key ?? "").trim();
      if (!key) return error('Campo "api_key" obrigatório com a chave do Serper.', 400);
      serper = { configured: true, source: "settings", last4: key.length > 4 ? key.slice(-4) : null };
      return json(serper);
    }
    if (path === "/api/settings/serper" && m === "DELETE") {
      serper = { configured: false, source: null, last4: null };
      return json(serper);
    }
    if (path === "/api/settings/serper/test" && m === "POST") {
      return json(serper.configured ? { ok: true } : { ok: false, error: "Nenhuma chave do Serper configurada." });
    }
    if (path === "/api/settings/company" && m === "PUT") {
      const input = (await body<Record<string, string>>(req)) ?? {};
      const cleaned = Object.fromEntries(Object.entries(input).filter(([, v]) => typeof v === "string" && v.trim()));
      company = Object.keys(cleaned).length ? cleaned : null;
      return json({ company_profile: company });
    }

    /* ---- AI ---- */
    if (path === "/api/ai/status" && m === "GET") {
      const active = providers.find((p) => p.is_active);
      return json({ enabled: Boolean(active), provider: active ? { id: active.id, kind: active.kind, label: active.label, model: active.model } : null });
    }
    if (path === "/api/ai/models" && m === "GET") {
      const kind = url.searchParams.get("kind") as ProviderKind;
      const models: Record<ProviderKind, Array<{ id: string; label: string }>> = {
        openai: [
          { id: "gpt-5.1", label: "GPT-5.1" },
          { id: "gpt-5-mini", label: "GPT-5 mini (econômico)" },
        ],
        google: [{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (econômico)" }],
        anthropic: [{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }],
        openrouter: [{ id: "openai/gpt-5-mini", label: "OpenAI GPT-5 mini" }],
        openai_compatible: [{ id: "llama3.1", label: "Llama 3.1 (Ollama)" }],
      };
      return models[kind] ? json({ kind, models: models[kind] }) : error('Parâmetro "kind" inválido.', 400);
    }
    if (path === "/api/ai/providers" && m === "GET") return json({ providers });
    if (path === "/api/ai/providers" && m === "POST") {
      const input = (await body<Partial<AiProvider> & { api_key?: string }>(req)) ?? {};
      if (!input.model) return error("Informe o modelo.", 400);
      if (input.kind === "openai_compatible" && !input.base_url) return error("URL base obrigatória para provedores compatíveis com OpenAI.", 400);
      if (input.kind !== "openai_compatible" && !input.api_key) return error("Chave de API obrigatória.", 400);
      const provider: AiProvider = {
        id: crypto.randomUUID(),
        kind: input.kind as ProviderKind,
        label: input.label || String(input.kind),
        model: input.model,
        base_url: input.base_url ?? null,
        has_key: Boolean(input.api_key),
        last4: input.api_key && input.api_key.length > 4 ? input.api_key.slice(-4) : null,
        is_active: !providers.some((p) => p.is_active),
        created_at: now(),
      };
      providers.push(provider);
      return json({ provider }, 201);
    }
    const providerMatch = /^\/api\/ai\/providers\/([^/]+)(?:\/(activate|test))?$/.exec(path);
    if (providerMatch) {
      const provider = providers.find((p) => p.id === providerMatch[1]);
      if (!provider) return error("Provedor não encontrado.", 404);
      const action = providerMatch[2];
      if (!action && m === "PATCH") {
        const input = (await body<Partial<AiProvider> & { api_key?: string }>(req)) ?? {};
        if (input.label !== undefined) provider.label = input.label;
        if (input.model) provider.model = input.model;
        if (input.base_url !== undefined) provider.base_url = input.base_url || null;
        if (input.api_key) Object.assign(provider, { has_key: true, last4: input.api_key.slice(-4) });
        return json({ provider });
      }
      if (!action && m === "DELETE") {
        providers = providers.filter((p) => p !== provider);
        return json({ ok: true });
      }
      if (action === "activate" && m === "POST") {
        for (const p of providers) p.is_active = p === provider;
        return json({ provider });
      }
      if (action === "test" && m === "POST") {
        await Bun.sleep(600);
        return json(provider.model.includes("erro") ? { ok: false, error: "Modelo não encontrado no provedor.", latency_ms: 95 } : { ok: true, latency_ms: 812 });
      }
    }
    if (path === "/api/ai/deactivate" && m === "POST") {
      for (const p of providers) p.is_active = false;
      return json({ ok: true });
    }

    /* ---- AI chat (fake /api/chat stream: dev/mock-ai-chat.ts) ---- */
    if (path === "/api/chat" || path.startsWith("/api/chat/")) {
      const handled = await aiChat.handle(req, path);
      if (handled) return handled;
    }

    /* ---- WhatsApp ---- */
    if (path.startsWith("/api/wa/") && !path.startsWith("/api/wa/validate")) {
      const handled = await wa.handle(req, url, path);
      if (handled) return handled;
    }
    if (path === "/api/wa/validate" && m === "POST") {
      const input = (await body<{ instance: string; lead_ids: number[] }>(req)) ?? { instance: "", lead_ids: [] };
      if (!input.lead_ids?.length) return error('Campo "lead_ids" deve ser uma lista não vazia.', 400);
      const job: ValidateJob & { paused_once: boolean } = {
        job_id: `val${crypto.randomUUID().slice(0, 12)}`,
        instance: input.instance,
        status: "running",
        total: input.lead_ids.length,
        checked: 0,
        is_whatsapp: 0,
        not_whatsapp: 0,
        ambiguous: 0,
        failed: 0,
        reason: null,
        eta_seconds: input.lead_ids.length * 3,
        results: input.lead_ids.map((lead_id) => ({ lead_id, phone: null, is_whatsapp: null })),
        paused_once: false,
      };
      validateJobs.set(job.job_id, job);
      driveValidate(job);
      return json({ job_id: job.job_id }, 202);
    }
    const valMatch = /^\/api\/wa\/validate\/([^/]+)(\/resume)?$/.exec(path);
    if (valMatch) {
      const job = validateJobs.get(valMatch[1]!);
      if (!job) return error("Job de validação não encontrado.", 404);
      if (valMatch[2] && m === "POST") {
        if (job.status !== "paused") return error("Esta validação já está em andamento.", 409);
        job.status = "running";
        job.reason = null;
        driveValidate(job);
        return json({ ok: true, job_id: job.job_id });
      }
      if (!valMatch[2] && m === "GET") {
        const { paused_once: _p, ...view } = job;
        return json(view);
      }
    }
    if (path.startsWith("/api/wa/")) return error("Rota /api/wa não encontrada (mock).", 404);

    return error("Rota não encontrada.", 404);
  }

  function driveValidate(job: ValidateJob & { paused_once: boolean }) {
    const tick = () => {
      if (job.status !== "running") return;
      const next = job.results.find((r) => r.is_whatsapp === null && !r.reason);
      if (!next) {
        job.status = "done";
        job.eta_seconds = null;
        return;
      }
      const lead = leads.find((l) => l.id === next.lead_id);
      const roll = next.lead_id % 7;
      if (!lead?.phone) {
        next.reason = "sem telefone";
      } else if (roll === 3) {
        next.reason = "duas contas distintas — decisão humana";
        job.ambiguous++;
      } else if (roll === 5) {
        next.is_whatsapp = false;
        job.not_whatsapp++;
        lead.is_whatsapp = 0;
      } else {
        next.is_whatsapp = true;
        job.is_whatsapp++;
        lead.is_whatsapp = 1;
        lead.whatsapp_jid = `55${lead.phone.replace(/\D/g, "").slice(-11)}@s.whatsapp.net`;
      }
      job.checked++;
      job.eta_seconds = (job.total - job.checked) * 3;
      // Pause once mid-way so the "Retomar" flow can be exercised.
      if (!job.paused_once && job.checked === Math.min(3, job.total - 1)) {
        job.paused_once = true;
        job.status = "paused";
        job.reason = "limite por hora atingido";
        return;
      }
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 1500);
  }

  return { handle };
}
