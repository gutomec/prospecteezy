/** Provider kinds supported by the AI layer. */
export const PROVIDER_KINDS = ["openai", "google", "anthropic", "openrouter", "openai_compatible"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  openai: "OpenAI",
  google: "Google Gemini",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  openai_compatible: "Compatível com OpenAI",
};

export interface ModelSuggestion {
  id: string;
  label: string;
}

/**
 * Curated suggestions for the model picker (GET /api/ai/models). Static and
 * non-exhaustive: any free-text model id is accepted.
 */
export const MODEL_SUGGESTIONS: Record<ProviderKind, ModelSuggestion[]> = {
  openai: [
    { id: "gpt-5.1", label: "GPT-5.1" },
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 mini (econômico)" },
    { id: "gpt-5-nano", label: "GPT-5 nano (mais barato)" },
  ],
  google: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (econômico)" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite (mais barato)" },
  ],
  anthropic: [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (mais barato)" },
  ],
  openrouter: [
    { id: "openai/gpt-5-mini", label: "OpenAI GPT-5 mini" },
    { id: "google/gemini-2.5-flash", label: "Google Gemini 2.5 Flash" },
    { id: "anthropic/claude-sonnet-5-5", label: "Anthropic Claude Sonnet 5.5" },
  ],
  openai_compatible: [
    { id: "llama3.1", label: "Llama 3.1 (Ollama)" },
    { id: "qwen2.5", label: "Qwen 2.5 (Ollama)" },
  ],
};
