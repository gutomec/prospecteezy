// POST /api/chat (AI SDK v7 UI message stream, useChat) — mock model, no network.
import { afterEach, describe, expect, test } from "bun:test";
import {
  AbstractChat,
  APICallError,
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ChatState,
  type ChatStatus,
  type UIMessage,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { resetJobs } from "../src/agent/jobs.ts";
import type { PlacesFetcher } from "../src/ingest/serper.ts";
import { call, scriptedModel, seedLead, startAiServer, textStep, toolStep, type Chunk } from "./_ai-helpers.ts";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  resetJobs();
});

interface Harness {
  base: string;
  db: import("bun:sqlite").Database;
  script: ReturnType<typeof scriptedModel>;
  serperCalls: Array<Record<string, unknown>>;
  waSends: Array<{ leadId: number; text: string }>;
}

async function setup(steps: Array<Chunk[] | Error>, model?: unknown, fetcher?: PlacesFetcher): Promise<Harness> {
  const script = scriptedModel(steps);
  const serperCalls: Harness["serperCalls"] = [];
  const waSends: Harness["waSends"] = [];
  const t = startAiServer({
    aiModelFactory: () => (model ?? script.model) as never,
    ...(fetcher ? { fetcher } : {}),
    serperFetch: (async (_url: string, init: RequestInit) => {
      serperCalls.push(JSON.parse(String(init.body)));
      return Response.json({ searchParameters: { q: "x" }, organic: [{ title: "Padaria Real", link: "https://real.example" }], credits: 1 });
    }) as typeof fetch,
    waSendToLead: async (leadId, text) => {
      waSends.push({ leadId, text });
      return { ok: true, jid: "5581999990000@s.whatsapp.net", instance: "main" };
    },
  });
  stop = t.stop;
  await call(t.base, "PUT", "/api/settings/serper", { api_key: "serper-key-0001" });
  await call(t.base, "POST", "/api/ai/providers", { kind: "openai", model: "gpt-5-mini", api_key: "sk-test-key-9999" });
  return { base: t.base, db: t.db, script, serperCalls, waSends };
}

type UiChunk = { type: string; [k: string]: any };

/** POST /api/chat and parse the SSE body (`data: {json}` frames, `[DONE]`). */
async function chat(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const chunks: UiChunk[] = [];
  let done = false;
  if (res.ok) {
    for (const frame of text.split("\n\n")) {
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      if (data === "[DONE]") done = true;
      else chunks.push(JSON.parse(data));
    }
  }
  let json: any = null;
  if (!res.ok) json = JSON.parse(text);
  return { status: res.status, headers: res.headers, chunks, done, json };
}

const userMsg = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

async function stored(base: string, id: string): Promise<{ messages: UIMessage[]; credits_used: number; title: string }> {
  return (await call(base, "GET", `/api/chat/${id}/messages`)).json;
}

/** What addToolApprovalResponse does on the client, then the automatic resubmit body. */
function respondToApprovals(messages: UIMessage[], approved: boolean, reason?: string) {
  const last = structuredClone(messages.at(-1)!);
  for (const part of last.parts as any[]) {
    if (part.state === "approval-requested") {
      part.state = "approval-responded";
      part.approval = { ...part.approval, approved, reason };
    }
  }
  return [...messages.slice(0, -1), last];
}

const toolPart = (m: UIMessage, name: string) => (m.parts as any[]).find((p) => p.type === `tool-${name}`);

