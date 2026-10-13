// POST /api/chat: the prospecting agent over the AI SDK v7 UI message stream
// protocol (useChat from @ai-sdk/react + AI Elements). The agent (tools,
// prompt, approval rules, Serper credit accounting) lives in agent.ts; the
// conversation is stored as UIMessage[] in ai_chats.
//
// The server is the source of truth: from the request only the LAST message is
// read (a new user message, or the assistant message carrying approval
// decisions made with addToolApprovalResponse). Approvals are matched against
// the STORED pending requests, so a replayed or forged decision can never run
// an action twice; one run per chat at a time (in-process lock).
import type { Database } from "bun:sqlite";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isToolUIPart,
  toUIMessageStream,
  type TextStreamPart,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import {
  AgentRequestError,
  API_KEY_UNREADABLE,
  createProspectAgent,
  RUN_TIMEOUT_MS,
  validateSendDraft,
  type AgentRuntimeDeps,
} from "./agent.ts";
import { loadOrCreateChat, saveChat, uiMessageText, type Chat } from "./chats.ts";
import { classifyLlmError, type LlmErrorInfo } from "./errors.ts";
import { providerApiKey, type ProviderRow } from "./providers.ts";
import { describeApproval } from "./tools.ts";

export class ChatRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type ChatAction =
  | { kind: "run" }
  | { kind: "send_draft"; leadId: number; text: string; deniedToolCallIds: string[] };

export interface PreparedChat {
  chat: Chat;
  action: ChatAction;
}

/** Chats with a run in progress (one at a time per chat id). */
const runningChats = new Set<string>();

export function isChatRunning(id: string): boolean {
  return runningChats.has(id);
}

const MAX_USER_TEXT = 20_000;
const AUTO_DENY_REASON = "O usuário seguiu a conversa sem decidir.";
const INTERRUPTED_TEXT = "Execução interrompida antes de terminar; a ação pode não ter sido concluída.";
const TIMEOUT_INFO: LlmErrorInfo = { code: "llm_unavailable", message: "A execução excedeu o tempo limite de 120 segundos." };

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }> & Record<string, unknown>;

function toolParts(message: UIMessage): ToolPart[] {
  return message.parts.filter((p) => isToolUIPart(p)) as ToolPart[];
}

/**
 * Resolves what a run left half-done, so nothing is ever (re)executed by
 * accident: a pending approval becomes denied (`denyPending`), an approved call
 * with no output and an input never executed become errors.
 */
function settleParts(messages: UIMessage[], denyPending: boolean): string[] {
  const denied: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of toolParts(message)) {
      const approval = part.approval as { id: string; approved?: boolean; reason?: string } | undefined;
      if (part.state === "approval-requested" && denyPending && approval) {
        Object.assign(part, { state: "output-denied", approval: { ...approval, approved: false, reason: AUTO_DENY_REASON } });
        denied.push(part.toolCallId);
      } else if (part.state === "approval-responded" && approval) {
        if (approval.approved === false) Object.assign(part, { state: "output-denied" });
        else Object.assign(part, { state: "output-error", errorText: INTERRUPTED_TEXT });
      } else if ((part.state === "input-streaming" || part.state === "input-available") && part.providerExecuted !== true) {
        Object.assign(part, { state: "output-error", errorText: INTERRUPTED_TEXT });
      }
    }
  }
  return denied;
}

/** An assistant message with nothing in it (a run that failed up front). */
function isEmptyAssistant(message: UIMessage): boolean {
  return message.role === "assistant" && !message.parts.some((p) => p.type !== "step-start" && !p.type.startsWith("data-"));
}

/**
 * Validates a useChat request body against the stored chat (400/409 happen
 * here, before the stream opens) and applies it to the stored history.
 */
