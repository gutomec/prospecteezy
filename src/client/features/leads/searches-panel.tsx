// "Buscas" panel of the Leads view: search history with live status and, per
// search, "Ver leads" (search_id filter), "Buscar mais" (POST
// /api/searches/:id/more), "Outra cidade" (POST /api/searches) and its tags
// (PUT /api/searches/:id/tags; inherited by the leads it collects). Plain REST,
// works with or without AI. Job progress reuses the chat's JobCard inline.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, EyeIcon, Loader2Icon, MapPinnedIcon, PlusIcon, SettingsIcon, TagIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { navigate } from "@/app/router";
import { StatusBadge } from "@/components/common/status-badge";
import { TagList } from "@/components/common/tag-badge";
import { TagInput } from "@/components/common/tag-input";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AiJobProgress } from "@/features/ai/job-progress";
import { ApiError, errorMessage } from "@/lib/api/client";
import { searchesApi } from "@/lib/api/endpoints";
import type { ProspectStarted, Search } from "@/lib/api/types";
import { formatDateTime, formatInt, plural } from "@/lib/format";
import { qk, useSearches } from "@/lib/queries";
import {
  formatRelativeTime,
  isExhaustedError,
  parseSearchCount,
  SEARCH_COUNT_DEFAULT,
  SEARCH_COUNT_MIN,
  SEARCH_STATUS,
  searchLabel,
  searchLastUsed,
  sortSearches,
} from "@/lib/searches";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/routes";
import { useLeadsState } from "./leads-state";

const OPEN_KEY = "prospecteezy-searches-open";
const EXHAUSTED_TEXT = "Esta busca já esgotou os resultados do Google Maps nas últimas 24 horas. Tente outro termo ou outra cidade.";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

interface TrackedJob {
  jobId: string;
  alreadyRunning: boolean;
}

export function SearchesPanel() {
  const searches = useSearches();
  const state = useLeadsState();
  const queryClient = useQueryClient();
  const [open, setOpenState] = useState(readOpen);
  // Jobs started from this panel (search id → job), kept after they finish
  // until dismissed; jobs started elsewhere show while running_job_id is set.
  const [tracked, setTracked] = useState<Record<number, TrackedJob>>({});
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [otherCityFor, setOtherCityFor] = useState<Search | null>(null);

  const list = useMemo(() => sortSearches(searches.data ?? []), [searches.data]);
  const runningCount = list.filter((s) => s.status === "running").length;

  const setOpen = (value: boolean) => {
    setOpenState(value);
    try {
      localStorage.setItem(OPEN_KEY, value ? "1" : "0");
    } catch {
      /* storage blocked */
    }
  };

  const onStarted = (started: ProspectStarted) => {
    setTracked((t) => ({ ...t, [started.search_id]: { jobId: started.job_id, alreadyRunning: started.already_running } }));
    setHidden((h) => {
      if (!h.has(started.job_id)) return h;
      const next = new Set(h);
      next.delete(started.job_id);
      return next;
    });
    setOpen(true);
    void queryClient.invalidateQueries({ queryKey: qk.searches });
  };

  const viewLeads = (search: Search) => {
    if (state.searchFilter?.id === search.id) {
      state.setSearchFilter(null);
      return;
    }
    state.setSearchFilter({ id: search.id, label: searchLabel(search) });
    const table = document.getElementById("leads-table");
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    table?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  };

  return (
    <section className="rounded-xl border bg-card shadow-xs" aria-labelledby="searches-heading">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className={cn("flex items-center gap-2 px-3 py-2", open && "border-b")}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="hover:bg-accent -mx-1 flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <ChevronDownIcon className={cn("text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none", !open && "-rotate-90")} aria-hidden="true" />
              <h2 id="searches-heading" className="text-sm font-semibold">
                Buscas
              </h2>
              {searches.data && <span className="text-muted-foreground text-xs tabular">{formatInt(list.length)}</span>}
            </button>
          </CollapsibleTrigger>
          {runningCount > 0 && (
            <span className="text-brand flex items-center gap-1.5 text-xs font-medium" role="status">
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              {runningCount === 1 ? "1 em andamento" : `${formatInt(runningCount)} em andamento`}
            </span>
          )}
        </div>

        <CollapsibleContent>
          {searches.isPending ? (
            <ul className="divide-y" aria-label="Carregando buscas">
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                  <Skeleton className="h-5 w-20 rounded-full" />
                </li>
              ))}
            </ul>
          ) : searches.error && !searches.data ? (
            <div className="flex flex-wrap items-center gap-2 px-3 py-3 text-sm">
              <TriangleAlertIcon className="text-destructive size-4" aria-hidden="true" />
              <span className="text-muted-foreground">{errorMessage(searches.error, "Não deu para carregar as buscas.")}</span>
              <Button variant="outline" size="xs" onClick={() => void searches.refetch()}>
                Tentar de novo
              </Button>
            </div>
          ) : list.length === 0 ? (
            <p className="text-muted-foreground px-3 py-3 text-sm">Nenhuma busca ainda. Use “Nova busca” para começar.</p>
          ) : (
            <ul className="max-h-[26rem] divide-y overflow-y-auto" aria-label="Histórico de buscas">
              {list.map((search) => {
                const own = tracked[search.id];
                const job = own ?? (search.running_job_id ? { jobId: search.running_job_id, alreadyRunning: false } : null);
                return (
                  <SearchRow
                    key={search.id}
                    search={search}
                    filtered={state.searchFilter?.id === search.id}
                    onViewLeads={() => viewLeads(search)}
                    onStarted={onStarted}
                    onOtherCity={() => setOtherCityFor(search)}
                    job={job && !hidden.has(job.jobId) ? job : null}
                    onHideJob={(jobId) => setHidden((h) => new Set(h).add(jobId))}
                  />
                );
              })}
            </ul>
          )}
        </CollapsibleContent>
      </Collapsible>

      <OtherCityDialog search={otherCityFor} onOpenChange={(value) => !value && setOtherCityFor(null)} onStarted={onStarted} />
    </section>
  );
}

