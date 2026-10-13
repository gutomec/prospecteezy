// AI chat (phase 3): pure helpers, approval/draft renderers (server-rendered
// markup) and the useChat contract against the preview's fake /api/chat
// (dev/mock-ai-chat.ts) with the SDK's own client (AbstractChat + transport).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AbstractChat,
  APICallError,
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ChatState,
  type ChatStatus,
} from "ai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { safeMarkdownUrl } from "../components/ai-elements/streamdown-safety";
import { createMockBackend } from "../dev/mock-backend";
import { ApprovalCard } from "../features/ai/approval-card";
import {
  actionSummary,
  approvalView,
  asDraft,
  asJobStart,
  asLeadStats,
  asQueryLeads,
  AUTO_DENY_REASON,
  completedToolNames,
  creditsFromMessages,
  creditsLabel,
  errorActions,
  extractLinks,
  isToolPart,
  lastUserText,
  parseChatError,
  pendingApprovalIds,
  readDescriptor,
  respondedApprovalIds,
  toolNameOf,
  type ToolPart,
} from "../features/ai/chat-logic";
import { DraftCard } from "../features/ai/draft-card";
import { aiLeadPrompt } from "../features/ai/use-ai-actions";
import type { AiChatMessage } from "../lib/api/types";

const tool = (name: string, extra: Record<string, unknown>): ToolPart =>
  ({ type: `tool-${name}`, toolCallId: `call-${name}`, input: {}, ...extra }) as unknown as ToolPart;

const descriptor = {
  title: "Consultar o Google via Serper: Busca",
  description: "Fazer uma consulta.",
  params: [{ label: "q", value: "padarias recife" }],
  estimated_credits: 1,
};

describe("chat-logic: tool parts and approvals", () => {
  test("toolNameOf / isToolPart", () => {
    expect(toolNameOf(tool("query_leads", { state: "input-available" }))).toBe("query_leads");
    expect(toolNameOf({ type: "dynamic-tool", toolName: "x", toolCallId: "c", state: "input-available", input: {} } as never)).toBe("x");
    expect(isToolPart({ type: "text", text: "oi" } as never)).toBe(false);
    expect(isToolPart(tool("lead_stats", { state: "input-available" }))).toBe(true);
  });

  test("readDescriptor validates untrusted data", () => {
    expect(readDescriptor(descriptor)).toEqual(descriptor);
    expect(readDescriptor(null)).toBeNull();
    expect(readDescriptor({ title: 3 })).toBeNull();
    expect(readDescriptor({ title: "T", params: [{ label: "a", value: 1 }, "x", { value: "sem rótulo" }], estimated_credits: "abc" })).toEqual({
      title: "T",
      description: "",
      params: [{ label: "a", value: "1" }],
      estimated_credits: 0,
    });
  });

  test("approvalView: pending only in the last message; stale after moving on", () => {
    const requested = tool("serper_search", { state: "approval-requested", approval: { id: "a1", descriptor } });
    expect(approvalView(requested, true)).toBe("pending");
    expect(approvalView(requested, false)).toBe("stale");
    expect(approvalView(requested, true, new Set(["a1"]))).toBe("stale");
    expect(approvalView(tool("x", { state: "approval-responded", approval: { id: "a", approved: true } }), true)).toBe("sending");
    expect(approvalView(tool("x", { state: "approval-responded", approval: { id: "a", approved: true } }), true, new Set(["a"]))).toBe("stale");
    expect(approvalView(tool("x", { state: "output-denied", approval: { id: "a", approved: false, reason: AUTO_DENY_REASON } }), false)).toBe("stale");
    expect(approvalView(tool("x", { state: "output-denied", approval: { id: "a", approved: false, reason: "caro" } }), true)).toBe("denied");
    expect(approvalView(tool("x", { state: "output-available", approval: { id: "a", approved: true }, output: {} }), true)).toBe("approved");
    expect(approvalView(tool("x", { state: "output-error", approval: { id: "a", approved: true }, errorText: "x" }), true)).toBe("failed");
    expect(approvalView(tool("query_leads", { state: "output-available", output: {} }), true)).toBeNull();
  });

  test("pending / responded approval ids come from the last assistant message only", () => {
    const messages = [
      { id: "1", role: "assistant", parts: [tool("a", { state: "approval-requested", approval: { id: "old" } })] },
      { id: "2", role: "user", parts: [{ type: "text", text: "x" }] },
      {
        id: "3",
        role: "assistant",
        parts: [
          tool("b", { state: "approval-requested", approval: { id: "p1" } }),
          tool("c", { state: "approval-responded", approval: { id: "r1", approved: true } }),
        ],
      },
    ] as unknown as AiChatMessage[];
    expect(pendingApprovalIds(messages)).toEqual(["p1"]);
    expect(respondedApprovalIds(messages)).toEqual(["r1"]);
    expect(pendingApprovalIds(messages.slice(0, 2))).toEqual([]);
  });
});

