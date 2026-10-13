// Advanced filters (tags, category, WhatsApp, rating range, presence of
// website / e-mail / phone) + the removable chips row. Edits are staged and applied on
// "Aplicar filtros", like the old UI.
import { FilterIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { TagsMode } from "@/lib/api/types";
import { formatInt, formatRating } from "@/lib/format";
import { activeFilterCount, DEFAULT_FILTERS, type AdvancedFilters, type Presence, type WhatsAppFilter } from "@/lib/lead-filters";
import { useTags } from "@/lib/queries";
import { removeTag, sameTag, tagColorClass } from "@/lib/tags";
import { cn } from "@/lib/utils";

const WA_OPTIONS: Array<[WhatsAppFilter, string]> = [
  ["all", "Todos"],
  ["yes", "Com"],
  ["no", "Sem"],
  ["pending", "Não validado"],
];
const TAGS_MODE_OPTIONS: Array<[TagsMode, string]> = [
  ["any", "Qualquer uma"],
  ["all", "Todas"],
];
const PRESENCE_OPTIONS: Array<[Presence, string]> = [
  ["all", "Todos"],
  ["with", "Com"],
  ["without", "Sem"],
];
const PRESENCE_LABELS: Record<"website" | "email" | "phone", { name: string; with: string; without: string }> = {
  website: { name: "Website", with: "Com website", without: "Sem website" },
  email: { name: "E-mail", with: "Com e-mail", without: "Sem e-mail" },
  phone: { name: "Telefone", with: "Com telefone", without: "Sem telefone" },
};

function Group({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="space-y-2" role="group" aria-labelledby={id}>
      <span id={id} className="text-muted-foreground text-xs font-medium">
        {label}
      </span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<[T, string]>; label: string }) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      aria-label={label}
      className="w-full"
    >
      {options.map(([v, text]) => (
        <ToggleGroupItem key={v} value={v} className="flex-1 text-xs">
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

interface FiltersPopoverProps {
  filters: AdvancedFilters;
  categories: string[];
  categoriesLoading: boolean;
  onApply: (filters: AdvancedFilters) => void;
}

export function FiltersPopover({ filters, categories, categoriesLoading, onApply }: FiltersPopoverProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const count = activeFilterCount(filters);
  const tags = useTags();
  // Existing tags + any selected tag that no longer exists (still removable).
  const tagOptions = [
    ...(tags.data ?? []).map((t) => ({ name: t.name, count: t.lead_count })),
    ...draft.tags.filter((t) => !(tags.data ?? []).some((x) => sameTag(x.name, t))).map((name) => ({ name, count: 0 })),
  ];

  const onOpenChange = (next: boolean) => {
    if (next) setDraft(filters);
    setOpen(next);
  };
  const patch = (value: Partial<AdvancedFilters>) => setDraft((d) => ({ ...d, ...value }));

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label={count ? `Filtros (${count} ativos)` : "Filtros"}>
          <FilterIcon />
          <span className="hidden sm:inline">Filtros</span>
          {count > 0 && (
            <Badge variant="secondary" className="h-4 min-w-4 rounded-full px-1 text-[10px] tabular">
              {count}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="max-h-[min(70vh,34rem)] space-y-4 overflow-y-auto p-4">
          <Group label="Tags" id="flt-tags">
            {tags.isPending ? (
              <p className="text-muted-foreground text-xs">Carregando tags…</p>
            ) : tagOptions.length === 0 ? (
              <p className="text-muted-foreground text-xs">Nenhuma tag ainda. Selecione leads e use “Tags” para criar.</p>
            ) : (
              <>
                <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                  {tagOptions.map((tag) => {
                    const on = draft.tags.some((t) => sameTag(t, tag.name));
                    return (
                      <button
                        key={tag.name}
                        type="button"
                        aria-pressed={on}
                        onClick={() => patch({ tags: on ? removeTag(draft.tags, tag.name) : [...draft.tags, tag.name] })}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                          on ? cn(tagColorClass(tag.name), "ring-1 ring-current/30") : "hover:bg-accent",
                        )}
                      >
                        {tag.name}
                        <span className={cn("tabular", on ? "opacity-80" : "text-muted-foreground")}>{formatInt(tag.count)}</span>
                      </button>
                    );
                  })}
                </div>
                {draft.tags.length > 1 && (
                  <Segmented label="Combinar tags" value={draft.tagsMode} onChange={(tagsMode) => patch({ tagsMode })} options={TAGS_MODE_OPTIONS} />
                )}
              </>
            )}
          </Group>

          <Group label="Categoria" id="flt-cat">
            {categoriesLoading ? (
              <p className="text-muted-foreground text-xs">Carregando categorias…</p>
            ) : categories.length === 0 ? (
              <p className="text-muted-foreground text-xs">Sem categorias ainda.</p>
            ) : (
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                {categories.map((cat) => {
                  const on = draft.categories.includes(cat);
                  return (
                    <button
                      key={cat}
                      type="button"
                      aria-pressed={on}
                      onClick={() => patch({ categories: on ? draft.categories.filter((c) => c !== cat) : [...draft.categories, cat] })}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                        on ? "border-brand/40 bg-brand/10 text-brand" : "hover:bg-accent",
                      )}
                    >
                      {cat}
                    </button>
                  );
                })}
              </div>
            )}
          </Group>

          <Group label="Status no WhatsApp" id="flt-wa">
            <Segmented label="Status no WhatsApp" value={draft.whatsapp} onChange={(whatsapp) => patch({ whatsapp })} options={WA_OPTIONS} />
          </Group>

          <Group label={`Avaliação: ${formatRating(draft.minRating)} a ${formatRating(draft.maxRating)}`} id="flt-rating">
            <Slider
              min={0}
              max={5}
              step={0.5}
              value={[draft.minRating, draft.maxRating]}
              onValueChange={(v) => patch({ minRating: v[0] ?? 0, maxRating: v[1] ?? 5 })}
              minStepsBetweenThumbs={0}
              thumbLabels={["Avaliação mínima", "Avaliação máxima"]}
              className="py-1"
            />
          </Group>

          {(Object.keys(PRESENCE_LABELS) as Array<keyof typeof PRESENCE_LABELS>).map((field) => (
            <Group key={field} label={PRESENCE_LABELS[field].name} id={`flt-${field}`}>
              <Segmented label={PRESENCE_LABELS[field].name} value={draft[field]} onChange={(v) => patch({ [field]: v })} options={PRESENCE_OPTIONS} />
            </Group>
          ))}
        </div>
        <Separator />
        <div className="flex justify-end gap-2 p-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onApply(DEFAULT_FILTERS);
              setOpen(false);
            }}
          >
            Limpar
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onApply(draft);
              setOpen(false);
            }}
          >
            Aplicar filtros
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface Chip {
  key: string;
  label: string;
  remove: (f: AdvancedFilters) => AdvancedFilters;
}

