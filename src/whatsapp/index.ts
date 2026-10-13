// Public surface of the WhatsApp module (whatsapp-module phase, squad
// agentic-whatsapp-nirvana). The core can import these to plug REST routes
// without this module ever touching src/server.ts.
export { validateLeads, validateLeadsCore } from "./validate.ts";
export type { ValidationReport, LeadValidationDetail, LeadValidationStatus } from "./validate.ts";
export { createValidateJob, getValidateJob, runValidateJob } from "./validate-job.ts";
export type { ValidateJobView, ValidateJobStatus } from "./validate-job.ts";
export { registerLeadContacts, registerLeadContactsCore, saveContactsCore } from "./contacts.ts";
export type {
  ContactReport,
  ContactRegistrationDetail,
  SaveContactsReport,
  SaveContactResult,
  SaveContactStatus,
} from "./contacts.ts";
export { brazilianVariants, phoneToUser, resolveRecipient } from "./resolver.ts";
export type { ResolveResult, OnWhatsAppSocket } from "./resolver.ts";
export { evaluateActionGate, evaluateSendGate, isWithinQuietHours, jitterMs } from "./gate.ts";
export { WA_CONFIG } from "./config.ts";
export { openWaDb, WA_DB_PATH, CORE_DB_PATH } from "./db.ts";
export { isPaired, clearInstanceAuth, authCategoryPrefix, DEFAULT_INSTANCE } from "./auth-state.ts";
// wa-backend HTTP surface: the core mounts handleWaRequest under /api/wa/*.
export { handleWaRequest, createWaRouter, formatSse, parseSseStream } from "./routes.ts";
export { WaManager } from "./manager.ts";
export type { WaEvent, WaStatus, SendResult } from "./manager.ts";
export {
  createInstance,
  listInstances,
  getInstance,
  getActiveInstance,
  setActiveInstance,
  generateInstanceId,
} from "./instances.ts";
export type { InstanceRow } from "./instances.ts";
// campaign-backend: personalized mass send over selected leads.
export {
  renderTemplate,
  createCampaign,
  getCampaign,
  runCampaign,
  PLACEHOLDER_COLUMNS,
  kindFromMime,
} from "./campaign.ts";
export type { CampaignView, CampaignRecipient, CampaignStatus } from "./campaign.ts";
