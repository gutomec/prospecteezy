// Fake POST /api/chat for the UI preview (PREVIEW_MOCK=1): speaks the real AI
// SDK v7 UI message stream protocol (createUIMessageStream from `ai`), with
// scripted answers instead of an LLM. Mirrors src/ai/chat.ts closely enough to
// exercise every client flow: streaming text + reasoning, tools, approvals
// (approve / deny / stale / replay → 400), send_draft, data-credits,
// data-error + error (retry with regenerate), history, delete (409 running).
// Never imported by the app bundle; never calls an LLM or Serper.
//
// Scripts (by the user's words): "busc… N … em Cidade" → start_prospect_search;
// "whatsapp" + "e-mail" / "quais leads" → query_leads; "redij…/mensagem" →
// present_message_draft; "pesquis…" → serper_search → save_lead_enrichment;
// "estatística/resumo/quantos" → lead_stats; "erro" (llm_quota) / "erro chave"
// (llm_auth) fail once, then regenerate works; anything else → markdown text.
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage, type UIMessageChunk } from "ai";
import type { Lead } from "../lib/api/types";

type Part = UIMessage["parts"][number] & Record<string, any>;
type Write = (chunk: UIMessageChunk) => void;

interface MockChat {
  id: string;
  title: string | null;
  credits_used: number;
  created_at: string;
  updated_at: string;
  messages: UIMessage[];
  running: boolean;
  failures: number;
}

interface Deps {
  getLeads: () => Lead[];
  aiEnabled: () => boolean;
  /** Starts a fake prospect job through the mock's own POST /api/prospect. */
  startProspect: (text: string) => Promise<{ job_id: string; search_id: number; already_running: boolean }>;
}

const AUTO_DENY_REASON = "O usuário seguiu a conversa sem decidir.";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const now = () => new Date().toISOString();
const sleep = (ms: number) => Bun.sleep(ms);
const norm = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

async function streamText(write: Write, text: string, delay = 35) {
  const id = `t-${crypto.randomUUID().slice(0, 8)}`;
  write({ type: "text-start", id });
  const words = text.split(/(\s+)/);
  for (let i = 0; i < words.length; i += 4) {
    write({ type: "text-delta", id, delta: words.slice(i, i + 4).join("") });
    await sleep(delay);
  }
  write({ type: "text-end", id });
}

async function streamReasoning(write: Write, text: string) {
  const id = `r-${crypto.randomUUID().slice(0, 8)}`;
  write({ type: "reasoning-start", id });
  for (const piece of text.match(/.{1,24}(\s|$)/g) ?? [text]) {
    write({ type: "reasoning-delta", id, delta: piece });
    await sleep(45);
  }
  write({ type: "reasoning-end", id });
}

function describe(tool: string, input: Record<string, any>, leads: Lead[]) {
  const lead = typeof input.lead_id === "number" ? leads.find((l) => l.id === input.lead_id) : undefined;
  const label = lead ? `${lead.name} (lead #${lead.id})` : `lead #${input.lead_id}`;
  switch (tool) {
    case "start_prospect_search":
      return {
        title: "Iniciar prospecção no Google Maps",
        description: `Buscar ${input.count} leads novos de "${input.niche}" em ${input.city} (Serper Places), salvar na base sem duplicar e procurar e-mails nos sites. Pode gastar mais créditos se houver muitos duplicados.`,
        params: [
          { label: "Nicho", value: String(input.niche) },
          { label: "Cidade", value: String(input.city) },
          { label: "Quantidade", value: String(input.count) },
        ],
        estimated_credits: Math.ceil(Number(input.count) / 10),
      };
    case "serper_search":
      return {
        title: "Consultar o Google via Serper: Busca",
        description: `Fazer uma consulta "search" no Serper (resultados orgânicos do Google).`,
        params: [
          { label: "q", value: String(input.q) },
          { label: "gl", value: "br" },
          { label: "hl", value: "pt-br" },
        ],
        estimated_credits: 1,
      };
    case "save_lead_enrichment":
      return {
        title: "Salvar enriquecimento no lead",
        description: `Gravar os dados abaixo em ${label}.`,
        params: [
          { label: "Resumo", value: String(input.enrichment?.summary ?? "") },
          { label: "Segmento", value: String(input.enrichment?.segment ?? "") },
          { label: "Fontes", value: (input.enrichment?.sources ?? []).join(", ") },
        ],
        estimated_credits: 0,
      };
    case "send_whatsapp_message":
      return {
        title: "Enviar mensagem pelo WhatsApp",
        description: `Enviar a mensagem abaixo para ${label}${lead?.phone ? ` (${lead.phone})` : ""} pela instância ativa. Sujeito ao limite anti-banimento e ao horário silencioso.`,
        params: [{ label: "Mensagem", value: String(input.text ?? "") }],
        estimated_credits: 0,
      };
    default:
      return { title: `Executar ${tool}`, description: "Ação que requer aprovação.", params: [], estimated_credits: 0 };
  }
}

