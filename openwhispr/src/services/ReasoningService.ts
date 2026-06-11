import {
  getModelProvider,
  getCloudModel,
  getOpenAiApiConfig,
  isEnterpriseProvider,
} from "../models/ModelRegistry";
import { BaseReasoningService, ReasoningConfig } from "./BaseReasoningService";
import { withRetry, createApiRetryStrategy } from "../utils/retry";
import { API_ENDPOINTS, TOKEN_LIMITS, buildApiUrl, ensureV1Suffix } from "../config/constants";
import logger from "../utils/logger";
import { getSettings } from "../stores/settingsStore";
import { streamText, stepCountIs } from "ai";
import { getAIModel } from "./ai/providers";
import { PROVIDER_REGISTRY, type ProviderContext } from "./ai/inferenceProviders";
import { getConfiguredOpenAIBase } from "./ai/openaiBase";
import { applyThinkingSuppression } from "./ai/thinkingSuppression";

export type AgentStreamChunk =
  | { type: "content"; text: string }
  | { type: "tool_calls"; calls: Array<{ id: string; name: string; arguments: string }> }
  | {
      type: "tool_result";
      callId: string;
      toolName: string;
      displayText: string;
      metadata?: Record<string, unknown>;
    }
  | { type: "done"; finishReason?: string };

class ReasoningService extends BaseReasoningService {
  private static readonly MAX_TOOL_STEPS = 20;
  private streamAbortController: AbortController | null = null;

  private readonly providerContext: ProviderContext;

