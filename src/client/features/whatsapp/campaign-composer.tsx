// Campaign composer ("Enviar mensagem" on selected leads, or "Nova campanha"
// in the WhatsApp view with a picker of validated leads): template with
// {{placeholders}}, live preview with a real lead, optional media
// (POST /api/wa/media), consent, POST /api/wa/campaign → progress (polling
// GET /api/wa/campaign/:job + SSE `campaign`), pause reason and "Retomar".
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  BracesIcon,
  CheckCircle2Icon,
  FileIcon,
  ImageIcon,
  Loader2Icon,
  PaperclipIcon,
  PauseCircleIcon,
  PlayIcon,
  SearchIcon,
  SendIcon,
  VideoIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link } from "@/app/router";
import { StatusBadge, type Tone } from "@/components/common/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, errorMessage } from "@/lib/api/client";
import { uploadWaMedia, waApi } from "@/lib/api/endpoints";
import type { Lead, WaCampaign, WaCampaignRecipient, WaUploadedMedia } from "@/lib/api/types";
import { formatInt, plural } from "@/lib/format";
import { qk, useAllLeads, useWaInstances, useWaLeads } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/routes";
import { instanceLabel } from "./accounts";
import { setLastCampaign } from "./campaign-store";
import { WaText } from "./message-bubble";
import { WA_STATUS_TONES } from "./wa-status-indicator";
import { pickConnectedInstance, useWaStreamEvent, WA_STATUS_LABELS } from "./wa-stream";
import {
  attachmentKind,
  attachmentLimitError,
  emptyPlaceholders,
  formatBytes,
  formatPhone,
  PLACEHOLDERS,
  recipientStatusText,
  renderTemplate,
  unknownPlaceholders,
} from "./wa-utils";

export interface CampaignComposerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Selected leads; empty → pick among leads with a validated WhatsApp. */
  leadIds: number[];
  /** Reopen the progress of an existing campaign instead of composing. */
  jobId?: string | null;
}

