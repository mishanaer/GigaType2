import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ProviderTabs } from "./ui/ProviderTabs";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import ModelCardList, { type ModelCardOption } from "./ui/ModelCardList";
import { useModelDownload, type ModelType } from "../hooks/useModelDownload";
import { MODEL_PICKER_COLORS, type ColorScheme } from "../utils/modelPickerStyles";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";

export interface LocalModel {
  id: string;
  name: string;
  size: string;
  sizeBytes?: number;
  description: string;
  descriptionKey?: string;
  specUrl?: string;
  isDownloaded?: boolean;
  downloaded?: boolean;
  recommended?: boolean;
}

export interface LocalProvider {
  id: string;
  name: string;
  models: LocalModel[];
}

interface LocalModelPickerProps {
  providers: LocalProvider[];
  selectedModel: string;
  selectedProvider: string;
  onModelSelect: (modelId: string) => void;
  onProviderSelect: (providerId: string) => void;
  modelType: ModelType;
  colorScheme?: Exclude<ColorScheme, "blue">;
  className?: string;
  onDownloadComplete?: () => void;
}

export default function LocalModelPicker({
  providers,
  selectedModel,
  selectedProvider,
  onModelSelect,
  onProviderSelect,
  modelType,
  colorScheme = "purple",
  className = "",
  onDownloadComplete,
}: LocalModelPickerProps) {
  const { t } = useTranslation();
  const [downloadedModels, setDownloadedModels] = useState<Set<string>>(new Set());

  const styles = useMemo(() => MODEL_PICKER_COLORS[colorScheme], [colorScheme]);

  const loadDownloadedModels = useCallback(async () => {
    try {
      let downloaded = new Set<string>();
      const result = await window.electronAPI?.modelGetAll?.();
      if (result && Array.isArray(result)) {
        downloaded = new Set(
          result
            .filter((m: { isDownloaded?: boolean }) => m.isDownloaded)
            .map((m: { id: string }) => m.id)
        );
      }
      setDownloadedModels(downloaded);
      return downloaded;
    } catch (error) {
      console.error("Failed to load downloaded models:", error);
      return new Set<string>();
    }
  }, []);

  useEffect(() => {
    const initAndValidate = async () => {
      const downloaded = await loadDownloadedModels();
      if (selectedModel && !downloaded.has(selectedModel)) {
        onModelSelect("");
      }
    };
    initAndValidate();
  }, [loadDownloadedModels, selectedModel, onModelSelect]);

  const handleDownloadComplete = useCallback(() => {
    loadDownloadedModels();
    onDownloadComplete?.();
  }, [loadDownloadedModels, onDownloadComplete]);

  const {
    downloadingModel,
    downloadProgress,
    downloadModel,
    isDownloadingModel,
    cancelDownload,
    isCancelling,
  } = useModelDownload({
    modelType,
    onDownloadComplete: handleDownloadComplete,
    onModelsCleared: loadDownloadedModels,
  });

  const handleDownload = useCallback(
    (modelId: string) => {
      downloadModel(modelId, onModelSelect);
    },
    [downloadModel, onModelSelect]
  );

  const currentProvider = providers.find((p) => p.id === selectedProvider);
  const models = useMemo(() => currentProvider?.models || [], [currentProvider?.models]);

  const progressDisplay = useMemo(() => {
    if (!downloadingModel) return null;

    const modelName = models.find((m) => m.id === downloadingModel)?.name || downloadingModel;

    return <DownloadProgressBar modelName={modelName} progress={downloadProgress} />;
  }, [downloadingModel, downloadProgress, models]);

  return (
    <div className={className}>
      <ProviderTabs
        providers={providers}
        selectedId={selectedProvider}
        onSelect={onProviderSelect}
        colorScheme={colorScheme}
        scrollable
      />

      {progressDisplay}

      <div className="mt-2">
        <h5 className={`${styles.header} mb-2`}>{t("common.availableModels")}</h5>

        <ModelCardList
          models={models.map(
            (model): ModelCardOption => ({
              value: model.id,
              label: model.name,
              description: model.size,
              specUrl: model.specUrl,
              icon: getProviderIcon(selectedProvider),
              invertInDark: isMonochromeProvider(selectedProvider),
              recommended: model.recommended,
              isDownloaded:
                downloadedModels.has(model.id) || model.isDownloaded || model.downloaded,
              isDownloading: isDownloadingModel(model.id),
            })
          )}
          selectedModel={selectedModel}
          onModelSelect={onModelSelect}
          onDownload={handleDownload}
          onCancelDownload={cancelDownload}
          isCancelling={isCancelling}
          colorScheme={colorScheme}
        />
      </div>
    </div>
  );
}
