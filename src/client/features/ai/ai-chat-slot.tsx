// AI chat inside the assistant Sheet (rendered when GET /api/ai/status says
// `enabled: true`). State lives in AiChatProvider; this is the view: toolbar
// (history, new conversation, credits), conversation, error card, composer.
// "Usar modo clássico" swaps the body for the classic prospect chat.
import { AlertTriangleIcon, ArrowLeftIcon, BotIcon, CoinsIcon, PlusIcon, RefreshCwIcon, RotateCcwIcon, SettingsIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { navigate } from "@/app/router";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion } from "@/components/ai-elements/suggestion";
import { Button } from "@/components/ui/button";
import { useAssistant } from "@/features/assistant/assistant-context";
import { ClassicProspectChat } from "@/features/assistant/classic-prospect-chat";
import type { AiStatus } from "@/lib/api/types";
import { ROUTES } from "@/routes";
import { useAiChat } from "./ai-chat-provider";
import { ChatHistory } from "./chat-history";
import { creditsLabel, errorActions, errorTitle, messageText, SUGGESTIONS, type ChatErrorInfo } from "./chat-logic";
import { MessageView } from "./message-view";

/**
 * Re-pins the log to the bottom when the panel opens and when a request starts:
 * late layout (markdown, collapsibles, the Sheet animation) and cards that
 * shrink on approval otherwise leave stick-to-bottom a few pixels short.
 */
function FollowNewActivity({ status }: { status: string }) {
  const { scrollToBottom } = useStickToBottomContext();
  useEffect(() => {
    void scrollToBottom({ animation: "instant", duration: 700 });
  }, [scrollToBottom]);
  useEffect(() => {
    if (status === "submitted") void scrollToBottom({ animation: "instant", duration: 400 });
  }, [status, scrollToBottom]);
  return null;
}

