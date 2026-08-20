import { API_ENDPOINTS, ensureV1Suffix } from "../../config/constants";
import { getSettings } from "../../stores/settingsStore";
import { isSecureEndpoint } from "../../utils/urlUtils";
import logger from "../../utils/logger";

// Base URL of the user's own OpenAI-compatible server (llama.cpp, Ollama,
// vLLM…). There is no hosted fallback: an unset or rejected URL returns "" and
// the caller refuses to run rather than quietly reaching a cloud provider.
export function getConfiguredOpenAIBase(): string {
  if (typeof window === "undefined") {
    return API_ENDPOINTS.OPENAI_BASE;
  }

  try {
    const settings = getSettings();
    if ((settings.cleanupProvider || "") !== "custom") {
      return API_ENDPOINTS.OPENAI_BASE;
    }

    const trimmed = (settings.cleanupCloudBaseUrl || "").trim();
    if (!trimmed) {
      return API_ENDPOINTS.OPENAI_BASE;
    }

    const normalized = ensureV1Suffix(trimmed);
    if (!normalized) {
      return API_ENDPOINTS.OPENAI_BASE;
    }

    if (!isSecureEndpoint(normalized)) {
      logger.logReasoning("SELF_HOSTED_BASE_REJECTED", {
        reason: "HTTPS required (HTTP allowed for local network only)",
        attempted: normalized,
      });
      return API_ENDPOINTS.OPENAI_BASE;
    }

    logger.logReasoning("SELF_HOSTED_ENDPOINT_RESOLVED", { endpoint: normalized });
    return normalized;
  } catch (error) {
    logger.logReasoning("SELF_HOSTED_ENDPOINT_ERROR", { error: (error as Error).message });
    return API_ENDPOINTS.OPENAI_BASE;
  }
}
