// Progress of a prospect job started by the AI tool `start_prospect_search`:
// polls GET /api/progress/:job and renders the classic chat's JobCard. Leads
// are refreshed while pages arrive and once more at the end.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { JobCard } from "@/features/assistant/classic-prospect-chat";
import { summarizeResult } from "@/features/assistant/prospect-chat-state";
import { ApiError } from "@/lib/api/client";
import { jobsApi } from "@/lib/api/endpoints";
import { qk } from "@/lib/queries";

const POLL_MS = 900;

export function AiJobProgress({ jobId, alreadyRunning }: { jobId: string; alreadyRunning: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.jobs.progress(jobId),
    queryFn: ({ signal }) => jobsApi.progress(jobId, signal).then((r) => r.job),
    refetchInterval: (q) => (q.state.data?.status === "running" || (!q.state.data && !q.state.error) ? POLL_MS : false),
    refetchIntervalInBackground: true,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 3,
    staleTime: 0,
  });

  const job = query.data;
  const steps = job?.steps.length ?? 0;
  const lastSteps = useRef(-1);
  useEffect(() => {
    if (!job) return;
    if (steps !== lastSteps.current) {
      const first = lastSteps.current === -1;
      lastSteps.current = steps;
      // Opening an old conversation (job already done) must not refresh the table.
      if (!(first && job.status !== "running")) void queryClient.invalidateQueries({ queryKey: qk.leads.root });
    }
  }, [job, steps, queryClient]);

  if (query.error) {
    const gone = query.error instanceof ApiError && query.error.status === 404;
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-xs">
        {gone
          ? "O progresso desta busca não está mais disponível (o servidor foi reiniciado ou a busca é antiga). Os leads salvos estão na tabela."
          : "Não consegui acompanhar o progresso desta busca agora."}
      </p>
    );
  }

  return (
    <div className="space-y-2" aria-live="polite">
      {alreadyRunning && (
        <p className="text-muted-foreground text-xs">Essa pesquisa já tinha uma busca em andamento; acompanhando a existente.</p>
      )}
      <JobCard
        item={{
          id: jobId,
          kind: "job",
          jobId,
          at: 0,
          job: job ?? { status: "running", steps: [], result: null, error: null },
        }}
      />
      {job?.status === "completed" && <p className="text-muted-foreground text-xs">{summarizeResult(job.result)}</p>}
      {job?.status === "failed" && job.error && <p className="text-destructive text-xs">{job.error}</p>}
    </div>
  );
}
