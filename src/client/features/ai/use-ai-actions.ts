// Lead-level AI actions used by the lead drawer ("Pesquisar com IA",
// "Redigir mensagem"): open the assistant panel with a PT-BR prompt that
// AiChatProvider consumes (`pendingPrompt`) and sends via useChat as soon as
// the chat is idle (classic mode only prefills the composer).
// Keep this signature stable: the drawer depends on it.
import { useCallback } from "react";
import type { Lead } from "@/lib/api/types";
import { useAssistant } from "@/features/assistant/assistant-context";

export type AiLeadAction = "research" | "draft";

export function aiLeadPrompt(action: AiLeadAction, lead: Pick<Lead, "id" | "name">): string {
  return action === "research"
    ? `Pesquise mais informações sobre o lead #${lead.id} (${lead.name}) e proponha um enriquecimento.`
    : `Redija uma mensagem de WhatsApp para o lead #${lead.id} (${lead.name}) com base no perfil da minha empresa.`;
}

export interface AiActions {
  runLeadAction: (action: AiLeadAction, lead: Pick<Lead, "id" | "name">) => void;
}

export function useAiActions(): AiActions {
  const { openWithPrompt } = useAssistant();
  const runLeadAction = useCallback(
    (action: AiLeadAction, lead: Pick<Lead, "id" | "name">) => openWithPrompt(aiLeadPrompt(action, lead), { autoSend: true }),
    [openWithPrompt],
  );
  return { runLeadAction };
}
