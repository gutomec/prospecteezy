// Rendering of one tool part, by tool name. Approval-gated tools show the
// approval card first and their result below it; unknown tools fall back to
// the generic AI Elements <Tool> (collapsible input/output).
import {
  BarChart3Icon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  GlobeIcon,
  MailIcon,
  MapPinIcon,
  PhoneIcon,
  SparklesIcon,
  UserRoundIcon,
  XCircleIcon,
} from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { useLeadsState } from "@/features/leads/leads-state";
import { WA_TONES } from "@/features/leads/leads-table";
import type { AiLeadRow } from "@/lib/api/types";
import { formatInt, hostnameOf, WHATSAPP_LABELS, whatsappState } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ApprovalCard } from "./approval-card";
import {
  actionSummary,
  approvalView,
  asDraft,
  asJobStart,
  asLeadDetail,
  asLeadStats,
  asQueryLeads,
  extractLinks,
  toolLabel,
  toolNameOf,
  type ApprovalView,
  type ToolPart,
} from "./chat-logic";
import { DraftCard } from "./draft-card";
import { AiJobProgress } from "./job-progress";

const RUNNING_TEXT: Record<string, string> = {
  query_leads: "Consultando leads…",
  get_lead: "Lendo o lead…",
  lead_stats: "Somando a base…",
  get_company_profile: "Lendo o perfil da empresa…",
  list_searches: "Listando pesquisas…",
  present_message_draft: "Preparando o rascunho…",
  start_prospect_search: "Iniciando a prospecção…",
  serper_search: "Consultando o Google…",
  scrape_webpage: "Lendo a página…",
  crawl_lead_website: "Visitando o site…",
  save_lead_enrichment: "Salvando…",
  send_whatsapp_message: "Enviando…",
};

const MAX_LEAD_CARDS = 8;

function WaBadge({ lead }: { lead: Pick<AiLeadRow, "id" | "is_whatsapp"> }) {
  const state = whatsappState(lead);
  return <StatusBadge tone={WA_TONES[state]}>{WHATSAPP_LABELS[state]}</StatusBadge>;
}

