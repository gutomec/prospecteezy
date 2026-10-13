// Response shapes mirrored from the backend (docs/api.md, src/server.ts,
// src/settings/routes.ts, src/ai/routes.ts, src/whatsapp/routes.ts).
// Keep in sync by hand: the client never imports server modules.

/* ---------------- leads & searches ---------------- */

/** `is_whatsapp`: 1 = validated, 0 = no WhatsApp, null = not validated yet. */
export type WhatsAppFlag = 0 | 1 | null;

export interface Lead {
  id: number;
  search_id: number;
  place_id: string | null;
  cid: string | null;
  position: number | null;
  name: string;
  category: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  rating_count: number | null;
  email: string | null;
  /** JSON object `{ network: url }` as text. */
  socials_json: string | null;
  is_whatsapp: WhatsAppFlag;
  whatsapp_jid: string | null;
  source: string;
  collected_at: string;
  enriched_at: string | null;
  /** Written by the AI tool `save_lead_enrichment` (JSON text). */
  ai_enrichment_json?: string | null;
  ai_enriched_at?: string | null;
  /** Tag display names (alphabetical). Treat a missing field as []. */
  tags?: string[];
}

/** GET /api/tags item. `slug` is the identity (lowercase, no accents). */
export interface Tag {
  id: number;
  name: string;
  slug: string;
  lead_count: number;
}

export type TagsMode = "any" | "all";

/** Body of POST /api/leads/tags (lead_ids: 1..5000). */
export interface LeadTagsUpdate {
  lead_ids: number[];
  add?: string[];
  remove?: string[];
}

/** Parsed `ai_enrichment_json` (every field optional). */
export interface AiEnrichment {
  summary?: string;
  segment?: string;
  size_estimate?: string;
  decision_makers?: Array<{ name?: string; role?: string; source_url?: string }>;
  socials?: Record<string, string>;
  extra_emails?: string[];
  extra_phones?: string[];
  notes?: string;
  sources?: string[];
}

export interface LeadsPage {
  leads: Lead[];
  total: number;
  page: number;
  page_size: number;
}

/** Server-sortable columns of GET /api/leads. */
export type LeadSortColumn =
  | "id"
  | "name"
  | "category"
  | "rating"
  | "rating_count"
  | "position"
  | "collected_at"
  | "is_whatsapp";

export interface LeadSort {
  column: LeadSortColumn;
  desc: boolean;
}

export interface LeadsQuery {
  search_id?: number;
  filter?: string;
  /** Tag names (any/all of them, see tags_mode). */
  tags?: string[];
  tags_mode?: TagsMode;
  sort?: LeadSort | null;
  page?: number;
  page_size?: number;
}

export interface Search {
  id: number;
  query_normalized: string;
  niche: string;
  city: string;
  gl: string;
  hl: string;
  created_at: string;
  last_used_at: string | null;
  /** When the last collection ran the source dry (null = not exhausted). */
  exhausted_at: string | null;
  last_page: number;
  total_collected: number;
  lead_count: number;
  /** Inherited by every lead this search collects. */
  tags: string[];
  /** running = a job collects now; exhausted = ran dry < 24 h ago; idle otherwise. */
  status: SearchStatus;
  running_job_id: string | null;
}

export type SearchStatus = "running" | "exhausted" | "idle";

/** Body of POST /api/searches. `count`: 1..500. */
export interface SearchCreateInput {
  niche: string;
  city: string;
  count: number;
  tags?: string[];
}

/* ---------------- jobs (prospect / enrich) ---------------- */

export interface JobStep {
  at: string;
  message: string;
}

export type JobStatus = "running" | "completed" | "failed";

export interface JobResult {
  collected_new: number;
  duplicates_skipped: number;
  pages_consumed: number;
  enriched: number;
  exhausted: boolean;
}

export interface Job {
  id: string;
  status: JobStatus;
  search_id: number | null;
  steps: JobStep[];
  result: JobResult | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProspectStarted {
  job_id: string;
  search_id: number;
  steps: JobStep[];
  already_running: boolean;
}

/* ---------------- settings ---------------- */

export type SerperSource = "settings" | "env" | null;

export interface SerperStatus {
  configured: boolean;
  source: SerperSource;
  last4: string | null;
}

export const COMPANY_PROFILE_KEYS = [
  "name",
  "website",
  "description",
  "offering",
  "target_customers",
  "differentiators",
  "tone",
  "signature",
  "call_to_action",
  "extra_instructions",
] as const;
export type CompanyProfileKey = (typeof COMPANY_PROFILE_KEYS)[number];
export type CompanyProfile = Partial<Record<CompanyProfileKey, string>>;

export interface Settings {
  serper: SerperStatus;
  company_profile: CompanyProfile | null;
  secrets_unreadable: boolean;
  warning?: string;
}

/* ---------------- AI providers ---------------- */

export type ProviderKind = "openai" | "google" | "anthropic" | "openrouter" | "openai_compatible";

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  openai: "OpenAI",
  google: "Google Gemini",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  openai_compatible: "Compatível com OpenAI",
};