export function createMockAiChat(deps: Deps) {
  const chats = new Map<string, MockChat>();

  const leadRow = (l: Lead) => ({
    id: l.id,
    search_id: l.search_id,
    name: l.name,
    category: l.category,
    address: l.address,
    phone: l.phone,
    email: l.email,
    website: l.website,
    rating: l.rating,
    is_whatsapp: l.is_whatsapp,
    has_ai_enrichment: Boolean(l.ai_enrichment_json),
  });

  function draftFor(lead: Lead) {
    const canSend = lead.is_whatsapp === 1 && Boolean(lead.whatsapp_jid);
    return {
      lead_id: lead.id,
      lead_name: lead.name,
      text: `Olá, equipe ${lead.name}! Aqui é a Norte Digital: criamos sites e campanhas de tráfego pago para ${lead.category?.toLowerCase() ?? "empresas"} da região. Posso mostrar em 15 minutos como trazer mais clientes pelo Google este mês?`,
      can_send_whatsapp: canSend,
      shown_to_user: true,
      ...(canSend ? {} : { reason: "Lead sem WhatsApp validado: o envio pelo WhatsApp fica indisponível." }),
    };
  }

  /** Runs an approved tool (the "execute" of src/ai/tools.ts). */
  async function execute(tool: string, input: Record<string, any>, chat: MockChat): Promise<unknown> {
    const leads = deps.getLeads();
    const lead = leads.find((l) => l.id === input.lead_id);
    switch (tool) {
      case "start_prospect_search": {
        const started = await deps.startProspect(`Busque os ${input.count} ${input.niche} de ${input.city}`);
        return { ...started, note: "A coleta roda em segundo plano; o progresso aparece na conversa." };
      }
      case "serper_search":
        await sleep(700);
        chat.credits_used += 1;
        return {
          type: "search",
          credits: 1,
          results: {
            organic: [
              { title: `${input.q} | Site oficial`, link: "https://www.exemplo.com.br/sobre", snippet: "Escritório com 15 anos de atuação em direito empresarial." },
              { title: `${input.q} no LinkedIn`, link: "https://www.linkedin.com/company/exemplo", snippet: "Sócios: Marina Souza (fundadora)." },
              { title: "Link malicioso (deve sumir)", link: "javascript:alert(1)", snippet: "Teste de segurança." },
              { title: "Avaliações no Google", link: "https://maps.google.com/?cid=123", snippet: "4,8 estrelas (120 avaliações)." },
            ],
          },
        };
      case "save_lead_enrichment":
        if (!lead) throw new Error(`Lead #${input.lead_id} não encontrado.`);
        lead.ai_enrichment_json = JSON.stringify(input.enrichment);
        lead.ai_enriched_at = now();
        return { saved: true, lead_id: lead.id, email_saved: false };
      case "send_whatsapp_message":
        await sleep(500);
        if (!lead || lead.is_whatsapp !== 1) {
          return { sent: false, lead_id: input.lead_id, code: "not_whatsapp", reason: "Lead sem WhatsApp validado." };
        }
        if (/silencio|silêncio/i.test(String(input.text))) {
          return { sent: false, lead_id: lead.id, code: "blocked", reason: "Horário silencioso: o envio fica para depois das 8h." };
        }
        return { sent: true, lead_id: lead.id };
      default:
        throw new Error(`Ferramenta ${tool} indisponível no mock.`);
    }
  }

  async function toolNow(write: Write, tool: string, input: unknown, output: unknown) {
    const toolCallId = `call-${crypto.randomUUID().slice(0, 8)}`;
    write({ type: "start-step" });
    write({ type: "tool-input-start", toolCallId, toolName: tool });
    await sleep(250);
    write({ type: "tool-input-available", toolCallId, toolName: tool, input });
    await sleep(500);
    write({ type: "tool-output-available", toolCallId, output });
    write({ type: "finish-step" });
  }

  function requestApproval(write: Write, tool: string, input: Record<string, any>) {
    const toolCallId = `call-${crypto.randomUUID().slice(0, 8)}`;
    write({ type: "start-step" });
    write({ type: "tool-input-available", toolCallId, toolName: tool, input });
    write({
      type: "tool-approval-request",
      approvalId: `approval-${crypto.randomUUID()}`,
      toolCallId,
      approvalDescriptor: describe(tool, input, deps.getLeads()),
    } as UIMessageChunk);
    write({ type: "finish-step" });
  }

  /** A new user message: scripted answer by keywords. */
  async function answer(write: Write, text: string, chat: MockChat) {
    const t = norm(text);
    const leads = deps.getLeads();

    if (t.includes("erro")) {
      chat.failures += 1;
      if (chat.failures % 2 === 1) {
        await sleep(400);
        const info = t.includes("chave")
          ? { code: "llm_auth", message: "O provedor de IA recusou a chave. Confira a chave em Configurações → Provedores de IA." }
          : { code: "llm_quota", message: "O provedor de IA recusou por limite de uso ou saldo esgotado. Tente mais tarde ou troque de provedor." };
        write({ type: "data-error", data: info, transient: true } as UIMessageChunk);
        write({ type: "data-credits", id: "credits", data: { credits_thread: chat.credits_used, credits_run: 0 } } as UIMessageChunk);
        write({ type: "error", errorText: info.message });
        return "error";
      }
      write({ type: "start-step" });
      await streamText(write, "Agora deu certo! Desculpe pela falha anterior do provedor. Em que posso ajudar?");
      write({ type: "finish-step" });
      return "stop";
    }

    const search = /(busc|prospect|encontr)\D*(\d{1,3})\s+(.+?)\s+em\s+(.+)$/i.exec(text.trim());
    if (search) {
      write({ type: "start-step" });
      await streamText(write, `Vou buscar ${search[2]} ${search[3]} em ${search[4]}. Isso gasta créditos do Serper, então preciso da sua aprovação:`);
      write({ type: "finish-step" });
      requestApproval(write, "start_prospect_search", { niche: search[3], city: search[4]!.replace(/[.!?]$/, ""), count: Number(search[2]) });
      return "tool-calls";
    }

    if ((t.includes("whatsapp") && (t.includes("e-mail") || t.includes("email"))) || t.includes("quais leads") || t.includes("liste")) {
      const both = leads.filter((l) => l.is_whatsapp === 1 && l.email);
      await toolNow(write, "query_leads", { is_whatsapp: "yes", has_email: true, limit: 20 }, { total: both.length, leads: both.slice(0, 20).map(leadRow) });
      write({ type: "start-step" });
      await streamText(
        write,
        `Encontrei **${both.length} leads** com WhatsApp validado **e** e-mail. Os mais recentes estão acima; clique em **Abrir** para ver a ficha completa.\n\nQuer que eu redija uma mensagem para algum deles?`,
      );
      write({ type: "finish-step" });
      return "stop";
    }

    if (t.includes("redij") || t.includes("redigir") || t.includes("mensagem")) {
      const id = Number(/#\s*(\d+)/.exec(text)?.[1]);
      const lead = leads.find((l) => l.id === id) ?? leads.find((l) => l.is_whatsapp === 1 && l.whatsapp_jid);
      if (!lead) {
        write({ type: "start-step" });
        await streamText(write, `Não encontrei o lead #${id}. Confira o número na tabela.`);
        write({ type: "finish-step" });
        return "stop";
      }
      await toolNow(write, "get_company_profile", {}, { profile: { name: "Norte Digital", offering: "Sites e tráfego pago para escritórios", tone: "próximo e direto" } });
      await toolNow(write, "present_message_draft", { lead_id: lead.id, text: draftFor(lead).text }, draftFor(lead));
      write({ type: "start-step" });
      await streamText(write, "Pronto: o rascunho acima é editável. Ajuste o que quiser e envie quando estiver bom.");
      write({ type: "finish-step" });
      return "stop";
    }

    if (t.includes("pesquis")) {
      const id = Number(/#\s*(\d+)/.exec(text)?.[1]);
      const lead = leads.find((l) => l.id === id) ?? leads[1]!;
      write({ type: "start-step" });
      await streamReasoning(write, `O usuário quer enriquecer o lead #${lead.id}. A busca orgânica do Google é o tipo mais barato (1 crédito) para achar site, sócios e redes.`);
      await streamText(write, `Vou pesquisar **${lead.name}** no Google para encontrar site, decisores e redes sociais.`);
      write({ type: "finish-step" });
      requestApproval(write, "serper_search", { type: "search", q: lead.name, gl: "br", hl: "pt-br", lead_id: lead.id });
      return "tool-calls";
    }

    if (t.includes("estatist") || t.includes("resumo") || t.includes("quantos")) {
      const n = (f: (l: Lead) => boolean) => leads.filter(f).length;
      await toolNow(write, "lead_stats", {}, {
        total: leads.length,
        with_email: n((l) => Boolean(l.email)),
        with_website: n((l) => Boolean(l.website)),
        whatsapp: { yes: n((l) => l.is_whatsapp === 1), no: n((l) => l.is_whatsapp === 0), unknown: n((l) => l.is_whatsapp === null) },
        with_ai_enrichment: n((l) => Boolean(l.ai_enrichment_json)),
        per_search: [],
      });
      write({ type: "start-step" });
      await streamText(write, "Esses são os totais da sua base agora.");
      write({ type: "finish-step" });
      return "stop";
    }

    write({ type: "start-step" });
    await streamReasoning(write, "Pedido genérico: explicar o que consigo fazer, com exemplos práticos.");
    await streamText(
      write,
      [
        "Posso ajudar de várias formas:",
        "",
        "1. **Buscar leads novos**: “Buscar 30 dentistas em Curitiba-PR” (pede aprovação, gasta créditos Serper).",
        "2. **Consultar sua base**: “Quais leads têm WhatsApp e e-mail?”",
        "3. **Pesquisar um lead**: “Pesquise o lead #2” e eu proponho um enriquecimento.",
        "4. **Redigir mensagens**: “Redija uma mensagem para o lead #4”.",
        "",
        "Saiba mais sobre o Serper em [serper.dev](https://serper.dev). Links inseguros como [este](javascript:alert(1)) são bloqueados.",
      ].join("\n"),
      25,
    );
    write({ type: "finish-step" });
    return "stop";
  }

  /** Continuation after approval decisions (parts already approval-responded). */
  async function continueAfter(write: Write, decided: Part[], chat: MockChat) {
    let lastApproved: { tool: string; input: Record<string, any> } | null = null;
    let anyDenied = false;
    for (const part of decided) {
      const tool = String(part.type).slice("tool-".length);
      if (!part.approval.approved) {
        write({ type: "tool-output-denied", toolCallId: part.toolCallId });
        anyDenied = true;
        continue;
      }
      try {
        const output = await execute(tool, part.input ?? {}, chat);
        write({ type: "tool-output-available", toolCallId: part.toolCallId, output });
        lastApproved = { tool, input: part.input ?? {} };
      } catch (error) {
        write({ type: "tool-output-error", toolCallId: part.toolCallId, errorText: (error as Error).message });
      }
    }
    write({ type: "start-step" });
    if (!lastApproved) {
      await streamText(write, anyDenied ? "Tudo bem, não vou executar essa ação. Quer tentar de outro jeito?" : "Não consegui concluir a ação.");
      write({ type: "finish-step" });
      return;
    }
    const leadId = Number(lastApproved.input.lead_id);
    switch (lastApproved.tool) {
      case "start_prospect_search":
        await streamText(write, "Busca iniciada! Acompanhe o progresso acima; a tabela de leads atualiza sozinha.");
        write({ type: "finish-step" });
        return;
      case "serper_search": {
        await streamText(write, "Achei o site oficial e a página no LinkedIn. Proponho salvar este enriquecimento:");
        write({ type: "finish-step" });
        requestApproval(write, "save_lead_enrichment", {
          lead_id: leadId,
          enrichment: {
            summary: "Escritório com 15 anos de atuação em direito empresarial para PMEs.",
            segment: "Direito empresarial",
            decision_makers: [{ name: "Marina Souza", role: "Sócia-fundadora" }],
            sources: ["https://www.exemplo.com.br/sobre", "https://www.linkedin.com/company/exemplo"],
          },
        });
        return;
      }
      case "save_lead_enrichment":
        await streamText(write, `Enriquecimento salvo no lead #${leadId}. Ele já aparece na ficha do lead.`);
        break;
      case "send_whatsapp_message":
        await streamText(write, "Pronto, processei o envio. Veja o resultado acima.");
        break;
      default:
        await streamText(write, "Feito.");
    }
    write({ type: "finish-step" });
  }

  function settlePending(messages: UIMessage[]): string[] {
    const denied: string[] = [];
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts as Part[]) {
        if (p.state === "approval-requested" && p.approval) {
          Object.assign(p, { state: "output-denied", approval: { ...p.approval, approved: false, reason: AUTO_DENY_REASON } });
          denied.push(p.toolCallId);
        }
      }
    }
    return denied;
  }

  function respond(chat: MockChat, run: (write: Write) => Promise<string | void>, continueId?: string): Response {
    chat.running = true;
    const stream = createUIMessageStream({
      originalMessages: chat.messages,
      generateId: () => `msg-${crypto.randomUUID()}`,
      execute: async ({ writer }) => {
        const write: Write = (chunk) => writer.write(chunk);
        write({ type: "start", ...(continueId ? { messageId: continueId } : {}) });
        await sleep(300);
        const reason = await run(write);
        if (reason === "error") return;
        write({ type: "data-credits", id: "credits", data: { credits_thread: chat.credits_used, credits_run: 0 } } as UIMessageChunk);
        write({ type: "finish", finishReason: reason === "tool-calls" ? "tool-calls" : "stop" });
      },
      onEnd: ({ messages }) => {
        // Drop an empty assistant message (a run that failed up front).
        const last = messages.at(-1);
        if (last?.role === "assistant" && !last.parts.some((p) => p.type !== "step-start" && !p.type.startsWith("data-"))) messages.pop();
        chat.messages = messages;
        chat.updated_at = now();
        chat.running = false;
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  async function post(req: Request): Promise<Response> {
    if (!deps.aiEnabled()) {
      return json({ error: "A inteligência artificial está desativada. Ative um provedor em Configurações → Provedores de IA.", code: "ai_disabled" }, 409);
    }
    let body: Record<string, any>;
    try {
      body = (await req.json()) as Record<string, any>;
    } catch {
      return json({ error: "Corpo inválido: envie o JSON do useChat." }, 400);
    }
    if (typeof body.id !== "string" || !body.id) return json({ error: 'Campo "id" (id da conversa) é obrigatório.' }, 400);
    let chat = chats.get(body.id);
    if (chat?.running) return json({ error: "Já existe uma resposta em andamento nesta conversa. Aguarde terminar." }, 409);
    if (!chat) {
      chat = { id: body.id, title: null, credits_used: 0, created_at: now(), updated_at: now(), messages: [], running: false, failures: 0 };
      chats.set(chat.id, chat);
    }
    const current = chat;
    const lastAssistant = [...current.messages].reverse().find((m) => m.role === "assistant");

    // 1. Draft card "Enviar pelo WhatsApp".
    if (body.action) {
      const leadId = Number(body.action.lead_id);
      const text = String(body.action.text ?? "").trim();
      const lead = deps.getLeads().find((l) => l.id === leadId);
      if (!text || text.length > 4096) return json({ error: "Texto da mensagem vazio ou longo demais." }, 400);
      if (!lead) return json({ error: `Lead #${leadId} não encontrado.` }, 400);
      if (lead.is_whatsapp !== 1) return json({ error: "Lead sem WhatsApp validado." }, 400);
      const denied = settlePending(current.messages);
      const last = current.messages.at(-1);
      return respond(
        current,
        async (write) => {
          for (const id of denied) write({ type: "tool-output-denied", toolCallId: id });
          requestApproval(write, "send_whatsapp_message", { lead_id: leadId, text });
          return "tool-calls";
        },
        last?.role === "assistant" ? last.id : undefined,
      );
    }

    // 2. Regenerate.
    if (body.trigger === "regenerate-message") {
      settlePending(current.messages);
      while (current.messages.at(-1)?.role === "assistant") current.messages.pop();
      const user = current.messages.at(-1);
      if (user?.role !== "user") return json({ error: "Não há mensagem para responder de novo." }, 400);
      const text = (user.parts as Part[]).filter((p) => p.type === "text").map((p) => p.text).join("\n");
      return respond(current, (write) => answer(write, text, current));
    }

    const incoming = (body.message ?? (Array.isArray(body.messages) ? body.messages.at(-1) : undefined)) as UIMessage | undefined;
    if (!incoming || !Array.isArray(incoming.parts)) return json({ error: "Nenhuma mensagem para processar." }, 400);

    // 3. Approval decisions.
    if (incoming.role === "assistant") {
      const decisions = (incoming.parts as Part[]).filter((p) => p.state === "approval-responded" && p.approval);
      if (!decisions.length) return json({ error: "Nenhuma aprovação respondida na mensagem." }, 400);
      const pending = new Map<string, Part>();
      for (const p of (lastAssistant?.parts ?? []) as Part[]) if (p.state === "approval-requested" && p.approval) pending.set(p.approval.id, p);
      for (const d of decisions) if (!pending.has(d.approval.id)) return json({ error: "Aprovação não encontrada ou já respondida." }, 400);
      if (decisions.length < pending.size) return json({ error: "Responda todas as aprovações pendentes desta mensagem." }, 400);
      const decided: Part[] = [];
      for (const d of decisions) {
        const part = pending.get(d.approval.id)!;
        const reason = typeof d.approval.reason === "string" && d.approval.reason.trim() ? d.approval.reason.trim() : undefined;
        Object.assign(part, { state: "approval-responded", approval: { ...part.approval, approved: d.approval.approved, ...(reason ? { reason } : {}) } });
        decided.push(part);
      }
      return respond(current, (write) => continueAfter(write, decided, current), lastAssistant!.id);
    }

    // 4. New user message.
    const text = (incoming.parts as Part[]).filter((p) => p.type === "text").map((p) => String(p.text)).join("\n").trim();
    if (!text) return json({ error: "A mensagem está vazia." }, 400);
    if (current.messages.some((m) => m.id === incoming.id)) {
      if (current.messages.at(-1)?.id !== incoming.id) return json({ error: "Esta mensagem já foi processada." }, 400);
    } else {
      settlePending(current.messages);
      current.messages.push({ id: incoming.id || `msg-${crypto.randomUUID()}`, role: "user", parts: [{ type: "text", text }] });
    }
    current.title ??= text.slice(0, 80);
    return respond(current, (write) => answer(write, text, current));
  }

  /** Routes under /api/chat; null = not ours. */
  async function handle(req: Request, path: string): Promise<Response | null> {
    const m = req.method;
    if (path === "/api/chat" && m === "POST") return post(req);
    if (path === "/api/chat" && m === "GET") {
      const list = [...chats.values()]
        .filter((c) => c.messages.length > 0)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map(({ id, title, credits_used, created_at, updated_at }) => ({ id, title, credits_used, created_at, updated_at }));
      return json({ chats: list });
    }
    const match = /^\/api\/chat\/([^/]+)(\/messages)?$/.exec(path);
    if (!match) return null;
    const chat = chats.get(decodeURIComponent(match[1]!));
    if (match[2] && m === "GET") {
      if (!chat) return json({ error: "Conversa não encontrada." }, 404);
      return json({ id: chat.id, title: chat.title, credits_used: chat.credits_used, running: chat.running, messages: chat.messages });
    }
    if (!match[2] && m === "DELETE") {
      if (!chat) return json({ error: "Conversa não encontrada." }, 404);
      if (chat.running) return json({ error: "A conversa está respondendo agora. Aguarde terminar." }, 409);
      chats.delete(chat.id);
      return json({ ok: true });
    }
    return null;
  }

  return { handle };
}