export function prepareChat(db: Database, body: unknown): PreparedChat {
  if (typeof body !== "object" || body === null) throw new ChatRequestError("Corpo inválido: envie o JSON do useChat.");
  const input = body as Record<string, unknown>;
  if (!isId(input.id)) throw new ChatRequestError('Campo "id" (id da conversa) é obrigatório.');
  if (runningChats.has(input.id)) {
    throw new ChatRequestError("Já existe uma resposta em andamento nesta conversa. Aguarde terminar.", 409);
  }
  const chat = loadOrCreateChat(db, input.id);

  // 1. UI action: the draft card's send button.
  if (input.action !== undefined) {
    const action = input.action as Record<string, unknown> | null;
    if (!action || action.type !== "send_draft") throw new ChatRequestError("Ação não suportada.");
    try {
      const { leadId, text } = validateSendDraft(db, action);
      const deniedToolCallIds = settleParts(chat.messages, true);
      return { chat, action: { kind: "send_draft", leadId, text, deniedToolCallIds } };
    } catch (error) {
      if (error instanceof AgentRequestError) throw new ChatRequestError(error.message);
      throw error;
    }
  }

  const trigger = input.trigger ?? "submit-message";
  // 2. Regenerate: drop the trailing answer and answer the last user message again.
  if (trigger === "regenerate-message") {
    settleParts(chat.messages, true);
    while (chat.messages.at(-1)?.role === "assistant") chat.messages.pop();
    if (chat.messages.at(-1)?.role !== "user") throw new ChatRequestError("Não há mensagem para responder de novo.");
    return { chat, action: { kind: "run" } };
  }
  if (trigger !== "submit-message") throw new ChatRequestError('Campo "trigger" inválido.');

  const incoming = (input.message ?? (Array.isArray(input.messages) ? input.messages.at(-1) : undefined)) as
    | Partial<UIMessage>
    | undefined;
  if (!incoming || typeof incoming !== "object" || !Array.isArray(incoming.parts)) {
    throw new ChatRequestError("Nenhuma mensagem para processar.");
  }

  // 3. Approval decisions (addToolApprovalResponse → automatic resubmit).
  if (incoming.role === "assistant") {
    const decisions = (incoming.parts as ToolPart[])
      .filter((p) => isToolUIPart(p as never) && p.state === "approval-responded")
      .map((p) => p.approval as { id?: unknown; approved?: unknown; reason?: unknown })
      .filter((a) => a && isId(a.id) && typeof a.approved === "boolean");
    if (decisions.length === 0) throw new ChatRequestError("Nenhuma aprovação respondida na mensagem.");
    const target = [...chat.messages].reverse().find((m) => m.role === "assistant");
    const pending = new Map<string, ToolPart>();
    for (const part of target ? toolParts(target) : []) {
      const approval = part.approval as { id: string } | undefined;
      if (part.state === "approval-requested" && approval) pending.set(approval.id, part);
    }
    for (const decision of decisions) {
      if (!pending.has(decision.id as string)) throw new ChatRequestError("Aprovação não encontrada ou já respondida.");
    }
    if (decisions.length < pending.size) throw new ChatRequestError("Responda todas as aprovações pendentes desta mensagem.");
    settleParts(chat.messages, false);
    for (const decision of decisions) {
      const part = pending.get(decision.id as string)!;
      const reason = typeof decision.reason === "string" && decision.reason.trim() ? decision.reason.trim().slice(0, 500) : undefined;
      Object.assign(part, {
        state: "approval-responded",
        approval: { ...(part.approval as object), approved: decision.approved, ...(reason ? { reason } : {}) },
      });
    }
    return { chat, action: { kind: "run" } };
  }

  // 4. A user message.
  if (incoming.role !== "user") throw new ChatRequestError("Papel de mensagem inválido.");
  const messageId = isId(incoming.id) ? incoming.id : `msg-${crypto.randomUUID()}`;
  const existing = chat.messages.findIndex((m) => m.id === messageId);
  if (existing !== -1) {
    // Same message again: only when it is still unanswered (the run failed).
    if (existing === chat.messages.length - 1) return { chat, action: { kind: "run" } };
    throw new ChatRequestError("Esta mensagem já foi processada.");
  }
  const text = uiMessageText(incoming as UIMessage);
  if (!text) throw new ChatRequestError("A mensagem está vazia.");
  if (text.length > MAX_USER_TEXT) throw new ChatRequestError("A mensagem excede 20.000 caracteres.");
  settleParts(chat.messages, true); // moving on = pending approvals are refused
  chat.messages.push({ id: messageId, role: "user", parts: [{ type: "text", text }] });
  return { chat, action: { kind: "run" } };
}

/** An LLM/stream failure already classified (code + PT-BR message). */
class LlmFailure extends Error {
  constructor(readonly info: LlmErrorInfo) {
    super(info.message);
  }
}

