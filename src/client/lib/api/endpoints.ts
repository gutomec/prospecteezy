// One function per REST route used by the UI. Views call these through
// TanStack Query hooks (see lib/queries.ts), never `fetch` directly.
import { api, ApiError, NETWORK_ERROR_MESSAGE, request, seg } from "./client";
import type {
  AiChatDetail,
  AiChatSummary,
  AiProvider,
  AiStatus,
  CompanyProfile,
  Job,
  Lead,
  LeadsPage,
  LeadTagsUpdate,
  LeadsQuery,
  ModelSuggestion,
  ProspectStarted,
  ProviderCreateInput,
  ProviderKind,
  ProviderTestResult,
  ProviderUpdateInput,
  Search,
  SearchCreateInput,
  Tag,
  SerperStatus,
  Settings,
  ValidateJob,
  WaCampaign,
  WaCampaignInput,
  WaChat,
  WaContactsSaveReport,
  WaInstance,
  WaLeadContact,
  WaMediaJob,
  WaMediaRecoverResult,
  WaMediaSummary,
  WaMessagesPage,
  WaMirroredMessage,
  WaQr,
  WaSendInput,
  WaUploadedMedia,
} from "./types";

/* ---------------- leads ---------------- */

export function leadsQueryString(query: LeadsQuery): string {
  const params = new URLSearchParams();
  if (query.search_id != null) params.set("search_id", String(query.search_id));
  if (query.filter?.trim()) params.set("filter", query.filter.trim());
  if (query.tags?.length) {
    params.set("tags", query.tags.join(","));
    if (query.tags_mode === "all") params.set("tags_mode", "all");
  }
  if (query.sort) params.set("sort", `${query.sort.column}${query.sort.desc ? ":desc" : ""}`);
  if (query.page) params.set("page", String(query.page));
  if (query.page_size) params.set("page_size", String(query.page_size));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const leadsApi = {
  list: (query: LeadsQuery, signal?: AbortSignal) =>
    api.get<LeadsPage>(`/api/leads${leadsQueryString(query)}`, signal),
  get: (id: number, signal?: AbortSignal) => api.get<{ lead: Lead }>(`/api/leads/${seg(id)}`, signal),
  remove: (ids: number[]) => api.delete<{ deleted: number }>("/api/leads", { ids }),
  enrich: (ids: number[]) => api.post<{ job_id: string }>("/api/leads/enrich", { ids }),
  addEvent: (id: number, event: string, payload?: unknown) =>
    api.post<{ ok: true }>(`/api/leads/${seg(id)}/events`, { event, payload }),
  searches: () => api.get<{ searches: Search[] }>("/api/searches"),
  /** Bulk add/remove; `tags` is the refreshed GET /api/tags list. */
  updateTags: (input: LeadTagsUpdate) => api.post<{ updated: number; tags: Tag[] }>("/api/leads/tags", input),
};

export const tagsApi = {
  list: (signal?: AbortSignal) => api.get<{ tags: Tag[] }>("/api/tags", signal),
};

/** Max leads the client loads for metrics, advanced filters and export (old UI cap). */
const ALL_LEADS_PAGE = 500;

/** Every lead, fetched in pages of 500 → `{ leads, total }`. */
export async function fetchAllLeads(signal?: AbortSignal): Promise<{ leads: Lead[]; total: number }> {
  const leads: Lead[] = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const data = await leadsApi.list({ page, page_size: ALL_LEADS_PAGE }, signal);
    total = data.total;
    leads.push(...data.leads);
    if (leads.length >= data.total || data.leads.length === 0) break;
  }
  return { leads, total };
}

/* ---------------- searches ---------------- */