interface SearchRowProps {
  search: Search;
  filtered: boolean;
  onViewLeads: () => void;
  onStarted: (started: ProspectStarted) => void;
  onOtherCity: () => void;
  job: TrackedJob | null;
  onHideJob: (jobId: string) => void;
}

function SearchRow({ search, filtered, onViewLeads, onStarted, onOtherCity, job, onHideJob }: SearchRowProps) {
  const status = SEARCH_STATUS[search.status];
  const lastUsed = searchLastUsed(search);
  const badge = (
    <StatusBadge tone={status.tone} dot={search.status !== "running"} className={cn(status.hint && "cursor-help")}>
      {search.status === "running" && <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />}
      {status.label}
    </StatusBadge>
  );

  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium" title={searchLabel(search)}>
              {search.niche}
            </p>
            {status.hint ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="rounded-full focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none" aria-label={`${status.label}: ${status.hint}`}>
                    {badge}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{status.hint}</TooltipContent>
              </Tooltip>
            ) : (
              badge
            )}
          </div>
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs tabular">
            <span className="inline-flex items-center gap-1">
              <MapPinnedIcon className="size-3" aria-hidden="true" />
              {search.city}
            </span>
            <span aria-hidden="true">·</span>
            <span>{plural(search.lead_count, "lead", "leads")}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={lastUsed} title={formatDateTime(lastUsed)}>
              {formatRelativeTime(lastUsed)}
            </time>
          </p>
          {search.tags.length > 0 && <TagList tags={search.tags} max={4} className="mt-1" />}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant={filtered ? "secondary" : "ghost"} size="xs" aria-pressed={filtered} onClick={onViewLeads}>
            <EyeIcon /> {filtered ? "Vendo leads" : "Ver leads"}
          </Button>
          <SearchTagsButton search={search} />
          <MoreButton search={search} onStarted={onStarted} onOtherCity={onOtherCity} />
          <Button variant="outline" size="xs" onClick={onOtherCity}>
            <MapPinnedIcon /> Outra cidade
          </Button>
        </div>
      </div>
      {job && (
        <div className="relative mt-2">
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute top-2 right-2 z-10"
            aria-label={`Ocultar progresso: ${searchLabel(search)}`}
            onClick={() => onHideJob(job.jobId)}
          >
            <XIcon />
          </Button>
          <AiJobProgress jobId={job.jobId} alreadyRunning={job.alreadyRunning} />
        </div>
      )}
    </li>
  );
}