describe("chat-logic: errors", () => {
  const apiError = (status: number, body: unknown) =>
    new APICallError({ message: "x", url: "/api/chat", requestBodyValues: {}, statusCode: status, responseBody: JSON.stringify(body) });

  test("pre-stream JSON errors keep status + code + PT-BR message", () => {
    expect(parseChatError(apiError(409, { error: "A IA está desativada.", code: "ai_disabled" }))).toEqual({
      status: 409,
      code: "ai_disabled",
      message: "A IA está desativada.",
    });
    const replay = parseChatError(apiError(400, { error: "Aprovação não encontrada ou já respondida." }));
    expect(replay).toMatchObject({ status: 400, message: "Aprovação não encontrada ou já respondida." });
    expect(errorActions(replay)).toEqual([]);
    expect(parseChatError(new APICallError({ message: "x", url: "u", requestBodyValues: {}, statusCode: 502, responseBody: "<html>" }))).toMatchObject({
      status: 502,
      message: "Erro 502 ao falar com o assistente.",
    });
  });

  test("data-error wins over the generic stream error; actions per code", () => {
    const info = parseChatError(new Error("recusou a chave"), { code: "llm_auth", message: "O provedor recusou a chave." });
    expect(info).toEqual({ status: null, code: "llm_auth", message: "O provedor recusou a chave." });
    expect(errorActions(info)).toEqual(["retry", "settings", "classic"]);
    expect(errorActions({ status: null, code: "llm_quota", message: "" })).toEqual(["retry", "settings", "classic"]);
    expect(errorActions({ status: null, code: "llm_unavailable", message: "" })).toEqual(["retry", "classic"]);
    expect(errorActions({ status: 409, code: "ai_disabled", message: "" })).toEqual(["classic"]);
    expect(parseChatError(new TypeError("Failed to fetch")).code).toBe("network");
    expect(parseChatError(new Error("Tempo esgotado.")).message).toBe("Tempo esgotado.");
  });
});

