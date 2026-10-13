/**
 * Serper.dev endpoint catalog used by the `serper_search` tool: which params
 * each type accepts, which are required, and the credit cost (the response's
 * `credits` field is authoritative; these are pre-approval estimates).
 * Source: Serper playground bundle (no official REST reference).
 */

export const SERPER_TYPES = [
  "search",
  "images",
  "videos",
  "news",
  "shopping",
  "scholar",
  "patents",
  "places",
  "maps",
  "reviews",
  "autocomplete",
  "lens",
  "product-reviews",
  "maps-autocomplete",
] as const;
export type SerperType = (typeof SERPER_TYPES)[number];

export const SERPER_PARAMS = [
  "q",
  "gl",
  "hl",
  "location",
  "num",
  "page",
  "tbs",
  "ll",
  "cid",
  "placeId",
  "fid",
  "url",
  "sortBy",
  "nextPageToken",
] as const;
export type SerperParam = (typeof SERPER_PARAMS)[number];
export type SerperParams = Partial<Record<SerperParam, string | number>>;

interface SerperTypeSpec {
  label: string;
  purpose: string;
  params: SerperParam[];
  cost: string;
}

const WEB_PARAMS: SerperParam[] = ["q", "location", "gl", "hl", "num", "page", "tbs"];

export const SERPER_CATALOG: Record<SerperType, SerperTypeSpec> = {
  search: { label: "Pesquisa Google", purpose: "resultados orgânicos, knowledge graph, perguntas relacionadas — pesquisa geral sobre empresas, pessoas e mercado", params: WEB_PARAMS, cost: "1 crédito" },
  images: { label: "Imagens", purpose: "busca de imagens", params: WEB_PARAMS, cost: "1 crédito (2 se num > 10)" },
  videos: { label: "Vídeos", purpose: "busca de vídeos", params: WEB_PARAMS, cost: "1 crédito" },
  news: { label: "Notícias", purpose: "notícias recentes sobre uma empresa ou setor (use tbs para limitar o período)", params: WEB_PARAMS, cost: "1 crédito" },
  shopping: { label: "Shopping", purpose: "produtos e preços", params: WEB_PARAMS, cost: "2 créditos" },
  scholar: { label: "Google Acadêmico", purpose: "artigos acadêmicos", params: ["q", "location", "gl", "hl", "page", "tbs"], cost: "1 crédito" },
  patents: { label: "Patentes", purpose: "patentes", params: WEB_PARAMS, cost: "1 crédito" },
  places: { label: "Google Places", purpose: "lista de estabelecimentos (nome, endereço, telefone, site, nota, cid, placeId) — melhor opção para listas de leads", params: ["q", "location", "gl", "hl", "num", "page", "ll"], cost: "1 crédito por página" },
  maps: { label: "Google Maps", purpose: "resultados do Maps com coordenadas; detalhes de um lugar por placeId/cid", params: ["q", "hl", "gl", "ll", "placeId", "cid", "page"], cost: "3 créditos" },
  reviews: { label: "Avaliações", purpose: "avaliações de um estabelecimento (reputação); exige cid, fid ou placeId", params: ["cid", "fid", "placeId", "gl", "hl", "sortBy", "nextPageToken"], cost: "1 crédito" },
  autocomplete: { label: "Autocompletar", purpose: "sugestões de pesquisa do Google", params: ["q", "location", "gl", "hl"], cost: "1 crédito" },
  lens: { label: "Google Lens", purpose: "busca reversa por imagem (url da imagem)", params: ["url", "location", "gl", "hl", "tbs"], cost: "3 créditos" },
  "product-reviews": { label: "Avaliações de produto", purpose: "avaliações de um produto do Google Shopping (q = productId)", params: ["q", "gl", "hl", "nextPageToken"], cost: "2 créditos" },
  "maps-autocomplete": { label: "Autocompletar do Maps", purpose: "sugestões de lugares do Google Maps", params: ["q", "location", "gl", "hl", "ll"], cost: "1 crédito" },
};

