// Job progress steps (prospect, enrich): done ✓, current spinner, failed ✕.
import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import type { JobStep } from "@/lib/api/types";
import { cn } from "@/lib/utils";

interface StepListProps {
  steps: JobStep[];
  running: boolean;
  failed?: boolean;
  /** Show only the last N steps. */
  limit?: number;
  className?: string;
}

export function StepList({ steps, running, failed = false, limit = 6, className }: StepListProps) {
  const shown = steps.slice(-limit);
  if (shown.length === 0) return null;
  return (
    <ol className={cn("space-y-1.5 text-sm", className)}>
      {shown.map((step, index) => {
        const last = index === shown.length - 1;
        const state = last && running ? "active" : last && failed ? "error" : "done";
        return (
          <li
            key={`${step.at}-${index}`}
            className={cn(
              "flex items-start gap-2 leading-5",
              state === "done" && "text-muted-foreground",
              state === "error" && "text-destructive",
            )}
            aria-current={state === "active" ? "step" : undefined}
          >
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
              {state === "active" ? (
                <Loader2Icon className="size-3.5 animate-spin text-brand" />
              ) : state === "error" ? (
                <XIcon className="size-3.5" />
              ) : (
                <CheckIcon className="size-3.5 text-success" />
              )}
            </span>
            <span className="tabular">{step.message}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** "N/M" in the latest step message → progress fraction (prospect pagination, enrichment). */
export function progressFromSteps(steps: JobStep[]): { done: number; target: number } | null {
  const last = steps.at(-1)?.message ?? "";
  const match = last.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  const done = Number(match[1]);
  const target = Number(match[2]);
  return target > 0 ? { done: Math.min(done, target), target } : null;
}
