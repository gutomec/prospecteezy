// Typed fetch wrapper for the local REST API (contract: docs/api.md).
//
// - Every non-GET/HEAD request carries `Content-Type: application/json` and a
//   JSON body (default `{}`): several routes answer 415 without it.
// - Errors become `ApiError` with the server's PT-BR `{ error }` message.

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export const NETWORK_ERROR_MESSAGE =
  "Não consegui falar com o servidor local. Ele está rodando? (bun run start)";

type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  method?: Method;
  /** Serialized as JSON. Omitted on GET/HEAD; defaults to `{}` otherwise. */
  body?: unknown;
  signal?: AbortSignal;
  /** Return the parsed body even when the status is not 2xx (e.g. WA send 409/429). */
  acceptErrorBody?: boolean;
}

/** Message shown to the user for any thrown value. */
export function errorMessage(error: unknown, fallback = "Algo deu errado. Tente de novo."): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

function messageFrom(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const value = (body as { error: unknown }).error;
    if (typeof value === "string" && value.trim()) return value;
  }
  return `Erro ${status} na API.`;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const init: RequestInit = { method, signal: options.signal, headers: { Accept: "application/json" } };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { Accept: "application/json", "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body ?? {});
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0);
  }

  let body: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null; // non-JSON body (proxy error page, empty, …)
    }
  }

  if (!response.ok && !options.acceptErrorBody) {
    throw new ApiError(messageFrom(body, response.status), response.status, body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string, body?: unknown) => request<T>(path, { method: "DELETE", body }),
};

/** Encodes one path segment (ids, jids). */
export const seg = (value: string | number) => encodeURIComponent(String(value));
