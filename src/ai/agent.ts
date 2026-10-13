import type { Database } from "bun:sqlite";
import { isStepCount, ToolLoopAgent } from "ai";
import { getLead } from "../db/repository.ts";
import { getCompanyProfile } from "../settings/repo.ts";
import type { SecretBox } from "../settings/secrets.ts";
import type { ModelFactory } from "./model-factory.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type { ProviderRow } from "./providers.ts";
import { APPROVAL_TOOLS, createTools, type ToolDeps } from "./tools.ts";

export const MAX_STEPS = 12;
export const RUN_TIMEOUT_MS = 120_000;

export type AgentRuntimeDeps = Omit<ToolDeps, "providerKind" | "addCredits"> & {
  box: SecretBox;
  modelFactory: ModelFactory;
};

export class AgentRequestError extends Error {}

/** Validates a "send this draft" request ({lead_id, text}) before it becomes
 *  a send_whatsapp_message call awaiting approval (/api/chat). */
export function validateSendDraft(db: Database, context: Record<string, unknown>): { leadId: number; text: string } {
  const leadId = context.lead_id;
  const text = typeof context.text === "string" ? context.text.trim() : "";
  if (typeof leadId !== "number" || !Number.isInteger(leadId)) throw new AgentRequestError('Campo "lead_id" inválido.');
  if (!text) throw new AgentRequestError("O rascunho está vazio.");
  if (text.length > 4096) throw new AgentRequestError("A mensagem excede 4096 caracteres.");
  const lead = getLead(db, leadId);
  if (!lead) throw new AgentRequestError("Lead não encontrado.");
  if (lead.is_whatsapp !== 1 || !lead.whatsapp_jid) {
    throw new AgentRequestError("O lead ainda não foi validado como WhatsApp.");
  }
  return { leadId, text };
}

/** The prospecting agent (tools, prompt, approval rules) for one run. */
export function createProspectAgent(
  db: Database,
  deps: AgentRuntimeDeps,
  provider: ProviderRow,
  apiKey: string | null,
  addCredits: (credits: number) => void,
) {
  const tools = createTools({ ...deps, providerKind: provider.kind, addCredits });
  return new ToolLoopAgent({
    model: deps.modelFactory({ kind: provider.kind, model: provider.model, apiKey, baseUrl: provider.base_url }),
    instructions: buildSystemPrompt(getCompanyProfile(db)),
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    toolApproval: Object.fromEntries(APPROVAL_TOOLS.map((name) => [name, "user-approval" as const])),
  });
}

export const API_KEY_UNREADABLE =
  "Não foi possível ler a chave do provedor de IA (a chave mestra mudou ou sumiu). Cadastre a chave de novo em Configurações → Inteligência artificial.";
