// Leads view: KPIs, searches panel (history, "buscar mais", "outra cidade"),
// toolbar (search, filters, density, export, new search), server-paginated
// table, selection bar and lead drawer.
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, BotIcon, DownloadIcon, Rows3Icon, Rows4Icon, SearchIcon, SearchXIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAssistant } from "@/features/assistant/assistant-context";
import { useProspectChat } from "@/features/assistant/prospect-chat-state";
import { errorMessage } from "@/lib/api/client";
import { fetchAllLeads } from "@/lib/api/endpoints";
import { downloadCsv, leadsToCsv } from "@/lib/csv";
import { plural } from "@/lib/format";
import { activeFilterCount, categoriesOf, filterLeadsLocally, needsLocalFiltering } from "@/lib/lead-filters";
import { qk, useAllLeads, useLeadsPage } from "@/lib/queries";
import { FilterChips, FiltersPopover } from "./filters-popover";
import { LeadSheet } from "./lead-sheet";
import { useLeadsState } from "./leads-state";
import { LeadsTable, Pagination } from "./leads-table";
import { MetricCards } from "./metric-cards";
import { SearchesPanel } from "./searches-panel";
import { SelectionBar } from "./selection-bar";

const SEARCH_DEBOUNCE_MS = 250;

export function LeadsView() {
  const state = useLeadsState();
  const { setOpen: setAssistantOpen } = useAssistant();
  const { busy: prospectRunning } = useProspectChat();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState(state.search);

  // Debounced search → state (which resets page + selection).
  useEffect(() => {
    if (searchInput === state.search) return;
    const timer = setTimeout(() => state.setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);
  useEffect(() => setSearchInput(state.search), [state.search]);

  // Filters the API can't apply run client-side (tags included); tags alone stay server-side.
  const advanced = needsLocalFiltering(state.filters);
  const anyFilter = activeFilterCount(state.filters) > 0;
  const searchId = state.searchFilter?.id ?? null;
  const all = useAllLeads();
  const serverPage = useLeadsPage(
    {
      search_id: searchId ?? undefined,
      filter: state.search || undefined,
      tags: state.filters.tags.length ? state.filters.tags : undefined,
      tags_mode: state.filters.tags.length > 1 ? state.filters.tagsMode : undefined,
      sort: state.sort,
      page: state.page,
      page_size: state.pageSize,
    },
    !advanced,
  );

  // Advanced filters run client-side over the full list (the API only has text, search and tag filters).
  const local = useMemo(
    () =>
      advanced && all.data
        ? filterLeadsLocally(all.data.leads, { text: state.search, filters: state.filters, sort: state.sort, page: state.page, pageSize: state.pageSize, searchId })
        : null,
    [advanced, all.data, state.search, state.filters, state.sort, state.page, state.pageSize, searchId],
  );

  const leads = advanced ? (local?.leads ?? []) : (serverPage.data?.leads ?? []);
  const total = advanced ? (local?.total ?? 0) : (serverPage.data?.total ?? 0);
  const loading = advanced ? all.isPending : serverPage.isPending;
  const error = advanced ? all.error : serverPage.error;

  // Page past the end (e.g. after deleting the last page's leads): clamp.
  useEffect(() => {
    if (!loading && total > 0 && leads.length === 0 && state.page > 1) {
      state.setPage(Math.max(1, Math.ceil(total / state.pageSize)));
    }
  }, [loading, total, leads.length, state]);

  const categories = useMemo(() => categoriesOf(all.data?.leads ?? []), [all.data]);

  const exportAll = async () => {
    try {
      const data = await queryClient.fetchQuery({ queryKey: qk.leads.all, queryFn: ({ signal }) => fetchAllLeads(signal) });
      if (data.leads.length === 0) {
        toast("Nada para exportar ainda.");
        return;
      }
      downloadCsv(leadsToCsv(data.leads, state.ambiguous), "prospecteezy-leads.csv");
      toast.success(`${plural(data.leads.length, "lead exportado", "leads exportados")}`);
    } catch (e) {
      toast.error(errorMessage(e, "Não deu para exportar: o servidor não respondeu."));
    }
  };

  const hasQuery = Boolean(state.search.trim()) || anyFilter || searchId !== null;
  const searchChips = state.searchFilter
    ? [{ key: "search", label: `Busca: ${state.searchFilter.label}`, onRemove: () => state.setSearchFilter(null) }]
    : [];
  const pageIds = leads.map((l) => l.id);

  return (
    <div className="space-y-5 pb-24">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Leads</h1>
          <p className="text-muted-foreground text-sm">Empresas coletadas pelas suas buscas, prontas para validar, enriquecer e abordar.</p>
        </div>
        <Button onClick={() => setAssistantOpen(true)}>
          <BotIcon /> Nova busca
        </Button>
      </div>

      <MetricCards leads={all.data?.leads ?? []} loading={all.isPending} />


      <SearchesPanel />

      <section id="leads-table" className="scroll-mt-4 overflow-hidden rounded-xl border bg-card shadow-xs" aria-label="Tabela de leads">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden="true" />
            <Input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Buscar por nome, categoria, endereço, telefone…"
              aria-label="Buscar leads"
              className="h-8 pl-8"
            />
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <FiltersPopover filters={state.filters} categories={categories} categoriesLoading={all.isPending} onApply={state.setFilters} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-pressed={state.density === "compact"}
                  aria-label="Tabela compacta"
                  onClick={() => state.setDensity(state.density === "compact" ? "comfortable" : "compact")}
                >
                  {state.density === "compact" ? <Rows4Icon /> : <Rows3Icon />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{state.density === "compact" ? "Densidade confortável" : "Densidade compacta"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label="Exportar todos os leads em CSV" onClick={exportAll}>
                  <DownloadIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Exportar CSV (todos)</TooltipContent>
            </Tooltip>
          </div>
          {(anyFilter || searchChips.length > 0) && (
            <div className="w-full">
              <FilterChips filters={state.filters} onChange={state.setFilters} onClearAll={state.clearFilters} extra={searchChips} />
            </div>
          )}
        </div>

        {error && leads.length === 0 ? (
          <EmptyState
            icon={AlertTriangleIcon}
            title="Não deu para carregar os leads"
            description={errorMessage(error, "O servidor local não respondeu.")}
            action={
              <Button variant="outline" size="sm" onClick={() => queryClient.invalidateQueries({ queryKey: qk.leads.root })}>
                Tentar de novo
              </Button>
            }
          />
        ) : !loading && leads.length === 0 ? (
          hasQuery ? (
            <EmptyState
              icon={SearchXIcon}
              title="Nada encontrado"
              description={
                state.search.trim()
                  ? `Nenhum lead corresponde a “${state.search.trim()}”. Ajuste o termo ou limpe os filtros.`
                  : !anyFilter && state.searchFilter
                    ? `A busca “${state.searchFilter.label}” ainda não tem leads.`
                    : "Nenhum lead corresponde aos filtros ativos."
              }
              action={
                <Button variant="outline" size="sm" onClick={state.clearFilters}>
                  Limpar filtros
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={UsersIcon}
              title={prospectRunning ? "Coletando leads…" : "Nenhum lead ainda"}
              description={
                prospectRunning
                  ? "O agente está trabalhando na busca. Os resultados aparecem aqui conforme são salvos."
                  : "Peça ao agente uma busca, por exemplo: “Busque os 100 principais escritórios de advocacia de São Paulo-SP”."
              }
              action={
                !prospectRunning && (
                  <Button size="sm" onClick={() => setAssistantOpen(true)}>
                    <BotIcon /> Fazer a primeira busca
                  </Button>
                )
              }
            />
          )
        ) : (
          <>
            <LeadsTable
              leads={leads}
              loading={loading}
              sort={state.sort}
              onSort={state.setSort}
              selection={state.selection}
              onToggle={state.toggleSelected}
              onTogglePage={(selected) => state.setManySelected(pageIds, selected)}
              ambiguous={state.ambiguous}
              density={state.density}
              onOpen={state.openLead}
            />
            <Pagination page={state.page} pageSize={state.pageSize} total={total} onPage={state.setPage} onPageSize={state.setPageSize} />
          </>
        )}
      </section>

      <SelectionBar pageIds={pageIds} />
      <LeadSheet />
    </div>
  );
}
