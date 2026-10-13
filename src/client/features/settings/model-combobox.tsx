// Free-text model id with suggestions from GET /api/ai/models?kind=.
// Any id is accepted; suggestions are a static, curated list.
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ProviderKind } from "@/lib/api/types";
import { useModelSuggestions } from "@/lib/queries";
import { cn } from "@/lib/utils";

interface ModelComboboxProps {
  id: string;
  kind: ProviderKind;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  describedBy?: string;
}

export function ModelCombobox({ id, kind, value, onChange, invalid, describedBy }: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const suggestions = useModelSuggestions(kind);
  const models = suggestions.data ?? [];
  const typed = search.trim();
  const showCustom = typed && !models.some((m) => m.id === typed);
  const selectedLabel = models.find((m) => m.id === value)?.label;

  const pick = (model: string) => {
    onChange(model);
    setSearch("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className="w-full justify-between font-normal"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value ? (
              <>
                <span className="font-mono text-xs">{value}</span>
                {selectedLabel && <span className="text-muted-foreground ml-2 text-xs">{selectedLabel}</span>}
              </>
            ) : (
              "Escolha ou digite um modelo"
            )}
          </span>
          <ChevronsUpDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder="Buscar ou digitar o id do modelo…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{suggestions.isPending ? "Carregando sugestões…" : "Nenhuma sugestão. Digite o id do modelo."}</CommandEmpty>
            {showCustom && (
              <CommandGroup heading="Usar este id">
                <CommandItem value={`custom:${typed}`} onSelect={() => pick(typed)}>
                  <span className="font-mono text-xs">{typed}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {models.length > 0 && (
              <CommandGroup heading="Sugestões">
                {models.map((m) => (
                  <CommandItem key={m.id} value={`${m.id} ${m.label}`} onSelect={() => pick(m.id)}>
                    <CheckIcon className={cn("size-4", value === m.id ? "opacity-100" : "opacity-0")} />
                    <span className="font-mono text-xs">{m.id}</span>
                    <span className="text-muted-foreground ml-auto truncate text-xs">{m.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