/** Text of the `error` chunk / tool errors: PT-BR, never the provider key. */
function errorText(error: unknown): string {
  if (error instanceof LlmFailure) return error.info.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one /api/chat request and returns the UI message stream response.
 * `signal` is the client connection (req.signal); disconnecting aborts the run.
 */
export function streamChat(
  db: Database,
  deps: AgentRuntimeDeps,
  provider: ProviderRow,
  prepared: PreparedChat,
  signal: AbortSignal,
): Response {
  const { chat, action } = prepared;
  runningChats.add(chat.id);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    runningChats.delete(chat.id);
  };
  try {
    // The user message / approval decisions are durable before anything runs:
    // a crash mid-run leaves an approved call that settleParts marks as
    // interrupted (never re-executed).
    saveChat(db, chat);
  } catch (error) {
    release();
    throw error;
  }

  let runCredits = 0;
  const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
  const abortSignal = AbortSignal.any([signal, timeout]);

  const stream = createUIMessageStream({
    originalMessages: chat.messages,
    generateId: () => `msg-${crypto.randomUUID()}`,
    onError: errorText,
    execute: async ({ writer }) => {
      const writeCredits = () =>
        writer.write({
          type: "data-credits",
          id: "credits",
          data: { credits_thread: chat.credits_used + runCredits, credits_run: runCredits },
        });
      const writeFailure = (info: LlmErrorInfo) => {
        writer.write({ type: "data-error", data: info, transient: true });
        writeCredits();
        writer.write({ type: "error", errorText: info.message });
      };

      if (action.kind === "send_draft") {
        writeDraftApproval(db, chat, action, writer.write.bind(writer));
        writeCredits();
        writer.write({ type: "finish", finishReason: "tool-calls" });
        return;
      }

      const apiKey = await providerApiKey(provider, deps.box);
      if (apiKey === undefined) {
        writer.write({ type: "start" });
        writeFailure({ code: "llm_auth", message: API_KEY_UNREADABLE });
        return;
      }

      let lastFailure: LlmErrorInfo | null = null;
      try {
        const agent = createProspectAgent(db, deps, provider, apiKey, (credits) => {
          runCredits += credits;
        });
        const modelMessages = await convertToModelMessages(chat.messages, {
          tools: agent.tools,
          ignoreIncompleteToolCalls: true,
        });
        // onError is forwarded to streamText; it silences the SDK's default
        // console logging (provider errors may echo request details).
        const result = await agent.stream({
          messages: modelMessages,
          abortSignal,
          onError: () => {},
        } as Parameters<typeof agent.stream>[0]);

        // Stream failures are classified here (code + PT-BR text); a timeout
        // becomes an error instead of a silent abort.
        const tagged = (result.stream as ReadableStream<TextStreamPart<ToolSet>>).pipeThrough(
          new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
            transform(part, controller) {
              if (part.type === "error") {
                lastFailure = part.error instanceof LlmFailure ? part.error.info : classifyLlmError(part.error, apiKey);
                controller.enqueue({ ...part, error: new LlmFailure(lastFailure) });
                return;
              }
              if (part.type === "abort" && timeout.aborted && !signal.aborted) {
                lastFailure = TIMEOUT_INFO;
                controller.enqueue({ type: "error", error: new LlmFailure(TIMEOUT_INFO) });
                return;
              }
              controller.enqueue(part);
            },
          }),
        );

        const toolInputs = new Map<string, { toolName: string; input: unknown }>();
        const chunks = toUIMessageStream({ stream: tagged, tools: agent.tools, onError: errorText });
        for await (const chunk of chunks as unknown as AsyncIterable<UIMessageChunk>) {
          if (chunk.type === "tool-input-available") {
            toolInputs.set(chunk.toolCallId, { toolName: chunk.toolName, input: chunk.input });
          }
          if (chunk.type === "tool-approval-request") {
            // Card data for the UI: title, description, params, estimated credits.
            const call = toolInputs.get(chunk.toolCallId);
            if (call) {
              chunk.approvalDescriptor = describeApproval(db, call.toolName, (call.input ?? {}) as Record<string, unknown>);
            }
          }
          if (chunk.type === "finish") writeCredits();
          if (chunk.type === "error") {
            writer.write({ type: "data-error", data: lastFailure ?? { code: "llm_error", message: chunk.errorText }, transient: true });
            writeCredits();
          }
          writer.write(chunk);
        }
      } catch (error) {
        if (signal.aborted) return; // client went away: nobody to tell
        writeFailure(timeout.aborted ? TIMEOUT_INFO : classifyLlmError(error, apiKey));
      }
    },
    onEnd: ({ messages }) => {
      try {
        const settled = messages.filter((m, i) => !(i === messages.length - 1 && isEmptyAssistant(m)));
        settleParts(settled, false);
        chat.messages = settled;
        chat.credits_used += runCredits;
        saveChat(db, chat);
      } finally {
        release();
      }
    },
  });
  return createUIMessageStreamResponse({ stream });
}

/**
 * The draft card's send button: a send_whatsapp_message call that waits for
 * the user's approval (no LLM call). It continues the last assistant message
 * (where the draft is); pending approvals there are refused first.
 */
function writeDraftApproval(
  db: Database,
  chat: Chat,
  action: { leadId: number; text: string; deniedToolCallIds: string[] },
  write: (chunk: UIMessageChunk) => void,
): void {
  const last = chat.messages.at(-1);
  write({ type: "start", ...(last?.role === "assistant" ? { messageId: last.id } : {}) });
  // Approvals refused by this action (already settled in the stored history).
  for (const toolCallId of action.deniedToolCallIds) write({ type: "tool-output-denied", toolCallId });
  const toolCallId = `call-${crypto.randomUUID()}`;
  const input = { lead_id: action.leadId, text: action.text };
  write({ type: "start-step" });
  write({ type: "tool-input-available", toolCallId, toolName: "send_whatsapp_message", input });
  write({
    type: "tool-approval-request",
    approvalId: `approval-${crypto.randomUUID()}`,
    toolCallId,
    approvalDescriptor: describeApproval(db, "send_whatsapp_message", input),
  });
  write({ type: "finish-step" });
}
