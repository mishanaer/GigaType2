import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Cpu, Network } from "lucide-react";
import {
  useSettingsStore,
  selectResolvedLLMConfig,
  setResolvedLLMConfig,
} from "../../stores/settingsStore";
import { InferenceModeSelector } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import ReasoningModelSelector from "../ReasoningModelSelector";
import OpenAICompatiblePanel from "../OpenAICompatiblePanel";
import { Toggle } from "../ui/toggle";
import type { InferenceMode } from "../../types/electron";
import type { InferenceScope } from "../../config/inferenceScopes";
import { modelRegistry, getLocalModel } from "../../models/ModelRegistry";

function isProviderValidForMode(provider: string, mode: InferenceMode): boolean {
  switch (mode) {
    case "local":
      return modelRegistry.getAllProviders().some((p) => p.id === provider);
    default:
      return true;
  }
}

const MODE_LABEL_PREFIX: Record<InferenceScope, string> = {
  dictationCleanup: "settingsPage.aiModels.modes",
  noteFormatting: "settingsPage.aiModels.modes",
  dictationAgent: "dictationAgent.modes",
  chatIntelligence: "agentMode.settings.modes",
};

interface InferenceConfigEditorProps {
  scope: InferenceScope;
  onModeChange?: (mode: InferenceMode) => void;
}

export default function InferenceConfigEditor({ scope, onModeChange }: InferenceConfigEditorProps) {
  const { t } = useTranslation();
  const config = useSettingsStore(useShallow((s) => selectResolvedLLMConfig(s, scope)));
  const effectiveMode = config.mode === "providers" ? "local" : config.mode;

  useEffect(() => {
    if (config.mode === "providers") {
      setResolvedLLMConfig(scope, { mode: "local" });
    }
  }, [config.mode, scope]);

  const prefix = MODE_LABEL_PREFIX[scope];
  const modes: InferenceModeOption[] = [
    {
      id: "local",
      label: t(`${prefix}.local`),
      description: t(`${prefix}.localDesc`),
      icon: <Cpu className="w-4 h-4" />,
    },
    {
      id: "self-hosted",
      label: t(`${prefix}.selfHosted`),
      description: t(`${prefix}.selfHostedDesc`),
      icon: <Network className="w-4 h-4" />,
    },
  ];

  const setField = useCallback(
    <K extends keyof Omit<typeof config, "scope">>(field: K) =>
      (value: NonNullable<(typeof config)[K]>) => {
        setResolvedLLMConfig(scope, { [field]: value });
      },
    [scope]
  );

  const handleModeSelect = useCallback(
    (mode: InferenceMode) => {
      if (mode === config.mode) return;

      const patch: Parameters<typeof setResolvedLLMConfig>[1] = {
        mode,
      };
      if (!isProviderValidForMode(config.provider, mode)) {
        patch.provider = "";
        patch.model = "";
      }
      setResolvedLLMConfig(scope, patch);

      if (mode === "self-hosted") {
        window.electronAPI?.llamaServerStop?.();
      }

      onModeChange?.(mode);
    },
    [scope, config.mode, config.provider, onModeChange]
  );

  const setMode = setField("mode");
  const setProvider = setField("provider");
  const setModel = setField("model");

  const renderModelSelector = () => (
    <ReasoningModelSelector
      reasoningModel={config.model}
      setReasoningModel={setModel}
      localReasoningProvider={config.provider}
      setLocalReasoningProvider={setProvider}
      setReasoningMode={setMode}
    />
  );

  const showThinkingToggle =
    effectiveMode === "self-hosted" ||
    (effectiveMode === "local" && !!getLocalModel(config.model)?.supportsThinking);

  return (
    <div className="space-y-3">
      <InferenceModeSelector modes={modes} activeMode={effectiveMode} onSelect={handleModeSelect} />

      {effectiveMode === "local" && renderModelSelector()}

      {effectiveMode === "self-hosted" && (
        <OpenAICompatiblePanel
          baseUrl={config.remoteUrl ?? ""}
          setBaseUrl={setField("remoteUrl")}
          model={config.model}
          setModel={setModel}
          baseUrlPlaceholder="http://192.168.1.126:11434/v1"
          helpExamples={
            <p className="text-xs text-muted-foreground">
              {t("reasoning.selfHosted.endpointHelp")}
            </p>
          }
        />
      )}

      {showThinkingToggle && (
        <div className="flex items-start justify-between gap-3 pt-1">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-foreground">
              {t("reasoning.disableThinking.label")}
            </h4>
            <p className="text-xs text-muted-foreground">{t("reasoning.disableThinking.help")}</p>
          </div>
          <Toggle checked={config.disableThinking} onChange={setField("disableThinking")} />
        </div>
      )}
    </div>
  );
}
