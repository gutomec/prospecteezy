import type { Database } from "bun:sqlite";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { nowIso } from "../db/index.ts";
import { addLeadEvent, findOrCreateSearch, getLead, listSearches, type LeadRow } from "../db/repository.ts";
import { isRecentlyExhausted, startStructuredProspectJob } from "../agent/orchestrator.ts";
import { getTagsBySearch, getTagsForLeads, MAX_TAGS_PER_REQUEST, normalizeTagName, TAG_MAX_LENGTH, tagFilterClause } from "../db/tags.ts";
import { crawlWebsite, defaultResolveHost, isUrlAllowed, type HostResolver } from "../ingest/email-crawler.ts";
import { createSerperFetcher, MissingApiKeyError, serperRequest, type PlacesFetcher } from "../ingest/serper.ts";
import { getCompanyProfile } from "../settings/repo.ts";
import type { SendToLeadResult } from "../whatsapp/send-to-lead.ts";
import {
  buildSerperBody,
  estimateSerperCredits,
  SERPER_CATALOG,
  SERPER_TYPES,
  serperCatalogText,
  trimSerperBody,
  validateSerperParams,
  type SerperParams,
} from "./serper-catalog.ts";

export interface ToolDeps {
  db: Database;
  providerKind: string;
  getSerperKey: () => Promise<string | null>;
  /** fetch used for generic Serper calls (tests inject a fake). */
  serperFetch?: typeof fetch;
  /** Places fetcher for start_prospect_search (tests); default = real client with the resolved key. */
  prospectFetcher?: PlacesFetcher;
  skipEnrichment?: boolean;
  crawlerFetch?: typeof fetch;
  crawlerResolveHost?: HostResolver;
  sendToLead: (leadId: number, text: string) => Promise<SendToLeadResult>;
  /** Accumulates Serper credits actually billed during this run. */
  addCredits: (credits: number) => void;
}

/** Tools that spend credits, mutate data or contact external sites. */
export const APPROVAL_TOOLS = [
  "start_prospect_search",
  "serper_search",
  "scrape_webpage",
  "crawl_lead_website",
  "save_lead_enrichment",
  "send_whatsapp_message",
] as const;

const MAX_SCRAPE_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 4_096;

const leadId = z.number().int().positive().describe("ID do lead (coluna id)");
const tagList = z
  .array(z.string().refine((t) => normalizeTagName(t) !== null, `Cada tag deve ter de 1 a ${TAG_MAX_LENGTH} caracteres.`))
  .max(MAX_TAGS_PER_REQUEST);

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function requireLead(db: Database, id: number): LeadRow {
  const lead = getLead(db, id);
  if (!lead) throw new Error(`Lead #${id} não encontrado.`);
  return lead;
}

async function requireSerperKey(deps: ToolDeps): Promise<string> {
  const key = await deps.getSerperKey();
  if (!key) throw new MissingApiKeyError();
  return key;
}

const serperInput = z
  .object({
    type: z.enum(SERPER_TYPES).describe("Endpoint do Serper"),
    q: z.string().max(500).optional(),
    gl: z.string().max(10).default("br"),
    hl: z.string().max(10).default("pt-br"),
    location: z.string().max(200).optional(),
    num: z.number().int().min(1).max(100).optional(),
    page: z.number().int().min(1).max(100).optional(),
    tbs: z.string().max(20).optional().describe("qdr:h | qdr:d | qdr:w | qdr:m | qdr:y"),
    ll: z.string().max(60).optional().describe("@latitude,longitude,zoomz"),
    cid: z.string().max(100).optional(),
    placeId: z.string().max(200).optional(),
    fid: z.string().max(200).optional(),
    url: z.string().max(2000).optional(),
    sortBy: z.string().max(50).optional(),
    nextPageToken: z.string().max(500).optional(),
  })
  .superRefine((input, ctx) => {
    const { type, ...params } = input;
    const error = validateSerperParams(type, serperParamsOf(params));
    if (error) ctx.addIssue({ code: "custom", message: error });
  });

/** gl/hl defaults are only sent to types that accept them. */
function serperParamsOf(input: Record<string, unknown>): SerperParams {
  const params: SerperParams = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number") params[key as keyof SerperParams] = value;
  }
  return params;
}

