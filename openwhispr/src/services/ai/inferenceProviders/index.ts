import type { InferenceProvider } from "./types";
import { localProvider } from "./local";
import { lanProvider } from "./lan";
import { openaiProvider } from "./openai";

// Only engines that stay on this machine or on an endpoint the user points at
// themselves. `openai` here is the OpenAI-compatible client used for
// self-hosted servers (llama.cpp, Ollama, vLLM…) — no hosted cloud provider is
// registered.
export const PROVIDER_REGISTRY: Readonly<Record<string, InferenceProvider>> = Object.freeze({
  custom: openaiProvider,
  local: localProvider,
  lan: lanProvider,
});

export type { InferenceProvider, ProviderContext, ProviderCallParams } from "./types";
