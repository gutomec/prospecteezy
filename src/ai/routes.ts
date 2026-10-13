import type { Database } from "bun:sqlite";
import { generateText } from "ai";
import type { AgentRuntimeDeps } from "./agent.ts";
import { ChatRequestError, isChatRunning, prepareChat, streamChat } from "./chat.ts";
import { deleteChat, listChats, loadChat } from "./chats.ts";
import { classifyLlmError } from "./errors.ts";
import { errorJson, INVALID_BODY, json, readJson } from "./http.ts";
import { isProviderKind, MODEL_SUGGESTIONS, PROVIDER_KINDS } from "./models.ts";
import {
  activateProvider,
  createProvider,
  deactivateProviders,
  deleteProvider,
  getActiveProvider,
  getProvider,
  listProviderRows,
  providerApiKey,
  ProviderValidationError,
  toView,
  updateProvider,
} from "./providers.ts";

export type AiRouteDeps = AgentRuntimeDeps & { db: Database };

const PROVIDER_TEST_TIMEOUT_MS = 20_000;
const NOT_FOUND = "Provedor não encontrado.";
const CHAT_NOT_FOUND = "Conversa não encontrada.";
const AI_DISABLED =
  "A inteligência artificial está desativada. Ative um provedor em Configurações → Inteligência artificial.";

type IdRequest = Request & { params: { id: string } };

export function createAiRoutes(deps: AiRouteDeps) {
  const { db, box } = deps;

  const withValidation = async (fn: () => Promise<Response>): Promise<Response> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ProviderValidationError) return errorJson(error.message, 400);
      throw error;
    }
  };

  return {
    "/api/ai/status": {
      GET: () => {
        const active = getActiveProvider(db);
        return json({
          enabled: active !== null,
          provider: active ? { id: active.id, kind: active.kind, label: active.label, model: active.model } : null,
        });
      },
    },

    "/api/ai/models": {
      GET: (req: Request) => {
        const kind = new URL(req.url).searchParams.get("kind");
        if (!isProviderKind(kind)) {
          return errorJson(`Parâmetro "kind" inválido. Use: ${PROVIDER_KINDS.join(", ")}.`, 400);
        }
        return json({ kind, models: MODEL_SUGGESTIONS[kind] });
      },
    },

    "/api/ai/providers": {
      GET: async () => {
        const providers = await Promise.all(listProviderRows(db).map((row) => toView(row, box)));
        return json({ providers });
      },
      POST: (req: Request) =>
        withValidation(async () => {
          const body = await readJson(req);
          if (body === undefined) return errorJson(INVALID_BODY, 400);
          const row = await createProvider(db, box, body);
          return json({ provider: await toView(row, box) }, 201);
        }),
    },

    "/api/ai/providers/:id": {
      PATCH: (req: IdRequest) =>
        withValidation(async () => {
          const body = await readJson(req);
          if (body === undefined) return errorJson(INVALID_BODY, 400);
          const row = await updateProvider(db, box, req.params.id, body);
          return row ? json({ provider: await toView(row, box) }) : errorJson(NOT_FOUND, 404);
        }),
      DELETE: (req: IdRequest) =>
        deleteProvider(db, req.params.id) ? json({ ok: true }) : errorJson(NOT_FOUND, 404),
    },

    "/api/ai/providers/:id/activate": {
      POST: async (req: IdRequest) => {
        const row = activateProvider(db, req.params.id);
        return row ? json({ provider: await toView(row, box) }) : errorJson(NOT_FOUND, 404);
      },
    },

    "/api/ai/deactivate": {
      POST: () => {
        deactivateProviders(db);
        return json({ ok: true });
      },
    },

    // Tiny completion ("Responda apenas: ok") to check key/model/URL.
    "/api/ai/providers/:id/test": {
      POST: async (req: IdRequest) => {
        const row = getProvider(db, req.params.id);
        if (!row) return errorJson(NOT_FOUND, 404);
        const started = performance.now();
        const latency = () => Math.round(performance.now() - started);
        const apiKey = await providerApiKey(row, box);
        if (apiKey === undefined) {
          return json({ ok: false, error: "Não foi possível ler a chave salva. Cadastre-a novamente.", latency_ms: 0 });
        }
        try {
          await generateText({
            model: deps.modelFactory({ kind: row.kind, model: row.model, apiKey, baseUrl: row.base_url }),
            prompt: "Responda apenas: ok",
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
          });
          return json({ ok: true, latency_ms: latency() });
        } catch (error) {
          return json({ ok: false, error: classifyLlmError(error, apiKey).message, latency_ms: latency() });
        }
      },
    },

    // AI SDK v7 UI message stream endpoint (useChat). See docs/api.md.
    "/api/chat": {
      GET: () => json({ chats: listChats(db) }),
      POST: async (req: Request) => {
        const provider = getActiveProvider(db);
        if (!provider) return json({ error: AI_DISABLED, code: "ai_disabled" }, 409);
        const body = await readJson(req);
        if (body === undefined) return errorJson("Corpo inválido: envie o JSON do useChat.", 400);
        try {
          const prepared = prepareChat(db, body);
          return streamChat(db, deps, provider, prepared, req.signal);
        } catch (error) {
          if (error instanceof ChatRequestError) return errorJson(error.message, error.status);
          throw error;
        }
      },
    },

    "/api/chat/:id": {
      DELETE: (req: IdRequest) => {
        if (isChatRunning(req.params.id)) return errorJson("A conversa está respondendo agora. Aguarde terminar.", 409);
        return deleteChat(db, req.params.id) ? json({ ok: true }) : errorJson(CHAT_NOT_FOUND, 404);
      },
    },

    "/api/chat/:id/messages": {
      GET: (req: IdRequest) => {
        const chat = loadChat(db, req.params.id);
        if (!chat) return errorJson(CHAT_NOT_FOUND, 404);
        return json({
          id: chat.id,
          title: chat.title,
          credits_used: chat.credits_used,
          running: isChatRunning(chat.id),
          messages: chat.messages,
        });
      },
    },
  };
}