function acceptedParams(type: (typeof SERPER_TYPES)[number], params: SerperParams): SerperParams {
  const out: SerperParams = {};
  for (const key of SERPER_CATALOG[type].params) if (params[key] !== undefined) out[key] = params[key];
  return out;
}

const enrichmentSchema = z.object({
  summary: z.string().max(4000).optional(),
  segment: z.string().max(500).optional(),
  size_estimate: z.string().max(500).optional(),
  decision_makers: z
    .array(z.object({ name: z.string().max(200), role: z.string().max(200).optional(), source_url: z.string().max(2000).optional() }))
    .max(20)
    .optional(),
  socials: z.record(z.string(), z.string().max(2000)).optional(),
  extra_emails: z.array(z.string().max(320)).max(20).optional(),
  extra_phones: z.array(z.string().max(50)).max(20).optional(),
  notes: z.string().max(4000).optional(),
  sources: z.array(z.string().max(2000)).max(30).optional(),
});

export function createTools(deps: ToolDeps) {
  const { db } = deps;
  return {
    get_company_profile: tool({
      description:
        "Lê o perfil da empresa do usuário (nome, oferta, público, diferenciais, tom, assinatura, CTA). Use antes de redigir mensagens.",
      inputSchema: z.object({}),
      execute: async () => {
        const profile = getCompanyProfile(db);
        return profile
          ? { profile }
          : { profile: null, note: "Perfil da empresa vazio. Peça ao usuário para preencher em Configurações → Perfil da empresa." };
      },
    }),

    list_searches: tool({
      description: "Lista as pesquisas de prospecção já feitas (nicho, cidade, quantidade de leads).",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = listSearches(db);
        const tags = getTagsBySearch(db);
        return {
          searches: rows.slice(0, 50).map((s) => ({
            id: s.id,
            niche: s.niche,
            city: s.city,
            tags: tags.get(s.id) ?? [],
            lead_count: s.lead_count,
            last_page: s.last_page,
            created_at: s.created_at,
          })),
        };
      },
    }),

    query_leads: tool({
      description:
        "Consulta leads no banco local (sem custo). Filtros opcionais; retorna linhas compactas e exibe os leads na conversa.",
      inputSchema: z.object({
        search_id: z.number().int().positive().optional(),
        text: z.string().max(200).optional().describe("Busca em nome, categoria e endereço"),
        city: z.string().max(200).optional().describe("Trecho do endereço/cidade"),
        has_email: z.boolean().optional(),
        is_whatsapp: z.enum(["yes", "no", "unknown"]).optional(),
        has_ai_enrichment: z.boolean().optional(),
        tags: tagList.optional().describe("Leads com qualquer uma destas tags (nome; maiúsculas e acentos ignorados)"),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async (input) => {
        const clauses: string[] = [];
        const args: (string | number)[] = [];
        if (input.search_id !== undefined) {
          clauses.push("search_id = ?");
          args.push(input.search_id);
        }
        if (input.text) {
          clauses.push("(name LIKE ? OR category LIKE ? OR address LIKE ?)");
          args.push(`%${input.text}%`, `%${input.text}%`, `%${input.text}%`);
        }
        if (input.city) {
          clauses.push("address LIKE ?");
          args.push(`%${input.city}%`);
        }
        if (input.has_email !== undefined) clauses.push(input.has_email ? "email IS NOT NULL" : "email IS NULL");
        if (input.is_whatsapp === "yes") clauses.push("is_whatsapp = 1");
        if (input.is_whatsapp === "no") clauses.push("is_whatsapp = 0");
        if (input.is_whatsapp === "unknown") clauses.push("is_whatsapp IS NULL");
        if (input.has_ai_enrichment !== undefined) {
          clauses.push(input.has_ai_enrichment ? "ai_enrichment_json IS NOT NULL" : "ai_enrichment_json IS NULL");
        }
        const tagClause = input.tags?.length ? tagFilterClause(input.tags, "any") : null;
        if (tagClause) {
          clauses.push(tagClause.sql);
          args.push(...tagClause.args);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const total = (db.query(`SELECT COUNT(*) AS n FROM leads ${where}`).get(...args) as { n: number }).n;
        const rows = db
          .query(
            `SELECT id, search_id, name, category, address, phone, email, website, rating, is_whatsapp,
                    ai_enrichment_json IS NOT NULL AS has_ai_enrichment
             FROM leads ${where} ORDER BY id ASC LIMIT ?`,
          )
          .all(...args, input.limit) as Array<Record<string, unknown> & { id: number }>;
        const tags = getTagsForLeads(db, rows.map((r) => r.id));
        return {
          total,
          leads: rows.map((r) => ({ ...r, has_ai_enrichment: r.has_ai_enrichment === 1, tags: tags.get(r.id) ?? [] })),
        };
      },
    }),

    get_lead: tool({
      description: "Lê todos os dados de um lead, incluindo o enriquecimento por IA e os eventos recentes.",
      inputSchema: z.object({ lead_id: leadId }),
      execute: async ({ lead_id }) => {
        const lead = requireLead(db, lead_id) as LeadRow & { ai_enrichment_json?: string | null };
        const events = db
          .query("SELECT event, payload_json, created_at FROM lead_events WHERE lead_id = ? ORDER BY id DESC LIMIT 10")
          .all(lead_id) as Array<{ event: string; payload_json: string | null; created_at: string }>;
        const { socials_json, ai_enrichment_json, ...rest } = lead;
        return {
          lead: {
            ...rest,
            tags: getTagsForLeads(db, [lead_id]).get(lead_id) ?? [],
            socials: parseJson(socials_json),
            ai_enrichment: parseJson(ai_enrichment_json ?? null),
          },
          events: events.map((e) => ({ event: e.event, payload: parseJson(e.payload_json), at: e.created_at })),
        };
      },
    }),

    lead_stats: tool({
      description: "Totais da base de leads: com e-mail, com site, WhatsApp sim/não/não verificado, por pesquisa.",
      inputSchema: z.object({}),
      execute: async () => {
        const totals = db
          .query(
            `SELECT COUNT(*) AS total,
                    SUM(email IS NOT NULL) AS with_email,
                    SUM(website IS NOT NULL) AS with_website,
                    SUM(is_whatsapp = 1) AS whatsapp_yes,
                    SUM(is_whatsapp = 0) AS whatsapp_no,
                    SUM(is_whatsapp IS NULL) AS whatsapp_unknown,
                    SUM(ai_enrichment_json IS NOT NULL) AS with_ai_enrichment
             FROM leads`,
          )
          .get() as Record<string, number | null>;
        const perSearch = db
          .query(
            `SELECT s.id AS search_id, s.niche, s.city, COUNT(l.id) AS leads
             FROM searches s LEFT JOIN leads l ON l.search_id = s.id
             GROUP BY s.id ORDER BY s.id DESC LIMIT 50`,
          )
          .all();
        const n = (v: number | null | undefined) => v ?? 0;
        return {
          total: n(totals.total),
          with_email: n(totals.with_email),
          with_website: n(totals.with_website),
          whatsapp: { yes: n(totals.whatsapp_yes), no: n(totals.whatsapp_no), unknown: n(totals.whatsapp_unknown) },
          with_ai_enrichment: n(totals.with_ai_enrichment),
          per_search: perSearch,
        };
      },
    }),

    present_message_draft: tool({
      description:
        "Mostra ao usuário um rascunho de mensagem editável para um lead (não envia nada). Use depois de redigir a mensagem.",
      inputSchema: z.object({ lead_id: leadId, text: z.string().min(1).max(MAX_MESSAGE_CHARS) }),
      execute: async ({ lead_id, text }) => {
        const lead = requireLead(db, lead_id);
        const canSend = lead.is_whatsapp === 1 && Boolean(lead.whatsapp_jid);
        return {
          lead_id,
          lead_name: lead.name,
          text,
          can_send_whatsapp: canSend,
          shown_to_user: true,
          ...(canSend ? {} : { reason: "Lead sem WhatsApp validado: o envio pelo WhatsApp fica indisponível." }),
        };
      },
    }),

    start_prospect_search: tool({
      description:
        "Inicia uma prospecção (Google Places via Serper): coleta leads novos de um nicho numa cidade, sem duplicar, e enriquece e-mails em segundo plano. Custo: 1 crédito por página de 10 resultados. Requer aprovação. Espera a coleta terminar e devolve o resultado real (collected_new, exhausted, credits_used). O Google Maps devolve só algumas dezenas de empresas por combinação nicho + cidade: nunca divida a mesma combinação em várias chamadas; para volumes maiores, use termos diferentes (sinônimos, especialidades) ou outras cidades, cada um numa chamada.",
      inputSchema: z.object({
        niche: z.string().min(2).max(200).describe('Nicho, ex.: "escritórios de advocacia"'),
        city: z.string().min(2).max(200).describe('Cidade, ex.: "São Paulo-SP"'),
        count: z.number().int().min(1).describe("Quantidade de leads novos (sem limite; a coleta para quando a fonte esgota)"),
        tags: tagList.optional().describe("Tags da busca, aplicadas aos leads que ela coletou e vai coletar"),
      }),
      execute: async ({ niche, city, count, tags }) => {
        const fetcher = deps.prospectFetcher ?? createSerperFetcher({ apiKey: await requireSerperKey(deps) });
        const search = findOrCreateSearch(db, niche, city);
        if (isRecentlyExhausted(db, search.id)) {
          return {
            search_id: search.id,
            collected_new: 0,
            credits_used: 0,
            exhausted: true,
            message: `A busca "${niche}" em ${city} já esgotou os resultados do Google Maps nas últimas 24 horas; nenhum crédito foi gasto. Tente outro termo ou outra cidade.`,
          };
        }
        const { job, alreadyRunning, collected } = startStructuredProspectJob(
          {
            db,
            fetcher,
            skipEnrichment: deps.skipEnrichment,
            crawlerFetch: deps.crawlerFetch,
            crawlerResolveHost: deps.crawlerResolveHost,
          },
          { niche, city, count, tags },
        );
        if (alreadyRunning || !collected) {
          return {
            job_id: job.id,
            search_id: job.search_id,
            already_running: true,
            note: "Já existe uma coleta em andamento para esta busca; o progresso aparece na conversa.",
          };
        }
        const result = await collected;
        deps.addCredits(result.pagesConsumed);
        return {
          job_id: job.id,
          search_id: job.search_id,
          already_running: false,
          requested: count,
          collected_new: result.collectedNew,
          duplicates_skipped: result.duplicatesSkipped,
          credits_used: result.pagesConsumed,
          exhausted: result.exhausted,
          note: result.exhausted && result.collectedNew < count
            ? `O Google Maps só tinha ${result.collectedNew} empresas novas para "${niche}" em ${city}. A busca de e-mails continua em segundo plano.`
            : "Coleta concluída; a busca de e-mails continua em segundo plano.",
        };
      },
    }),

    serper_search: tool({
      description: `Consulta o Serper.dev (Google). Gasta créditos e requer aprovação. Escolha o tipo mais barato que responde à pergunta.\nTipos:\n${serperCatalogText()}\nPadrões: gl="br", hl="pt-br".`,
      inputSchema: serperInput,
      execute: async (input, { abortSignal }) => {
        const { type, ...rest } = input;
        const params = acceptedParams(type, serperParamsOf(rest));
        const result = await serperRequest({
          apiKey: await requireSerperKey(deps),
          type,
          body: buildSerperBody(type, params),
          estimatedCredits: estimateSerperCredits(type, params),
          fetchImpl: deps.serperFetch,
          signal: abortSignal,
        });
        deps.addCredits(result.credits);
        return { type, credits: result.credits, results: trimSerperBody(result.body) };
      },
    }),

    scrape_webpage: tool({
      description:
        "Lê o texto de uma página pública via Serper (scrape.serper.dev/webpage). Custa 2 créditos ou mais. Requer aprovação.",
      inputSchema: z.object({
        url: z.string().max(2000).describe("URL http(s) pública"),
        includeMarkdown: z.boolean().optional(),
      }),
      execute: async ({ url, includeMarkdown }, { abortSignal }) => {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error("URL inválida.");
        }
        if (!(await isUrlAllowed(parsed, deps.crawlerResolveHost ?? defaultResolveHost))) {
          throw new Error("URL recusada: só endereços http(s) públicos são permitidos.");
        }
        const result = await serperRequest({
          apiKey: await requireSerperKey(deps),
          type: "webpage",
          body: { url: parsed.href, ...(includeMarkdown ? { includeMarkdown: true } : {}) },
          estimatedCredits: 2,
          fetchImpl: deps.serperFetch,
          signal: abortSignal,
        });
        deps.addCredits(result.credits);
        const body = result.body;
        const content = String((includeMarkdown ? body.markdown : undefined) ?? body.text ?? "");
        return {
          url: parsed.href,
          credits: result.credits,
          metadata: body.metadata ?? null,
          text: content.slice(0, MAX_SCRAPE_CHARS),
          truncated: content.length > MAX_SCRAPE_CHARS,
        };
      },
    }),

    crawl_lead_website: tool({
      description:
        "Visita o site do lead com o crawler local (sem créditos Serper) e retorna e-mail e redes sociais encontrados. Não grava nada. Requer aprovação.",
      inputSchema: z.object({ lead_id: leadId }),
      execute: async ({ lead_id }) => {
        const lead = requireLead(db, lead_id);
        if (!lead.website) throw new Error(`O lead #${lead_id} não tem site cadastrado.`);
        const result = await crawlWebsite(lead.website, {
          fetchImpl: deps.crawlerFetch,
          resolveHost: deps.crawlerResolveHost,
        });
        return {
          lead_id,
          website: lead.website,
          email: result.email,
          socials: result.socials,
          pages_visited: result.pagesVisited,
          skipped_by_robots: result.skippedByRobots,
        };
      },
    }),

    save_lead_enrichment: tool({
      description:
        "Grava o enriquecimento por IA de um lead (resumo, segmento, decisores, redes, contatos extras, fontes). O e-mail só é gravado se o lead ainda não tiver. Requer aprovação. Nunca invente dados: use só o que as ferramentas retornaram.",
      inputSchema: z.object({
        lead_id: leadId,
        enrichment: enrichmentSchema,
        email: z.email().max(320).optional(),
      }),
      execute: async ({ lead_id, enrichment, email }) => {
        const lead = requireLead(db, lead_id);
        const emailSaved = Boolean(email) && !lead.email;
        db.transaction(() => {
          db.query(
            `UPDATE leads SET ai_enrichment_json = ?, ai_enriched_at = ?, email = COALESCE(email, ?) WHERE id = ?`,
          ).run(JSON.stringify(enrichment), nowIso(), emailSaved ? email! : null, lead_id);
          addLeadEvent(db, lead_id, "ai_enriched", {
            source: `ai:${deps.providerKind}`,
            fields: Object.keys(enrichment),
            ...(emailSaved ? { email } : {}),
          });
        })();
        return { saved: true, lead_id, email_saved: emailSaved };
      },
    }),

    send_whatsapp_message: tool({
      description:
        "Envia uma mensagem de WhatsApp para um lead já validado, pela instância ativa, respeitando o limite anti-banimento e o horário silencioso. Requer aprovação.",
      inputSchema: z.object({ lead_id: leadId, text: z.string().min(1).max(MAX_MESSAGE_CHARS) }),
      execute: async ({ lead_id, text }) => {
        const result = await deps.sendToLead(lead_id, text);
        return result.ok
          ? { sent: true, lead_id }
          : { sent: false, lead_id, code: result.code, reason: result.reason };
      },
    }),
  } satisfies ToolSet;
}

export type AgentTools = ReturnType<typeof createTools>;

// ---------------------------------------------------------------- approval texts

function clip(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function leadLabel(db: Database, id: unknown): string {
  const lead = typeof id === "number" ? getLead(db, id) : null;
  return lead ? `${lead.name} (lead #${lead.id})` : `lead #${String(id)}`;
}

/** What the approval card shows (sent as the approval descriptor). */
export interface ApprovalInfo {
  title: string;
  description: string;
  params: { label: string; value: string }[];
  estimated_credits: number;
}

/** Title, description, key params and credit estimate shown in the approval card. */
export function describeApproval(
  db: Database,
  toolName: string,
  input: Record<string, unknown>,
): ApprovalInfo {
  switch (toolName) {
    case "start_prospect_search": {
      const count = Number(input.count ?? 0);
      return {
        title: "Iniciar prospecção no Google Maps",
        description: `Buscar ${count} leads novos de "${input.niche}" em ${input.city} (Serper Places), salvar na base sem duplicar e procurar e-mails nos sites. Pode gastar mais créditos se houver muitos duplicados.`,
        params: [
          { label: "Nicho", value: String(input.niche) },
          { label: "Cidade", value: String(input.city) },
          { label: "Quantidade", value: String(count) },
          ...(Array.isArray(input.tags) && input.tags.length
            ? [{ label: "Tags", value: clip(input.tags.map(String).join(", ")) }]
            : []),
        ],
        estimated_credits: Math.ceil(count / 10),
      };
    }
    case "serper_search": {
      const type = input.type as (typeof SERPER_TYPES)[number];
      const spec = SERPER_CATALOG[type];
      const params = acceptedParams(type, serperParamsOf(input));
      return {
        title: `Consultar o Google via Serper: ${spec?.label ?? type}`,
        description: `Fazer uma consulta "${type}" no Serper (${spec?.purpose ?? ""}).`,
        params: Object.entries(params).map(([label, value]) => ({ label, value: clip(String(value)) })),
        estimated_credits: spec ? estimateSerperCredits(type, params) : 1,
      };
    }
    case "scrape_webpage":
      return {
        title: "Ler uma página da web",
        description: "Extrair o texto da página abaixo via Serper. Páginas pesadas podem custar mais créditos.",
        params: [{ label: "URL", value: clip(String(input.url)) }],
        estimated_credits: 2,
      };
    case "crawl_lead_website": {
      const lead = typeof input.lead_id === "number" ? getLead(db, input.lead_id) : null;
      return {
        title: "Visitar o site do lead",
        description: `Visitar o site de ${leadLabel(db, input.lead_id)} para procurar e-mails e redes sociais. Nada é gravado nesta etapa.`,
        params: [{ label: "Site", value: lead?.website ?? "não cadastrado" }],
        estimated_credits: 0,
      };
    }
    case "save_lead_enrichment": {
      const lead = typeof input.lead_id === "number" ? getLead(db, input.lead_id) : null;
      const e = (input.enrichment ?? {}) as z.infer<typeof enrichmentSchema>;
      const params: { label: string; value: string }[] = [];
      if (e.summary) params.push({ label: "Resumo", value: clip(e.summary) });
      if (e.segment) params.push({ label: "Segmento", value: clip(e.segment) });
      if (e.size_estimate) params.push({ label: "Porte estimado", value: clip(e.size_estimate) });
      if (e.decision_makers?.length) {
        params.push({
          label: "Decisores",
          value: clip(e.decision_makers.map((d) => (d.role ? `${d.name} (${d.role})` : d.name)).join("; ")),
        });
      }
      if (e.socials && Object.keys(e.socials).length) {
        params.push({ label: "Redes sociais", value: clip(Object.entries(e.socials).map(([k, v]) => `${k}: ${v}`).join("; ")) });
      }
      if (e.extra_emails?.length) params.push({ label: "E-mails extras", value: clip(e.extra_emails.join(", ")) });
      if (e.extra_phones?.length) params.push({ label: "Telefones extras", value: clip(e.extra_phones.join(", ")) });
      if (e.notes) params.push({ label: "Observações", value: clip(e.notes) });
      if (e.sources?.length) params.push({ label: "Fontes", value: clip(e.sources.join(", ")) });
      const email = typeof input.email === "string" ? input.email : null;
      if (email) {
        params.push({
          label: "E-mail",
          value: lead?.email ? `${email} (não será gravado: o lead já tem ${lead.email})` : `vazio → ${email}`,
        });
      }
      const previous = (lead as (LeadRow & { ai_enriched_at?: string | null }) | null)?.ai_enriched_at;
      return {
        title: "Salvar enriquecimento no lead",
        description: `Gravar os dados abaixo em ${leadLabel(db, input.lead_id)}.${previous ? ` Substitui o enriquecimento anterior (${previous.slice(0, 10)}).` : ""}`,
        params,
        estimated_credits: 0,
      };
    }
    case "send_whatsapp_message": {
      const lead = typeof input.lead_id === "number" ? getLead(db, input.lead_id) : null;
      return {
        title: "Enviar mensagem pelo WhatsApp",
        description: `Enviar a mensagem abaixo para ${leadLabel(db, input.lead_id)}${lead?.phone ? ` (${lead.phone})` : ""} pela instância ativa. Sujeito ao limite anti-banimento e ao horário silencioso.`,
        params: [{ label: "Mensagem", value: clip(String(input.text ?? ""), 1000) }],
        estimated_credits: 0,
      };
    }
    default:
      return { title: `Executar ${toolName}`, description: "Ação que requer aprovação.", params: [], estimated_credits: 0 };
  }
}