export function CampaignComposer({ open, onOpenChange, leadIds, jobId: initialJobId = null }: CampaignComposerProps) {
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  // Each opening starts fresh (or on the requested campaign).
  useEffect(() => {
    if (open) setJobId(initialJobId);
  }, [open, initialJobId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 p-0 sm:max-w-2xl">
        {jobId ? (
          <CampaignProgress jobId={jobId} onClose={() => onOpenChange(false)} />
        ) : (
          open && (
            <ComposeStage
              leadIds={leadIds}
              onCancel={() => onOpenChange(false)}
              onStarted={(id) => {
                setLastCampaign(id);
                setJobId(id);
              }}
            />
          )
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- compose ---------------- */

interface MediaState {
  file: File;
  status: "uploading" | "ready" | "error";
  progress: number;
  uploaded: WaUploadedMedia | null;
  error: string | null;
  previewUrl: string | null;
}

function ComposeStage({ leadIds, onCancel, onStarted }: { leadIds: number[]; onCancel: () => void; onStarted: (jobId: string) => void }) {
  const picking = leadIds.length === 0;
  const all = useAllLeads();
  const waLeads = useWaLeads(picking);
  const instances = useWaInstances();
  const instance = pickConnectedInstance(instances.data) ?? instances.data?.find((i) => i.is_active) ?? null;
  const connected = instance?.status === "connected";

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [pickerQuery, setPickerQuery] = useState("");
  const [template, setTemplate] = useState("");
  const [consent, setConsent] = useState(false);
  const [media, setMedia] = useState<MediaState | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; valid?: string[] } | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      uploadAbort.current?.abort();
    },
    [],
  );
  useEffect(() => () => {
    if (media?.previewUrl) URL.revokeObjectURL(media.previewUrl);
  }, [media?.previewUrl]);

  const byId = useMemo(() => new Map((all.data?.leads ?? []).map((l) => [l.id, l])), [all.data]);
  const ids = picking ? [...picked] : leadIds;
  const recipients: Lead[] = useMemo(() => ids.map((id) => byId.get(id)).filter((l): l is Lead => Boolean(l)), [ids, byId]);
  const missing = ids.length - recipients.length;

  const summary = useMemo(() => {
    let yes = 0;
    let pending = 0;
    let no = 0;
    let noPhone = 0;
    for (const l of recipients) {
      if (!l.phone) noPhone++;
      else if (l.is_whatsapp === 1) yes++;
      else if (l.is_whatsapp === 0) no++;
      else pending++;
    }
    return { yes, pending, no, noPhone };
  }, [recipients]);

  const unknown = unknownPlaceholders(template);
  const emptySkips = useMemo(
    () => (template.includes("{{") ? recipients.filter((l) => l.is_whatsapp !== 0 && emptyPlaceholders(template, l).length > 0).length : 0),
    [template, recipients],
  );
  const previewLead = recipients.find((l) => l.id === previewId) ?? recipients.find((l) => l.is_whatsapp === 1) ?? recipients[0] ?? null;
  const previewEmpty = previewLead ? emptyPlaceholders(template, previewLead) : [];
  const rendered = previewLead ? renderTemplate(template, previewLead) : template;

  const mediaReady = media?.status === "ready" ? media.uploaded : null;
  const hasContent = template.trim().length > 0 || Boolean(mediaReady);
  const canSend = connected && consent && hasContent && unknown.length === 0 && ids.length > 0 && media?.status !== "uploading" && !sending;

  const insert = (token: string) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? template.length;
    const end = el?.selectionEnd ?? template.length;
    const next = template.slice(0, start) + token + template.slice(end);
    setTemplate(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    const limit = attachmentLimitError(file);
    if (limit) {
      setError({ message: limit });
      return;
    }
    if (attachmentKind(file) === "audio") {
      setError({ message: "Áudio não é aceito em campanhas: anexe imagem, vídeo ou documento." });
      return;
    }
    uploadAbort.current?.abort();
    const controller = new AbortController();
    uploadAbort.current = controller;
    setError(null);
    const kind = attachmentKind(file);
    setMedia({ file, status: "uploading", progress: 0, uploaded: null, error: null, previewUrl: kind === "image" ? URL.createObjectURL(file) : null });
    uploadWaMedia(file, { signal: controller.signal, onProgress: (p) => setMedia((m) => (m && m.file === file ? { ...m, progress: p } : m)) })
      .then((uploaded) => setMedia((m) => (m && m.file === file ? { ...m, status: "ready", progress: 1, uploaded } : m)))
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setMedia((m) => (m && m.file === file ? { ...m, status: "error", error: errorMessage(e, "Falha no envio da mídia.") } : m));
      });
  };

  const submit = async () => {
    if (!canSend || !instance) return;
    setSending(true);
    setError(null);
    try {
      const { job_id } = await waApi.createCampaign({
        instance: instance.id,
        lead_ids: ids,
        template,
        media: mediaReady ? { media_id: mediaReady.media_id } : undefined,
      });
      onStarted(job_id);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { valid_placeholders?: string[]; job_id?: string } | null) : null;
      if (e instanceof ApiError && e.status === 409 && body?.job_id) {
        // Another campaign is running on this account: show it.
        toast(e.message);
        onStarted(body.job_id);
        return;
      }
      setError({ message: errorMessage(e, "Não foi possível criar a campanha."), valid: body?.valid_placeholders });
    } finally {
      setSending(false);
    }
  };

  const pickerRows = useMemo(() => {
    const term = pickerQuery.trim().toLowerCase();
    return (waLeads.data ?? []).filter((l) => !term || l.name.toLowerCase().includes(term) || (l.phone ?? "").includes(term) || (l.category ?? "").toLowerCase().includes(term));
  }, [waLeads.data, pickerQuery]);

  const MediaIcon = media && attachmentKind(media.file) === "video" ? VideoIcon : media && attachmentKind(media.file) === "image" ? ImageIcon : FileIcon;

  return (
    <>
      <DialogHeader className="border-b px-5 py-4 text-left">
        <DialogTitle className="flex items-center gap-2">
          <SendIcon className="size-4" aria-hidden="true" /> {picking ? "Nova campanha" : "Enviar mensagem"}
        </DialogTitle>
        <DialogDescription>
          {picking ? "Escolha leads com WhatsApp validado e escreva a mensagem." : `Para ${plural(ids.length, "lead selecionado", "leads selecionados")}.`} Cada lead recebe
          a mensagem personalizada, no ritmo das travas anti-ban.
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {/* account */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Enviando por</span>
          {instances.isPending ? (
            <Skeleton className="h-5 w-40" />
          ) : instance ? (
            <>
              <span className="font-medium">{instanceLabel(instance)}</span>
              {instance.phone && <span className="text-muted-foreground font-mono text-xs">{formatPhone(instance.phone)}</span>}
              <StatusBadge tone={WA_STATUS_TONES[instance.status]}>{WA_STATUS_LABELS[instance.status]}</StatusBadge>
            </>
          ) : (
            <StatusBadge tone="danger">Nenhuma conta conectada</StatusBadge>
          )}
        </div>
        {!instances.isPending && !connected && (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>Conecte um WhatsApp para disparar</AlertTitle>
            <AlertDescription>
              <p>
                {instance?.status_reason ?? "A campanha precisa de uma conta conectada."}{" "}
                <Link to={ROUTES.whatsapp} className="font-medium underline underline-offset-2">
                  Abrir contas de WhatsApp
                </Link>
              </p>
            </AlertDescription>
          </Alert>
        )}

        {/* recipients */}
        {picking && (
          <section className="space-y-2" aria-labelledby="cmp-picker">
            <div className="flex items-center justify-between gap-2">
              <h3 id="cmp-picker" className="text-sm font-medium">
                Destinatários
              </h3>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setPicked(picked.size === pickerRows.length ? new Set() : new Set(pickerRows.map((l) => l.lead_id)))}
                disabled={pickerRows.length === 0}
              >
                {picked.size === pickerRows.length && pickerRows.length > 0 ? "Limpar" : `Selecionar ${pickerRows.length === (waLeads.data?.length ?? 0) ? "todos" : "filtrados"}`}
              </Button>
            </div>
            <div className="relative">
              <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden="true" />
              <Input value={pickerQuery} onChange={(e) => setPickerQuery(e.target.value)} placeholder="Filtrar por nome, categoria ou telefone" aria-label="Filtrar leads" className="h-8 pl-8" />
            </div>
            <ul className="max-h-44 overflow-y-auto rounded-md border" aria-label="Leads com WhatsApp validado">
              {waLeads.isPending ? (
                <li className="p-3">
                  <Skeleton className="h-4 w-1/2" />
                </li>
              ) : pickerRows.length === 0 ? (
                <li className="text-muted-foreground p-3 text-sm">Nenhum lead com WhatsApp validado. Valide leads na aba Leads.</li>
              ) : (
                pickerRows.map((l) => (
                  <li key={l.lead_id} className="border-b last:border-b-0">
                    <label className="hover:bg-accent/50 flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                      <Checkbox
                        checked={picked.has(l.lead_id)}
                        onCheckedChange={(v) =>
                          setPicked((set) => {
                            const next = new Set(set);
                            if (v === true) next.add(l.lead_id);
                            else next.delete(l.lead_id);
                            return next;
                          })
                        }
                      />
                      <span className="min-w-0 flex-1 truncate">{l.name}</span>
                      <span className="text-muted-foreground hidden truncate text-xs sm:inline">{l.category}</span>
                    </label>
                  </li>
                ))
              )}
            </ul>
          </section>
        )}

        {ids.length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs" aria-label="Situação dos destinatários">
            <StatusBadge tone="success">{plural(summary.yes, "validado", "validados")}</StatusBadge>
            {summary.pending > 0 && <StatusBadge tone="info">{plural(summary.pending, "será validado antes do envio", "serão validados antes do envio")}</StatusBadge>}
            {summary.no > 0 && <StatusBadge tone="neutral">{plural(summary.no, "sem WhatsApp (pulado)", "sem WhatsApp (pulados)")}</StatusBadge>}
            {summary.noPhone > 0 && <StatusBadge tone="neutral">{plural(summary.noPhone, "sem telefone (pulado)", "sem telefone (pulados)")}</StatusBadge>}
            {missing > 0 && <StatusBadge tone="warning">{plural(missing, "fora da lista carregada", "fora da lista carregada")}</StatusBadge>}
          </div>
        )}

        {/* template */}
        <div className="space-y-1.5">
          <div className="flex items-end justify-between gap-2">
            <Label htmlFor="cmp-template">{mediaReady ? "Legenda da mídia" : "Mensagem"}</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="xs" variant="outline">
                  <BracesIcon /> Inserir campo
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel>Campos do lead</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {PLACEHOLDERS.map((p) => (
                  <DropdownMenuItem key={p.column} onSelect={() => insert(`{{${p.column}}}`)}>
                    <span className="flex-1">{p.label}</span>
                    <code className="text-muted-foreground font-mono text-xs">{`{{${p.column}}}`}</code>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Textarea
            id="cmp-template"
            ref={textareaRef}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder="Olá {{name}}, vi que vocês atuam com {{category}}…"
            rows={5}
            maxLength={4096}
            aria-invalid={unknown.length > 0}
            aria-describedby="cmp-template-help"
          />
          <p id="cmp-template-help" className={cn("text-xs", unknown.length ? "text-destructive" : "text-muted-foreground")}>
            {unknown.length
              ? `Campo desconhecido: ${unknown.map((u) => `{{${u}}}`).join(", ")}. Use ${PLACEHOLDERS.map((p) => `{{${p.column}}}`).join(", ")}.`
              : "Formatação do WhatsApp funciona: *negrito*, _itálico_, ~riscado~."}
          </p>
          {emptySkips > 0 && (
            <p className="text-warning-foreground dark:text-warning text-xs">
              {plural(emptySkips, "lead será pulado", "leads serão pulados")} porque um campo usado está vazio para {emptySkips === 1 ? "ele" : "eles"}.
            </p>
          )}
        </div>

        {/* media */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={media?.status === "uploading"}>
              <PaperclipIcon /> {media ? "Trocar mídia" : "Anexar mídia (opcional)"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip"
              className="hidden"
              tabIndex={-1}
              onChange={(e) => {
                pickFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            {media && (
              <div className={cn("flex min-w-0 items-center gap-2 rounded-md border p-1.5 pr-1", media.status === "error" && "border-destructive/40")}>
                {media.previewUrl ? (
                  <img src={media.previewUrl} alt="" className="size-8 rounded object-cover" />
                ) : (
                  <MediaIcon className="text-muted-foreground size-4" aria-hidden="true" />
                )}
                <div className="min-w-0">
                  <p className="max-w-48 truncate text-xs font-medium">{media.file.name}</p>
                  <p className={cn("text-[11px] tabular", media.status === "error" ? "text-destructive" : "text-muted-foreground")} role={media.status === "error" ? "alert" : undefined}>
                    {media.status === "uploading" ? `Enviando… ${Math.round(media.progress * 100)}%` : media.status === "error" ? media.error : formatBytes(media.file.size)}
                  </p>
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Remover mídia"
                  onClick={() => {
                    uploadAbort.current?.abort();
                    setMedia(null);
                  }}
                >
                  <XIcon />
                </Button>
              </div>
            )}
          </div>
          {mediaReady && <p className="text-muted-foreground text-xs">Com mídia anexada, o texto acima vai como legenda.</p>}
        </div>

        {/* preview */}
        <section className="space-y-2" aria-labelledby="cmp-preview">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="cmp-preview" className="text-sm font-medium">
              Prévia
            </h3>
            {recipients.length > 1 && previewLead && (
              <Select value={String(previewLead.id)} onValueChange={(v) => setPreviewId(Number(v))}>
                <SelectTrigger size="sm" className="w-56" aria-label="Lead da prévia">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {recipients.slice(0, 100).map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="bg-muted/40 rounded-lg border p-3">
            {all.isPending ? (
              <Skeleton className="h-10 w-2/3" />
            ) : !template.trim() && !mediaReady ? (
              <p className="text-muted-foreground text-sm">A prévia aparece aqui com os dados de um lead real.</p>
            ) : (
              <div className="bg-success/12 dark:bg-success/16 ml-auto w-fit max-w-[90%] rounded-lg rounded-tr-sm px-3 py-2 text-sm shadow-xs">
                {media?.previewUrl && <img src={media.previewUrl} alt="" className="mb-1.5 max-h-40 rounded-md object-cover" />}
                {media && !media.previewUrl && (
                  <p className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs">
                    <MediaIcon className="size-3.5" aria-hidden="true" /> {media.file.name}
                  </p>
                )}
                {rendered && <WaText text={rendered} />}
              </div>
            )}
            {previewLead && previewEmpty.length > 0 && template.trim() && (
              <p className="text-warning-foreground dark:text-warning mt-2 text-xs">
                Este lead seria pulado: campo vazio {previewEmpty.map((c) => `{{${c}}}`).join(", ")}.
              </p>
            )}
          </div>
        </section>

        {/* risk + consent */}
        <Alert>
          <AlertTriangleIcon />
          <AlertTitle>Mensagem para quem não iniciou conversa</AlertTitle>
          <AlertDescription>
            <p>
              É prospecção fria: há risco real de bloqueio do número (Termos do WhatsApp) e sensibilidade de LGPD. As travas anti-ban (1 envio a cada ~30 s com variação,
              teto de 20 por hora, horário de silêncio das 21h às 8h) reduzem o risco, não eliminam. Use um número dedicado.
            </p>
          </AlertDescription>
        </Alert>
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" />
          Li o aviso e assumo a responsabilidade por este disparo.
        </label>

        {error && (
          <Alert variant="destructive">
            <XCircleIcon />
            <AlertTitle>Não foi possível disparar</AlertTitle>
            <AlertDescription>
              <p>{error.message}</p>
              {error.valid && <p>Campos válidos: {error.valid.map((v) => `{{${v}}}`).join(", ")}.</p>}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <DialogFooter className="items-center border-t px-5 py-3 sm:justify-between">
        <span className="text-muted-foreground hidden text-xs tabular sm:inline">{plural(ids.length, "destinatário", "destinatários")}</span>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!canSend}>
            {sending ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
            Disparar para {formatInt(ids.length)}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

/* ---------------- progress ---------------- */

const CAMPAIGN_STATUS: Record<WaCampaign["status"], { label: string; tone: Tone }> = {
  queued: { label: "Na fila", tone: "info" },
  running: { label: "Enviando", tone: "info" },
  done: { label: "Concluída", tone: "success" },
  paused: { label: "Pausada", tone: "warning" },
  failed: { label: "Falhou", tone: "danger" },
};

/** Rough ETA under the send gate: ~35 s apart, but never more than 20 per hour. */
function etaLabel(pending: number): string {
  const minutes = Math.max(1, Math.round(Math.max((pending * 35) / 60, (pending / 20) * 60)));
  if (minutes < 60) return `${minutes} min restantes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} h${rest ? ` ${rest} min` : ""} restantes`;
}

const RECIPIENT_TONES: Record<WaCampaignRecipient["status"], Tone> = { queued: "neutral", sent: "success", failed: "danger", skipped: "warning" };

export function CampaignProgress({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const all = useAllLeads();
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: qk.wa.campaign(jobId),
    queryFn: ({ signal }) => waApi.campaign(jobId, signal),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status === "done" || status === "failed" || status === "paused" ? false : 1500;
    },
    refetchIntervalInBackground: true,
  });

  useWaStreamEvent("campaign", (data) => {
    if (data.job_id === jobId) void queryClient.invalidateQueries({ queryKey: qk.wa.campaign(jobId) });
  });

  const job = query.data;
  const names = useMemo(() => new Map((all.data?.leads ?? []).map((l) => [l.id, l.name])), [all.data]);

  const resume = async () => {
    setResuming(true);
    setResumeError(null);
    try {
      await waApi.resumeCampaign(jobId);
      queryClient.setQueryData<WaCampaign>(qk.wa.campaign(jobId), (j) => (j ? { ...j, status: "running", reason: null } : j));
      void queryClient.invalidateQueries({ queryKey: qk.wa.campaign(jobId) });
    } catch (e) {
      setResumeError(errorMessage(e, "Não foi possível retomar a campanha."));
    } finally {
      setResuming(false);
    }
  };

  const processed = job ? job.sent + job.failed + job.skipped : 0;
  const pending = job ? Math.max(0, job.total - processed) : 0;
  const pct = job && job.total > 0 ? Math.round((processed / job.total) * 100) : 0;
  const status = job ? CAMPAIGN_STATUS[job.status] : null;
  const active = job?.status === "running" || job?.status === "queued";

  return (
    <>
      <DialogHeader className="border-b px-5 py-4 text-left">
        <DialogTitle className="flex items-center gap-2">
          <SendIcon className="size-4" aria-hidden="true" /> Campanha
          {status && <StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
        </DialogTitle>
        <DialogDescription>Os envios seguem no servidor mesmo com esta janela fechada.</DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {query.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-2 w-full" />
          </div>
        ) : query.isError ? (
          <Alert variant="destructive">
            <XCircleIcon />
            <AlertTitle>Campanha indisponível</AlertTitle>
            <AlertDescription>{errorMessage(query.error, "Perdi contato com o servidor.")}</AlertDescription>
          </Alert>
        ) : job ? (
          <>
            <dl className="grid grid-cols-4 gap-2" aria-label="Resumo da campanha">
              {[
                ["Total", job.total, ""],
                ["Enviadas", job.sent, "text-success"],
                ["Falhas", job.failed, "text-destructive"],
                ["Puladas", job.skipped, "text-warning-foreground dark:text-warning"],
              ].map(([label, value, tone]) => (
                <div key={label as string} className="rounded-lg border bg-card p-2.5 text-center">
                  <dd className={cn("text-xl font-semibold tabular", tone as string)}>{formatInt(value as number)}</dd>
                  <dt className="text-muted-foreground text-xs">{label}</dt>
                </div>
              ))}
            </dl>
            <div className="space-y-1.5">
              <Progress value={pct} aria-label="Progresso da campanha" aria-valuetext={`${processed} de ${job.total} processados`} />
              <p className="text-muted-foreground text-xs tabular" aria-live="polite">
                {processed} de {job.total} processados
                {active && pending > 0 && ` · ritmo anti-ban: ~1 envio a cada 30 s, teto de 20 por hora · cerca de ${etaLabel(pending)}`}
              </p>
            </div>

            {job.status === "paused" && (
              <Alert className="border-warning/40">
                <PauseCircleIcon />
                <AlertTitle>Campanha pausada{job.reason ? `: ${job.reason}` : ""}</AlertTitle>
                <AlertDescription>
                  <p>
                    {plural(pending, "destinatário continua", "destinatários continuam")} na fila e nunca recebem mensagem repetida. Retome quando o motivo for resolvido (por
                    exemplo, depois das 8h).
                  </p>
                </AlertDescription>
              </Alert>
            )}
            {job.status === "done" && (
              <Alert>
                <CheckCircle2Icon className="text-success" />
                <AlertTitle>Campanha concluída</AlertTitle>
                <AlertDescription>
                  {formatInt(job.sent)} enviadas, {formatInt(job.failed)} com falha, {formatInt(job.skipped)} puladas.
                </AlertDescription>
              </Alert>
            )}
            {job.status === "failed" && (
              <Alert variant="destructive">
                <XCircleIcon />
                <AlertTitle>A campanha falhou</AlertTitle>
                <AlertDescription>{job.reason ?? "Erro inesperado no envio."} Você pode tentar retomar os destinatários que ficaram na fila.</AlertDescription>
              </Alert>
            )}
            {resumeError && (
              <Alert variant="destructive">
                <XCircleIcon />
                <AlertTitle>Não deu para retomar</AlertTitle>
                <AlertDescription>{resumeError}</AlertDescription>
              </Alert>
            )}

            <ul className="divide-y rounded-lg border" aria-label="Destinatários">
              {job.recipients.length === 0 ? (
                <li className="text-muted-foreground p-3 text-sm">Preparando destinatários…</li>
              ) : (
                job.recipients.map((r) => (
                  <li key={r.lead_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium">{names.get(r.lead_id) ?? `Lead ${r.lead_id}`}</span>
                    <span className="text-muted-foreground font-mono text-xs">{r.phone ?? "—"}</span>
                    <StatusBadge tone={RECIPIENT_TONES[r.status]} className="max-w-full">
                      <span className="truncate">{recipientStatusText(r)}</span>
                    </StatusBadge>
                  </li>
                ))
              )}
            </ul>
          </>
        ) : null}
      </div>

      <DialogFooter className="border-t px-5 py-3">
        {(job?.status === "paused" || job?.status === "failed") && (
          <Button onClick={resume} disabled={resuming}>
            {resuming ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
            {resuming ? "Retomando…" : "Retomar"}
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>
          {active ? "Fechar (segue em segundo plano)" : "Fechar"}
        </Button>
      </DialogFooter>
    </>
  );
}
