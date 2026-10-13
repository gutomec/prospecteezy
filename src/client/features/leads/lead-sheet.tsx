// Lead details drawer: tags (editable), contact (copyable), origin, derived
// timeline, read-only AI enrichment, and AI actions (only when AI is enabled).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  CircleDashedIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  MailIcon,
  MapPinIcon,
  MessageCircleIcon,
  PenLineIcon,
  PhoneIcon,
  SearchIcon,
  SparklesIcon,
  StarIcon,
  TagIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { TagInput } from "@/components/common/tag-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useAiActions } from "@/features/ai/use-ai-actions";
import { errorMessage } from "@/lib/api/client";
import { leadsApi } from "@/lib/api/endpoints";
import type { Lead } from "@/lib/api/types";
import { formatDateTime, formatInt, formatRating, hostnameOf, parseAiEnrichment, parseSocials, phoneDigits, safeUrl, textOf } from "@/lib/format";
import { qk, useAiStatus, useLead } from "@/lib/queries";
import { sameTag } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { useLeadsState } from "./leads-state";
import { WhatsAppBadge } from "./leads-table";

async function copy(value: string, message = "Copiado") {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  } catch {
    toast.error("Não deu para copiar automaticamente.");
  }
}

function SafeLink({ url, children }: { url: unknown; children?: ReactNode }) {
  const href = safeUrl(url);
  if (!href) return <span className="break-all">{children ?? textOf(url)}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand inline-flex items-center gap-1 break-all hover:underline">
      {children ?? hostnameOf(href)}
      <ExternalLinkIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">(abre em nova aba)</span>
    </a>
  );
}

function Section({ title, children, icon }: { title: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function ContactRow({ icon, label, children, copyValue }: { icon: ReactNode; label: string; children: ReactNode; copyValue?: string | null }) {
  return (
    <div className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
      <span className="text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
      {copyValue && (
        <Button variant="ghost" size="icon-xs" onClick={() => copy(copyValue)} aria-label={`Copiar ${label}`} title="Copiar">
          <CopyIcon />
        </Button>
      )}
    </div>
  );
}

/** Derived activity timeline (the API has no GET for lead_events yet). */
function timeline(lead: Lead) {
  const items: Array<{ done: boolean; text: string; at?: string | null }> = [
    { done: true, text: `Coletado via ${lead.source === "serper:places" ? "busca Serper (Places)" : lead.source}`, at: lead.collected_at },
  ];
  if (lead.enriched_at) {
    items.push({ done: true, text: lead.email ? "E-mail encontrado no site" : "Site visitado: e-mail não publicado", at: lead.enriched_at });
  } else {
    items.push({ done: false, text: lead.website ? "Enriquecimento de e-mail pendente" : "Sem site para enriquecer" });
  }
  if (lead.is_whatsapp === 1) items.push({ done: true, text: "Validado no WhatsApp" });
  else if (lead.is_whatsapp === 0) items.push({ done: true, text: "Número sem WhatsApp" });
  else items.push({ done: false, text: "Validação de WhatsApp pendente" });
  if (lead.ai_enriched_at) items.push({ done: true, text: "Enriquecido por IA", at: lead.ai_enriched_at });
  return items;
}

function AiEnrichmentSection({ lead }: { lead: Lead }) {
  const data = parseAiEnrichment(lead);
  if (!data) return null;
  const strings = (value: unknown) => (Array.isArray(value) ? value.map(textOf).filter(Boolean) : []);
  const people = (Array.isArray(data.decision_makers) ? data.decision_makers : []).filter((p) => p && typeof p === "object" && textOf(p.name));
  const socials = data.socials && typeof data.socials === "object" && !Array.isArray(data.socials) ? Object.entries(data.socials).filter(([, url]) => textOf(url)) : [];
  const emails = strings(data.extra_emails);
  const phones = strings(data.extra_phones);
  const sources = strings(data.sources).filter((u) => safeUrl(u));
  const summary = textOf(data.summary);
  const rows: Array<[string, ReactNode]> = [];
  if (textOf(data.segment)) rows.push(["Segmento", textOf(data.segment)]);
  if (textOf(data.size_estimate)) rows.push(["Porte", textOf(data.size_estimate)]);
  if (people.length)
    rows.push([
      "Decisores",
      <ul className="space-y-1">
        {people.map((p, i) => (
          <li key={i}>
            {textOf(p.name)}
            {textOf(p.role) && <span className="text-muted-foreground"> · {textOf(p.role)}</span>}
            {safeUrl(p.source_url) && (
              <>
                {" "}
                <SafeLink url={p.source_url}>fonte</SafeLink>
              </>
            )}
          </li>
        ))}
      </ul>,
    ]);
  if (socials.length)
    rows.push([
      "Redes",
      <ul className="space-y-1">
        {socials.map(([network, url]) => (
          <li key={network}>
            <span className="capitalize">{network}</span>: <SafeLink url={url} />
          </li>
        ))}
      </ul>,
    ]);
  if (emails.length) rows.push(["E-mails", <span className="font-mono text-xs break-all">{emails.join(", ")}</span>]);
  if (phones.length) rows.push(["Telefones", <span className="font-mono text-xs">{phones.join(", ")}</span>]);
  if (textOf(data.notes)) rows.push(["Notas", textOf(data.notes)]);
  if (sources.length)
    rows.push([
      "Fontes",
      <ul className="space-y-1">
        {sources.map((u) => (
          <li key={u}>
            <SafeLink url={u} />
          </li>
        ))}
      </ul>,
    ]);
  if (lead.ai_enriched_at) rows.push(["Atualizado em", formatDateTime(lead.ai_enriched_at)]);
  if (!summary && rows.length === 0) return null;
  return (
    <Section title="Enriquecimento por IA" icon={<SparklesIcon className="size-3.5" />}>
      <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
        {summary && <p className="text-sm leading-relaxed">{summary}</p>}
        {rows.length > 0 && (
          <dl className="space-y-2">
            {rows.map(([label, value]) => (
              <Field key={label} label={label}>
                {value}
              </Field>
            ))}
          </dl>
        )}
      </div>
    </Section>
  );
}

/** Tags of one lead: every chip add/remove is saved right away (POST /api/leads/tags). */
function LeadTags({ lead }: { lead: Lead }) {
  const queryClient = useQueryClient();
  const saved = lead.tags ?? [];
  const [tags, setTags] = useState(saved);
  const savedKey = saved.join("\u0000");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setTags(saved), [lead.id, savedKey]);

  const update = useMutation({
    mutationFn: (diff: { add: string[]; remove: string[] }) => leadsApi.updateTags({ lead_ids: [lead.id], ...diff }),
    onError: (error) => {
      setTags(saved);
      toast.error(errorMessage(error, "Não foi possível salvar as tags. Tente de novo."));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.leads.root }),
  });

  const onChange = (next: string[]) => {
    const add = next.filter((t) => !tags.some((x) => sameTag(x, t)));
    const remove = tags.filter((t) => !next.some((x) => sameTag(x, t)));
    setTags(next);
    if (add.length || remove.length) update.mutate({ add, remove });
  };

  return (
    <Section title="Tags" icon={<TagIcon className="size-3.5" />}>
      <TagInput id={`lead-tags-${lead.id}`} value={tags} onChange={onChange} aria-label={`Tags de ${lead.name}`} aria-describedby={`lead-tags-${lead.id}-help`} />
      <p id={`lead-tags-${lead.id}-help`} className="text-muted-foreground text-xs" aria-live="polite">
        {update.isPending ? "Salvando…" : "Enter adiciona, Backspace remove a última. Salva na hora."}
      </p>
    </Section>
  );
}

