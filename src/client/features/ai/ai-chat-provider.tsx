// App-level state of the AI chat (POST /api/chat, AI SDK v7 UI message stream).
// The `Chat` instance lives here, not in the panel, so a running answer, the
// composer text and the open conversation survive closing the assistant Sheet.
//
// Server = source of truth: the transport sends only the last message; the
// history comes from GET /api/chat/:id/messages when a conversation is opened.
import { Chat, useChat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useAssistant } from "@/features/assistant/assistant-context";
import { useProspectChat } from "@/features/assistant/prospect-chat-state";
import { ApiError, errorMessage } from "@/lib/api/client";
import { aiChatApi } from "@/lib/api/endpoints";
import type { AiChatDataTypes, AiChatMessage } from "@/lib/api/types";
import { qk, useAiStatus } from "@/lib/queries";
import {
  completedToolNames,
  creditsFromMessages,
  LEAD_MUTATING_TOOLS,
  lastUserText,
  parseChatError,
  respondedApprovalIds,
  type ChatErrorInfo,
} from "./chat-logic";

const CHAT_ID_KEY = "prospecteezy-ai-chat-id";

function storedChatId(): string | null {
  try {
    return localStorage.getItem(CHAT_ID_KEY);
  } catch {
    return null;
  }
}

function rememberChatId(id: string) {
  try {
    localStorage.setItem(CHAT_ID_KEY, id);
  } catch {
    // private mode: the conversation still works, it just isn't reopened on reload
  }
}

const newId = () => crypto.randomUUID();

/** Only the last message goes to the server (it ignores the rest anyway). */
const transport = new DefaultChatTransport<AiChatMessage>({
  api: "/api/chat",
  prepareSendMessagesRequest: ({ id, messages, trigger, messageId, body }) => ({
    body: { ...body, id, trigger, messageId, message: messages.at(-1) },
  }),
});

type DataError = AiChatDataTypes["error"];

interface Handlers {
  onData: (part: { type: string; data: unknown }) => void;
  onError: (error: Error) => void;
  onFinish: (options: { message: AiChatMessage; isError: boolean }) => void;
}

function createChat(id: string, messages: AiChatMessage[], handlers: { current: Handlers }) {
  return new Chat<AiChatMessage>({
    id,
    messages,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onData: (part) => handlers.current.onData(part as { type: string; data: unknown }),
    onError: (error) => handlers.current.onError(error),
    onFinish: ({ message, isError }) => handlers.current.onFinish({ message, isError }),
  });
}

export type AiChatView = "ai" | "classic";

interface AiChatContextValue {
  chatId: string;
  messages: AiChatMessage[];
  status: ReturnType<typeof useChat<AiChatMessage>>["status"];
  /** Loading a stored conversation. */
  loading: boolean;
  loadError: string | null;
  /** The opened conversation was still answering on the server when loaded. */
  runningOnServer: boolean;
  /** Serper credits spent in this conversation (null = unknown yet). */
  credits: number | null;
  errorInfo: ChatErrorInfo | null;
  /** Approvals the server will never accept again (replayed → 400). */
  resolvedApprovals: ReadonlySet<string>;
  input: string;
  setInput: (value: string) => void;
  view: AiChatView;
  setView: (view: AiChatView) => void;
  send: (text: string) => void;
  stop: () => void;
  retry: () => void;
  respondApproval: (id: string, approved: boolean, reason?: string) => void;
  sendDraft: (leadId: number, text: string) => void;
  newChat: () => void;
  openChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<boolean>;
  reload: () => Promise<void>;
  /** "Usar modo clássico": send the last user text through POST /api/prospect. */
  switchToClassic: () => void;
}

const AiChatContext = createContext<AiChatContextValue | null>(null);

