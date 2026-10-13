import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SettingsCard({
  id,
  icon: Icon,
  title,
  description,
  aside,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 rounded-xl border bg-card shadow-xs">
      <header className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="flex gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
            <Icon className="size-4" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h2 id={`${id}-title`} className="text-sm font-semibold">
              {title}
            </h2>
            <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">{description}</p>
          </div>
        </div>
        {aside && <div className="shrink-0 sm:pt-1">{aside}</div>}
      </header>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

/** ok: true = success, false = error, null = neutral/in progress. */
export type Result = { ok: boolean | null; text: string } | null;

export function FormResult({ result, className }: { result: Result; className?: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "text-sm",
        result?.ok === true && "text-success",
        result?.ok === false && "text-destructive",
        result?.ok === null && "text-muted-foreground",
        className,
      )}
    >
      {result?.text}
    </p>
  );
}
