/**
 * PT-BR prospect-request parser.
 *
 * Understood forms (examples):
 *   "Busque os 100 principais escritórios de advocacia de São Paulo-SP"
 *   "top 50 clínicas de estética em Fortaleza"
 *   "Traga os 20 melhores restaurantes japoneses em Curitiba-PR"
 *   "academias 24 horas no Recife com e-mail"   → count only right after verb/qualifier
 *   "mais 100" / "+100" / "mais 30 da mesma pesquisa"   → continuation
 */

export const DEFAULT_COUNT = 20;

export type ParsedRequest =
  | { kind: "new"; niche: string; city: string; count: number }
  | { kind: "more"; count: number }
  | { kind: "unknown"; message: string };

const LEAD_VERBS =
  /^(?:busque|buscar|encontre|encontrar|procure|procurar|liste|listar|traga|trazer|me\s+traga|quero|pesquise|pesquisar)\b[,:\s]*/i;
const QUALIFIERS = /^(?:(?:os|as)\b)?\s*(?:(?:principais|melhores|top)\b)?\s*/i;
// Count = a number right after the verb, optionally preceded by qualifiers
// ("os 100", "top 50"). Numbers elsewhere ("24 horas") belong to the niche.
const LEADING_COUNT = /^(?:(?:os|as|top|principais|melhores)\s+)*(\d+)\b\s*/i;
// City separators, besides the " de " fallback. The last one in the phrase wins.
const CITY_SEPARATORS = [" em ", " no ", " na ", " nos ", " nas "];
const OUT_OF_RANGE = "A quantidade precisa ser de pelo menos 1.";

function cleanEdges(value: string): string {
  return value.replace(/^[\s,.:;–—-]+|[\s,.:;–—.!?]+$/g, "").trim();
}

export function parseProspectRequest(text: string): ParsedRequest {
  const input = text.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!input) {
    return { kind: "unknown", message: "Pedido vazio. Diga o que devo buscar." };
  }

  // Continuation: "mais 100", "+100", "mais 30 da mesma pesquisa/busca/query"
  const moreMatch = input.match(
    /^(?:\+|mais\s+)(\d+)(?:\s+(?:leads?|resultados?|contatos?))?(?:\s+d[ae]\s+mesm[ao]\s+(?:pesquisa|busca|query|consulta))?\s*[.!]?$/i,
  );
  if (moreMatch) {
    const count = parseInt(moreMatch[1]!, 10);
    if (count < 1) return { kind: "unknown", message: OUT_OF_RANGE };
    return { kind: "more", count };
  }

  // Strip the leading verb ("Busque", "Traga", ...) and "mais" prefix
  let rest = input.replace(LEAD_VERBS, "");
  rest = rest.replace(/^mais\s+/i, "");

  // Count: only the number right after the verb (and qualifiers)
  let count = DEFAULT_COUNT;
  const countMatch = rest.match(LEADING_COUNT);
  if (countMatch) {
    count = parseInt(countMatch[1]!, 10);
    rest = rest.slice(countMatch[0].length);
  }
  rest = rest.replace(/\s+/g, " ").trim();
  rest = rest.replace(QUALIFIERS, "").trim();

  // City separator: the last " em "/" no "/" na "/" nos "/" nas ", else the last " de ".
  const lower = rest.toLowerCase();
  let separatorIndex = -1;
  let separatorLength = 0;
  for (const separator of CITY_SEPARATORS) {
    const index = lower.lastIndexOf(separator);
    if (index > separatorIndex) {
      separatorIndex = index;
      separatorLength = separator.length;
    }
  }
  if (separatorIndex === -1) {
    separatorIndex = lower.lastIndexOf(" de ");
    separatorLength = 4;
  }
  if (separatorIndex === -1) {
    return {
      kind: "unknown",
      message:
        'Não entendi o pedido. Tente algo como: "Busque os 100 principais escritórios de advocacia de São Paulo-SP".',
    };
  }

  const niche = cleanEdges(rest.slice(0, separatorIndex));
  // Drop a trailing qualifier clause: "Curitiba-PR com e-mail" → "Curitiba-PR".
  const city = cleanEdges(rest.slice(separatorIndex + separatorLength).replace(/\s+com\s.*$/i, ""));

  if (!niche || !city) {
    return {
      kind: "unknown",
      message:
        'Não consegui identificar o nicho e a cidade. Tente: "top 50 clínicas de estética em Fortaleza".',
    };
  }
  if (count < 1) {
    return { kind: "unknown", message: OUT_OF_RANGE };
  }

  return { kind: "new", niche, city, count };
}
