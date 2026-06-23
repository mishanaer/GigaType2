import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  LlamaServerStatus,
  LlamaVulkanStatus,
  VulkanGpuResult,
  LlamaVulkanDownloadProgress,
  InferenceMode,
} from "../types/electron";
import { Button } from "./ui/button";
import { Zap } from "lucide-react";
import LocalModelPicker, { type LocalProvider } from "./LocalModelPicker";
import logger from "../utils/logger";
import { modelRegistry } from "../models/ModelRegistry";
import { getCachedPlatform } from "../utils/platform";

interface ReasoningModelSelectorProps {
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
  localReasoningProvider: string;
  setLocalReasoningProvider: (provider: string) => void;
  setReasoningMode?: (mode: InferenceMode) => void;
}

function GpuStatusBadge() {
  const { t } = useTranslation();
  const [serverStatus, setServerStatus] = useState<LlamaServerStatus | null>(null);
  const [vulkanStatus, setVulkanStatus] = useState<LlamaVulkanStatus | null>(null);
  const [gpuResult, setGpuResult] = useState<VulkanGpuResult | null>(null);
  const [progress, setProgress] = useState<LlamaVulkanDownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [activationFailed, setActivationFailed] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem("llamaVulkanBannerDismissed") === "true"
  );
  const platform = getCachedPlatform();

  useEffect(() => {
    const poll = () => {
      window.electronAPI
        ?.llamaServerStatus?.()
        .then(setServerStatus)
        .catch(() => {});
      if (platform !== "darwin") {
        window.electronAPI
          ?.getLlamaVulkanStatus?.()
          .then(setVulkanStatus)
          .catch(() => {});
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [platform]);

  useEffect(() => {
    if (platform !== "darwin") {
      window.electronAPI
        ?.detectVulkanGpu?.()
        .then(setGpuResult)
        .catch(() => {});
    }
  }, [platform]);

  useEffect(() => {
    const cleanup = window.electronAPI?.onLlamaVulkanDownloadProgress?.((data) => {
      setProgress(data);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    if (!activating) return;
    if (serverStatus?.gpuAccelerated || vulkanStatus?.downloaded) {
      setActivating(false);
      setActivationFailed(false);
      return;
    }
    const timeout = setTimeout(() => {
      setActivating(false);
      setActivationFailed(true);
    }, 10000);
    const fastPoll = setInterval(() => {
      window.electronAPI
        ?.llamaServerStatus?.()
        .then(setServerStatus)
        .catch(() => {});
      window.electronAPI
        ?.getLlamaVulkanStatus?.()
        .then(setVulkanStatus)
        .catch(() => {});
    }, 1000);
    return () => {
      clearTimeout(timeout);
      clearInterval(fastPoll);
    };
  }, [activating, serverStatus?.gpuAccelerated, vulkanStatus?.downloaded]);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.downloadLlamaVulkanBinary?.();
      if (result?.success) {
        setVulkanStatus((prev) => (prev ? { ...prev, downloaded: true } : prev));
        await window.electronAPI?.llamaGpuReset?.();
        setActivating(true);
        setActivationFailed(false);
      } else if (result && !result.cancelled) {
        setError(result.error || t("gpu.activationFailed"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gpu.activationFailed"));
    } finally {
      setDownloading(false);
      setProgress(null);
    }
  };

  const handleDelete = async () => {
    await window.electronAPI?.deleteLlamaVulkanBinary?.();
    setVulkanStatus((prev) => (prev ? { ...prev, downloaded: false } : prev));
  };

  const handleRetry = async () => {
    setActivationFailed(false);
    setActivating(true);
    await window.electronAPI?.llamaGpuReset?.();
  };

  // State 1: macOS
  if (platform === "darwin") {
    if (!serverStatus?.running) return null;
    return (
      <div className="flex items-center gap-1.5 mt-2 px-1">
        <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-success" />
        <span className="text-xs text-muted-foreground">{t("gpu.active")}</span>
      </div>
    );
  }

  // State 3: Downloading
  if (downloading && progress) {
    return (
      <div className="flex items-center gap-2 mt-2 px-1">
        <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${progress.percentage}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">{progress.percentage}%</span>
        <button
          type="button"
          onClick={() => window.electronAPI?.cancelLlamaVulkanDownload?.()}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t("gpu.cancel")}
        </button>
      </div>
    );
  }

  // State 3b: Error
  if (error) {
    return (
      <div className="flex items-center gap-1.5 mt-2 px-1">
        <span className="text-xs text-destructive">{error}</span>
        <button
          type="button"
          onClick={() => setError(null)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-1"
        >
          {t("gpu.dismiss")}
        </button>
      </div>
    );
  }

  // State 5: Activating
  if (activating) {
    return (
      <div className="flex items-center gap-1.5 mt-2 px-1">
        <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-primary animate-pulse" />
        <span className="text-xs text-muted-foreground">{t("gpu.activating")}</span>
      </div>
    );
  }

  // State 4: Downloaded + GPU active
  if (vulkanStatus?.downloaded) {
    const isGpu = serverStatus?.gpuAccelerated && serverStatus?.backend === "vulkan";

    // State 6: Activation failed
    if (!isGpu && activationFailed) {
      return (
        <div className="flex items-center gap-1.5 mt-2 px-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-warning" />
          <span className="text-xs text-muted-foreground">{t("gpu.activationFailed")}</span>
          <button
            type="button"
            onClick={handleRetry}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-1"
          >
            {t("gpu.retry")}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
          >
            {t("gpu.remove")}
          </button>
        </div>
      );
    }

    // State 4: GPU active or just downloaded
    return (
      <div className="flex items-center gap-1.5 mt-2 px-1">
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${isGpu ? "bg-success" : "bg-primary"}`}
        />
        <span className="text-xs text-muted-foreground">
          {isGpu ? t("gpu.active") : t("gpu.ready")}
        </span>
        <button
          type="button"
          onClick={handleDelete}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
        >
          {t("gpu.remove")}
        </button>
      </div>
    );
  }

  // State 7: GPU available, not downloaded — show banner
  if (gpuResult?.available && !dismissed) {
    return (
      <div className="mt-2 rounded-md border border-primary/20 bg-primary/5 p-2.5">
        <div className="flex items-start gap-2.5">
          <Zap size={13} className="text-primary shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground">{t("gpu.reasoningBanner")}</p>
            <div className="flex items-center gap-2 mt-1.5">
              <Button
                onClick={handleDownload}
                size="sm"
                variant="default"
                className="h-6 px-2.5 text-xs"
              >
                {t("gpu.enableButton")}
              </Button>
              <button
                onClick={() => {
                  localStorage.setItem("llamaVulkanBannerDismissed", "true");
                  setDismissed(true);
                }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("gpu.dismiss")}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export default function ReasoningModelSelector({
  reasoningModel,
  setReasoningModel,
  localReasoningProvider,
  setLocalReasoningProvider,
  setReasoningMode: setReasoningModeProp,
}: ReasoningModelSelectorProps) {
  const [selectedLocalProvider, setSelectedLocalProvider] = useState("qwen");

  const localProviders = useMemo<LocalProvider[]>(() => {
    return modelRegistry.getAllProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        size: model.size,
        sizeBytes: model.sizeBytes,
        description: model.description,
        descriptionKey: model.descriptionKey,
        specUrl: model.hfRepo ? `https://huggingface.co/${model.hfRepo}` : undefined,
        recommended: model.recommended,
      })),
    }));
  }, []);

  useEffect(() => {
    const localProviderIds = localProviders.map((p) => p.id);
    if (localProviderIds.includes(localReasoningProvider)) {
      setSelectedLocalProvider(localReasoningProvider);
      return;
    }

    setSelectedLocalProvider("qwen");
    setReasoningModeProp?.("local");
    setLocalReasoningProvider("qwen");
    setReasoningModel("");
  }, [
    localProviders,
    localReasoningProvider,
    setLocalReasoningProvider,
    setReasoningModeProp,
    setReasoningModel,
  ]);

  const [downloadedModels, setDownloadedModels] = useState<Set<string>>(new Set());

  const loadDownloadedModels = useCallback(async () => {
    try {
      const result = await window.electronAPI?.modelGetAll?.();
      if (result && Array.isArray(result)) {
        const downloaded = new Set(
          result
            .filter((m: { isDownloaded?: boolean }) => m.isDownloaded)
            .map((m: { id: string }) => m.id)
        );
        setDownloadedModels(downloaded);
        return downloaded;
      }
    } catch (error) {
      logger.error("Failed to load downloaded models", { error }, "models");
    }
    return new Set<string>();
  }, []);

  useEffect(() => {
    loadDownloadedModels();
  }, [loadDownloadedModels]);

  const handleLocalProviderChange = async (providerId: string) => {
    setReasoningModeProp?.("local");
    setSelectedLocalProvider(providerId);
    setLocalReasoningProvider(providerId);
    const downloaded = await loadDownloadedModels();
    const provider = localProviders.find((p) => p.id === providerId);
    const models = provider?.models ?? [];
    if (models.length > 0) {
      const firstDownloaded = models.find((m) => downloaded.has(m.id));
      if (firstDownloaded) {
        setReasoningModel(firstDownloaded.id);
      } else {
        setReasoningModel("");
      }
    }
  };

  return (
    <div className="space-y-4">
      <LocalModelPicker
        providers={localProviders}
        selectedModel={reasoningModel}
        selectedProvider={selectedLocalProvider}
        onModelSelect={setReasoningModel}
        onProviderSelect={handleLocalProviderChange}
        modelType="llm"
        colorScheme="purple"
        onDownloadComplete={loadDownloadedModels}
      />
      <GpuStatusBadge />
    </div>
  );
}
