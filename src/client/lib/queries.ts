// TanStack Query keys + shared hooks. Invalidate by prefix:
//   queryClient.invalidateQueries({ queryKey: qk.leads.root })  → every leads query
import { QueryClient, useQuery } from "@tanstack/react-query";
import { ApiError } from "./api/client";
import { aiApi, fetchAllLeads, leadsApi, searchesApi, settingsApi, tagsApi, waApi } from "./api/endpoints";
import type { LeadsQuery, ProviderKind } from "./api/types";

export const qk = {
  leads: {
    root: ["leads"] as const,
    page: (query: LeadsQuery) => ["leads", "page", query] as const,
    all: ["leads", "all"] as const,
    detail: (id: number) => ["leads", "detail", id] as const,
  },
  // Under the leads prefix: any leads refresh (jobs, deletions) also refreshes
  // lead counts and statuses of the searches.
  searches: ["leads", "searches"] as const,
  // Also under the leads prefix: lead counts per tag follow every leads refresh.
  tags: ["leads", "tags"] as const,
  settings: ["settings"] as const,
  ai: {
    root: ["ai"] as const,
    status: ["ai", "status"] as const,
    providers: ["ai", "providers"] as const,
    models: (kind: ProviderKind) => ["ai", "models", kind] as const,
    chats: ["ai", "chats"] as const,
  },
  wa: {
    root: ["wa"] as const,
    instances: ["wa", "instances"] as const,
    chats: (instance: string) => ["wa", "chats", instance] as const,
    leads: ["wa", "leads"] as const,
    campaign: (jobId: string) => ["wa", "campaign", jobId] as const,
  },
  jobs: {
    progress: (jobId: string) => ["jobs", "progress", jobId] as const,
    validate: (jobId: string) => ["jobs", "validate", jobId] as const,
  },
};

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // 4xx are final (bad request, not found); retry network/5xx once.
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1,
      },
    },
  });
}

/* ---------------- shared hooks ---------------- */

export function useLeadsPage(query: LeadsQuery, enabled = true) {
  return useQuery({
    queryKey: qk.leads.page(query),
    queryFn: ({ signal }) => leadsApi.list(query, signal),
    placeholderData: (previous) => previous,
    enabled,
  });
}

/** All leads (≤ 5000) for metrics, categories, advanced filters and export. */
export function useAllLeads(enabled = true) {
  return useQuery({ queryKey: qk.leads.all, queryFn: ({ signal }) => fetchAllLeads(signal), enabled });
}

export function useLead(id: number | null) {
  return useQuery({
    queryKey: qk.leads.detail(id ?? 0),
    queryFn: ({ signal }) => leadsApi.get(id!, signal).then((r) => r.lead),
    enabled: id != null,
  });
}

const SEARCHES_POLL_MS = 2000;

/** Searches (history) with live status; polls while any search is collecting. */
export function useSearches() {
  return useQuery({
    queryKey: qk.searches,
    queryFn: ({ signal }) => searchesApi.list(signal).then((r) => r.searches),
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === "running") ? SEARCHES_POLL_MS : false),
    refetchIntervalInBackground: true,
    staleTime: 5_000,
  });
}

/** Every tag with its lead count (autocomplete, filters). */
export function useTags() {
  return useQuery({ queryKey: qk.tags, queryFn: ({ signal }) => tagsApi.list(signal).then((r) => r.tags) });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: settingsApi.get });
}

/** AI on/off. Errors (route missing, server down) count as "classic mode". */
export function useAiStatus() {
  const query = useQuery({ queryKey: qk.ai.status, queryFn: aiApi.status, staleTime: 30_000 });
  return { ...query, enabled: query.data?.enabled === true, provider: query.data?.provider ?? null };
}

export function useAiProviders() {
  return useQuery({ queryKey: qk.ai.providers, queryFn: () => aiApi.providers().then((r) => r.providers) });
}

export function useModelSuggestions(kind: ProviderKind) {
  return useQuery({
    queryKey: qk.ai.models(kind),
    queryFn: () => aiApi.models(kind).then((r) => r.models),
    staleTime: Infinity,
  });
}

export function useWaInstances() {
  return useQuery({
    queryKey: qk.wa.instances,
    queryFn: () => waApi.instances().then((r) => r.instances),
    staleTime: 10_000,
  });
}

export function useWaChats(instance: string | null) {
  return useQuery({
    queryKey: qk.wa.chats(instance ?? ""),
    queryFn: ({ signal }) => waApi.chats(instance!, signal).then((r) => r.chats),
    enabled: instance != null,
    staleTime: 10_000,
  });
}

/** Prospected leads with a validated WhatsApp, startable as conversations. */
export function useWaLeads(enabled = true) {
  return useQuery({ queryKey: qk.wa.leads, queryFn: () => waApi.leads().then((r) => r.leads), enabled });
}
