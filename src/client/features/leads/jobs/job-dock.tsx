// Floating progress panels (bottom-right) for validation and enrichment.
// Closing a panel only hides it: polling continues and a toast reports the end.
import { CheckCircle2Icon, Loader2Icon, MailSearchIcon, PauseCircleIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { navigate } from "@/app/router";
import { StepList } from "@/components/common/step-list";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { ValidateJobStatus } from "@/lib/api/types";
import { formatInt, plural } from "@/lib/format";
import { ROUTES } from "@/routes";
import { useLeadsState } from "../leads-state";
import { useLeadJobs } from "./lead-jobs";

const VALIDATE_STATUS: Record<ValidateJobStatus, string> = {
  queued: "Na fila",
  running: "Validando…",
  done: "Concluída",
  paused: "Pausada",
  failed: "Falhou",
};

function DockPanel({ icon, title, subtitle, onClose, children, label }: { icon: ReactNode; title: string; subtitle: string; onClose: () => void; children: ReactNode; label: string }) {
  return (
    <section
      className="pointer-events-auto w-full rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg sm:w-96"
      aria-label={label}
    >
      <div className="mb-3 flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{icon}</div>
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-muted-foreground text-xs tabular">{subtitle}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={`Fechar painel: ${title}`}>
          <XIcon />
        </Button>
      </div>
      {children}
    </section>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className="rounded-md border bg-background px-2 py-1.5 text-center">
      <div className={`text-base font-semibold tabular ${tone ?? ""}`}>{formatInt(value)}</div>
      <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">{label}</div>
    </div>
  );
}

function ValidatePanel() {
  const { validate } = useLeadJobs();
  const { selection } = useLeadsState();
  const { phase, job } = validate;
  const close = validate.closePanel;

  if (phase.kind === "idle") return null;

  if (phase.kind === "no-connection" || phase.kind === "error") {
    return (
      <DockPanel icon={<ShieldCheckIcon className="size-4" />} title="Validar WhatsApp" subtitle={phase.kind === "error" ? "Erro" : "Sem conta conectada"} onClose={close} label="Validação de WhatsApp">
        <Alert variant="destructive">
          <AlertDescription>{phase.message}</AlertDescription>
        </Alert>
        {phase.kind === "no-connection" && (
          <>
            <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
              Os lookups precisam de uma conta pareada e ativa. Conecte um WhatsApp na aba WhatsApp.
            </p>
            <Button
              size="sm"
              className="mt-3"
              onClick={() => {
                close();
                navigate(ROUTES.whatsapp);
              }}
            >
              Ir para WhatsApp
            </Button>
          </>
        )}
      </DockPanel>
    );
  }

  if (phase.kind === "starting" || !job) {
    const total = phase.kind === "starting" ? phase.total : 0;
    return (
      <DockPanel icon={<Loader2Icon className="size-4 animate-spin" />} title="Validar WhatsApp" subtitle={total ? `Iniciando · ${plural(total, "lead", "leads")}` : "Carregando…"} onClose={close} label="Validação de WhatsApp">
        {phase.kind === "starting" && <p className="text-muted-foreground text-sm">Enviando pela conta {phase.instanceName}…</p>}
        <Progress value={0} className="mt-3" aria-label="Progresso da validação" />
      </DockPanel>
    );
  }

  const pending = Math.max(0, job.total - job.checked);
  const active = job.status === "running" || job.status === "queued";
  const subtitle = active ? `${VALIDATE_STATUS[job.status]} · ${formatInt(job.checked)}/${formatInt(job.total)}` : VALIDATE_STATUS[job.status];
  const etaMin = job.eta_seconds ? Math.max(1, Math.round(job.eta_seconds / 60)) : null;

  return (
    <DockPanel
      icon={job.status === "done" ? <CheckCircle2Icon className="size-4 text-success" /> : job.status === "paused" ? <PauseCircleIcon className="size-4 text-warning" /> : <Loader2Icon className="size-4 animate-spin" />}
      title="Validar WhatsApp"
      subtitle={subtitle}
      onClose={close}
      label="Validação de WhatsApp"
    >
      <Progress
        value={job.total ? (job.checked / job.total) * 100 : 0}
        aria-label="Progresso da validação"
        aria-valuetext={`${job.checked} de ${job.total} validados`}
      />
      <div className="mt-3 grid grid-cols-4 gap-1.5" role="group" aria-label="Resumo da validação">
        <Stat value={job.is_whatsapp} label="Com" tone="text-success" />
        <Stat value={job.not_whatsapp} label="Sem" />
        <Stat value={job.ambiguous} label="Ambíguos" tone="text-warning-foreground dark:text-warning" />
        <Stat value={job.failed} label="Falhas" tone="text-destructive" />
      </div>
      {active && pending > 0 && (
        <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
          Validação em lotes para proteger o número: pode levar um tempo. {plural(pending, "pendente", "pendentes")}
          {etaMin ? ` · cerca de ${formatInt(etaMin)} min` : ""}.
        </p>
      )}
      {job.status === "paused" && (
        <Alert className="mt-3">
          <AlertDescription>
            Validação pausada{job.reason ? ` (${job.reason})` : ""}.{" "}
            {pending === 1 ? "O lead pendente continua na fila e pode ser retomado." : `Os ${formatInt(pending)} leads pendentes continuam na fila e podem ser retomados.`}
          </AlertDescription>
        </Alert>
      )}
      {validate.resumeError && (
        <Alert variant="destructive" className="mt-2">
          <AlertDescription>{validate.resumeError}</AlertDescription>
        </Alert>
      )}
      {job.status === "done" && (
        <p className="mt-3 text-sm">
          Concluída: {formatInt(job.is_whatsapp)} com WhatsApp, {formatInt(job.not_whatsapp)} sem, {formatInt(job.ambiguous)} ambíguo(s) e {formatInt(job.failed)} falha(s).
        </p>
      )}
      {job.status === "failed" && (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>A validação falhou{job.reason ? `: ${job.reason}` : "."}</AlertDescription>
        </Alert>
      )}
      {!active && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {job.status === "paused" && (
            <>
              <Button size="sm" variant="ghost" disabled={validate.resuming || selection.size === 0} onClick={() => validate.start([...selection], { fresh: true })}>
                Nova validação
              </Button>
              <Button size="sm" disabled={validate.resuming} onClick={validate.resume}>
                {validate.resuming && <Loader2Icon className="animate-spin" />}
                {validate.resuming ? "Retomando…" : "Retomar"}
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" onClick={close}>
            Fechar
          </Button>
        </div>
      )}
    </DockPanel>
  );
}

function EnrichPanel() {
  const { enrich } = useLeadJobs();
  if (!enrich.jobId) return null;
  const job = enrich.job;
  const running = enrich.running;
  const failed = job?.status === "failed";
  const subtitle = enrich.error
    ? "Interrompido"
    : !job
      ? `Iniciando · ${plural(enrich.total, "lead", "leads")}`
      : job.status === "completed"
        ? "Concluído"
        : failed
          ? "Falhou"
          : "Em andamento…";
  return (
    <DockPanel
      icon={running ? <Loader2Icon className="size-4 animate-spin" /> : job?.status === "completed" ? <CheckCircle2Icon className="size-4 text-success" /> : <MailSearchIcon className="size-4" />}
      title="Enriquecer e-mails"
      subtitle={subtitle}
      onClose={enrich.closePanel}
      label="Enriquecimento de e-mails"
    >
      {job && <StepList steps={job.steps} running={job.status === "running"} failed={failed} limit={5} />}
      {(failed || enrich.error) && (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>{enrich.error ?? job?.error ?? "O enriquecimento falhou."}</AlertDescription>
        </Alert>
      )}
      {job?.status === "completed" && job.result && (
        <p className="mt-3 text-sm">{plural(job.result.enriched, "e-mail encontrado", "e-mails encontrados")}.</p>
      )}
    </DockPanel>
  );
}

export function JobDock() {
  const { validate, enrich } = useLeadJobs();
  const { selection } = useLeadsState();
  if (!validate.panelOpen && !enrich.panelOpen) return null;
  return (
    // Sits above the selection bar when it is visible.
    <div className={`pointer-events-none fixed right-4 left-4 z-40 flex flex-col items-end gap-3 sm:left-auto ${selection.size > 0 ? "bottom-20" : "bottom-4"}`}>
      {validate.panelOpen && <ValidatePanel />}
      {enrich.panelOpen && <EnrichPanel />}
    </div>
  );
}
