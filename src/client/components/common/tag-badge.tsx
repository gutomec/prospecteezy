// Tag pill (color derived from the slug, see lib/tags.ts) and a compact list
// that shows the first N tags plus "+M" with the rest in a tooltip.
import { XIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { tagColorClass } from "@/lib/tags";
import { cn } from "@/lib/utils";

export function TagBadge({ name, onRemove, className }: { name: string; onRemove?: () => void; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-40 shrink-0 items-center gap-0.5 rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        onRemove && "pr-0.5",
        tagColorClass(name),
        className,
      )}
      title={name}
    >
      <span className="truncate">{name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="rounded-full p-0.5 opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          aria-label={`Remover tag ${name}`}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </span>
  );
}

/**
 * First `max` tags, then "+N" (tooltip lists the hidden ones). Renders nothing
 * for no tags. `interactive={false}` (inside a button): "+N" is plain text.
 */
export function TagList({
  tags,
  max = 2,
  interactive = true,
  className,
  badgeClassName,
}: {
  tags: readonly string[];
  max?: number;
  interactive?: boolean;
  className?: string;
  badgeClassName?: string;
}) {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const hidden = tags.slice(max);
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      <span className="sr-only">Tags:</span>
      {shown.map((tag) => (
        <TagBadge key={tag} name={tag} className={badgeClassName} />
      ))}
      {hidden.length > 0 && !interactive && (
        <>
          <span className="text-muted-foreground text-xs tabular" aria-hidden="true">
            +{hidden.length}
          </span>
          <span className="sr-only">{hidden.join(", ")}</span>
        </>
      )}
      {hidden.length > 0 && interactive && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="inline-flex h-5 cursor-default items-center rounded-full border bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              aria-label={`Mais ${hidden.length} ${hidden.length === 1 ? "tag" : "tags"}: ${hidden.join(", ")}`}
            >
              +{hidden.length}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{hidden.join(", ")}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
