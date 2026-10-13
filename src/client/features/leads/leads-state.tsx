// UI state of the Leads view, kept above the router so search, filters, page
// and selection survive a trip to WhatsApp/Configurações.
//
// Selection model: a Set of lead ids that spans pages ("N selecionados
// (M fora desta página)"). It is cleared whenever the result set changes
// (search text, filters or the search filter) so hidden leads can't be acted on by accident.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { LeadSort } from "@/lib/api/types";
import { DEFAULT_FILTERS, type AdvancedFilters } from "@/lib/lead-filters";

export type Density = "comfortable" | "compact";

/** "Ver leads" of one search (Buscas panel): server-side `search_id` filter. */
export interface SearchFilter {
  id: number;
  /** "dentistas em Campinas-SP" (chip text). */
  label: string;
}
const DENSITY_KEY = "prospecteezy-density";

interface LeadsState {
  search: string;
  filters: AdvancedFilters;
  searchFilter: SearchFilter | null;
  sort: LeadSort | null;
  page: number;
  pageSize: number;
  selection: ReadonlySet<number>;
  /** Leads the current session's validation marked ambiguous (DB stores them as null). */
  ambiguous: ReadonlySet<number>;
  density: Density;
  openLeadId: number | null;
}

interface LeadsActions {
  setSearch: (value: string) => void;
  setFilters: (value: AdvancedFilters) => void;
  clearFilters: () => void;
  setSearchFilter: (value: SearchFilter | null) => void;
  setSort: (value: LeadSort | null) => void;
  setPage: (value: number) => void;
  setPageSize: (value: number) => void;
  toggleSelected: (id: number, selected?: boolean) => void;
  setManySelected: (ids: number[], selected: boolean) => void;
  clearSelection: () => void;
  setAmbiguous: (update: (current: Set<number>) => Set<number>) => void;
  setDensity: (value: Density) => void;
  openLead: (id: number | null) => void;
}

const LeadsStateContext = createContext<(LeadsState & LeadsActions) | null>(null);

function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function LeadsStateProvider({ children }: { children: ReactNode }) {
  const [search, setSearchState] = useState("");
  const [filters, setFiltersState] = useState<AdvancedFilters>(DEFAULT_FILTERS);
  const [searchFilter, setSearchFilterState] = useState<SearchFilter | null>(null);
  const [sort, setSortState] = useState<LeadSort | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(50);
  const [selection, setSelection] = useState<ReadonlySet<number>>(new Set());
  const [ambiguous, setAmbiguousState] = useState<ReadonlySet<number>>(new Set());
  const [density, setDensityState] = useState<Density>(readDensity);
  const [openLeadId, openLead] = useState<number | null>(null);

  const clearSelection = useCallback(() => setSelection((s) => (s.size ? new Set() : s)), []);

  const setSearch = useCallback(
    (value: string) => {
      setSearchState(value);
      clearSelection();
      setPage(1);
    },
    [clearSelection],
  );

  const setFilters = useCallback(
    (value: AdvancedFilters) => {
      setFiltersState(value);
      clearSelection();
      setPage(1);
    },
    [clearSelection],
  );

  const setSearchFilter = useCallback(
    (value: SearchFilter | null) => {
      setSearchFilterState(value);
      clearSelection();
      setPage(1);
    },
    [clearSelection],
  );

  const clearFilters = useCallback(() => {
    setSearchState("");
    setSearchFilterState(null);
    setFilters(DEFAULT_FILTERS);
  }, [setFilters]);

  const setSort = useCallback((value: LeadSort | null) => {
    setSortState(value);
    setPage(1);
  }, []);

  const setPageSize = useCallback((value: number) => {
    setPageSizeState(value);
    setPage(1);
  }, []);

  const toggleSelected = useCallback((id: number, selected?: boolean) => {
    setSelection((current) => {
      const next = new Set(current);
      const shouldSelect = selected ?? !next.has(id);
      if (shouldSelect) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const setManySelected = useCallback((ids: number[], selected: boolean) => {
    setSelection((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const setAmbiguous = useCallback((update: (current: Set<number>) => Set<number>) => {
    setAmbiguousState((current) => update(new Set(current)));
  }, []);

  const setDensity = useCallback((value: Density) => {
    setDensityState(value);
    try {
      localStorage.setItem(DENSITY_KEY, value);
    } catch {
      /* storage blocked */
    }
  }, []);

  const value = useMemo(
    () => ({
      search,
      filters,
      searchFilter,
      sort,
      page,
      pageSize,
      selection,
      ambiguous,
      density,
      openLeadId,
      setSearch,
      setFilters,
      clearFilters,
      setSearchFilter,
      setSort,
      setPage,
      setPageSize,
      toggleSelected,
      setManySelected,
      clearSelection,
      setAmbiguous,
      setDensity,
      openLead,
    }),
    [search, filters, searchFilter, sort, page, pageSize, selection, ambiguous, density, openLeadId, setSearch, setFilters, clearFilters, setSearchFilter, setSort, setPageSize, toggleSelected, setManySelected, clearSelection, setAmbiguous, setDensity],
  );
  return <LeadsStateContext.Provider value={value}>{children}</LeadsStateContext.Provider>;
}

export function useLeadsState() {
  const ctx = useContext(LeadsStateContext);
  if (!ctx) throw new Error("useLeadsState must be used inside <LeadsStateProvider>");
  return ctx;
}

/** "3 selecionados (1 fora desta página)" */
export function selectionLabel(selected: number, hidden: number): string {
  const base = selected === 1 ? "1 selecionado" : `${selected.toLocaleString("pt-BR")} selecionados`;
  return hidden > 0 ? `${base} (${hidden.toLocaleString("pt-BR")} fora desta página)` : base;
}