export const searchesApi = {
  list: (signal?: AbortSignal) => api.get<{ searches: Search[] }>("/api/searches", signal),
  /** 409 `{ code: "exhausted" }` when the search ran dry in the last 24 h. */
  more: (id: number, count: number, tags?: string[]) =>
    api.post<ProspectStarted>(`/api/searches/${seg(id)}/more`, tags?.length ? { count, tags } : { count }),
  create: (input: SearchCreateInput) => api.post<ProspectStarted>("/api/searches", input),
  /** Replaces the search's tags; new ones also go to the leads it already collected. */
  setTags: (id: number, tags: string[]) => api.put<{ search: Search }>(`/api/searches/${seg(id)}/tags`, { tags }),
};

/* ---------------- prospect / jobs ---------------- */

export const jobsApi = {
  prospect: (text: string, tags?: string[]) =>
    api.post<ProspectStarted>("/api/prospect", tags?.length ? { text, tags } : { text }),
  progress: (jobId: string, signal?: AbortSignal) =>
    api.get<{ job: Job }>(`/api/progress/${seg(jobId)}`, signal),
};

/* ---------------- settings ---------------- */

export const settingsApi = {
  get: () => api.get<Settings>("/api/settings"),
  saveSerper: (apiKey: string) => api.put<SerperStatus>("/api/settings/serper", { api_key: apiKey }),
  removeSerper: () => api.delete<SerperStatus>("/api/settings/serper"),
  /** Spends 1 Serper credit. */
  testSerper: () => api.post<{ ok: boolean; error?: string }>("/api/settings/serper/test"),
  saveCompany: (profile: CompanyProfile) =>
    api.put<{ company_profile: CompanyProfile | null }>("/api/settings/company", profile),
};

/* ---------------- AI ---------------- */

export const aiApi = {
  status: () => api.get<AiStatus>("/api/ai/status"),
  models: (kind: ProviderKind) =>
    api.get<{ kind: ProviderKind; models: ModelSuggestion[] }>(`/api/ai/models?kind=${seg(kind)}`),
  providers: () => api.get<{ providers: AiProvider[] }>("/api/ai/providers"),
  create: (input: ProviderCreateInput) => api.post<{ provider: AiProvider }>("/api/ai/providers", input),
  update: (id: string, input: ProviderUpdateInput) =>
    api.patch<{ provider: AiProvider }>(`/api/ai/providers/${seg(id)}`, input),
  remove: (id: string) => api.delete<{ ok: true }>(`/api/ai/providers/${seg(id)}`),
  activate: (id: string) => api.post<{ provider: AiProvider }>(`/api/ai/providers/${seg(id)}/activate`),
  deactivate: () => api.post<{ ok: true }>("/api/ai/deactivate"),
  test: (id: string) => api.post<ProviderTestResult>(`/api/ai/providers/${seg(id)}/test`),
};

/** AI chat history. POST /api/chat is the streaming transport (useChat), not here. */
export const aiChatApi = {
  list: () => api.get<{ chats: AiChatSummary[] }>("/api/chat"),
  messages: (id: string, signal?: AbortSignal) => api.get<AiChatDetail>(`/api/chat/${seg(id)}/messages`, signal),
  remove: (id: string) => api.delete<{ ok: true }>(`/api/chat/${seg(id)}`),
};

/* ---------------- WhatsApp ---------------- */

const inst = (id: string) => `/api/wa/instances/${seg(id)}`;

export interface MessagesCursor {
  limit?: number;
  beforeId?: string;
  /** Unix seconds (fallback cursor when the id is unknown). */
  before?: number;
}

export interface MediaKey {
  instance: string;
  chat: string;
  id: string;
  fromMe: boolean;
}

/** URL of GET /api/wa/messages/media|thumbnail for one message. */
export function waMediaUrl(kind: "media" | "thumbnail", key: MediaKey): string {
  const params = new URLSearchParams({ instance: key.instance, chat: key.chat, id: key.id, from_me: key.fromMe ? "1" : "0" });
  return `/api/wa/messages/${kind}?${params}`;
}