function LeadCards({ total, leads }: { total: number; leads: AiLeadRow[] }) {
  const { openLead } = useLeadsState();
  if (leads.length === 0) {
    return <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-sm">Nenhum lead encontrado com esses filtros.</p>;
  }
  const shown = leads.slice(0, MAX_LEAD_CARDS);
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs tabular">
        {total > shown.length ? `Mostrando ${shown.length} de ${formatInt(total)} leads` : `${formatInt(total)} ${total === 1 ? "lead" : "leads"}`}
      </p>
      <ul className="space-y-2" aria-label="Leads encontrados">
        {shown.map((lead) => (
          <li key={lead.id} className="rounded-lg border bg-card p-3 shadow-xs">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={lead.name}>
                  {lead.name} <span className="text-muted-foreground font-normal tabular">#{lead.id}</span>
                </p>
                {lead.category && <p className="text-muted-foreground truncate text-xs">{lead.category}</p>}
              </div>
              <Button type="button" variant="outline" size="xs" onClick={() => openLead(lead.id)} aria-label={`Abrir ${lead.name}`}>
                Abrir
              </Button>
            </div>
            <div className="text-muted-foreground mt-2 space-y-1 text-xs">
              {lead.address && (
                <p className="flex items-start gap-1.5">
                  <MapPinIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  <span className="line-clamp-2">{lead.address}</span>
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {lead.phone && (
                  <span className="inline-flex items-center gap-1 tabular">
                    <PhoneIcon className="size-3" aria-hidden="true" />
                    {lead.phone}
                  </span>
                )}
                {lead.email && (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <MailIcon className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{lead.email}</span>
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                <WaBadge lead={lead} />
                {lead.has_ai_enrichment && (
                  <StatusBadge tone="info" dot={false}>
                    <SparklesIcon className="size-3" aria-hidden="true" /> Enriquecido
                  </StatusBadge>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LeadDetailSummary({ output }: { output: unknown }) {
  const { openLead } = useLeadsState();
  const lead = asLeadDetail(output);
  if (!lead) return null;
  return (
    <div className="rounded-lg border bg-card p-3 text-sm shadow-xs">
      <div className="flex items-start gap-2">
        <UserRoundIcon className="text-muted-foreground mt-0.5 size-4" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {lead.name} <span className="text-muted-foreground font-normal tabular">#{lead.id}</span>
          </p>
          <p className="text-muted-foreground truncate text-xs">{[lead.category, lead.address].filter(Boolean).join(" · ")}</p>
        </div>
        <Button type="button" variant="outline" size="xs" onClick={() => openLead(lead.id)} aria-label={`Abrir ${lead.name}`}>
          Abrir
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <WaBadge lead={lead} />
        <StatusBadge tone={lead.email ? "success" : "neutral"} dot={false}>
          {lead.email ? "Com e-mail" : "Sem e-mail"}
        </StatusBadge>
        <StatusBadge tone={lead.website ? "success" : "neutral"} dot={false}>
          {lead.website ? hostnameOf(lead.website) : "Sem site"}
        </StatusBadge>
      </div>
      {lead.summary && <p className="text-muted-foreground mt-2 line-clamp-3 text-xs">{lead.summary}</p>}
    </div>
  );
}

function StatsSummary({ output }: { output: unknown }) {
  const stats = asLeadStats(output);
  if (!stats) return null;
  const items: Array<[string, number]> = [
    ["Leads", stats.total],
    ["Com e-mail", stats.with_email],
    ["Com site", stats.with_website],
    ["WhatsApp", stats.whatsapp.yes],
    ["Sem WhatsApp", stats.whatsapp.no],
    ["Não validados", stats.whatsapp.unknown],
    ["Enriquecidos por IA", stats.with_ai_enrichment],
  ];
  return (
    <div className="rounded-lg border bg-card p-3 shadow-xs">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium">
        <BarChart3Icon className="size-3.5 text-brand" aria-hidden="true" /> Totais da base
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        {items.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular">{formatInt(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function LinkResults({ toolName, output }: { toolName: string; output: unknown }) {
  const links = extractLinks(toolName, output);
  if (links.length === 0) {
    return <p className="text-muted-foreground text-xs">{toolName === "scrape_webpage" ? "Página lida." : "Nenhum link nos resultados."}</p>;
  }
  return (
    <Sources className="mb-0 rounded-lg border bg-card p-3 text-foreground shadow-xs" defaultOpen={links.length <= 3}>
      <SourcesTrigger count={links.length} className="text-brand w-full text-left text-xs" />
      <SourcesContent className="w-full">
        <ul className="space-y-2">
          {links.map((link) => (
            <li key={link.url} className="min-w-0">
              <Source href={link.url} className="group inline-flex max-w-full items-center gap-1.5 text-xs font-medium hover:underline">
                <GlobeIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{link.title}</span>
                <ExternalLinkIcon className="size-3 shrink-0 opacity-60" aria-hidden="true" />
                <span className="sr-only">(abre em nova aba)</span>
              </Source>
              <p className="text-muted-foreground truncate pl-5 text-[11px]">
                {hostnameOf(link.url)}
                {link.snippet ? ` · ${link.snippet}` : ""}
              </p>
            </li>
          ))}
        </ul>
      </SourcesContent>
    </Sources>
  );
}

function ActionStatus({ toolName, output }: { toolName: string; output: unknown }) {
  const summary = actionSummary(toolName, output);
  if (!summary) return null;
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 rounded-lg border p-2.5 text-xs",
        summary.ok ? "border-success/25 bg-success/8 text-foreground" : "border-destructive/25 bg-destructive/8 text-destructive",
      )}
      role="status"
    >
      {summary.ok ? (
        <CheckCircle2Icon className="text-success mt-px size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <XCircleIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      )}
      {summary.text}
    </p>
  );
}

function GenericTool({ part, toolName }: { part: ToolPart; toolName: string }) {
  const p = part as ToolPart & { input?: unknown; output?: unknown; errorText?: string };
  return (
    <Tool className="mb-0 bg-card">
      <ToolHeader type={"dynamic-tool"} toolName={toolName} title={toolLabel(toolName)} state={part.state} />
      <ToolContent>
        <ToolInput input={p.input} />
        <ToolOutput output={p.output as never} errorText={p.errorText} />
      </ToolContent>
    </Tool>
  );
}

/** Result of a finished tool, by name (null = use the generic view). */
function ToolResult({ part, toolName, busy, onSendDraft }: { part: ToolPart; toolName: string; busy: boolean; onSendDraft: (leadId: number, text: string) => void }) {
  const output = (part as { output?: unknown }).output;
  switch (toolName) {
    case "query_leads": {
      const data = asQueryLeads(output);
      return data ? <LeadCards total={data.total} leads={data.leads} /> : null;
    }
    case "get_lead":
      return <LeadDetailSummary output={output} />;
    case "lead_stats":
      return <StatsSummary output={output} />;
    case "present_message_draft": {
      const draft = asDraft(output);
      return draft ? <DraftCard draft={draft} disabled={busy} onSend={onSendDraft} /> : null;
    }
    case "start_prospect_search": {
      const job = asJobStart(output);
      return job ? <AiJobProgress jobId={job.job_id} alreadyRunning={job.already_running} /> : null;
    }
    case "serper_search":
    case "scrape_webpage":
      return <LinkResults toolName={toolName} output={output} />;
    case "save_lead_enrichment":
    case "send_whatsapp_message":
    case "crawl_lead_website":
      return <ActionStatus toolName={toolName} output={output} />;
    default:
      return null;
  }
}

const KNOWN_TOOLS = new Set([
  "query_leads",
  "get_lead",
  "lead_stats",
  "present_message_draft",
  "start_prospect_search",
  "serper_search",
  "scrape_webpage",
  "save_lead_enrichment",
  "send_whatsapp_message",
  "crawl_lead_website",
]);

interface ToolPartViewProps {
  part: ToolPart;
  isLastMessage: boolean;
  busy: boolean;
  resolvedApprovals: ReadonlySet<string>;
  onRespond: (approvalId: string, approved: boolean, reason?: string) => void;
  onSendDraft: (leadId: number, text: string) => void;
}

export function ToolPartView({ part, isLastMessage, busy, resolvedApprovals, onRespond, onSendDraft }: ToolPartViewProps) {
  const toolName = toolNameOf(part);
  const view: ApprovalView | null = approvalView(part, isLastMessage, resolvedApprovals);
  const errorText = (part as { errorText?: string }).errorText;

  if (!KNOWN_TOOLS.has(toolName)) {
    return view ? (
      <div className="space-y-2">
        <ApprovalCard part={part} toolName={toolName} view={view} canRespond={!busy} onRespond={onRespond} />
        {part.state === "output-available" && <GenericTool part={part} toolName={toolName} />}
      </div>
    ) : (
      <GenericTool part={part} toolName={toolName} />
    );
  }

  const running = part.state === "input-streaming" || part.state === "input-available" || view === "sending";
  return (
    <div className="space-y-2">
      {view && <ApprovalCard part={part} toolName={toolName} view={view} canRespond={!busy} onRespond={onRespond} />}
      {running && (
        <Shimmer as="p" className="text-sm" duration={1.5}>
          {RUNNING_TEXT[toolName] ?? "Trabalhando…"}
        </Shimmer>
      )}
      {part.state === "output-available" && <ToolResult part={part} toolName={toolName} busy={busy} onSendDraft={onSendDraft} />}
      {part.state === "output-error" && view !== "failed" && (
        <p className="text-destructive flex items-start gap-1.5 text-xs">
          <XCircleIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {toolLabel(toolName)}: {errorText}
        </p>
      )}
    </div>
  );
}