/** Pre-approval credit estimate for one call. */
export function estimateSerperCredits(type: SerperType, params: SerperParams): number {
  switch (type) {
    case "shopping":
    case "product-reviews":
      return 2;
    case "maps":
    case "lens":
      return 3;
    case "images":
      return Number(params.num ?? 10) > 10 ? 2 : 1;
    default:
      return 1;
  }
}

/** PT-BR validation error for the model, or null when the call is valid. */
export function validateSerperParams(type: SerperType, params: SerperParams): string | null {
  const spec = SERPER_CATALOG[type];
  const given = (Object.keys(params) as SerperParam[]).filter(
    (k) => params[k] !== undefined && params[k] !== "",
  );
  const unsupported = given.filter((k) => !spec.params.includes(k));
  if (unsupported.length) {
    return `Parâmetros não aceitos pelo tipo "${type}": ${unsupported.join(", ")}. Aceitos: ${spec.params.join(", ")}.`;
  }
  const has = (k: SerperParam) => given.includes(k);
  if (type === "reviews") {
    if (!has("cid") && !has("fid") && !has("placeId")) return 'O tipo "reviews" exige cid, fid ou placeId.';
  } else if (type === "lens") {
    if (!has("url")) return 'O tipo "lens" exige "url" (endereço da imagem).';
  } else if (type === "maps") {
    if (!has("q") && !has("placeId") && !has("cid")) return 'O tipo "maps" exige q, placeId ou cid.';
    if (Number(params.page ?? 1) > 1 && !has("ll")) return 'O tipo "maps" exige "ll" (@lat,lng,zoom) quando page > 1.';
  } else if (!has("q")) {
    return `O tipo "${type}" exige "q".`;
  }
  if (has("tbs") && !/^qdr:[hdwmy]\d*$/.test(String(params.tbs))) {
    return 'Use "tbs" no formato qdr:h, qdr:d, qdr:w, qdr:m ou qdr:y.';
  }
  if (has("ll") && !/^@-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d+(\.\d+)?z$/.test(String(params.ll))) {
    return 'Use "ll" no formato @latitude,longitude,zoomz (ex.: @-23.55,-46.63,14z).';
  }
  return null;
}

/** Request body for a validated call (product-reviews sends q as productId). */
export function buildSerperBody(type: SerperType, params: SerperParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of SERPER_CATALOG[type].params) {
    const value = params[key];
    if (value !== undefined && value !== "") body[key] = value;
  }
  if (type === "product-reviews" && body.q !== undefined) {
    body.productId = body.q;
    delete body.q;
  }
  return body;
}

/** Catalog text embedded in the tool description (endpoint purpose, params, cost). */
export function serperCatalogText(): string {
  return SERPER_TYPES.map((type) => {
    const spec = SERPER_CATALOG[type];
    return `- ${type} (${spec.label}): ${spec.purpose}. Parâmetros: ${spec.params.join(", ")}. Custo: ${spec.cost}.`;
  }).join("\n");
}

const MAX_RESULT_CHARS = 8_000;

/**
 * Caps a Serper response for the model (~8 KB): drops request echo fields,
 * then halves the longest arrays until it fits, then truncates as text.
 */
export function trimSerperBody(body: Record<string, unknown>, maxChars = MAX_RESULT_CHARS): unknown {
  const copy: Record<string, unknown> = { ...body };
  delete copy.searchParameters;
  delete copy.credits;
  for (let i = 0; i < 20 && JSON.stringify(copy).length > maxChars; i++) {
    let longestKey: string | null = null;
    let longest = 1;
    for (const [key, value] of Object.entries(copy)) {
      if (Array.isArray(value) && value.length > longest) {
        longest = value.length;
        longestKey = key;
      }
    }
    if (!longestKey) break;
    copy[longestKey] = (copy[longestKey] as unknown[]).slice(0, Math.ceil(longest / 2));
  }
  const text = JSON.stringify(copy);
  if (text.length <= maxChars) return copy;
  return { truncated: true, partial_json: text.slice(0, maxChars) };
}