export function AiChatProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const ai = useAiStatus();
  const { pendingPrompt, consumePrompt } = useAssistant();
  const prospect = useProspectChat();

  const handlers = useRef<Handlers>({ onData: () => {}, onError: () => {}, onFinish: () => {} });
  const [chatId, setChatId] = useState(() => storedChatId() ?? newId());
  const [chat, setChat] = useState(() => createChat(chatId, [], handlers));
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runningOnServer, setRunningOnServer] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [dataError, setDataError] = useState<DataError | null>(null);
  const [resolvedApprovals, setResolvedApprovals] = useState<ReadonlySet<string>>(() => new Set());
  const [input, setInput] = useState("");
  const [view, setView] = useState<AiChatView>("ai");

  const { messages, status, error, sendMessage, regenerate, stop, addToolApprovalResponse, setMessages } = useChat<AiChatMessage>({
    chat,
    throttle: 40,
  });

  /** Replaces the Chat instance with a stored (or empty) conversation. */
  const loadChat = useCallback(
    async (id: string) => {
      setLoading(true);
      setLoadError(null);
      setDataError(null);
      setResolvedApprovals(new Set());
      let stored: AiChatMessage[] = [];
      let used: number | null = null;
      let running = false;
      try {
        const detail = await aiChatApi.messages(id);
        stored = Array.isArray(detail.messages) ? detail.messages : [];
        used = detail.credits_used;
        running = detail.running;
      } catch (err) {
        // 404 = a conversation that was never sent (new): start empty.
        if (!(err instanceof ApiError && err.status === 404)) {
          setLoadError(errorMessage(err, "Não consegui carregar a conversa."));
        }
      }
      setChatId(id);
      rememberChatId(id);
      setChat(createChat(id, stored, handlers));
      setCredits(used ?? creditsFromMessages(stored));
      setRunningOnServer(running);
      setLoading(false);
      setLoaded(true);
    },
    [],
  );

  // First load (only once AI is on: classic mode never touches /api/chat).
  useEffect(() => {
    if (ai.enabled && !loaded && !loading) void loadChat(chatId);
  }, [ai.enabled, loaded, loading, loadChat, chatId]);

  const reload = useCallback(async () => {
    try {
      const detail = await aiChatApi.messages(chatId);
      setMessages(detail.messages ?? []);
      setCredits(detail.credits_used);
      setRunningOnServer(detail.running);
    } catch {
      // keep what is on screen
    }
  }, [chatId, setMessages]);

  handlers.current = {
    onData: (part) => {
      if (part.type === "data-credits") {
        const value = Number((part.data as AiChatDataTypes["credits"])?.credits_thread);
        if (Number.isFinite(value)) setCredits(value);
      } else if (part.type === "data-error") {
        setDataError(part.data as DataError);
      }
    },
    onError: (err) => {
      const info = parseChatError(err);
      if (info.code === "ai_disabled") {
        void queryClient.invalidateQueries({ queryKey: qk.ai.status });
        return;
      }
      if (info.status === 400) {
        // A replayed/expired approval: the server never runs it. Mark the
        // cards resolved and resync with the stored conversation.
        const ids = respondedApprovalIds(chat.messages);
        if (ids.length) {
          setResolvedApprovals((previous) => new Set([...previous, ...ids]));
          void reload();
        }
      }
    },
    onFinish: ({ message }) => {
      void queryClient.invalidateQueries({ queryKey: qk.ai.chats });
      if (completedToolNames(message).some((name) => LEAD_MUTATING_TOOLS.has(name))) {
        void queryClient.invalidateQueries({ queryKey: qk.leads.root });
      }
    },
  };

  const busy = status === "submitted" || status === "streaming";

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setDataError(null);
      setRunningOnServer(false);
      void sendMessage({ text });
    },
    [sendMessage],
  );

  const retry = useCallback(() => {
    setDataError(null);
    void regenerate();
  }, [regenerate]);

  const respondApproval = useCallback(
    (id: string, approved: boolean, reason?: string) => {
      setDataError(null);
      void addToolApprovalResponse({ id, approved, ...(reason?.trim() ? { reason: reason.trim() } : {}) });
    },
    [addToolApprovalResponse],
  );

  const sendDraft = useCallback(
    (leadId: number, text: string) => {
      setDataError(null);
      void sendMessage(undefined, { body: { action: { type: "send_draft", lead_id: leadId, text } } });
    },
    [sendMessage],
  );

  const newChat = useCallback(() => {
    void chat.stop();
    const id = newId();
    setChatId(id);
    rememberChatId(id);
    setChat(createChat(id, [], handlers));
    setCredits(null);
    setDataError(null);
    setLoadError(null);
    setRunningOnServer(false);
    setResolvedApprovals(new Set());
    setView("ai");
  }, [chat]);

  const openChat = useCallback(
    async (id: string) => {
      void chat.stop();
      setView("ai");
      await loadChat(id);
    },
    [chat, loadChat],
  );

  const deleteChat = useCallback(
    async (id: string) => {
      try {
        await aiChatApi.remove(id);
      } catch (err) {
        toast.error(
          err instanceof ApiError && err.status === 409
            ? "Esta conversa ainda está respondendo. Aguarde terminar para excluir."
            : errorMessage(err, "Não consegui excluir a conversa."),
        );
        return false;
      }
      void queryClient.invalidateQueries({ queryKey: qk.ai.chats });
      if (id === chatId) newChat();
      toast.success("Conversa excluída");
      return true;
    },
    [chatId, newChat, queryClient],
  );

  const switchToClassic = useCallback(() => {
    const text = lastUserText(chat.messages);
    setView("classic");
    if (text) void prospect.submit(text);
  }, [chat, prospect]);

  // Prompts from elsewhere (lead drawer): auto-send when idle, else prefill.
  useEffect(() => {
    if (!ai.enabled || !pendingPrompt || loading || !loaded) return;
    if (pendingPrompt.autoSend && busy) return; // wait for the current answer
    const taken = consumePrompt();
    if (!taken) return;
    setView("ai");
    if (taken.autoSend) send(taken.text);
    else setInput(taken.text);
  }, [ai.enabled, pendingPrompt, loading, loaded, busy, consumePrompt, send]);

  const errorInfo = useMemo(
    () => (status === "error" && error ? parseChatError(error, dataError) : null),
    [status, error, dataError],
  );

  const value = useMemo<AiChatContextValue>(
    () => ({
      chatId,
      messages,
      status,
      loading,
      loadError,
      runningOnServer,
      credits,
      errorInfo,
      resolvedApprovals,
      input,
      setInput,
      view,
      setView,
      send,
      stop: () => void stop(),
      retry,
      respondApproval,
      sendDraft,
      newChat,
      openChat,
      deleteChat,
      reload,
      switchToClassic,
    }),
    [chatId, messages, status, loading, loadError, runningOnServer, credits, errorInfo, resolvedApprovals, input, view, send, stop, retry, respondApproval, sendDraft, newChat, openChat, deleteChat, reload, switchToClassic],
  );

  return <AiChatContext.Provider value={value}>{children}</AiChatContext.Provider>;
}

export function useAiChat(): AiChatContextValue {
  const ctx = useContext(AiChatContext);
  if (!ctx) throw new Error("useAiChat must be used inside <AiChatProvider>");
  return ctx;
}