export interface AiProvider {
  id: string;
  kind: ProviderKind;
  label: string;
  model: string;
  base_url: string | null;
  has_key: boolean;
  last4: string | null;
  is_active: boolean;
  created_at: string;
}

export interface AiStatus {
  enabled: boolean;
  provider: Pick<AiProvider, "id" | "kind" | "label" | "model"> | null;
}

export interface ModelSuggestion {
  id: string;
  label: string;
}

export interface ProviderCreateInput {
  kind: ProviderKind;
  label?: string;
  model: string;
  api_key?: string;
  base_url?: string;
}

export interface ProviderUpdateInput {
  label?: string;
  model?: string;
  api_key?: string;
  base_url?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  error?: string;
  latency_ms: number;
}

/* ---------------- AI chat (POST /api/chat, AI SDK v7 UI message stream) ---------------- */

/** Data parts streamed by /api/chat (`data-credits` is stored; `data-error` is transient). */
export interface AiChatDataTypes {
  credits: { credits_thread: number; credits_run: number };
  error: { code: AiErrorCode; message: string };
  [key: string]: unknown;
}

export type AiErrorCode = "llm_auth" | "llm_quota" | "llm_unavailable" | "llm_error";

/** Stored conversation messages (`UIMessage` with our data parts; tools untyped). */
export type AiChatMessage = import("ai").UIMessage<unknown, AiChatDataTypes>;

export interface AiChatSummary {
  id: string;
  /** First user message (≤ 80 chars) or null. */
  title: string | null;
  credits_used: number;
  created_at: string;
  updated_at: string;
}

export interface AiChatDetail {
  id: string;
  title: string | null;
  credits_used: number;
  running: boolean;
  messages: AiChatMessage[];
}

/** `part.approval.descriptor` of a tool part waiting for approval. */
export interface ApprovalDescriptor {
  title: string;
  description: string;
  params: Array<{ label: string; value: string }>;
  estimated_credits: number;
}

/** Compact lead row returned by the `query_leads` tool. */
export interface AiLeadRow {
  id: number;
  search_id: number;
  name: string;
  category: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  rating: number | null;
  is_whatsapp: WhatsAppFlag;
  has_ai_enrichment: boolean;
}

export interface MessageDraftOutput {
  lead_id: number;
  lead_name: string;
  text: string;
  can_send_whatsapp: boolean;
  reason?: string;
}

/* ---------------- WhatsApp ---------------- */

export type WaStatus = "connecting" | "qr" | "connected" | "disconnected" | "logged_out";

export interface WaInstance {
  id: string;
  name: string | null;
  phone: string | null;
  status: WaStatus;
  status_reason: string | null;
  is_active: boolean;
}

export type ValidateJobStatus = "queued" | "running" | "done" | "paused" | "failed";

export interface ValidateJob {
  job_id: string;
  instance: string;
  status: ValidateJobStatus;
  total: number;
  checked: number;
  is_whatsapp: number;
  not_whatsapp: number;
  ambiguous: number;
  failed: number;
  reason: string | null;
  eta_seconds: number | null;
  results: Array<{
    lead_id: number;
    phone: string | null;
    is_whatsapp: boolean | null;
    jid?: string;
    reason?: string;
  }>;
}

/* ---------------- WhatsApp: chats, messages, media ---------------- */

export interface WaChat {
  jid: string;
  /** Resolved by the backend (chat name → address book → push name → number). */
  name: string | null;
  /** Real phone number when known, also for `@lid` chats. */
  phone: string | null;
  last_message: string | null;
  last_type: string | null;
  /** Unix seconds. */
  last_ts: number | null;
  unread: number;
  saved: boolean;
}

export type WaMediaKind = "image" | "video" | "audio" | "voice" | "document" | "sticker";

export interface WaMedia {
  kind: WaMediaKind;
  mimetype: string | null;
  file_name: string | null;
  file_size: number | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  has_thumbnail: boolean;
  /** false = keys never stored (message older than the media update). */
  available: boolean;
  /** The file is already on this computer: showing it downloads nothing. */
  cached: boolean;
}

/** GET /api/wa/chats/:jid/media-summary. */
export interface WaMediaSummary {
  total: number;
  cached: number;
  /** Keys stored, not cached: can be downloaded now. */
  downloadable: number;
  /** No keys (received before the media update): only a history re-sync can help. */
  unavailable: number;
  downloadable_bytes: number;
  unknown_size_count: number;
  cached_bytes: number;
}