export const waApi = {
  instances: () => api.get<{ instances: WaInstance[] }>("/api/wa/instances"),
  createInstance: (name?: string) => api.post<{ id: string }>("/api/wa/instances", name ? { name } : {}),
  qr: (id: string, signal?: AbortSignal) => api.get<WaQr>(`${inst(id)}/qr`, signal),
  select: (id: string) => api.post<{ ok: true; active_instance: string }>(`${inst(id)}/select`),
  disconnect: (id: string) => api.post<{ ok: true; status: string }>(`${inst(id)}/disconnect`),
  reconnect: (id: string) => api.post<{ ok: true; status: string }>(`${inst(id)}/reconnect`),
  repair: (id: string) => api.post<{ ok: true; status: string }>(`${inst(id)}/repair`),
  remove: (id: string) => api.delete<{ ok: true }>(inst(id)),

  chats: (instance: string, signal?: AbortSignal) =>
    api.get<{ chats: WaChat[] }>(`/api/wa/chats?instance=${seg(instance)}`, signal),
  messages: (instance: string, jid: string, cursor: MessagesCursor = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams({ instance });
    if (cursor.limit) params.set("limit", String(cursor.limit));
    if (cursor.beforeId) params.set("before_id", cursor.beforeId);
    if (cursor.before != null) params.set("before", String(cursor.before));
    return api.get<WaMessagesPage>(`/api/wa/chats/${seg(jid)}/messages?${params}`, signal);
  },
  /** Throws ApiError; 409/429 bodies carry `{ ok: false, blocked_code, reason }` in `error.body`. */
  mediaSummary: (instance: string, jid: string, signal?: AbortSignal) =>
    api.get<WaMediaSummary>(`/api/wa/chats/${seg(jid)}/media-summary?instance=${seg(instance)}`, signal),
  downloadChatMedia: (instance: string, jid: string) =>
    api.post<{ job_id: string }>(`/api/wa/chats/${seg(jid)}/media/download`, { instance }),
  recoverChatMedia: (instance: string, jid: string) =>
    api.post<WaMediaRecoverResult>(`/api/wa/chats/${seg(jid)}/media/recover`, { instance }),
  mediaJob: (jobId: string, signal?: AbortSignal) => api.get<WaMediaJob>(`/api/wa/media-jobs/${seg(jobId)}`, signal),
  send: (input: WaSendInput) => api.post<{ ok: true; message?: WaMirroredMessage }>("/api/wa/send", input),
  leads: () => api.get<{ leads: WaLeadContact[] }>("/api/wa/leads"),
  saveContacts: (instance: string, jids: string[]) =>
    api.post<WaContactsSaveReport>("/api/wa/contacts/save", { instance, jids }),

  validate: (instance: string, leadIds: number[]) =>
    api.post<{ job_id: string }>("/api/wa/validate", { instance, lead_ids: leadIds }),
  validateJob: (jobId: string, signal?: AbortSignal) =>
    api.get<ValidateJob>(`/api/wa/validate/${seg(jobId)}`, signal),
  resumeValidate: (jobId: string) =>
    request<{ ok: true; job_id: string }>(`/api/wa/validate/${seg(jobId)}/resume`, { method: "POST" }),

  createCampaign: (input: WaCampaignInput) => api.post<{ job_id: string }>("/api/wa/campaign", input),
  campaign: (jobId: string, signal?: AbortSignal) => api.get<WaCampaign>(`/api/wa/campaign/${seg(jobId)}`, signal),
  resumeCampaign: (jobId: string) => api.post<{ ok: true; job_id: string }>(`/api/wa/campaign/${seg(jobId)}/resume`),
};

/**
 * POST /api/wa/media (multipart, field `file`) with upload progress.
 * XMLHttpRequest because fetch has no upload progress events.
 */
export function uploadWaMedia(
  file: File,
  { onProgress, signal }: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<WaUploadedMedia> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/wa/media");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as WaUploadedMedia);
        return;
      }
      const message =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Erro ${xhr.status} no envio do arquivo.`;
      reject(new ApiError(message, xhr.status, body));
    };
    xhr.onerror = () => reject(new ApiError(NETWORK_ERROR_MESSAGE, 0));
    xhr.onabort = () => reject(new DOMException("Upload cancelado.", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}
