import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-14 text-center", className)}>
      <div className="flex size-11 items-center justify-center rounded-xl border bg-muted/50 text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="max-w-sm space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>}
      </div>
      {action}
    </div>
  );
}
