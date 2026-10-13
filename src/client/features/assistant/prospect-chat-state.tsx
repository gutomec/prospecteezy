// State + side effects of the classic (rule-based) prospect chat:
// POST /api/prospect → poll GET /api/progress/:job until completed/failed.
// Lives at app level so history and a running job survive closing the panel
// or switching views.
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, errorMessage } from "@/lib/api/client";
import { jobsApi } from "@/lib/api/endpoints";
import type { Job, JobResult } from "@/lib/api/types";
import { formatInt } from "@/lib/format";
import { qk } from "@/lib/queries";

const POLL_INTERVAL_MS = 900;
const MAX_POLL_FAILURES = 5;
const LEADS_REFRESH_COALESCE_MS = 1200;

export type ChatItem =
  | { id: string; kind: "user" | "agent" | "error"; text: string; at: number; action?: "open-settings" }
  | { id: string; kind: "job"; jobId: string; job: Pick<Job, "status" | "steps" | "result" | "error">; at: number };

interface ProspectChatValue {
  items: ChatItem[];
  busy: boolean;
  /** True once a search finished successfully (enables "mais N" shortcuts). */
  canContinue: boolean;
  /** `tags` (optional) go on the resolved search and its leads. */
  submit: (text: string, tags?: string[]) => Promise<void>;
  /** Track a job started elsewhere (phase 3: an AI tool that starts a prospect search). */
  trackJob: (jobId: string) => void;
}

const ProspectChatContext = createContext<ProspectChatValue | null>(null);

let sequence = 0;
const nextId = () => `m${Date.now().toString(36)}${(sequence++).toString(36)}`;

export const GREETING =
  "Olá! Eu busco, salvo e organizo leads para você. Experimente: “Busque os 100 principais escritórios de advocacia de São Paulo-SP”. Depois peça “mais 100” que eu continuo de onde parei, sem duplicar.";

export function summarizeResult(result: JobResult | null): string {
  const r = result ?? { collected_new: 0, duplicates_skipped: 0, pages_consumed: 0, enriched: 0, exhausted: false };
  let text =
    `Prontinho: ${formatInt(r.collected_new)} leads novos salvos (${formatInt(r.pages_consumed)} páginas consultadas, ` +
    `${formatInt(r.duplicates_skipped)} duplicados ignorados, ${formatInt(r.enriched)} enriquecidos com dados do site).`;
  if (r.exhausted) text += " A fonte esgotou os resultados disponíveis para esta pesquisa.";
  return text;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function ProspectChatProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<ChatItem[]>(() => [{ id: nextId(), kind: "agent", text: GREETING, at: Date.now() }]);
  const [busy, setBusy] = useState(false);
  const [canContinue, setCanContinue] = useState(false);
  const busyRef = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const push = useCallback((item: Omit<Extract<ChatItem, { kind: "user" | "agent" | "error" }>, "id" | "at">) => {
    setItems((list) => [...list, { ...item, id: nextId(), at: Date.now() }]);
  }, []);

  /** Coalesced leads refresh (at most once per 1.2 s while a job saves leads). */
  const refreshLeads = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void queryClient.invalidateQueries({ queryKey: qk.leads.root });
    }, LEADS_REFRESH_COALESCE_MS);
  }, [queryClient]);

  const pollJob = useCallback(
    async (jobId: string, itemId: string) => {
      const update = (job: Pick<Job, "status" | "steps" | "result" | "error">) =>
        setItems((list) => list.map((item) => (item.id === itemId && item.kind === "job" ? { ...item, job } : item)));
      let lastSteps = -1;
      let failures = 0;
      while (mounted.current) {
        await sleep(failures === 0 ? POLL_INTERVAL_MS : POLL_INTERVAL_MS * 2 ** failures);
        let job: Job;
        try {
          ({ job } = await jobsApi.progress(jobId));
          failures = 0;
        } catch (error) {
          const notFound = error instanceof ApiError && error.status === 404;
          failures += 1;
          if (!notFound && failures < MAX_POLL_FAILURES) continue;
          update({ status: "failed", steps: [], result: null, error: null });
          push({
            kind: "error",
            text: notFound
              ? "O servidor foi reiniciado e o progresso deste job se perdeu. Os leads já salvos continuam no banco."
              : "Perdi a conexão com o servidor durante a busca. Os leads já salvos continuam no banco.",
          });
          return;
        }
        update(job);
        if (job.steps.length !== lastSteps) {
          lastSteps = job.steps.length;
          refreshLeads();
        }
        if (job.status === "completed") {
          push({ kind: "agent", text: summarizeResult(job.result) });
          setCanContinue(true);
          void queryClient.invalidateQueries({ queryKey: qk.leads.root });
          return;
        }
        if (job.status === "failed") {
          push({ kind: "error", text: job.error ?? "A busca falhou por um motivo desconhecido." });
          void queryClient.invalidateQueries({ queryKey: qk.leads.root });
          return;
        }
      }
    },
    [push, queryClient, refreshLeads],
  );

  const startTracking = useCallback(
    async (jobId: string, initialSteps: Job["steps"]) => {
      const itemId = nextId();
      setItems((list) => [
        ...list,
        { id: itemId, kind: "job", jobId, at: Date.now(), job: { status: "running", steps: initialSteps, result: null, error: null } },
      ]);
      await pollJob(jobId, itemId);
    },
    [pollJob],
  );

  const setBusyBoth = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  };

  const submit = useCallback(
    async (raw: string, tags: string[] = []) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;
      setBusyBoth(true);
      push({ kind: "user", text: tags.length ? `${text}\nTags: ${tags.join(", ")}` : text });
      try {
        const started = await jobsApi.prospect(text, tags);
        if (started.already_running) {
          push({
            kind: "agent",
            text: "Essa pesquisa já tem uma busca em andamento. Vou acompanhar a busca existente; repita o pedido quando ela terminar.",
          });
        }
        await startTracking(started.job_id, started.steps ?? []);
      } catch (error) {
        push({ kind: "error", text: errorMessage(error, "Algo deu errado ao enviar o pedido. Tente de novo.") });
        if (error instanceof ApiError && error.status === 503) {
          push({
            kind: "agent",
            text: "Para eu conseguir buscar, configure a chave do Serper em Configurações (ou SERPER_API_KEY no arquivo .env). Enquanto isso, seus leads já salvos continuam disponíveis na tabela.",
            action: "open-settings",
          });
        }
      } finally {
        if (mounted.current) setBusyBoth(false);
      }
    },
    [push, startTracking],
  );

  const trackJob = useCallback((jobId: string) => void startTracking(jobId, []), [startTracking]);

  const value = useMemo(() => ({ items, busy, canContinue, submit, trackJob }), [items, busy, canContinue, submit, trackJob]);
  return <ProspectChatContext.Provider value={value}>{children}</ProspectChatContext.Provider>;
}

export function useProspectChat(): ProspectChatValue {
  const ctx = useContext(ProspectChatContext);
  if (!ctx) throw new Error("useProspectChat must be used inside <ProspectChatProvider>");
  return ctx;
}
