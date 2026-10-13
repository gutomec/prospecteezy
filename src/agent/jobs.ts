import { nowIso } from "../db/index.ts";

export type JobStatus = "running" | "completed" | "failed";

export interface JobStep {
  at: string;
  message: string; // PT-BR, shown in the chat UI
}

export interface Job {
  id: string;
  status: JobStatus;
  search_id: number | null;
  steps: JobStep[];
  result: {
    collected_new: number;
    duplicates_skipped: number;
    pages_consumed: number;
    enriched: number;
    exhausted: boolean;
  } | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const jobs = new Map<string, Job>();

/** Finished jobs are kept for polling this long, then evicted. */
export const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;

/** Drops finished jobs older than the TTL; running jobs are always kept. */
export function pruneJobs(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.status !== "running" && now - Date.parse(job.updated_at) > FINISHED_JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

export function createJob(): Job {
  pruneJobs();
  const job: Job = {
    id: crypto.randomUUID(),
    status: "running",
    search_id: null,
    steps: [],
    result: null,
    error: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | null {
  return jobs.get(id) ?? null;
}

/** The running job collecting for this search, if any (one at a time per search). */
export function getRunningJobForSearch(searchId: number): Job | null {
  for (const job of jobs.values()) {
    if (job.status === "running" && job.search_id === searchId) return job;
  }
  return null;
}

export function addStep(job: Job, message: string): void {
  job.steps.push({ at: nowIso(), message });
  job.updated_at = nowIso();
}

export function completeJob(job: Job, result: NonNullable<Job["result"]>): void {
  job.status = "completed";
  job.result = result;
  job.updated_at = nowIso();
}

export function failJob(job: Job, error: string): void {
  job.status = "failed";
  job.error = error;
  job.updated_at = nowIso();
}

/** Test-only helper: clears the in-memory registry. */
export function resetJobs(): void {
  jobs.clear();
}
