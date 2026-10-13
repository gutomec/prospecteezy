import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ProviderKind } from "./models.ts";

export interface ModelConfig {
  kind: ProviderKind;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
}

/** Builds a language model for a provider config. Injectable (tests use the AI SDK mock model). */
export type ModelFactory = (config: ModelConfig) => LanguageModel;

export const createLanguageModel: ModelFactory = ({ kind, model, apiKey, baseUrl }) => {
  const key = apiKey ?? undefined;
  const baseURL = baseUrl ?? undefined;
  switch (kind) {
    case "openai":
      return createOpenAI({ apiKey: key, baseURL })(model);
    case "google":
      return createGoogle({ apiKey: key, baseURL })(model);
    case "anthropic":
      return createAnthropic({ apiKey: key, baseURL })(model);
    case "openrouter":
      return createOpenRouter({ apiKey: key, baseURL })(model);
    case "openai_compatible":
      return createOpenAICompatible({ name: "custom", baseURL: baseURL!, apiKey: key })(model);
  }
};
