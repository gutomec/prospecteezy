// Bulk lead jobs started from the selection bar, tracked at app level so they
// keep running (and the grid keeps refreshing) across views:
//  - WhatsApp validation: POST /api/wa/validate → GET /api/wa/validate/:job
//    (status queued|running|done|paused|failed; paused → POST …/resume).
//  - E-mail enrichment:   POST /api/leads/enrich → GET /api/progress/:job.
// Their progress panels are rendered by <JobDock/>.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ApiError, errorMessage } from "@/lib/api/client";
import { jobsApi, leadsApi, waApi } from "@/lib/api/endpoints";
import type { Job, ValidateJob } from "@/lib/api/types";
import { formatInt } from "@/lib/format";
import { qk } from "@/lib/queries";
import { pickConnectedInstance } from "@/features/whatsapp/wa-stream";
import { useLeadsState } from "../leads-state";

const POLL_MS = 2000;

/* ---------------- validation ---------------- */

export type ValidatePhase =
  | { kind: "idle" }
  | { kind: "starting"; total: number; instanceName: string }
  | { kind: "no-connection"; message: string }
  | { kind: "error"; message: string }
  | { kind: "tracking"; jobId: string };

/** Outcome of one result row: the backend collapses ambiguous/failed/no-phone/queued into is_whatsapp:null. */
export function validationOutcome(r: ValidateJob["results"][number]): "yes" | "no" | "queued" | "no_phone" | "failed" | "ambiguous" {
  if (r.is_whatsapp === true) return "yes";
  if (r.is_whatsapp === false) return "no";
  const reason = (r.reason ?? "").toLowerCase();
  if (!reason) return "queued";
  if (reason.includes("telefone")) return "no_phone";
  if (reason.includes("lookup") || reason.includes("conect") || reason.includes("falh")) return "failed";
  return "ambiguous";
}

interface LeadJobsValue {
  validate: {
    phase: ValidatePhase;
    job: ValidateJob | undefined;
    panelOpen: boolean;
    running: boolean;
    resuming: boolean;
    resumeError: string | null;
    start: (ids: number[], options?: { fresh?: boolean }) => Promise<void>;
    resume: () => Promise<void>;
    openPanel: () => void;
    closePanel: () => void;
  };
  enrich: {
    jobId: string | null;
    job: Job | undefined;
    total: number;
    error: string | null;
    panelOpen: boolean;
    running: boolean;
    start: (ids: number[]) => Promise<void>;
    openPanel: () => void;
    closePanel: () => void;
  };
}

const LeadJobsContext = createContext<LeadJobsValue | null>(null);