describe("chat-logic: outputs, links, credits", () => {
  test("output guards drop malformed data", () => {
    expect(asQueryLeads({ total: 3, leads: [{ id: 1, name: "A" }, { id: "x" }, null] })).toEqual({ total: 3, leads: [{ id: 1, name: "A" } as never] });
    expect(asQueryLeads({ rows: [] })).toBeNull();
    expect(asDraft({ lead_id: 4, text: "Olá", can_send_whatsapp: false, reason: "Sem WhatsApp" })).toEqual({
      lead_id: 4,
      lead_name: "Lead #4",
      text: "Olá",
      can_send_whatsapp: false,
      reason: "Sem WhatsApp",
    });
    expect(asDraft({ lead_id: "4", text: "x" })).toBeNull();
    expect(asJobStart({ job_id: "j1", already_running: true })).toEqual({ job_id: "j1", already_running: true });
    expect(asLeadStats({ total: 10, whatsapp: { yes: 2 } })).toMatchObject({ total: 10, whatsapp: { yes: 2, no: 0, unknown: 0 } });
  });

  test("actionSummary for save / send / crawl", () => {
    expect(actionSummary("save_lead_enrichment", { saved: true, lead_id: 2, email_saved: true })).toEqual({
      ok: true,
      text: "Enriquecimento salvo no lead #2 (e-mail gravado).",
    });
    expect(actionSummary("send_whatsapp_message", { sent: false, lead_id: 2, code: "blocked", reason: "Horário silencioso." })).toEqual({
      ok: false,
      text: "Horário silencioso.",
    });
    expect(actionSummary("send_whatsapp_message", { sent: true, lead_id: 7 })?.ok).toBe(true);
    expect(actionSummary("crawl_lead_website", { email: "a@b.com", socials: { instagram: "x" }, pages_visited: 3 })?.text).toBe(
      "Site visitado (3 páginas): e-mail a@b.com, instagram.",
    );
    expect(actionSummary("query_leads", {})).toBeNull();
  });

  test("extractLinks keeps only http(s), dedupes, reads places/news/scrape", () => {
    const links = extractLinks("serper_search", {
      results: {
        organic: [
          { title: "Site", link: "https://a.example/x", snippet: "s" },
          { title: "XSS", link: "javascript:alert(1)" },
          { title: "Dup", link: "https://a.example/x" },
        ],
        places: [{ title: "Padaria", website: "http://padaria.example" }, { title: "Sem site" }],
        searchParameters: { q: "x" },
      },
    });
    expect(links).toEqual([
      { url: "https://a.example/x", title: "Site", snippet: "s" },
      { url: "http://padaria.example/", title: "Padaria" },
    ]);
    expect(extractLinks("scrape_webpage", { url: "https://b.example/", metadata: { title: "Página B" } })).toEqual([
      { url: "https://b.example/", title: "Página B" },
    ]);
    expect(extractLinks("scrape_webpage", { url: "data:text/html,oi" })).toEqual([]);
  });

  test("credits, last user text, completed tools", () => {
    const messages = [
      { id: "u", role: "user", parts: [{ type: "text", text: "Buscar 30 dentistas" }] },
      {
        id: "a",
        role: "assistant",
        parts: [
          { type: "data-credits", id: "credits", data: { credits_thread: 3, credits_run: 1 } },
          tool("save_lead_enrichment", { state: "output-available", output: { saved: true } }),
          tool("serper_search", { state: "approval-requested", approval: { id: "x" } }),
        ],
      },
    ] as unknown as AiChatMessage[];
    expect(creditsFromMessages(messages)).toBe(3);
    expect(creditsFromMessages([])).toBeNull();
    expect(lastUserText(messages)).toBe("Buscar 30 dentistas");
    expect(completedToolNames(messages[1])).toEqual(["save_lead_enrichment"]);
    expect(creditsLabel(1)).toBe("1 crédito Serper nesta conversa");
    expect(creditsLabel(1200)).toBe("1.200 créditos Serper nesta conversa");
  });

  test("markdown links: only http(s)/mailto/tel survive", () => {
    expect(safeMarkdownUrl("https://serper.dev")).toBe("https://serper.dev/");
    expect(safeMarkdownUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(safeMarkdownUrl("javascript:alert(1)")).toBe("");
    expect(safeMarkdownUrl(" JavaScript:alert(1)")).toBe("");
    expect(safeMarkdownUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe("");
    expect(safeMarkdownUrl("/relative")).toBe("");
  });

  test("lead drawer prompts (stable contract)", () => {
    expect(aiLeadPrompt("research", { id: 7, name: "Padaria Pão Bom" })).toBe(
      "Pesquise mais informações sobre o lead #7 (Padaria Pão Bom) e proponha um enriquecimento.",
    );
    expect(aiLeadPrompt("draft", { id: 7, name: "Padaria Pão Bom" })).toBe(
      "Redija uma mensagem de WhatsApp para o lead #7 (Padaria Pão Bom) com base no perfil da minha empresa.",
    );
  });
});

describe("renderers (static markup)", () => {
  const card = (view: Parameters<typeof ApprovalCard>[0]["view"], extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(ApprovalCard, {
        part: tool("serper_search", { state: "approval-requested", approval: { id: "a1", descriptor }, ...extra }),
        toolName: "serper_search",
        view,
        canRespond: true,
        onRespond: () => {},
      }),
    );

  test("pending approval card shows descriptor, credits and both actions", () => {
    const html = card("pending");
    expect(html).toContain("Consultar o Google via Serper: Busca");
    expect(html).toContain("padarias recife");
    expect(html).toContain("≈ 1 crédito Serper");
    expect(html).toContain("Aprovar");
    expect(html).toContain("Recusar");
  });

  test("stale card: resolved label, no actions", () => {
    const html = card("stale");
    expect(html).toContain("Recusado (nova mensagem)");
    expect(html).not.toContain("Aprovar");
  });

  test("draft card: send button only when WhatsApp is validated; else the reason", () => {
    const base = { lead_id: 4, lead_name: "Padaria", text: "Olá!", can_send_whatsapp: true };
    expect(renderToStaticMarkup(createElement(DraftCard, { draft: base, disabled: false, onSend: () => {} }))).toContain("Enviar pelo WhatsApp");
    const blocked = renderToStaticMarkup(
      createElement(DraftCard, { draft: { ...base, can_send_whatsapp: false, reason: "Lead sem WhatsApp validado." }, disabled: false, onSend: () => {} }),
    );
    expect(blocked).not.toContain("Enviar pelo WhatsApp");
    expect(blocked).toContain("Lead sem WhatsApp validado.");
  });
});

// ---------------------------------------------------------------------------
// useChat contract against the preview's fake backend.
// ---------------------------------------------------------------------------

class MemoryState implements ChatState<AiChatMessage> {
  status: ChatStatus = "ready";
  error: Error | undefined = undefined;
  messages: AiChatMessage[] = [];
  pushMessage = (m: AiChatMessage) => void this.messages.push(m);
  popMessage = () => void this.messages.pop();
  replaceMessage = (i: number, m: AiChatMessage) => void (this.messages[i] = m);
  snapshot = <T,>(thing: T): T => structuredClone(thing);
}

class TestChat extends AbstractChat<AiChatMessage> {
  data: Array<{ type: string; data: any }> = [];
  constructor(base: string, id: string) {
    super({
      id,
      state: new MemoryState(),
      transport: new DefaultChatTransport({
        api: `${base}/api/chat`,
        prepareSendMessagesRequest: ({ id, messages, trigger, messageId, body }) => ({
          body: { ...body, id, trigger, messageId, message: messages.at(-1) },
        }),
      }),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onData: (part) => void this.data.push(part as never),
    });
  }
}

async function settle(chat: TestChat) {
  for (let i = 0; i < 600 && (chat.status === "submitted" || chat.status === "streaming"); i++) await Bun.sleep(10);
  await Bun.sleep(30);
}

const partOf = (m: AiChatMessage | undefined, name: string) => m?.parts.filter(isToolPart).find((p) => toolNameOf(p) === name) as any;

describe("useChat contract with the mock /api/chat", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";

  beforeAll(async () => {
    const mock = createMockBackend();
    server = Bun.serve({ port: 0, fetch: (req) => mock.handle(req, new URL(req.url)) });
    base = `http://localhost:${server.port}`;
    // AI starts disabled in the mock: 409 ai_disabled first, then activate.
    const disabled = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "x" }) });
    expect(disabled.status).toBe(409);
    expect(((await disabled.json()) as { code: string }).code).toBe("ai_disabled");
    await fetch(`${base}/api/ai/providers/p1/activate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  });
  afterAll(() => server.stop(true));

  test("approve → executes, continues the same message, credits arrive; replay → 400", async () => {
    const chat = new TestChat(base, "c-approve");
    await chat.sendMessage({ text: "Pesquise o lead #2" });
    await settle(chat);
    const search = partOf(chat.lastMessage, "serper_search");
    expect(search.state).toBe("approval-requested");
    expect(readDescriptor(search.approval.descriptor)?.estimated_credits).toBe(1);
    expect(approvalView(search, true)).toBe("pending");

    await chat.addToolApprovalResponse({ id: search.approval.id, approved: true });
    await settle(chat);
    expect(chat.messages).toHaveLength(2);
    expect(partOf(chat.lastMessage, "serper_search").state).toBe("output-available");
    expect(extractLinks("serper_search", partOf(chat.lastMessage, "serper_search").output).some((l) => l.url.startsWith("javascript"))).toBe(false);
    expect(partOf(chat.lastMessage, "save_lead_enrichment").state).toBe("approval-requested");
    expect(chat.data.filter((d) => d.type === "data-credits").at(-1)?.data.credits_thread).toBe(1);

    // Replaying the first decision: the server refuses it (400) and never re-runs.
    const replay = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "c-approve",
        message: { id: chat.lastMessage!.id, role: "assistant", parts: [{ ...search, state: "approval-responded", approval: { ...search.approval, approved: true } }] },
      }),
    });
    expect(replay.status).toBe(400);
  });

  test("a new user message makes the pending approval stale (server denies it)", async () => {
    const chat = new TestChat(base, "c-stale");
    await chat.sendMessage({ text: "Buscar 30 dentistas em Curitiba-PR" });
    await settle(chat);
    const pending = partOf(chat.lastMessage, "start_prospect_search");
    expect(pending.state).toBe("approval-requested");
    await chat.sendMessage({ text: "Deixa pra lá. Quantos leads eu tenho?" });
    await settle(chat);
    expect(approvalView(partOf(chat.messages[1], "start_prospect_search"), false)).toBe("stale");
    const stored = (await (await fetch(`${base}/api/chat/c-stale/messages`)).json()) as { messages: AiChatMessage[] };
    expect(approvalView(partOf(stored.messages[1], "start_prospect_search"), false)).toBe("stale");
    expect(partOf(stored.messages[1], "start_prospect_search").state).toBe("output-denied");
  });

  test("draft card send: send_draft → send_whatsapp_message approval → sent", async () => {
    const chat = new TestChat(base, "c-draft");
    await chat.sendMessage({ text: "Redija uma mensagem para o lead #4" });
    await settle(chat);
    const draft = asDraft(partOf(chat.lastMessage, "present_message_draft").output)!;
    expect(draft.lead_id).toBe(4);
    expect(draft.can_send_whatsapp).toBe(true);
    await chat.sendMessage(undefined, { body: { action: { type: "send_draft", lead_id: 4, text: "Olá, editado!" } } });
    await settle(chat);
    expect(chat.messages).toHaveLength(2);
    const send = partOf(chat.lastMessage, "send_whatsapp_message");
    expect(send.state).toBe("approval-requested");
    expect(send.input).toEqual({ lead_id: 4, text: "Olá, editado!" });
    await chat.addToolApprovalResponse({ id: send.approval.id, approved: true });
    await settle(chat);
    expect(actionSummary("send_whatsapp_message", partOf(chat.lastMessage, "send_whatsapp_message").output)?.ok).toBe(true);
  });

  test("LLM error: data-error then error; regenerate answers again", async () => {
    const chat = new TestChat(base, "c-error");
    await chat.sendMessage({ text: "simule um erro" });
    await settle(chat);
    expect(chat.status).toBe("error");
    const dataError = chat.data.find((d) => d.type === "data-error")!.data;
    expect(dataError.code).toBe("llm_quota");
    expect(parseChatError(chat.error, dataError).message).toContain("limite");
    await chat.regenerate();
    await settle(chat);
    expect(chat.status).toBe("ready");
    expect(chat.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("history list, 404 for unknown chat, delete", async () => {
    const list = (await (await fetch(`${base}/api/chat`)).json()) as { chats: Array<{ id: string; title: string }> };
    expect(list.chats.map((c) => c.id)).toContain("c-draft");
    expect((await fetch(`${base}/api/chat/nope/messages`)).status).toBe(404);
    const del = await fetch(`${base}/api/chat/c-draft`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(del.status).toBe(200);
    expect((await fetch(`${base}/api/chat/c-draft/messages`)).status).toBe(404);
  });
});
