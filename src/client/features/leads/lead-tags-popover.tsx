// "Tags" action of the selection bar: add tags to, or remove tags from, every
// selected lead (all pages) via POST /api/leads/tags.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, TagIcon } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { TagInput } from "@/components/common/tag-input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { errorMessage } from "@/lib/api/client";
import { leadsApi } from "@/lib/api/endpoints";
import { plural } from "@/lib/format";
import { qk, useAllLeads } from "@/lib/queries";
import { tagSlug, type TagOption } from "@/lib/tags";

type Mode = "add" | "remove";

/** Tags present on the given leads, with how many of them carry each one. */
export function tagCountsOf(leads: ReadonlyArray<{ tags?: string[] }>): TagOption[] {
  const counts = new Map<string, TagOption>();
  for (const lead of leads) {
    for (const tag of lead.tags ?? []) {
      const slug = tagSlug(tag);
      const entry = counts.get(slug);
      if (entry) entry.count = (entry.count ?? 0) + 1;
      else counts.set(slug, { name: tag, count: 1 });
    }
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, "pt-BR")).map(([, option]) => option);
}

export function LeadTagsPopover({ ids }: { ids: number[] }) {
  const queryClient = useQueryClient();
  const all = useAllLeads();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("add");
  const [tags, setTags] = useState<string[]>([]);
  const count = ids.length;

  const present = useMemo(() => {
    const chosen = new Set(ids);
    return tagCountsOf((all.data?.leads ?? []).filter((l) => chosen.has(l.id)));
  }, [all.data, ids]);

  const update = useMutation({
    mutationFn: (input: { mode: Mode; tags: string[] }) =>
      leadsApi.updateTags({ lead_ids: ids, ...(input.mode === "add" ? { add: input.tags } : { remove: input.tags }) }),
    onSuccess: ({ updated }, input) => {
      setOpen(false);
      const what = plural(input.tags.length, "tag", "tags");
      if (updated === 0) toast(input.mode === "add" ? "Nada mudou: os leads já tinham essas tags." : "Nada mudou: os leads não tinham essas tags.");
      else if (input.mode === "add") toast.success(`${what} ${input.tags.length === 1 ? "adicionada" : "adicionadas"} a ${plural(updated, "lead", "leads")}`);
      else toast.success(`${what} ${input.tags.length === 1 ? "removida" : "removidas"} de ${plural(updated, "lead", "leads")}`);
    },
    onError: (error) => toast.error(errorMessage(error, "Não foi possível atualizar as tags. Tente de novo.")),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.leads.root }),
  });

  const onOpenChange = (value: boolean) => {
    if (value) {
      setMode("add");
      setTags([]);
    }
    setOpen(value);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (tags.length === 0 || update.isPending) return;
    update.mutate({ mode, tags });
  };

  const inputId = "selection-tags-input";
  const helpId = `${inputId}-help`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" aria-label="Tags da seleção">
          <TagIcon />
          <span className="hidden sm:inline">Tags</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-[min(22rem,calc(100vw-2rem))]">
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={mode}
            onValueChange={(v) => {
              if (!v) return;
              setMode(v as Mode);
              setTags([]);
            }}
            aria-label="Adicionar ou remover tags"
            className="w-full"
          >
            <ToggleGroupItem value="add" className="flex-1 text-xs">
              Adicionar
            </ToggleGroupItem>
            <ToggleGroupItem value="remove" className="flex-1 text-xs">
              Remover
            </ToggleGroupItem>
          </ToggleGroup>

          <div className="space-y-1.5">
            <label htmlFor={inputId} className="text-sm font-medium">
              {mode === "add" ? "Tags para adicionar" : "Tags para remover"}
            </label>
            {mode === "remove" && present.length === 0 && !all.isPending ? (
              <p id={helpId} className="text-muted-foreground text-xs">
                Os leads selecionados não têm tags.
              </p>
            ) : (
              <>
                <TagInput
                  key={mode}
                  id={inputId}
                  value={tags}
                  onChange={setTags}
                  suggestions={mode === "remove" ? present : undefined}
                  allowCreate={mode === "add"}
                  placeholder={mode === "add" ? "Digite e tecle Enter…" : "Escolha as tags…"}
                  aria-describedby={helpId}
                  autoFocus
                />
                <p id={helpId} className="text-muted-foreground text-xs">
                  {mode === "add"
                    ? "Enter adiciona; tags que ainda não existem são criadas."
                    : "Só as tags presentes na seleção; o número indica quantos leads selecionados as têm."}
                </p>
              </>
            )}
          </div>

          <Button type="submit" size="sm" className="w-full" disabled={tags.length === 0 || update.isPending}>
            {update.isPending && <Loader2Icon className="animate-spin" />}
            {mode === "add" ? `Adicionar a ${plural(count, "lead", "leads")}` : `Remover de ${plural(count, "lead", "leads")}`}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