/** GET /api/wa/media-jobs/:id (bulk download of one chat). */
export interface WaMediaJob {
  status: "running" | "done" | "failed";
  total: number;
  /** Downloaded successfully. */
  done: number;
  failed: number;
  bytes: number;
  errors: Array<{ message_id: string; code: string }>;
}

/** POST /api/wa/chats/:jid/media/recover. */
export interface WaMediaRecoverResult {
  requested: number;
  recovered: number;
  still_unavailable: number;
}

export interface WaQuoted {
  id: string;
  text: string | null;
  type: string | null;
}

export interface WaReaction {
  emoji: string;
  from_me: boolean;
}

/** pending | sent | delivered | read | played | error (null on inbound). */
export type WaMessageStatus = "pending" | "sent" | "delivered" | "read" | "played" | "error";

export interface WaMessage {
  id: string;
  from_me: boolean;
  /** Text, or the caption of a media message. */
  text: string | null;
  /** Stored message type (conversation, imageMessage, …). */
  type: string | null;
  /** Unix seconds. */
  ts: number;
  status: WaMessageStatus | string | null;
  media: WaMedia | null;
  quoted: WaQuoted | null;
  reactions: WaReaction[];
}

export interface WaMessagesPage {
  /** Ascending. */
  messages: WaMessage[];
  has_more: boolean;
  /** The mirror is exhausted and older history is being requested from WhatsApp. */
  fetching: boolean;
}

export interface WaQr {
  /** PNG data URL, or null while the QR is being generated. */
  qr: string | null;
  expires_at: number | null;
  status: WaStatus;
  status_reason: string | null;
}

/** POST /api/wa/media → handle reused by /send and /campaign. */
export interface WaUploadedMedia {
  media_id: string;
  kind: "image" | "video" | "audio" | "document";
  mime: string;
  filename: string | null;
  size: number;
}

/** Message echoed by POST /api/wa/send and by the SSE `message` event. */
export interface WaMirroredMessage {
  chat_jid: string;
  message_id: string;
  from_me: boolean;
  text: string | null;
  type: string | null;
  ts: number;
  status: string | null;
  media?: WaMedia | null;
  quoted?: WaQuoted | null;
}

export interface WaSendInput {
  instance: string;
  jid: string;
  text?: string;
  media_id?: string;
  caption?: string;
  voice?: boolean;
}

/** 409 (quiet hours, not connected) and 429 (rate limit) bodies of POST /api/wa/send. */
export interface WaSendBlocked {
  ok: false;
  blocked_code: "quiet_hours" | "rate_limit" | string | null;
  reason: string | null;
}

/** Prospected lead with a validated WhatsApp (GET /api/wa/leads). */
export interface WaLeadContact {
  lead_id: number;
  name: string;
  phone: string | null;
  jid: string;
  category: string | null;
  tags?: string[];
}

export interface WaContactsSaveReport {
  results: Array<{ jid: string; status: "saved" | "skipped_already_saved" | "failed"; reason?: string | null }>;
  saved: number;
  skipped: number;
  failed: number;
}

/* ---------------- WhatsApp: campaigns ---------------- */

export type WaCampaignStatus = "queued" | "running" | "done" | "paused" | "failed";
export type WaRecipientStatus = "queued" | "sent" | "failed" | "skipped";

export interface WaCampaignRecipient {
  lead_id: number;
  phone: string | null;
  status: WaRecipientStatus;
  reason: string | null;
  message_id: string | null;
}

export interface WaCampaign {
  job_id: string;
  instance: string;
  status: WaCampaignStatus;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  reason: string | null;
  recipients: WaCampaignRecipient[];
}

export interface WaCampaignInput {
  instance: string;
  lead_ids: number[];
  template: string;
  media?: { media_id: string };
}

/** SSE frames of GET /api/wa/stream (`event:` name → `data` payload). */
export interface WaStreamEvents {
  status: { instance: string; status: WaStatus; me_jid?: string | null; reason?: string | null };
  qr: { instance: string; qr: string; expires_at: number };
  message: { instance: string } & WaMirroredMessage;
  /** Delivery tick of a mirrored message (WhatsApp messages.update). */
  message_status: { instance: string; chat_jid: string; message_id: string; from_me: boolean; status: WaMessageStatus | string };
  campaign: {
    instance: string;
    job_id: string;
    status: WaCampaignStatus;
    total?: number;
    sent?: number;
    failed?: number;
    skipped?: number;
    reason?: string | null;
    recipient?: WaCampaignRecipient;
  };
  validate: { instance: string; job_id: string; status: ValidateJobStatus; [key: string]: unknown };
  reaction: { instance: string; chat_jid: string; target_id: string; emoji: string; from_me: boolean; removed: boolean };
}