function ErrorCard({ info, onRetry, onSettings, onClassic }: { info: ChatErrorInfo; onRetry: () => void; onSettings: () => void; onClassic: () => void }) {
  const actions = errorActions(info);
  return (
    <div role="alert" className="border-destructive/30 bg-destructive/8 space-y-2 rounded-lg border p-3">
      <p className="text-destructive flex items-center gap-1.5 text-sm font-medium">
        <AlertTriangleIcon className="size-4 shrink-0" aria-hidden="true" />
        {errorTitle(info)}
      </p>
      <p className="text-sm leading-relaxed">{info.message}</p>
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {actions.includes("retry") && (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              <RotateCcwIcon /> Tentar novamente
            </Button>
          )}
          {actions.includes("settings") && (
            <Button type="button" size="sm" variant="outline" onClick={onSettings}>
              <SettingsIcon /> Abrir Configurações
            </Button>
          )}
          {actions.includes("classic") && (
            <Button type="button" size="sm" variant="ghost" onClick={onClassic}>
              <BotIcon /> Usar modo clássico
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function AiChatSlot({ provider }: { provider: AiStatus["provider"] }) {
  const chat = useAiChat();
  const { setOpen, pendingPrompt } = useAssistant();
  const { messages, status, input, setInput } = chat;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = status === "submitted" || status === "streaming";

  const openSettings = useCallback(() => {
    setOpen(false);
    navigate(ROUTES.settings);
  }, [setOpen]);

  // Focus the composer when the panel opens on the AI view.
  useEffect(() => {
    if (chat.view === "ai" && !chat.loading) inputRef.current?.focus({ preventScroll: true });
  }, [chat.view, chat.loading]);

  const pickSuggestion = (suggestion: string) => {
    if (suggestion.endsWith("#")) {
      setInput(suggestion);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
      return;
    }
    chat.send(suggestion);
  };

  if (chat.view === "classic" && !pendingPrompt?.autoSend) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="bg-muted/40 flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
          <p className="text-muted-foreground text-xs">Modo clássico (sem IA) nesta sessão.</p>
          <Button type="button" variant="ghost" size="xs" onClick={() => chat.setView("ai")}>
            <ArrowLeftIcon /> Voltar ao assistente de IA
          </Button>
        </div>
        <ClassicProspectChat />
      </div>
    );
  }

  const last = messages.at(-1);
  const streamingId = status === "streaming" && last?.role === "assistant" ? last.id : null;
  const waitingFirstChunk = status === "submitted" || (status === "streaming" && last?.role !== "assistant");
  const lastAssistantText = !busy && last?.role === "assistant" ? messageText(last) : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <ChatHistory />
        <Button type="button" variant="ghost" size="sm" onClick={chat.newChat} disabled={chat.loading} aria-label="Nova conversa">
          <PlusIcon /> <span className="hidden sm:inline">Nova conversa</span>
        </Button>
        <div className="ml-auto flex min-w-0 items-center gap-2 pr-1">
          {chat.credits !== null && chat.credits > 0 && (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs whitespace-nowrap tabular" title={creditsLabel(chat.credits)}>
              <CoinsIcon className="size-3.5" aria-hidden="true" />
              <span aria-hidden="true">
                {chat.credits.toLocaleString("pt-BR")} <span className="hidden sm:inline">{chat.credits === 1 ? "crédito" : "créditos"} Serper</span>
              </span>
              <span className="sr-only">{creditsLabel(chat.credits)}</span>
            </span>
          )}
          {provider && (
            <span className="text-muted-foreground hidden max-w-36 truncate text-[11px] md:inline" title={`${provider.label} · ${provider.model}`}>
              {provider.model}
            </span>
          )}
        </div>
      </div>

      {/* Screen readers: the log is aria-busy while streaming; this announces start/end. */}
      <div className="sr-only" role="status" aria-live="polite">
        {waitingFirstChunk ? "Assistente pensando…" : streamingId ? "Assistente respondendo…" : lastAssistantText ? `Resposta: ${lastAssistantText.slice(0, 600)}` : ""}
      </div>

      {chat.loading ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Shimmer as="p" className="text-sm">
            Carregando conversa…
          </Shimmer>
        </div>
      ) : (
        <Conversation className="min-h-0" initial="instant" resize="instant" aria-label="Conversa com o assistente de IA" aria-busy={busy}>
          <ConversationContent className="gap-5 px-4 py-4">
            {chat.loadError && (
              <div role="alert" className="border-destructive/30 bg-destructive/8 flex items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <span>{chat.loadError}</span>
                <Button type="button" size="xs" variant="outline" onClick={() => void chat.openChat(chat.chatId)}>
                  <RefreshCwIcon /> Tentar de novo
                </Button>
              </div>
            )}
            {messages.length === 0 && !chat.loadError ? (
              <ConversationEmptyState className="gap-4 px-2 py-10">
                <div className="flex size-11 items-center justify-center rounded-xl border bg-muted/50 text-brand">
                  <SparklesIcon className="size-5" aria-hidden="true" />
                </div>
                <div className="max-w-sm space-y-1">
                  <h3 className="text-sm font-semibold">Como posso ajudar na prospecção?</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    Busco leads, consulto sua base, pesquiso empresas e redijo mensagens. Ações que gastam créditos ou enviam algo pedem sua aprovação.
                  </p>
                </div>
                <div className="flex w-full flex-col items-center gap-2" role="group" aria-label="Sugestões">
                  {SUGGESTIONS.map((s) => (
                    <Suggestion key={s} suggestion={s} onClick={pickSuggestion} className="h-auto max-w-full py-1.5 whitespace-normal" variant="outline">
                      {s.endsWith("#") ? `${s}…` : s}
                    </Suggestion>
                  ))}
                </div>
              </ConversationEmptyState>
            ) : (
              messages.map((message, index) => (
                <MessageView
                  key={message.id}
                  message={message}
                  isLast={index === messages.length - 1}
                  streaming={message.id === streamingId}
                  busy={busy}
                  resolvedApprovals={chat.resolvedApprovals}
                  onRespond={chat.respondApproval}
                  onSendDraft={chat.sendDraft}
                />
              ))
            )}
            {waitingFirstChunk && (
              <Shimmer as="p" className="text-sm" duration={1.5}>
                Pensando…
              </Shimmer>
            )}
            {chat.runningOnServer && !busy && (
              <div className="bg-muted/50 flex items-center justify-between gap-2 rounded-lg border p-3 text-xs">
                <span>Esta conversa ainda estava respondendo no servidor quando foi aberta.</span>
                <Button type="button" size="xs" variant="outline" onClick={() => void chat.reload()}>
                  <RefreshCwIcon /> Recarregar
                </Button>
              </div>
            )}
            {chat.errorInfo && (
              <ErrorCard info={chat.errorInfo} onRetry={chat.retry} onSettings={openSettings} onClassic={chat.switchToClassic} />
            )}
          </ConversationContent>
          <ConversationScrollButton />
          <FollowNewActivity status={status} />
        </Conversation>
      )}

      <div className="bg-background/80 shrink-0 border-t px-3 pt-3 pb-3">
        <PromptInput
          onSubmit={({ text }) => {
            if (busy || !text.trim()) return;
            chat.send(text);
            setInput("");
          }}
        >
          <PromptInputTextarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ex.: Buscar 30 dentistas em Curitiba-PR"
            aria-label="Mensagem para o assistente de IA"
            maxLength={20000}
            disabled={chat.loading}
          />
          <PromptInputFooter className="pt-0">
            <span className="text-muted-foreground pl-1 text-[11px]">Enter envia · Shift+Enter quebra linha</span>
            <PromptInputSubmit status={busy ? status : undefined} onStop={chat.stop} disabled={!busy && !input.trim()} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
