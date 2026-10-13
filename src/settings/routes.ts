import type { Database } from "bun:sqlite";
import { errorJson, INVALID_BODY, json, readJson } from "../ai/http.ts";
import { listProviderRows } from "../ai/providers.ts";
import { redactSecrets } from "../ai/errors.ts";
import { serperRequest } from "../ingest/serper.ts";
import {
  deleteSerperApiKey,
  getCompanyProfile,
  getSerperApiKey,
  getSerperStatus,
  parseCompanyProfile,
  saveCompanyProfile,
  setSerperApiKey,
} from "./repo.ts";
import type { SecretBox } from "./secrets.ts";

export interface SettingsRouteDeps {
  db: Database;
  box: SecretBox;
  serperFetch?: typeof fetch;
}

const MAX_SERPER_KEY = 500;

/** True when any stored secret can no longer be decrypted (master key missing/changed). */
async function anySecretUnreadable(deps: SettingsRouteDeps, serperUnreadable: boolean): Promise<boolean> {
  if (serperUnreadable) return true;
  for (const row of listProviderRows(deps.db)) {
    if (row.api_key_enc && (await deps.box.decrypt(row.api_key_enc)) === null) return true;
  }
  return false;
}

async function serperView(deps: SettingsRouteDeps) {
  const { unreadable: _unreadable, ...status } = await getSerperStatus(deps.db, deps.box);
  return status;
}

export function createSettingsRoutes(deps: SettingsRouteDeps) {
  const { db, box } = deps;
  return {
    "/api/settings": {
      GET: async () => {
        const { unreadable, ...serper } = await getSerperStatus(db, box);
        const secretsUnreadable = await anySecretUnreadable(deps, unreadable);
        return json({
          serper,
          company_profile: getCompanyProfile(db),
          secrets_unreadable: secretsUnreadable,
          ...(secretsUnreadable
            ? { warning: "Algumas chaves salvas não puderam ser lidas (a chave mestra data/.master.key sumiu ou mudou). Cadastre-as novamente." }
            : {}),
        });
      },
    },

    "/api/settings/serper": {
      PUT: async (req: Request) => {
        const body = (await readJson(req)) as { api_key?: unknown } | undefined;
        const apiKey = typeof body?.api_key === "string" ? body.api_key.trim() : "";
        if (!apiKey) return errorJson('Campo "api_key" obrigatório com a chave do Serper.', 400);
        if (apiKey.length > MAX_SERPER_KEY) return errorJson("Chave do Serper longa demais.", 400);
        await setSerperApiKey(db, box, apiKey);
        return json(await serperView(deps));
      },
      DELETE: async () => {
        deleteSerperApiKey(db);
        return json(await serperView(deps));
      },
    },

    // Spends 1 Serper credit (autocomplete) to check the key.
    "/api/settings/serper/test": {
      POST: async () => {
        const apiKey = await getSerperApiKey(db, box);
        if (!apiKey) return json({ ok: false, error: "Nenhuma chave do Serper configurada." });
        try {
          await serperRequest({
            apiKey,
            type: "autocomplete",
            body: { q: "prospecção", gl: "br", hl: "pt-br" },
            estimatedCredits: 1,
            fetchImpl: deps.serperFetch,
            sleep: async () => {},
          });
          return json({ ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return json({ ok: false, error: redactSecrets(message, apiKey) });
        }
      },
    },

    "/api/settings/company": {
      PUT: async (req: Request) => {
        const body = await readJson(req);
        if (body === undefined) return errorJson(INVALID_BODY, 400);
        const parsed = parseCompanyProfile(body);
        if (!parsed.ok) return errorJson(parsed.error, 400);
        return json({ company_profile: saveCompanyProfile(db, parsed.profile) });
      },
    },
  };
}
