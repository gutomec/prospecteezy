// "Carregar arquivos": downloads the media of one conversation only after the
// user sees a summary (count, size, disk use) and confirms. Optionally asks the
// phone for the chat history first, to recover keys of old media. The flow
// state lives in the button (not the dialog), so closing the dialog does not
// stop the job: the thread is refreshed when it ends either way.
import { AlertCircleIcon, CheckCircle2Icon, FolderDownIcon, Loader2Icon, RefreshCwIcon, SmartphoneIcon } from "lucide-react";
import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, errorMessage } from "@/lib/api/client";
import { waApi } from "@/lib/api/endpoints";
import { formatBytes, MEDIA_LOAD_INITIAL, mediaJobPercent, mediaLoadOutcome, mediaLoadReducer, mediaSummaryText } from "./wa-utils";

const POLL_MS = 1000;

interface MediaLoadButtonProps {
  instance: string;
  chatJid: string;
  /** null = connected; otherwise why the button is disabled. */
  disabledReason: string | null;
  /** Called when a download job ends (refresh the bubbles). */
  onFinished: () => void;
}

export function MediaLoadButton({ instance, chatJid, disabledReason, onFinished }: MediaLoadButtonProps) {
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useReducer(mediaLoadReducer, MEDIA_LOAD_INITIAL);
  const [recover, setRecover] = useState(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const busy = state.phase === "recovering" || state.phase === "downloading";

  const loadSummary = useCallback(() => {
    dispatch({ type: "reset" });
    waApi.mediaSummary(instance, chatJid).then(
      (summary) => {
        setRecover(summary.unavailable > 0);
        dispatch({ type: "summary_loaded", summary });
      },
      (error) => dispatch({ type: "failed", message: errorMessage(error, "Não consegui ver os arquivos desta conversa.") }),
    );
  }, [instance, chatJid]);

  const openDialog = () => {
    setOpen(true);
    if (!busy) loadSummary(); // a running flow keeps its progress
  };

  // Recovery step: ask the phone for the history (the backend waits up to ~45 s).
  useEffect(() => {
    if (state.phase !== "recovering") return;
    let alive = true;
    waApi.recoverChatMedia(instance, chatJid).then(
      (result) => alive && dispatch({ type: "recovered", result }),
      (error) => alive && dispatch({ type: "recover_failed", message: errorMessage(error, "Não consegui pedir o histórico ao celular.") }),
    );
    return () => {
      alive = false;
    };
  }, [state.phase, instance, chatJid]);

  // Download step: start the job (or attach to the one already running), then poll it.
  const jobId = state.phase === "downloading" ? state.jobId : null;
  const downloading = state.phase === "downloading";
  useEffect(() => {
    if (!downloading || jobId) return;
    let alive = true;
    waApi.downloadChatMedia(instance, chatJid).then(
      (r) => alive && dispatch({ type: "job_started", jobId: r.job_id }),
      (error) => {
        if (!alive) return;
        const running = error instanceof ApiError ? (error.body as { job_id?: unknown } | null)?.job_id : undefined;
        if (typeof running === "string") dispatch({ type: "job_started", jobId: running });
        else dispatch({ type: "failed", message: errorMessage(error, "Não consegui iniciar o download.") });
      },
    );
    return () => {
      alive = false;
    };
  }, [downloading, jobId, instance, chatJid]);

  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const job = await waApi.mediaJob(jobId);
        if (!alive) return;
        dispatch({ type: "job_progress", job });
        if (job.status === "running") timer = setTimeout(poll, POLL_MS);
        else onFinishedRef.current();
      } catch (error) {
        if (alive) dispatch({ type: "failed", message: errorMessage(error, "Perdi o acompanhamento do download.") });
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  const disabled = disabledReason !== null;
  const tip = disabledReason ?? "Baixar as fotos, vídeos, áudios e documentos desta conversa";

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span: a disabled button gets no hover/focus, the wrapper still explains why */}
          <span tabIndex={disabled ? 0 : -1} className="inline-flex rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
            <Button size="sm" variant="outline" onClick={openDialog} disabled={disabled} aria-label="Carregar arquivos" aria-busy={busy}>
              {busy ? <Loader2Icon className="animate-spin" /> : <FolderDownIcon />}
              <span className="hidden sm:inline">Carregar arquivos</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Carregar arquivos</DialogTitle>
            <DialogDescription className="sr-only">Baixar os arquivos de mídia desta conversa para este computador.</DialogDescription>
          </DialogHeader>
          <MediaLoadBody state={state} recover={recover} onRecoverChange={setRecover} onRetry={loadSummary} />
          <DialogFooter>
            {state.phase === "ready" ? (
              <>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancelar
                </Button>
                <Button
                  onClick={() => dispatch({ type: "start", recover })}
                  disabled={state.summary.downloadable === 0 && !(recover && state.summary.unavailable > 0)}
                >
                  <FolderDownIcon /> Baixar arquivos
                </Button>
              </>
            ) : (
              <Button variant={busy ? "outline" : "default"} onClick={() => setOpen(false)}>
                {busy ? "Continuar em segundo plano" : "Fechar"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MediaLoadBody({
  state,
  recover,
  onRecoverChange,
  onRetry,
}: {
  state: ReturnType<typeof mediaLoadReducer>;
  recover: boolean;
  onRecoverChange: (value: boolean) => void;
  onRetry: () => void;
}) {
  const checkboxId = useId();

  if (state.phase === "loading") {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> Verificando os arquivos desta conversa…
      </p>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="flex items-start gap-2 rounded-md bg-destructive/8 p-3 text-sm text-destructive" role="alert">
        <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-2">
          <p>{state.message}</p>
          <Button size="xs" variant="outline" onClick={onRetry} className="text-foreground">
            <RefreshCwIcon /> Tentar de novo
          </Button>
        </div>
      </div>
    );
  }

  if (state.phase === "ready") {
    return (
      <div className="space-y-4 text-sm">
        <p className="leading-relaxed">{mediaSummaryText(state.summary)}</p>
        {state.summary.unavailable > 0 && (
          <div className="flex items-start gap-2.5 rounded-md border p-3">
            <Checkbox id={checkboxId} checked={recover} onCheckedChange={(v) => onRecoverChange(v === true)} className="mt-0.5" />
            <div className="space-y-1">
              <Label htmlFor={checkboxId} className="font-medium">
                Tentar recuperar os arquivos antigos
              </Label>
              <p className="text-muted-foreground text-xs leading-snug">
                Pede ao seu celular o histórico desta conversa. Leva até 45 segundos e nem sempre o WhatsApp reenvia os arquivos antigos.
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (state.phase === "recovering") {
    return (
      <div className="space-y-2 text-sm" role="status" aria-live="polite">
        <p className="flex items-center gap-2 font-medium">
          <SmartphoneIcon className="size-4" aria-hidden="true" />
          Pedindo histórico ao celular…
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        </p>
        <p className="text-muted-foreground text-xs">Pode levar até 45 segundos. Mantenha o celular conectado à internet.</p>
      </div>
    );
  }

  if (state.phase === "downloading") {
    const job = state.job;
    const percent = mediaJobPercent(job);
    return (
      <div className="space-y-3 text-sm">
        {state.recover && <RecoverNote recovered={state.recover.recovered} requested={state.recover.requested} />}
        {state.recoverError && <p className="text-warning-foreground dark:text-warning text-xs">{state.recoverError} Seguindo com os arquivos disponíveis.</p>}
        <div className="space-y-1.5" role="status" aria-live="polite">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium">{job ? "Baixando arquivos…" : "Preparando o download…"}</span>
            {job && (
              <span className="text-muted-foreground text-xs tabular">
                {(job.done + job.failed).toLocaleString("pt-BR")} de {job.total.toLocaleString("pt-BR")} · {formatBytes(job.bytes)}
              </span>
            )}
          </div>
          <Progress value={percent} aria-label="Progresso do download" aria-valuetext={`${percent}%`} />
        </div>
      </div>
    );
  }

  // finished
  const outcome = mediaLoadOutcome(state);
  return (
    <div className="space-y-3 text-sm" role="status">
      <p className="flex items-center gap-2 font-medium">
        <CheckCircle2Icon className="text-success size-4" aria-hidden="true" /> Pronto
      </p>
      {state.recover && <RecoverNote recovered={state.recover.recovered} requested={state.recover.requested} />}
      {state.recoverError && <p className="text-warning-foreground dark:text-warning text-xs">{state.recoverError}</p>}
      <dl className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Baixados" value={outcome.downloaded} />
        <Stat label="Falharam" value={outcome.failed} tone={outcome.failed > 0 ? "text-destructive" : undefined} />
        <Stat label="Ainda indisponíveis" value={outcome.stillUnavailable} />
      </dl>
      {state.job.bytes > 0 && <p className="text-muted-foreground text-xs">{formatBytes(state.job.bytes)} salvos em data/wa-media.</p>}
    </div>
  );
}

function RecoverNote({ recovered, requested }: { recovered: number; requested: number }) {
  if (requested === 0) return null;
  return (
    <p className="text-muted-foreground text-xs">
      {recovered > 0
        ? `O celular reenviou ${recovered.toLocaleString("pt-BR")} ${recovered === 1 ? "arquivo antigo" : "arquivos antigos"}.`
        : "O celular não reenviou os arquivos antigos desta conversa."}
    </p>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-md border p-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={`text-lg font-semibold tabular ${tone ?? ""}`}>{value.toLocaleString("pt-BR")}</dd>
    </div>
  );
}