export function filterChips(f: AdvancedFilters): Chip[] {
  const chips: Chip[] = f.tags.map((tag) => ({
    key: `tag:${tag}`,
    label: f.tags.length > 1 && f.tagsMode === "all" ? `Tag: ${tag} (todas)` : `Tag: ${tag}`,
    remove: (x) => ({ ...x, tags: removeTag(x.tags, tag) }),
  }));
  chips.push(...f.categories.map((cat) => ({
    key: `cat:${cat}`,
    label: cat,
    remove: (x: AdvancedFilters) => ({ ...x, categories: x.categories.filter((c) => c !== cat) }),
  })));
  if (f.whatsapp !== "all") {
    const label = { yes: "No WhatsApp", no: "Sem WhatsApp", pending: "WhatsApp não validado" }[f.whatsapp];
    chips.push({ key: "wa", label, remove: (x) => ({ ...x, whatsapp: "all" }) });
  }
  if (f.minRating > 0) chips.push({ key: "min", label: `Avaliação ≥ ${formatRating(f.minRating)}`, remove: (x) => ({ ...x, minRating: 0 }) });
  if (f.maxRating < 5) chips.push({ key: "max", label: `Avaliação ≤ ${formatRating(f.maxRating)}`, remove: (x) => ({ ...x, maxRating: 5 }) });
  for (const field of ["website", "email", "phone"] as const) {
    const value = f[field];
    if (value !== "all") chips.push({ key: field, label: PRESENCE_LABELS[field][value], remove: (x) => ({ ...x, [field]: "all" }) });
  }
  return chips;
}

/** Chip of a filter kept outside AdvancedFilters (e.g. "Busca: dentistas em Campinas-SP"). */
export interface ExtraChip {
  key: string;
  label: string;
  onRemove: () => void;
}

export function FilterChips({ filters, onChange, onClearAll, extra = [] }: { filters: AdvancedFilters; onChange: (f: AdvancedFilters) => void; onClearAll: () => void; extra?: ExtraChip[] }) {
  const chips = [
    ...extra.map((chip) => ({ key: chip.key, label: chip.label, onRemove: chip.onRemove })),
    ...filterChips(filters).map((chip) => ({ key: chip.key, label: chip.label, onRemove: () => onChange(chip.remove(filters)) })),
  ];
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <span key={chip.key} className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border bg-muted/60 pr-1 pl-2.5 text-xs">
          <span className="truncate">{chip.label}</span>
          <button
            type="button"
            onClick={chip.onRemove}
            className="hover:bg-accent rounded-full p-0.5 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            aria-label={`Remover filtro ${chip.label}`}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      <Button variant="link" size="xs" className="text-muted-foreground h-6" onClick={onClearAll}>
        Limpar tudo
      </Button>
    </div>
  );
}