describe("POST /api/chat (AI SDK UI message stream)", () => {
  test("409 JSON when AI is disabled", async () => {
    const t = startAiServer();
    stop = t.stop;
    const res = await chat(t.base, { id: "c0", messages: [userMsg("u1", "oi")], trigger: "submit-message" });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "ai_disabled" });
    expect(res.json.error).toContain("desativada");
  });

  test("400 on bad bodies", async () => {
    const h = await setup([]);
    expect((await chat(h.base, { messages: [userMsg("u1", "oi")] })).status).toBe(400);
    expect((await chat(h.base, { id: "c1", messages: [] })).status).toBe(400);
    expect((await chat(h.base, { id: "c1", messages: [userMsg("u1", "  ")] })).status).toBe(400);
    expect((await chat(h.base, { id: "c1", trigger: "resume-stream", messages: [userMsg("u1", "oi")] })).status).toBe(400);
  });

  test("text streaming: UI message stream protocol, credits data part, history reload and list", async () => {
    const h = await setup([textStep("Olá! Como posso ajudar?"), textStep("Claro.")]);
    const res = await chat(h.base, { id: "chat-a", messages: [userMsg("u1", "Oi, tudo bem?")], trigger: "submit-message" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(res.done).toBe(true);
    expect(res.chunks.map((c) => c.type)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "data-credits",
      "finish",
    ]);
    expect(res.chunks[0]!.messageId).toMatch(/^msg-/);
    expect(res.chunks[3]!.delta).toBe("Olá! Como posso ajudar?");
    expect(res.chunks[6]).toEqual({ type: "data-credits", id: "credits", data: { credits_thread: 0, credits_run: 0 } });

    const s = await stored(h.base, "chat-a");
    expect(s.title).toBe("Oi, tudo bem?");
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages[1]!.id).toBe(res.chunks[0]!.messageId);
    expect((s.messages[1]!.parts as any[]).find((p) => p.type === "text").text).toBe("Olá! Como posso ajudar?");

    // Second turn: the client may send only the last message; history comes from the server.
    await chat(h.base, { id: "chat-a", message: userMsg("u2", "Me ajuda?"), trigger: "submit-message" });
    const prompt = h.script.prompts[1] as Array<{ role: string }>;
    expect(prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect((await stored(h.base, "chat-a")).messages).toHaveLength(4);

    // Same user message again → already processed.
    expect((await chat(h.base, { id: "chat-a", message: userMsg("u1", "Oi, tudo bem?") })).status).toBe(400);

    const list = await call(h.base, "GET", "/api/chat");
    expect(list.json.chats).toEqual([expect.objectContaining({ id: "chat-a", title: "Oi, tudo bem?", credits_used: 0 })]);
    expect((await call(h.base, "GET", "/api/chat/nope/messages")).status).toBe(404);
  });

  test("approval round-trip executes exactly once; structured output + credits; replay refused", async () => {
    const h = await setup([
      toolStep("call-1", "serper_search", { type: "search", q: "Padaria Real Recife" }),
      textStep("Encontrei a Padaria Real."),
    ]);
    const first = await chat(h.base, { id: "chat-b", messages: [userMsg("u1", "Pesquise a Padaria Real")] });
    const request = first.chunks.find((c) => c.type === "tool-approval-request")!;
    expect(request).toMatchObject({ toolCallId: "call-1", approvalId: expect.any(String) });
    expect(request.approvalDescriptor).toMatchObject({ title: expect.stringContaining("Serper"), estimated_credits: 1 });
    expect(first.chunks.find((c) => c.type === "tool-input-available")).toMatchObject({ toolName: "serper_search" });
    expect(h.serperCalls).toHaveLength(0);

    const s1 = await stored(h.base, "chat-b");
    const pending = toolPart(s1.messages.at(-1)!, "serper_search");
    expect(pending.state).toBe("approval-requested");
    expect(pending.approval.descriptor.title).toContain("Serper");

    const approvedMessages = respondToApprovals(s1.messages, true);
    const second = await chat(h.base, { id: "chat-b", messages: approvedMessages, trigger: "submit-message", messageId: approvedMessages.at(-1)!.id });
    expect(second.status).toBe(200);
    expect(second.chunks[0]).toMatchObject({ type: "start", messageId: s1.messages.at(-1)!.id }); // continues the same message
    const output = second.chunks.find((c) => c.type === "tool-output-available")!;
    expect(output.toolCallId).toBe("call-1");
    expect(output.output).toMatchObject({ type: "search", credits: 1, results: { organic: [{ title: "Padaria Real" }] } });
    expect(second.chunks.find((c) => c.type === "data-credits")!.data).toEqual({ credits_thread: 1, credits_run: 1 });
    expect(h.serperCalls).toHaveLength(1);

    const s2 = await stored(h.base, "chat-b");
    expect(s2.messages).toHaveLength(2);
    expect(toolPart(s2.messages[1]!, "serper_search").state).toBe("output-available");
    expect(s2.credits_used).toBe(1);

    // Replaying the same approval (double click, retry, forged) never re-executes.
    const replay = await chat(h.base, { id: "chat-b", messages: approvedMessages, trigger: "submit-message" });
    expect(replay.status).toBe(400);
    expect(replay.json.error).toContain("já respondida");
    expect(h.serperCalls).toHaveLength(1);
  });

  test("denial does not execute; part ends output-denied; the model is told", async () => {
    const h = await setup([toolStep("call-1", "serper_search", { type: "search", q: "x" }), textStep("Tudo bem, não vou pesquisar.")]);
    await chat(h.base, { id: "chat-c", messages: [userMsg("u1", "Pesquise x")] });
    const s1 = await stored(h.base, "chat-c");
    const res = await chat(h.base, { id: "chat-c", messages: respondToApprovals(s1.messages, false, "caro demais") });
    expect(res.status).toBe(200);
    expect(h.serperCalls).toHaveLength(0);
    const s2 = await stored(h.base, "chat-c");
    const part = toolPart(s2.messages[1]!, "serper_search");
    expect(part.state).toBe("output-denied");
    expect(part.approval).toMatchObject({ approved: false, reason: "caro demais" });
    expect(JSON.stringify(h.script.prompts[1])).toContain("execution-denied");
  });

  test("a new user message auto-denies pending approvals (never executed later)", async () => {
    const h = await setup([toolStep("call-1", "serper_search", { type: "search", q: "x" }), textStep("Ok.")]);
    await chat(h.base, { id: "chat-d", messages: [userMsg("u1", "Pesquise x")] });
    const s1 = await stored(h.base, "chat-d");
    await chat(h.base, { id: "chat-d", message: userMsg("u2", "Deixa pra lá") });
    const s2 = await stored(h.base, "chat-d");
    expect(toolPart(s2.messages[1]!, "serper_search").state).toBe("output-denied");
    const late = await chat(h.base, { id: "chat-d", messages: respondToApprovals(s1.messages, true) });
    expect(late.status).toBe(400);
    expect(h.serperCalls).toHaveLength(0);
  });

  test("draft card send: action → send_whatsapp_message approval (no LLM), approve → sent once", async () => {
    const h = await setup([textStep("Enviado!")]);
    const leadId = seedLead(h.db, { is_whatsapp: 1, whatsapp_jid: "5581999990000@s.whatsapp.net" });
    const res = await chat(h.base, { id: "chat-e", messages: [], trigger: "submit-message", action: { type: "send_draft", lead_id: leadId, text: "Olá, Padaria!" } });
    expect(res.status).toBe(200);
    expect(h.script.calls()).toBe(0);
    expect(res.chunks.find((c) => c.type === "tool-input-available")).toMatchObject({
      toolName: "send_whatsapp_message",
      input: { lead_id: leadId, text: "Olá, Padaria!" },
    });
    expect(res.chunks.find((c) => c.type === "tool-approval-request")!.approvalDescriptor.title).toBe("Enviar mensagem pelo WhatsApp");
    const s1 = await stored(h.base, "chat-e");
    await chat(h.base, { id: "chat-e", messages: respondToApprovals(s1.messages, true) });
    expect(h.waSends).toEqual([{ leadId, text: "Olá, Padaria!" }]);
    const s2 = await stored(h.base, "chat-e");
    expect(toolPart(s2.messages.at(-1)!, "send_whatsapp_message")).toMatchObject({ state: "output-available", output: { sent: true, lead_id: leadId } });

    const bad = await chat(h.base, { id: "chat-e", action: { type: "send_draft", lead_id: 999, text: "x" } });
    expect(bad.status).toBe(400);
  });

  test("structured outputs: query_leads → {leads}, present_message_draft → {can_send_whatsapp, reason}", async () => {
    const h = await setup([
      toolStep("q1", "query_leads", { limit: 5 }),
      toolStep("d1", "present_message_draft", { lead_id: 1, text: "Olá!" }),
      textStep("Pronto."),
    ]);
    seedLead(h.db);
    const res = await chat(h.base, { id: "chat-f", messages: [userMsg("u1", "Liste e redija")] });
    const outputs = res.chunks.filter((c) => c.type === "tool-output-available");
    expect(outputs[0]!.output).toMatchObject({ total: 1, leads: [{ id: 1, name: "Padaria Pão Bom" }] });
    expect(outputs[1]!.output).toMatchObject({ lead_id: 1, text: "Olá!", can_send_whatsapp: false, reason: expect.any(String) });
  });

  test("LLM errors → data-error {code, message} then error chunk (PT-BR); regenerate retries", async () => {
    const authError = new APICallError({
      message: "Incorrect API key sk-test-key-9999",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 401,
      responseBody: "{}",
      isRetryable: false,
    });
    const h = await setup([authError, textStep("Agora foi.")]);
    const res = await chat(h.base, { id: "chat-g", messages: [userMsg("u1", "Oi")] });
    expect(res.status).toBe(200);
    const types = res.chunks.map((c) => c.type);
    const dataError = res.chunks.find((c) => c.type === "data-error")!;
    expect(dataError).toMatchObject({ transient: true, data: { code: "llm_auth" } });
    const error = res.chunks.find((c) => c.type === "error")!;
    expect(error.errorText).toContain("recusou a chave");
    expect(error.errorText).not.toContain("sk-test-key-9999");
    expect(types.indexOf("data-error")).toBeLessThan(types.indexOf("error"));

    // useChat regenerate(): answers the last user message again.
    const retry = await chat(h.base, { id: "chat-g", messages: [userMsg("u1", "Oi")], trigger: "regenerate-message" });
    expect(retry.chunks.find((c) => c.type === "text-delta")!.delta).toBe("Agora foi.");
    const s = await stored(h.base, "chat-g");
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("one run per chat: concurrent request → 409; DELETE removes the chat", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowModel = new MockLanguageModelV4({
      doStream: async () => {
        await gate;
        return { stream: new ReadableStream({ start(c) { for (const chunk of textStep("ok")) c.enqueue(chunk); c.close(); } }) };
      },
    } as never);
    const h = await setup([], slowModel);
    const first = chat(h.base, { id: "chat-h", messages: [userMsg("u1", "Oi")] });
    await Bun.sleep(30);
    const second = await chat(h.base, { id: "chat-h", messages: [userMsg("u2", "Oi de novo")] });
    expect(second.status).toBe(409);
    expect((await call(h.base, "DELETE", "/api/chat/chat-h")).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect((await call(h.base, "DELETE", "/api/chat/chat-h")).json).toEqual({ ok: true });
    expect((await call(h.base, "GET", "/api/chat/chat-h/messages")).status).toBe(404);
    expect((await call(h.base, "DELETE", "/api/chat/chat-h")).status).toBe(404);
  });
});

describe("agent tools over /api/chat", () => {
  test("serper_search param validation fails before approval and spends nothing", async () => {
    const h = await setup([toolStep("c1", "serper_search", { type: "reviews", sortBy: "newest" }), textStep("Preciso do cid.")]);
    const res = await chat(h.base, { id: "chat-v", messages: [userMsg("u1", "avaliações")] });
    expect(res.chunks.find((c) => c.type === "tool-approval-request")).toBeUndefined();
    expect(JSON.stringify(res.chunks)).toContain("exige cid, fid ou placeId");
    expect(h.serperCalls).toHaveLength(0);
  });

  test("save_lead_enrichment writes the lead + an ai_enriched event only after approval", async () => {
    const enrichment = {
      summary: "Padaria artesanal no centro.",
      decision_makers: [{ name: "Maria Silva", role: "Sócia", source_url: "https://paobom.example/sobre" }],
      socials: { instagram: "https://instagram.com/paobom" },
      sources: ["https://paobom.example/sobre"],
    };
    const h = await setup([
      toolStep("c1", "save_lead_enrichment", { lead_id: 1, enrichment, email: "contato@paobom.example" }),
      textStep("Enriquecimento salvo."),
    ]);
    seedLead(h.db);
    const first = await chat(h.base, { id: "chat-en", messages: [userMsg("u1", "Salve o enriquecimento")] });
    const request = first.chunks.find((c) => c.type === "tool-approval-request")!;
    expect(request.approvalDescriptor.title).toBe("Salvar enriquecimento no lead");
    expect(JSON.stringify(request.approvalDescriptor)).toContain("Maria Silva (Sócia)");
    expect((h.db.query("SELECT ai_enrichment_json FROM leads WHERE id = 1").get() as any).ai_enrichment_json).toBeNull();

    const s1 = await stored(h.base, "chat-en");
    await chat(h.base, { id: "chat-en", messages: respondToApprovals(s1.messages, true) });
    const lead = h.db.query("SELECT email, ai_enrichment_json, ai_enriched_at FROM leads WHERE id = 1").get() as any;
    expect(lead.email).toBe("contato@paobom.example");
    expect(JSON.parse(lead.ai_enrichment_json)).toEqual(enrichment);
    expect(lead.ai_enriched_at).toBeTruthy();
    const event = h.db.query("SELECT payload_json FROM lead_events WHERE lead_id = 1 AND event = 'ai_enriched'").get() as any;
    expect(JSON.parse(event.payload_json)).toMatchObject({ source: "ai:openai", email: "contato@paobom.example" });
  });

  test("start_prospect_search reuses the prospect pipeline after approval", async () => {
    const fetcher: PlacesFetcher = async (_q, page, num) =>
      page > 1 ? [] : Array.from({ length: num }, (_, i) => ({ title: `Lugar ${i}`, placeId: `pl-${i}`, cid: `c-${i}` }));
    const h = await setup(
      [toolStep("c1", "start_prospect_search", { niche: "padarias", city: "Recife", count: 5 }), textStep("Coleta iniciada.")],
      undefined,
      fetcher,
    );
    const first = await chat(h.base, { id: "chat-p", messages: [userMsg("u1", "Busque 5 padarias em Recife")] });
    expect(first.chunks.find((c) => c.type === "tool-approval-request")!.approvalDescriptor).toMatchObject({ estimated_credits: 1 });
    const s1 = await stored(h.base, "chat-p");
    const second = await chat(h.base, { id: "chat-p", messages: respondToApprovals(s1.messages, true) });
    const output = second.chunks.find((c) => c.type === "tool-output-available")!.output as {
      job_id: string;
      collected_new: number;
      credits_used: number;
      exhausted: boolean;
    };
    expect(typeof output.job_id).toBe("string");
    // The tool waits for the collection phase and reports the real outcome.
    expect(output).toMatchObject({ collected_new: 10, credits_used: 1, exhausted: false });
    for (let i = 0; i < 50; i++) {
      const progress = await call(h.base, "GET", `/api/progress/${output.job_id}`);
      if (progress.json.job.status !== "running") break;
      await Bun.sleep(10);
    }
    // Every fetched page is persisted (credit already spent): one page of 10.
    expect((h.db.query("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n).toBe(10);
  });

  test("start_prospect_search reports an exhausted source and skips re-running it without credits", async () => {
    let fetches = 0;
    const fetcher: PlacesFetcher = async (_q, page) => {
      fetches++;
      return page > 1 ? [] : Array.from({ length: 3 }, (_, i) => ({ title: `Estúdio ${i}`, placeId: `st-${i}`, cid: `s-${i}` }));
    };
    const h = await setup(
      [
        toolStep("c1", "start_prospect_search", { niche: "estúdios de pilates", city: "Toledo-PR", count: 50 }),
        textStep("Só havia 3."),
        toolStep("c2", "start_prospect_search", { niche: "estúdios de pilates", city: "Toledo-PR", count: 50 }),
        textStep("Já esgotado."),
      ],
      undefined,
      fetcher,
    );
    await chat(h.base, { id: "chat-x", messages: [userMsg("u1", "Busque 50 estúdios de pilates em Toledo-PR")] });
    const run1 = await chat(h.base, { id: "chat-x", messages: respondToApprovals((await stored(h.base, "chat-x")).messages, true) });
    const out1 = run1.chunks.find((c) => c.type === "tool-output-available")!.output as Record<string, unknown>;
    expect(out1).toMatchObject({ collected_new: 3, credits_used: 1, exhausted: true });
    expect(run1.chunks.find((c) => c.type === "data-credits")).toMatchObject({ data: { credits_run: 1 } });
    const fetchesAfterFirst = fetches;

    await chat(h.base, { id: "chat-x", messages: [...(await stored(h.base, "chat-x")).messages, userMsg("u2", "Tente de novo")] });
    const run2 = await chat(h.base, { id: "chat-x", messages: respondToApprovals((await stored(h.base, "chat-x")).messages, true) });
    const out2 = run2.chunks.find((c) => c.type === "tool-output-available")!.output as Record<string, unknown>;
    expect(out2).toMatchObject({ collected_new: 0, credits_used: 0, exhausted: true });
    expect(fetches).toBe(fetchesAfterFirst);
  });

  test("an approved action is never re-executed after a later LLM failure", async () => {
    const h = await setup([
      toolStep("c1", "send_whatsapp_message", { lead_id: 1, text: "Olá!" }),
      new APICallError({ message: "overloaded", url: "u", requestBodyValues: {}, statusCode: 503, isRetryable: false }),
      textStep("Mensagem enviada."),
    ]);
    seedLead(h.db, { is_whatsapp: 1, whatsapp_jid: "5581999990000@s.whatsapp.net" });
    await chat(h.base, { id: "chat-r", messages: [userMsg("u1", "Envie")] });
    const s1 = await stored(h.base, "chat-r");
    const second = await chat(h.base, { id: "chat-r", messages: respondToApprovals(s1.messages, true) });
    expect(second.chunks.find((c) => c.type === "data-error")).toMatchObject({ data: { code: "llm_unavailable" } });
    expect(h.waSends).toHaveLength(1);

    await chat(h.base, { id: "chat-r", messages: (await stored(h.base, "chat-r")).messages, trigger: "regenerate-message" });
    expect(h.waSends).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Contract check with the SDK's own client (what useChat wraps): AbstractChat +
// DefaultChatTransport, addToolApprovalResponse, sendAutomaticallyWhen.
// ---------------------------------------------------------------------------

class MemoryState implements ChatState<UIMessage> {
  status: ChatStatus = "ready";
  error: Error | undefined = undefined;
  messages: UIMessage[] = [];
  pushMessage = (m: UIMessage) => void this.messages.push(m);
  popMessage = () => void this.messages.pop();
  replaceMessage = (i: number, m: UIMessage) => void (this.messages[i] = m);
  snapshot = <T>(thing: T): T => structuredClone(thing);
}

class TestChat extends AbstractChat<UIMessage> {
  constructor(base: string, id: string, onData: (part: unknown) => void) {
    super({
      id,
      state: new MemoryState(),
      transport: new DefaultChatTransport({ api: `${base}/api/chat` }),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onData,
    });
  }
}

async function settle(chat: TestChat): Promise<void> {
  for (let i = 0; i < 200 && (chat.status === "submitted" || chat.status === "streaming"); i++) await Bun.sleep(10);
  await Bun.sleep(30);
}

describe("useChat contract (AbstractChat + DefaultChatTransport)", () => {
  test("sendMessage → approval card → addToolApprovalResponse auto-resubmits → executed once", async () => {
    const h = await setup([toolStep("call-1", "serper_search", { type: "search", q: "Padaria" }), textStep("Achei.")]);
    const data: any[] = [];
    const client = new TestChat(h.base, "chat-client", (p) => data.push(p));
    await client.sendMessage({ text: "Pesquise a Padaria" });
    await settle(client);
    const card = toolPart(client.messages.at(-1)!, "serper_search");
    expect(card.state).toBe("approval-requested");
    expect(card.approval.descriptor.estimated_credits).toBe(1);

    await client.addToolApprovalResponse({ id: card.approval.id, approved: true });
    await settle(client);
    expect(h.serperCalls).toHaveLength(1);
    expect(client.messages).toHaveLength(2); // same assistant message continued
    const done = toolPart(client.messages[1]!, "serper_search");
    expect(done.state).toBe("output-available");
    expect((client.messages[1]!.parts as any[]).some((p) => p.type === "text" && p.text === "Achei.")).toBe(true);
    expect(data.filter((d) => d.type === "data-credits").at(-1).data).toEqual({ credits_thread: 1, credits_run: 1 });

    // The server copy matches what the client shows.
    const s = await stored(h.base, "chat-client");
    expect(toolPart(s.messages[1]!, "serper_search").state).toBe("output-available");
  });

  test("draft send through sendMessage(undefined, {body: {action}})", async () => {
    const h = await setup([textStep("Rascunho pronto."), textStep("Mensagem enviada.")]);
    const leadId = seedLead(h.db, { is_whatsapp: 1, whatsapp_jid: "5581999990000@s.whatsapp.net" });
    const client = new TestChat(h.base, "chat-draft", () => {});
    await client.sendMessage({ text: "Redija" });
    await settle(client);
    await client.sendMessage(undefined, { body: { action: { type: "send_draft", lead_id: leadId, text: "Olá!" } } });
    await settle(client);
    const card = toolPart(client.messages.at(-1)!, "send_whatsapp_message");
    expect(card.state).toBe("approval-requested");
    expect(client.messages).toHaveLength(2);
    await client.addToolApprovalResponse({ id: card.approval.id, approved: true });
    await settle(client);
    expect(h.waSends).toEqual([{ leadId, text: "Olá!" }]);
    expect(toolPart(client.messages.at(-1)!, "send_whatsapp_message").state).toBe("output-available");
  });
});
