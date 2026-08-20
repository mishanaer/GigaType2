import modelDataRaw from "./modelRegistryData.json";
import { getSettings } from "../stores/settingsStore";

export interface ModelDefinition {
  id: string;
  name: string;
  size: string;
  sizeBytes: number;
  description: string;
  descriptionKey?: string;
  fileName: string;
  quantization: string;
  contextLength: number;
  hfRepo: string;
  recommended?: boolean;
  supportsThinking?: boolean;
}

export interface LocalProviderData {
  id: string;
  name: string;
  baseUrl: string;
  promptTemplate: string;
  models: ModelDefinition[];
}

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: ModelDefinition[];
  formatPrompt(text: string, systemPrompt: string): string;
}

export interface TranscriptionModelDefinition {
  id: string;
  name: string;
  description: string;
  descriptionKey?: string;
  streaming?: boolean;
}

export interface TranscriptionProviderData {
  id: string;
  name: string;
  baseUrl: string;
  models: TranscriptionModelDefinition[];
}

interface ModelRegistryData {
  transcriptionProviders: TranscriptionProviderData[];
  localProviders: LocalProviderData[];
}

const modelData: ModelRegistryData = modelDataRaw as ModelRegistryData;

function createPromptFormatter(template: string): (text: string, systemPrompt: string) => string {
  return (text: string, systemPrompt: string) => {
    return template.replace("{system}", systemPrompt).replace("{user}", text);
  };
}

class ModelRegistry {
  private static instance: ModelRegistry;
  private providers = new Map<string, ModelProvider>();

  private constructor() {
    this.registerProvidersFromData();
  }

  static getInstance(): ModelRegistry {
    if (!ModelRegistry.instance) {
      ModelRegistry.instance = new ModelRegistry();
    }
    return ModelRegistry.instance;
  }

  registerProvider(provider: ModelProvider) {
    this.providers.set(provider.id, provider);
  }

  getProvider(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  getAllProviders(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  getModel(modelId: string): { model: ModelDefinition; provider: ModelProvider } | undefined {
    for (const provider of this.providers.values()) {
      const model = provider.models.find((m) => m.id === modelId);
      if (model) {
        return { model, provider };
      }
    }
    return undefined;
  }

  getAllModels(): Array<ModelDefinition & { providerId: string }> {
    const models: Array<ModelDefinition & { providerId: string }> = [];
    for (const provider of this.providers.values()) {
      for (const model of provider.models) {
        models.push({ ...model, providerId: provider.id });
      }
    }
    return models;
  }

  getTranscriptionProviders(): TranscriptionProviderData[] {
    return modelData.transcriptionProviders;
  }

  private registerProvidersFromData() {
    const localProviders = modelData.localProviders;

    for (const providerData of localProviders) {
      const formatPrompt = createPromptFormatter(providerData.promptTemplate);

      this.registerProvider({
        id: providerData.id,
        name: providerData.name,
        baseUrl: providerData.baseUrl,
        models: providerData.models,
        formatPrompt,
      });
    }
  }
}

export const modelRegistry = ModelRegistry.getInstance();

export interface ReasoningModel {
  value: string;
  label: string;
  description: string;
  descriptionKey?: string;
}

export interface ReasoningProvider {
  name: string;
  models: ReasoningModel[];
}

export type ReasoningProviders = Record<string, ReasoningProvider>;

function buildReasoningProviders(): ReasoningProviders {
  const providers: ReasoningProviders = {};

  providers.local = {
    name: "Local AI",
    models: modelRegistry.getAllModels().map((model) => ({
      value: model.id,
      label: model.name,
      description: `${model.description} (${model.size})`,
      descriptionKey: model.descriptionKey,
    })),
  };

  return providers;
}

export const REASONING_PROVIDERS = buildReasoningProviders();

export interface ReasoningModelWithProvider extends ReasoningModel {
  provider: string;
  fullLabel: string;
}

export function getAllReasoningModels(): ReasoningModelWithProvider[] {
  return Object.entries(REASONING_PROVIDERS).flatMap(([providerId, provider]) =>
    provider.models.map((model) => ({
      ...model,
      provider: providerId,
      fullLabel: `${provider.name} ${model.label}`,
    }))
  );
}

export function getReasoningModelLabel(modelId: string): string {
  const model = getAllReasoningModels().find((m) => m.value === modelId);
  return model?.fullLabel || modelId;
}

export function getModelProvider(modelId: string): string {
  if (getSettings().cleanupProvider === "custom") {
    return "custom";
  }

  const model = getAllReasoningModels().find((m) => m.value === modelId);
  return model?.provider || "local";
}

export function getTranscriptionProviders(): TranscriptionProviderData[] {
  return modelRegistry.getTranscriptionProviders();
}

export function getStreamingTranscriptionProviders(): TranscriptionProviderData[] {
  return modelRegistry
    .getTranscriptionProviders()
    .map((p) => ({ ...p, models: p.models.filter((m) => m.streaming) }))
    .filter((p) => p.models.length > 0);
}

export function getTranscriptionProvider(
  providerId: string
): TranscriptionProviderData | undefined {
  return getTranscriptionProviders().find((p) => p.id === providerId);
}

export function getTranscriptionModels(providerId: string): TranscriptionModelDefinition[] {
  const provider = getTranscriptionProvider(providerId);
  return provider?.models || [];
}

export function getDefaultTranscriptionModel(providerId: string): string {
  const models = getTranscriptionModels(providerId);
  return models[0]?.id || "gigaam-v3-e2e-rnnt";
}

export function getLocalModel(modelId: string): ModelDefinition | undefined {
  return modelRegistry.getModel(modelId)?.model;
}

export interface OpenAiApiConfig {
  tokenParam: "max_tokens" | "max_completion_tokens";
  supportsTemperature: boolean;
}

// Self-hosted OpenAI-compatible servers accept arbitrary model ids, so this is
// pure heuristics over the id.
export function getOpenAiApiConfig(modelId: string): OpenAiApiConfig {
  const isLegacy =
    modelId.startsWith("gpt-3") ||
    modelId.startsWith("gpt-4o") ||
    modelId.startsWith("gpt-4-") ||
    modelId === "gpt-4";

  if (isLegacy) {
    return { tokenParam: "max_tokens", supportsTemperature: true };
  }

  // gpt-4.1* supports temperature but uses max_completion_tokens
  if (modelId.startsWith("gpt-4.1")) {
    return { tokenParam: "max_completion_tokens", supportsTemperature: true };
  }

  // gpt-5* reasoning models: no temperature
  return { tokenParam: "max_completion_tokens", supportsTemperature: false };
}