  constructor() {
    super();
    this.providerContext = {
      getSystemPrompt: this.getSystemPrompt.bind(this),
      getPreferredLanguage: this.getPreferredLanguage.bind(this),
      getUiLanguage: this.getUiLanguage.bind(this),
      callChatCompletionsApi: this.callChatCompletionsApi.bind(this),
      calculateMaxTokens: this.calculateMaxTokens.bind(this),
    };

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => this.destroy());
    }
  }

  private isLanCleanupMode(): boolean {
    const settings = getSettings();
    return settings.cleanupMode === "self-hosted" && !!settings.cleanupRemoteUrl;
  }

  private async callChatCompletionsApi(
    endpoint: string,
    model: string,
    text: string,
    agentName: string | null,
    config: ReasoningConfig,
    providerName: string
  ): Promise<string> {
    const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName);
    const userPrompt = text;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const requestBody: any = {
      model,
      messages,
      temperature: config.temperature ?? 0.3,
      max_tokens:
        config.maxTokens ||
        Math.max(
          4096,
          this.calculateMaxTokens(
            text.length,
            TOKEN_LIMITS.MIN_TOKENS,
            TOKEN_LIMITS.MAX_TOKENS,
            TOKEN_LIMITS.TOKEN_MULTIPLIER
          )
        ),
    };

    applyThinkingSuppression(requestBody, model, providerName, config);

    logger.logReasoning(`${providerName.toUpperCase()}_REQUEST`, {
      endpoint,
      model,
      requestBody: JSON.stringify(requestBody).substring(0, 200),
    });

    const response = await withRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errorText = await res.text();
          let errorData: any = { error: res.statusText };

          try {
            errorData = JSON.parse(errorText);
          } catch {
            errorData = { error: errorText || res.statusText };
          }

          logger.logReasoning(`${providerName.toUpperCase()}_API_ERROR_DETAIL`, {
            status: res.status,
            statusText: res.statusText,
            error: errorData,
            errorMessage: errorData.error?.message || errorData.message || errorData.error,
            fullResponse: errorText.substring(0, 500),
          });

          const errorMessage =
            errorData.error?.message ||
            errorData.message ||
            errorData.error ||
            `${providerName} API error: ${res.status}`;
          throw new Error(errorMessage);
        }

        const jsonResponse = await res.json();

        logger.logReasoning(`${providerName.toUpperCase()}_RAW_RESPONSE`, {
          hasResponse: !!jsonResponse,
          responseKeys: jsonResponse ? Object.keys(jsonResponse) : [],
          hasChoices: !!jsonResponse?.choices,
          choicesLength: jsonResponse?.choices?.length || 0,
          fullResponse: JSON.stringify(jsonResponse).substring(0, 500),
        });

        return jsonResponse;
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          throw new Error("Request timed out after 30s");
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    }, createApiRetryStrategy());

    if (!response.choices || !response.choices[0]) {
      logger.logReasoning(`${providerName.toUpperCase()}_RESPONSE_ERROR`, {
        model,
        response: JSON.stringify(response).substring(0, 500),
        hasChoices: !!response.choices,
        choicesCount: response.choices?.length || 0,
      });
      throw new Error(`Invalid response structure from ${providerName} API`);
    }

    const choice = response.choices[0];
    const responseText = choice.message?.content?.trim() || "";

    if (!responseText) {
      logger.logReasoning(`${providerName.toUpperCase()}_EMPTY_RESPONSE`, {
        model,
        finishReason: choice.finish_reason,
        hasMessage: !!choice.message,
        response: JSON.stringify(choice).substring(0, 500),
      });
      throw new Error(`${providerName} returned empty response`);
    }

    logger.logReasoning(`${providerName.toUpperCase()}_RESPONSE`, {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
    });

    return responseText;
  }

  async processText(
    text: string,
    model: string = "",
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    const trimmedModel = model?.trim?.() || "";
    const isLanCleanup = !!config.lanUrl || this.isLanCleanupMode();
    const providerId = isLanCleanup ? "lan" : config.provider || getModelProvider(trimmedModel);

    if (!trimmedModel && providerId !== "openwhispr" && providerId !== "lan") {
      throw new Error("No reasoning model selected");
    }

    logger.logReasoning("PROVIDER_SELECTION", {
      provider: providerId,
      model: trimmedModel,
      agentName,
      isLanCleanup,
      textLength: text.length,
    });

    const handler = PROVIDER_REGISTRY[providerId];
    if (!handler) {
      throw new Error(`Unsupported reasoning provider: ${providerId}`);
    }

    const startTime = Date.now();
    try {
      const result = await handler.call({
        text,
        model: trimmedModel,
        agentName,
        config,
        ctx: this.providerContext,
      });

      logger.logReasoning("PROVIDER_SUCCESS", {
        provider: providerId,
        model: trimmedModel,
        processingTimeMs: Date.now() - startTime,
        resultLength: result.length,
      });

      return result;
    } catch (error) {
      logger.logReasoning("PROVIDER_ERROR", {
        provider: providerId,
        model: trimmedModel,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  async *processTextStreaming(
    messages: Array<{ role: string; content: string }>,
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string }
  ): AsyncGenerator<string, void, unknown> {
    const cloudProviders = ["openai", "groq", "gemini", "anthropic", "custom"];
    const isLocalProvider = !cloudProviders.includes(provider);

    const settings = getSettings();
    const lanOverride = config.lanUrl?.trim();
    const isLanCleanup = !!lanOverride || this.isLanCleanupMode();

    let endpoint: string;

    if (isLanCleanup) {
      const rawUrl = lanOverride || settings.cleanupRemoteUrl.trim();
      const baseUrl = ensureV1Suffix(rawUrl);
      endpoint = buildApiUrl(baseUrl, "/chat/completions");
    } else if (isLocalProvider) {
      const serverResult = await window.electronAPI.llamaServerStart(model);
      if (!serverResult.success || !serverResult.port) {
        throw new Error(serverResult.error || "Failed to start local model server");
      }
      endpoint = `http://127.0.0.1:${serverResult.port}/v1/chat/completions`;
    } else {
      const providerKey = provider as "openai" | "groq" | "gemini" | "anthropic" | "custom";
      if (providerKey !== "custom") {
        throw new Error(`${providerKey} cloud reasoning is disabled`);
      }

      endpoint = buildApiUrl(
        config.baseUrl?.trim() || getConfiguredOpenAIBase(),
        "/chat/completions"
      );
    }

    const apiConfig = getOpenAiApiConfig(model);
    const useOldTokenParam = isLocalProvider || isLanCleanup || provider === "groq";

    const requestBody: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };

    const maxTokens = config.maxTokens || Math.max(4096, TOKEN_LIMITS.MAX_TOKENS);

    if (useOldTokenParam) {
      requestBody.temperature = config.temperature ?? 0.3;
      requestBody.max_tokens = maxTokens;
    } else {
      requestBody[apiConfig.tokenParam] = maxTokens;
      if (apiConfig.supportsTemperature) {
        requestBody.temperature = config.temperature ?? 0.3;
      }
    }

    applyThinkingSuppression(requestBody, model, provider, config);

    logger.logReasoning("AGENT_STREAM_REQUEST", {
      endpoint,
      model,
      provider,
      isLocal: isLocalProvider,
      isLan: !!isLanCleanup,
      messageCount: messages.length,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    this.streamAbortController = new AbortController();
    const controller = this.streamAbortController;
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === "AbortError") {
        throw new Error("Streaming request timed out");
      }
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage: string;
      try {
        const errorData = JSON.parse(errorText);
        errorMessage =
          errorData.error?.message ||
          errorData.message ||
          errorData.error ||
          `API error: ${response.status}`;
      } catch {
        errorMessage = errorText || `API error: ${response.status}`;
      }
      logger.logReasoning("AGENT_STREAM_ERROR", { status: response.status, errorMessage });
      throw new Error(errorMessage);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let insideThinkBlock = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data);
            let content = parsed.choices?.[0]?.delta?.content;
            if (!content) continue;

            const stripThinking =
              (isLocalProvider || isLanCleanup) && config.disableThinking !== false;
            if (stripThinking) {
              if (insideThinkBlock) {
                const endIdx = content.indexOf("</think>");
                if (endIdx !== -1) {
                  insideThinkBlock = false;
                  content = content.slice(endIdx + 8);
                } else {
                  continue;
                }
              }
              const startIdx = content.indexOf("<think>");
              if (startIdx !== -1) {
                const before = content.slice(0, startIdx);
                const after = content.slice(startIdx + 7);
                const endIdx = after.indexOf("</think>");
                if (endIdx !== -1) {
                  content = before + after.slice(endIdx + 8);
                } else {
                  insideThinkBlock = true;
                  content = before;
                }
              }
              if (!content) continue;
            }

            yield content;
          } catch {
            // skip malformed SSE chunks
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
      this.streamAbortController = null;
      reader.releaseLock();
    }
  }

  async *processTextStreamingAI(
    messages: Array<{ role: string; content: string }>,
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string },
    tools?: Record<string, import("ai").Tool>
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    if (isEnterpriseProvider(provider)) {
      throw new Error(
        "Agent Mode is not yet supported with enterprise providers (Bedrock/Azure/Vertex). " +
          "Switch to Cloud or Local for Agent Mode, or use this provider for text cleanup only."
      );
    }

    const cloudProviders = ["openai", "groq", "gemini", "anthropic", "custom"];
    const isLocalProvider = !cloudProviders.includes(provider);

    const settings = getSettings();
    const lanOverride = config.lanUrl?.trim();
    const isLanCleanup = !!lanOverride || this.isLanCleanupMode();

    if ((isLocalProvider || isLanCleanup) && !tools) {
      const contentGen = this.processTextStreaming(messages, model, provider, config);
      for await (const text of contentGen) {
        yield { type: "content", text };
      }
      yield { type: "done", finishReason: "stop" };
      return;
    }

    let baseURL: string | undefined;

    if (isLanCleanup) {
      const rawUrl = lanOverride || settings.cleanupRemoteUrl.trim();
      baseURL = ensureV1Suffix(rawUrl);
    } else if (isLocalProvider) {
      const serverResult = await window.electronAPI.llamaServerStart(model);
      if (!serverResult.success || !serverResult.port) {
        throw new Error(serverResult.error || "Failed to start local model server");
      }
      baseURL = `http://127.0.0.1:${serverResult.port}/v1`;
    } else {
      const providerKey = provider as "openai" | "groq" | "gemini" | "anthropic" | "custom";
      if (providerKey !== "custom") {
        throw new Error(`${providerKey} cloud reasoning is disabled`);
      }
      baseURL =
        provider === "custom" ? config.baseUrl?.trim() || getConfiguredOpenAIBase() : undefined;
    }
    const apiConfig = getOpenAiApiConfig(model);

    const aiProvider = isLocalProvider || isLanCleanup ? "local" : provider;
    const aiModel = getAIModel(aiProvider, model, baseURL);

    const modelDef = getCloudModel(model);
    const userSuppressesThinking = config.disableThinking === true && !!modelDef?.supportsThinking;
    const needsDisableThinking =
      provider === "groq" && (modelDef?.disableThinking || userSuppressesThinking);

    logger.logReasoning("AGENT_AI_SDK_STREAM_REQUEST", {
      model,
      provider,
      hasTools: !!tools,
      toolCount: tools ? Object.keys(tools).length : 0,
      messageCount: messages.length,
    });

    const useTemperature = isLocalProvider || isLanCleanup || apiConfig.supportsTemperature;

    const result = streamText({
      model: aiModel,
      messages: messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      })),
      tools: tools || undefined,
      stopWhen: stepCountIs(tools ? ReasoningService.MAX_TOOL_STEPS : 1),
      ...(useTemperature ? { temperature: config.temperature ?? 0.3 } : {}),
      maxOutputTokens: config.maxTokens || 4096,
      ...(needsDisableThinking ? { providerOptions: { groq: { reasoningEffort: "none" } } } : {}),
    });

    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        yield { type: "content", text: chunk.text };
      } else if (chunk.type === "tool-call") {
        yield {
          type: "tool_calls",
          calls: [
            {
              id: chunk.toolCallId,
              name: chunk.toolName,
              arguments: JSON.stringify(chunk.input),
            },
          ],
        };
      } else if (chunk.type === "tool-result") {
        const output = chunk.output;
        const displayText =
          typeof output === "string" ? output : output?.error ? String(output.error) : "Done";
        yield {
          type: "tool_result",
          callId: chunk.toolCallId,
          toolName: chunk.toolName,
          displayText,
        };
      } else if (chunk.type === "finish") {
        yield { type: "done", finishReason: chunk.finishReason };
      }
    }
  }

  cancelActiveStream(): void {
    this.streamAbortController?.abort();
    this.streamAbortController = null;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (this.isLanCleanupMode()) {
        logger.logReasoning("PROVIDER_AVAILABILITY_CHECK", { lanCleanup: true });
        return true;
      }

      const settings = getSettings();
      if (settings.cleanupProvider === "custom" && settings.cleanupCloudBaseUrl?.trim()) {
        logger.logReasoning("PROVIDER_AVAILABILITY_CHECK", {
          customProvider: true,
          hasCustomEndpoint: true,
        });
        return true;
      }

      const localAvailable = await window.electronAPI?.checkLocalReasoningAvailable?.();

      logger.logReasoning("PROVIDER_AVAILABILITY_CHECK", {
        hasLocal: !!localAvailable,
      });

      return !!localAvailable;
    } catch (error) {
      logger.logReasoning("PROVIDER_AVAILABILITY_CHECK_ERROR", {
        error: (error as Error).message,
        stack: (error as Error).stack,
        name: (error as Error).name,
      });
      return false;
    }
  }

  destroy(): void {
    this.cancelActiveStream();
  }
}

export default new ReasoningService();