function LeadDetails({ lead }: { lead: Lead }) {
  const { ambiguous, openLead } = useLeadsState();
  const ai = useAiStatus();
  const { runLeadAction } = useAiActions();
  // Close the drawer first: two modal sheets would fight over focus.
  const askAi = (action: "research" | "draft") => {
    openLead(null);
    runLeadAction(action, lead);
  };
  const socials = parseSocials(lead);
  const website = safeUrl(lead.website);
  const digits = phoneDigits(lead.phone);
  const canChat = lead.is_whatsapp === 1 && digits.length > 0;
  const mapsUrl =
    lead.latitude != null && lead.longitude != null ? `https://www.google.com/maps/search/?api=1&query=${lead.latitude},${lead.longitude}` : null;

  return (
    <div className="space-y-6 px-4 pb-8 sm:px-6">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!canChat} asChild={canChat}>
          {canChat ? (
            <a href={`https://wa.me/${digits}`} target="_blank" rel="noopener noreferrer">
              <MessageCircleIcon /> Abrir conversa
            </a>
          ) : (
            <>
              <MessageCircleIcon /> Abrir conversa
            </>
          )}
        </Button>
        {website && (
          <Button size="sm" variant="outline" asChild>
            <a href={website} target="_blank" rel="noopener noreferrer">
              <GlobeIcon /> Visitar site
            </a>
          </Button>
        )}
        {lead.phone && (
          <Button size="sm" variant="ghost" onClick={() => copy(lead.phone!, "Telefone copiado")}>
            <CopyIcon /> Copiar telefone
          </Button>
        )}
      </div>

      {ai.enabled && (
        <div className="flex flex-wrap gap-2 rounded-lg border border-brand/20 bg-brand/5 p-3">
          <p className="text-muted-foreground w-full text-xs">Assistente de IA</p>
          <Button size="sm" variant="outline" onClick={() => askAi("research")}>
            <SearchIcon /> Pesquisar com IA
          </Button>
          <Button size="sm" variant="outline" onClick={() => askAi("draft")}>
            <PenLineIcon /> Redigir mensagem
          </Button>
        </div>
      )}

      <LeadTags lead={lead} />

      <Separator />

      <Section title="Contato">
        <div className="-mx-2 space-y-0.5">
          <ContactRow icon={<PhoneIcon className="size-4" />} label="telefone" copyValue={lead.phone}>
            {lead.phone ? <span className="font-mono">{lead.phone}</span> : <span className="text-muted-foreground">Sem telefone</span>}
          </ContactRow>
          <ContactRow icon={<MailIcon className="size-4" />} label="e-mail" copyValue={lead.email}>
            {lead.email ? (
              <a href={`mailto:${lead.email}`} className="break-all hover:underline">
                {lead.email}
              </a>
            ) : (
              <span className="text-muted-foreground">{lead.enriched_at ? "O site não publica e-mail" : "Sem e-mail ainda"}</span>
            )}
          </ContactRow>
          <ContactRow icon={<GlobeIcon className="size-4" />} label="website" copyValue={lead.website}>
            {lead.website ? <SafeLink url={lead.website} /> : <span className="text-muted-foreground">Sem site</span>}
          </ContactRow>
          {Object.entries(socials).map(([network, url]) => (
            <ContactRow key={network} icon={<ExternalLinkIcon className="size-4" />} label={network} copyValue={url}>
              <span className="capitalize">{network}</span>: <SafeLink url={url} />
            </ContactRow>
          ))}
        </div>
      </Section>

      <Separator />

      <Section title="Origem">
        <dl className="space-y-2">
          <Field label="Endereço">{lead.address ?? "—"}</Field>
          {mapsUrl && (
            <Field label="Coordenadas">
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="text-brand inline-flex items-center gap-1 font-mono text-xs hover:underline">
                <MapPinIcon className="size-3" aria-hidden="true" />
                {lead.latitude!.toFixed(5)}, {lead.longitude!.toFixed(5)}
                <span className="sr-only">(abre o mapa em nova aba)</span>
              </a>
            </Field>
          )}
          <Field label="Avaliação">
            {lead.rating != null ? (
              <span className="inline-flex items-center gap-1 tabular">
                <StarIcon className="size-3.5 fill-amber-400 text-amber-400" aria-hidden="true" />
                {formatRating(lead.rating)}
                {lead.rating_count != null && <span className="text-muted-foreground">({formatInt(lead.rating_count)} avaliações)</span>}
              </span>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Posição na busca">{lead.position != null ? `#${lead.position}` : "—"}</Field>
          <Field label="Fonte">
            <code className="text-xs">{lead.source}</code>
          </Field>
          <Field label="WhatsApp">
            <div className="space-y-1">
              <WhatsAppBadge lead={lead} ambiguous={ambiguous} />
              {lead.whatsapp_jid && <p className="text-muted-foreground font-mono text-xs break-all">{lead.whatsapp_jid}</p>}
            </div>
          </Field>
        </dl>
      </Section>

      <Separator />

      <Section title="Linha do tempo">
        <ol className="relative space-y-3 border-l pl-4">
          {timeline(lead).map((item, i) => (
            <li key={i} className="relative text-sm">
              <span
                className={cn(
                  "absolute top-0.5 -left-[1.4rem] flex size-4 items-center justify-center rounded-full border bg-background",
                  item.done ? "border-success/40 text-success" : "text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {item.done ? <CheckIcon className="size-2.5" /> : <CircleDashedIcon className="size-2.5" />}
              </span>
              <p className={cn(!item.done && "text-muted-foreground")}>{item.text}</p>
              {item.at && <p className="text-muted-foreground text-xs tabular">{formatDateTime(item.at)}</p>}
            </li>
          ))}
        </ol>
      </Section>

      <AiEnrichmentSection lead={lead} />
    </div>
  );
}

export function LeadSheet() {
  const { openLeadId, openLead } = useLeadsState();
  const query = useLead(openLeadId);
  const lead = query.data;

  return (
    <Sheet open={openLeadId !== null} onOpenChange={(open) => !open && openLead(null)}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <SheetHeader className="space-y-1.5 px-4 pt-5 pb-4 sm:px-6">
          {lead ? (
            <>
              <SheetTitle className="pr-8 text-lg leading-snug">{lead.name}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                {lead.category && <span>{lead.category}</span>}
                <span className="text-muted-foreground/60">·</span>
                <span>Lead #{lead.id}</span>
              </SheetDescription>
            </>
          ) : (
            <>
              <SheetTitle className="sr-only">Detalhes do lead</SheetTitle>
              <SheetDescription className="sr-only">Carregando</SheetDescription>
              {query.isError ? null : (
                <div className="space-y-2" aria-busy="true">
                  <Skeleton className="h-6 w-3/4" />
                  <Skeleton className="h-4 w-1/3" />
                </div>
              )}
            </>
          )}
        </SheetHeader>
        {query.isError ? (
          <div className="px-4 sm:px-6">
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(query.error, "Lead indisponível.")}</AlertDescription>
            </Alert>
          </div>
        ) : lead ? (
          <LeadDetails lead={lead} />
        ) : (
          <div className="space-y-3 px-4 sm:px-6">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
