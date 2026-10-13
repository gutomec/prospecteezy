import { APICallError, LoadAPIKeyError, RetryError } from "ai";

export type LlmErrorCode = "llm_auth" | "llm_quota" | "llm_unavailable" | "llm_error";

export interface LlmErrorInfo {
  code: LlmErrorCode;
  message: string;
}

const KEY_LIKE = /\b(sk|pk|rk|AIza|gsk|xai|key)[-_A-Za-z0-9]{12,}/g;

/** Removes anything that looks like an API key (and the known key) from provider text. */
export function redactSecrets(text: string, secret?: string | null): string {
  let out = text;
  if (secret && secret.length >= 4) out = out.split(secret).join("***");
  return out.replace(KEY_LIKE, "***");
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** Maps a provider failure to a PT-BR message + stable code (never leaks the key). */
export function classifyLlmError(error: unknown, secret?: string | null): LlmErrorInfo {
  const root = RetryError.isInstance(error) ? error.lastError : error;

  if (LoadAPIKeyError.isInstance(root)) {
    return { code: "llm_auth", message: "O provedor de IA está sem chave de API. Cadastre a chave em Configurações → Inteligência artificial." };
  }
  if (APICallError.isInstance(root)) {
    const status = root.statusCode ?? 0;
    const body = `${root.message} ${root.responseBody ?? ""}`.toLowerCase();
    if (status === 401 || status === 403) {
      return { code: "llm_auth", message: "O provedor de IA recusou a chave de API. Verifique a chave em Configurações → Inteligência artificial." };
    }
    if (status === 402 || status === 429 || /quota|insufficient|billing|credit/.test(body)) {
      return { code: "llm_quota", message: "O provedor de IA recusou por limite de uso ou saldo insuficiente. Tente mais tarde ou verifique seu plano." };
    }
    if (status === 408 || status >= 500) {
      return { code: "llm_unavailable", message: "O provedor de IA está indisponível no momento. Tente novamente em instantes." };
    }
    if (status === 404) {
      return { code: "llm_error", message: "O provedor de IA não encontrou o modelo configurado. Confira o nome do modelo em Configurações → Inteligência artificial." };
    }
    return {
      code: "llm_error",
      message: `O provedor de IA retornou um erro (HTTP ${status || "?"}): ${redactSecrets(root.message, secret).slice(0, 200)}`,
    };
  }
  if (isTimeout(root)) {
    return { code: "llm_unavailable", message: "O provedor de IA demorou demais para responder (tempo limite esgotado)." };
  }
  if (root instanceof TypeError || (root instanceof Error && /ECONN|ENOTFOUND|fetch failed|network/i.test(root.message))) {
    return { code: "llm_unavailable", message: "Não foi possível conectar ao provedor de IA (falha de rede ou URL incorreta)." };
  }
  const detail = root instanceof Error ? redactSecrets(root.message, secret).slice(0, 200) : "";
  return { code: "llm_error", message: `Erro ao falar com o provedor de IA${detail ? `: ${detail}` : "."}` };
}