export function LeadJobsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { setAmbiguous } = useLeadsState();
  const refreshLeads = useCallback(() => queryClient.invalidateQueries({ queryKey: qk.leads.root }), [queryClient]);

  /* ---- validation ---- */
  const [validatePhase, setValidatePhase] = useState<ValidatePhase>({ kind: "idle" });
  const [validatePanel, setValidatePanel] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const validateJobId = validatePhase.kind === "tracking" ? validatePhase.jobId : null;
  const startingRef = useRef(false);

  const validateQuery = useQuery({
    queryKey: qk.jobs.validate(validateJobId ?? ""),
    queryFn: ({ signal }) => waApi.validateJob(validateJobId!, signal),
    enabled: validateJobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "done" || status === "failed" || status === "paused") return false;
      return POLL_MS;
    },
    // Keep tracking in a background tab, like the old UI.
    refetchIntervalInBackground: true,
    retry: 3,
  });
  const validateJob = validateQuery.data;
  const validateRunning =
    validatePhase.kind === "starting" ||
    (validatePhase.kind === "tracking" && (!validateJob || validateJob.status === "running" || validateJob.status === "queued"));

  // Refresh the grid on every progress step; keep the session's ambiguous set in sync.
  const lastChecked = useRef(-1);
  useEffect(() => {
    if (!validateJob) return;
    setAmbiguous((set) => {
      for (const r of validateJob.results) {
        const outcome = validationOutcome(r);
        if (outcome === "ambiguous") set.add(r.lead_id);
        else if (outcome === "yes" || outcome === "no") set.delete(r.lead_id);
      }
      return set;
    });
    if (validateJob.checked !== lastChecked.current) {
      lastChecked.current = validateJob.checked;
      void refreshLeads();
    }
    if (validateJob.status === "done" && !validatePanel) {
      toast.success(`Validação concluída: ${formatInt(validateJob.is_whatsapp)} com WhatsApp.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react only to new job snapshots
  }, [validateJob]);

  const startValidate = useCallback(
    async (ids: number[], options?: { fresh?: boolean }) => {
      if (startingRef.current) return;
      if (ids.length === 0) {
        toast("Selecione ao menos um lead para validar.");
        return;
      }
      setValidatePanel(true);
      if (validateRunning) return; // just reopen the running job's panel
      // A paused job reopens (Retomar / Nova validação) instead of creating another.
      if (!options?.fresh && validateJob?.status === "paused") {
        setResumeError(null);
        return;
      }
      startingRef.current = true;
      try {
        let instances;
        try {
          instances = await queryClient.fetchQuery({
            queryKey: qk.wa.instances,
            queryFn: () => waApi.instances().then((r) => r.instances),
            staleTime: 0,
          });
        } catch (error) {
          setValidatePhase({ kind: "error", message: errorMessage(error, "Não consegui consultar as contas de WhatsApp.") });
          return;
        }
        const instance = pickConnectedInstance(instances);
        if (!instance) {
          setValidatePhase({ kind: "no-connection", message: "Nenhum WhatsApp conectado. Conecte uma conta antes de validar." });
          return;
        }
        const previous = validatePhase;
        setValidatePhase({ kind: "starting", total: ids.length, instanceName: instance.name || instance.phone || "WhatsApp" });
        try {
          const { job_id } = await waApi.validate(instance.id, ids);
          lastChecked.current = -1;
          setResumeError(null);
          setValidatePhase({ kind: "tracking", jobId: job_id });
        } catch (error) {
          // 409 with job_id = a validation is already running on this account: follow it.
          const body = error instanceof ApiError ? (error.body as { job_id?: string } | null) : null;
          if (error instanceof ApiError && error.status === 409 && body?.job_id) {
            toast(error.message);
            setValidatePhase({ kind: "tracking", jobId: body.job_id });
          } else if (error instanceof ApiError && error.status === 409) {
            setValidatePhase({ kind: "no-connection", message: error.message });
          } else {
            setValidatePhase(previous.kind === "tracking" ? previous : { kind: "error", message: errorMessage(error, "Não foi possível iniciar a validação.") });
            if (previous.kind === "tracking") toast.error(errorMessage(error, "Não foi possível iniciar a validação."));
          }
        }
      } finally {
        startingRef.current = false;
      }
    },
    [queryClient, validateJob?.status, validatePhase, validateRunning],
  );

  const resumeValidate = useCallback(async () => {
    if (!validateJobId || resuming) return;
    setResuming(true);
    setResumeError(null);
    try {
      await waApi.resumeValidate(validateJobId);
      queryClient.setQueryData<ValidateJob>(qk.jobs.validate(validateJobId), (job) => (job ? { ...job, status: "running" } : job));
      void queryClient.invalidateQueries({ queryKey: qk.jobs.validate(validateJobId) });
    } catch (error) {
      setResumeError(errorMessage(error, "Não foi possível retomar a validação."));
    } finally {
      setResuming(false);
    }
  }, [queryClient, resuming, validateJobId]);

  /* ---- enrichment ---- */
  const [enrichJobId, setEnrichJobId] = useState<string | null>(null);
  const [enrichTotal, setEnrichTotal] = useState(0);
  const [enrichPanel, setEnrichPanel] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [enrichStarting, setEnrichStarting] = useState(false);

  const enrichQuery = useQuery({
    queryKey: qk.jobs.progress(enrichJobId ?? ""),
    queryFn: ({ signal }) => jobsApi.progress(enrichJobId!, signal).then((r) => r.job),
    enabled: enrichJobId !== null,
    refetchInterval: (query) => (query.state.data?.status === "running" || !query.state.data ? POLL_MS : false),
    refetchIntervalInBackground: true,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 4,
  });
  const enrichJob = enrichQuery.data;
  const enrichRunning = enrichStarting || (enrichJobId !== null && !enrichQuery.isError && enrichJob?.status !== "completed" && enrichJob?.status !== "failed");

  const lastEnrichSteps = useRef(-1);
  useEffect(() => {
    if (!enrichJob) return;
    if (enrichJob.steps.length !== lastEnrichSteps.current) {
      lastEnrichSteps.current = enrichJob.steps.length;
      void refreshLeads();
    }
    if (enrichJob.status !== "running" && !enrichPanel) {
      if (enrichJob.status === "completed") toast.success("Enriquecimento de e-mails concluído.");
      else toast.error(enrichJob.error || "O enriquecimento de e-mails falhou.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react only to new job snapshots
  }, [enrichJob]);

  useEffect(() => {
    if (!enrichQuery.isError) return;
    const notFound = enrichQuery.error instanceof ApiError && enrichQuery.error.status === 404;
    setEnrichError(
      notFound
        ? "O servidor foi reiniciado e o progresso se perdeu. Os e-mails já encontrados continuam salvos."
        : "Perdi contato com o servidor. Os e-mails já encontrados continuam salvos.",
    );
    void refreshLeads();
  }, [enrichQuery.isError, enrichQuery.error, refreshLeads]);

  const startEnrich = useCallback(
    async (ids: number[]) => {
      if (enrichRunning) {
        setEnrichPanel(true);
        return;
      }
      if (ids.length === 0) {
        toast("Selecione ao menos um lead para enriquecer.");
        return;
      }
      setEnrichStarting(true);
      try {
        const { job_id } = await leadsApi.enrich(ids);
        lastEnrichSteps.current = -1;
        setEnrichError(null);
        setEnrichTotal(ids.length);
        setEnrichJobId(job_id);
        setEnrichPanel(true);
      } catch (error) {
        toast.error(errorMessage(error, "Não foi possível iniciar o enriquecimento."));
      } finally {
        setEnrichStarting(false);
      }
    },
    [enrichRunning],
  );

  const value = useMemo<LeadJobsValue>(
    () => ({
      validate: {
        phase: validatePhase,
        job: validateJob,
        panelOpen: validatePanel,
        running: validateRunning,
        resuming,
        resumeError,
        start: startValidate,
        resume: resumeValidate,
        openPanel: () => setValidatePanel(true),
        closePanel: () => setValidatePanel(false),
      },
      enrich: {
        jobId: enrichJobId,
        job: enrichJob,
        total: enrichTotal,
        error: enrichError,
        panelOpen: enrichPanel,
        running: enrichRunning,
        start: startEnrich,
        openPanel: () => setEnrichPanel(true),
        closePanel: () => setEnrichPanel(false),
      },
    }),
    [validatePhase, validateJob, validatePanel, validateRunning, resuming, resumeError, startValidate, resumeValidate, enrichJobId, enrichJob, enrichTotal, enrichError, enrichPanel, enrichRunning, startEnrich],
  );

  return <LeadJobsContext.Provider value={value}>{children}</LeadJobsContext.Provider>;
}

export function useLeadJobs(): LeadJobsValue {
  const ctx = useContext(LeadJobsContext);
  if (!ctx) throw new Error("useLeadJobs must be used inside <LeadJobsProvider>");
  return ctx;
}