function ExhaustedNotice({ onOtherCity }: { onOtherCity: () => void }) {
  return (
    <div className="space-y-2" role="status">
      <p className="text-sm">{EXHAUSTED_TEXT}</p>
      <Button size="sm" className="w-full" onClick={onOtherCity}>
        <MapPinnedIcon /> Outra cidade
      </Button>
    </div>
  );
}

function MoreButton({ search, onStarted, onOtherCity }: { search: Search; onStarted: (started: ProspectStarted) => void; onOtherCity: () => void }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(String(SEARCH_COUNT_DEFAULT));
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const running = search.status === "running";
  const inputId = `more-count-${search.id}`;

  const more = useMutation({
    mutationFn: (value: number) => searchesApi.more(search.id, value, tags),
    onSuccess: (started) => {
      setOpen(false);
      if (started.already_running) toast("Essa busca já estava em andamento; acompanhando a existente.");
      onStarted(started);
    },
    onError: (e) => {
      if (isExhaustedError(e)) setExhausted(true);
      else setError(errorMessage(e, "Não consegui iniciar a busca."));
    },
  });

  const onOpenChange = (value: boolean) => {
    if (value) {
      setCount(String(SEARCH_COUNT_DEFAULT));
      setTags([]);
      setError(null);
      setExhausted(search.status === "exhausted");
    }
    setOpen(value);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = parseSearchCount(count);
    if (value === null) {
      setError(`Informe um número inteiro a partir de ${SEARCH_COUNT_MIN}.`);
      return;
    }
    setError(null);
    more.mutate(value);
  };

  if (running) {
    return (
      <Button variant="outline" size="xs" disabled>
        <Loader2Icon className="animate-spin" /> Em andamento
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs">
          <PlusIcon /> Buscar mais
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(18rem,calc(100vw-2rem))]">
        {exhausted ? (
          <ExhaustedNotice
            onOtherCity={() => {
              setOpen(false);
              onOtherCity();
            }}
          />
        ) : (
          <form onSubmit={onSubmit} className="space-y-3" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor={inputId}>Quantos leads novos?</Label>
              <Input
                id={inputId}
                type="number"
                inputMode="numeric"
                min={SEARCH_COUNT_MIN}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                className="h-8 tabular"
                aria-invalid={error ? true : undefined}
                aria-describedby={`${inputId}-help`}
                autoFocus
              />
              <p id={`${inputId}-help`} className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")} role={error ? "alert" : undefined}>
                {error ?? `Continua de onde “${searchLabel(search)}” parou. 1 crédito Serper por página de 10.`}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${inputId}-tags`}>
                Tags extras <span className="text-muted-foreground font-normal">(opcional)</span>
              </Label>
              <TagInput id={`${inputId}-tags`} value={tags} onChange={setTags} aria-describedby={`${inputId}-tags-help`} />
              <p id={`${inputId}-tags-help`} className="text-muted-foreground text-xs">
                {search.tags.length ? `Somadas às da busca (${search.tags.join(", ")}).` : "Ficam na busca e nos leads dela."}
              </p>
            </div>
            {more.error instanceof ApiError && more.error.status === 503 && <SettingsLink />}
            <Button type="submit" size="sm" className="w-full" disabled={more.isPending}>
              {more.isPending ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
              Buscar mais
            </Button>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Edit a search's tags (PUT /api/searches/:id/tags). */
function SearchTagsButton({ search }: { search: Search }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<string[]>(search.tags);
  const inputId = `search-tags-${search.id}`;

  const save = useMutation({
    mutationFn: (value: string[]) => searchesApi.setTags(search.id, value),
    onSuccess: () => {
      setOpen(false);
      toast.success(`Tags de “${searchLabel(search)}” salvas.`);
    },
    onError: (e) => toast.error(errorMessage(e, "Não foi possível salvar as tags.")),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.leads.root }),
  });

  const onOpenChange = (value: boolean) => {
    if (value) setTags(search.tags);
    setOpen(value);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!save.isPending) save.mutate(tags);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" aria-label={`Editar tags de ${searchLabel(search)}`}>
          <TagIcon /> Tags
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))]">
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={inputId}>Tags da busca</Label>
            <TagInput id={inputId} value={tags} onChange={setTags} aria-describedby={`${inputId}-help`} autoFocus />
            <p id={`${inputId}-help`} className="text-muted-foreground text-xs">
              Novas tags também são aplicadas aos leads já coletados por esta busca. Tirar uma tag daqui não a remove dos leads.
            </p>
          </div>
          <Button type="submit" size="sm" className="w-full" disabled={save.isPending}>
            {save.isPending && <Loader2Icon className="animate-spin" />}
            Salvar tags
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function SettingsLink() {
  return (
    <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => navigate(ROUTES.settings)}>
      <SettingsIcon /> Abrir Configurações
    </Button>
  );
}

function OtherCityDialog({ search, onOpenChange, onStarted }: { search: Search | null; onOpenChange: (open: boolean) => void; onStarted: (started: ProspectStarted) => void }) {
  const open = search !== null;
  const [niche, setNiche] = useState("");
  const [city, setCity] = useState("");
  const [count, setCount] = useState(String(SEARCH_COUNT_DEFAULT));
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<"niche" | "city" | "count" | null>(null);

  useEffect(() => {
    if (!search) return;
    setNiche(search.niche);
    setCity("");
    setCount(String(SEARCH_COUNT_DEFAULT));
    setTags(search.tags);
    setError(null);
    setInvalid(null);
  }, [search]);

  const create = useMutation({
    mutationFn: searchesApi.create,
    onSuccess: (started) => {
      if (started.already_running) toast("Essa busca já estava em andamento; acompanhando a existente.");
      else toast.success(`Busca iniciada: ${niche.trim()} em ${city.trim()}.`);
      onStarted(started);
      onOpenChange(false);
    },
    onError: (e) => setError(errorMessage(e, "Não consegui iniciar a busca.")),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = parseSearchCount(count);
    if (niche.trim().length < 2) {
      setInvalid("niche");
      setError("Informe o nicho (pelo menos 2 caracteres).");
      return;
    }
    if (city.trim().length < 2) {
      setInvalid("city");
      setError("Informe a cidade, por exemplo: Cascavel-PR.");
      return;
    }
    if (value === null) {
      setInvalid("count");
      setError(`A quantidade deve ser um número inteiro a partir de ${SEARCH_COUNT_MIN}.`);
      return;
    }
    setInvalid(null);
    setError(null);
    create.mutate({ niche: niche.trim(), city: city.trim(), count: value, ...(tags.length ? { tags } : {}) });
  };

  const missingKey = create.error instanceof ApiError && create.error.status === 503;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>Buscar em outra cidade</DialogTitle>
            <DialogDescription>
              {search ? `Mesmo nicho de “${searchLabel(search)}” (ou outro termo) numa nova cidade.` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="other-city-niche">Nicho</Label>
            <Input id="other-city-niche" value={niche} onChange={(e) => setNiche(e.target.value)} aria-invalid={invalid === "niche" || undefined} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="other-city-city">Cidade</Label>
            <Input
              id="other-city-city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Ex.: Cascavel-PR"
              required
              autoFocus
              aria-invalid={invalid === "city" || undefined}
              aria-describedby="other-city-city-help"
            />
            <p id="other-city-city-help" className="text-muted-foreground text-xs">
              Ex.: Cascavel-PR. Inclua a sigla do estado para resultados mais precisos.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="other-city-count">Quantidade de leads novos</Label>
            <Input
              id="other-city-count"
              type="number"
              inputMode="numeric"
              min={SEARCH_COUNT_MIN}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              className="tabular sm:w-32"
              aria-invalid={invalid === "count" || undefined}
              aria-describedby="other-city-count-help"
            />
            <p id="other-city-count-help" className="text-muted-foreground text-xs">
              Sem limite: a coleta para quando o Google Maps não tem mais empresas. 1 crédito Serper por página de 10 resultados.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="other-city-tags">
              Tags <span className="text-muted-foreground font-normal">(opcional)</span>
            </Label>
            <TagInput id="other-city-tags" value={tags} onChange={setTags} aria-describedby="other-city-tags-help" />
            <p id="other-city-tags-help" className="text-muted-foreground text-xs">
              Aplicadas à nova busca e a todos os leads que ela coletar.
            </p>
          </div>

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            {missingKey && <SettingsLink />}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2Icon className="animate-spin" />}
              Iniciar busca
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
