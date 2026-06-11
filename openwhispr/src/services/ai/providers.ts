import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

// Renderer-side AI SDK factory for no-auth OpenAI-compatible endpoints.

export function getAIModel(
  provider: string,
  model: string,
  baseURL?: string
): LanguageModel {
  switch (provider) {
    case "custom":
      return createOpenAI({ apiKey: "no-key", baseURL })(model);
    case "local":
      return createOpenAI({ apiKey: "no-key", baseURL }).chat(model);
    default:
      throw new Error(`Unsupported AI SDK provider for renderer: ${provider}`);
  }
}
