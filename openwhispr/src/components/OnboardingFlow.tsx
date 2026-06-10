import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import TitleBar from "./TitleBar";
import PermissionsSection from "./ui/PermissionsSection";
import { AlertDialog, ConfirmDialog } from "./ui/dialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useDialogs } from "../hooks/useDialogs";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useSettings } from "../hooks/useSettings";
import { useGigaamSidecarStatus } from "../hooks/useGigaamSidecarStatus";
import { setAgentName as saveAgentName } from "../utils/agentName";
import { getDefaultHotkey, isGlobeLikeHotkey } from "../utils/hotkeys";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { getPlatform } from "../utils/platform";
import logger from "../utils/logger";
import {
  ONBOARDING_CURRENT_STEP_KEY,
  markGigaTypeOnboardingCompleted,
} from "../utils/onboardingState";

interface OnboardingFlowProps {
  onComplete: () => void;
}

function formatBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return "0 МБ";
  const mb = bytes / 1_000_000;
  if (mb < 1000) return `${Math.round(mb)} МБ`;
  return `${(mb / 1000).toFixed(1)} ГБ`;
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t } = useTranslation();

  const getMaxStep = () => 1;

  const [currentStep, setCurrentStep, removeCurrentStep] = useLocalStorage(
    ONBOARDING_CURRENT_STEP_KEY,
    0,
    {
      serialize: String,
      deserialize: (value) => {
        const parsed = parseInt(value, 10);
        // Clamp to valid range to handle users upgrading from older versions
        // with different step counts
        if (isNaN(parsed) || parsed < 0) return 0;
        const maxStep = getMaxStep();
        if (parsed > maxStep) return maxStep;
        return parsed;
      },
    }
  );
  const { dictationKey, setDictationKey } = useSettings();
  const { status: gigaamStatus, restart: restartGigaam, isRestarting: isRestartingGigaam } =
    useGigaamSidecarStatus();

  const [hotkey, setHotkey] = useState(dictationKey || getDefaultHotkey());
  const { alertDialog, confirmDialog, showAlertDialog, hideAlertDialog, hideConfirmDialog } =
    useDialogs();
  const autoRegisterInFlightRef = useRef(false);
  const hotkeyStepInitializedRef = useRef(false);

  const { registerHotkey } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setHotkey(registeredHotkey);
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: false,
  });

  const permissionsHook = usePermissions(showAlertDialog);
  useClipboard(showAlertDialog); // Initialize clipboard hook for permission checks

  useEffect(() => {
    const migrationKey = "onboardingSetupStepRemoved";
    if (localStorage.getItem(migrationKey) === "1") return;

    const raw = localStorage.getItem("onboardingCurrentStep");
    const parsed = raw == null ? NaN : parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      setCurrentStep(Math.min(parsed - 1, getMaxStep()));
    }
    localStorage.setItem(migrationKey, "1");
  }, [setCurrentStep]);

  // Update wizard UI when backend falls back to a different hotkey.
  // Only update local state — don't persist to localStorage so the app
  // retries the preferred key on next launch.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onHotkeyFallbackUsed?.((data: { fallback: string }) => {
      if (data?.fallback) {
        setHotkey(data.fallback);
      }
    });
    return () => unsubscribe?.();
  }, []);

  const modelStepIndex = 1;

  useEffect(() => {
    if (currentStep !== modelStepIndex) {
      hotkeyStepInitializedRef.current = false;
      return;
    }

    // Prevent double-invocation from React.StrictMode
    if (autoRegisterInFlightRef.current || hotkeyStepInitializedRef.current) {
      return;
    }

    const autoRegisterDefaultHotkey = async () => {
      autoRegisterInFlightRef.current = true;
      hotkeyStepInitializedRef.current = true;

      try {
        // Check if backend already registered a hotkey (e.g., KDE D-Bus fallback)
        const backendKey = localStorage.getItem("dictationKey");
        if (backendKey && backendKey.trim() !== "") {
          setHotkey(backendKey);
          setDictationKey(backendKey);
          return;
        }

        // Get platform-appropriate default hotkey from backend (accounts for
        // X11 modifier-only and GNOME gsettings limitations)
        const defaultHotkey =
          (await window.electronAPI?.getEffectiveDefaultHotkey?.()) || getDefaultHotkey();
        const platform = window.electronAPI?.getPlatform?.() ?? "darwin";

        // Only auto-register if no hotkey is currently set
        const shouldAutoRegister =
          !hotkey || hotkey.trim() === "" || (platform !== "darwin" && isGlobeLikeHotkey(hotkey));

        if (shouldAutoRegister) {
          // Try to register the default hotkey silently
          const success = await registerHotkey(defaultHotkey);
          if (success) {
            setHotkey(defaultHotkey);
          }
        }
      } catch (error) {
        logger.error("Failed to auto-register default hotkey", { error }, "onboarding");
      } finally {
        autoRegisterInFlightRef.current = false;
      }
    };

    void autoRegisterDefaultHotkey();
  }, [currentStep, hotkey, registerHotkey, modelStepIndex, setDictationKey]);

  useEffect(() => {
    if (currentStep !== modelStepIndex) return;
    if (gigaamStatus?.available && gigaamStatus.healthStatus === "stopped") {
      void restartGigaam();
    }
  }, [
    currentStep,
    modelStepIndex,
    gigaamStatus?.available,
    gigaamStatus?.healthStatus,
    restartGigaam,
  ]);

  const ensureHotkeyRegistered = useCallback(async () => {
    if (!window.electronAPI?.updateHotkey) {
      return true;
    }

    try {
      const result = await window.electronAPI.updateHotkey(hotkey);
      if (result && !result.success) {
        showAlertDialog({
          title: t("onboarding.hotkey.couldNotRegisterTitle"),
          description: result.message || t("onboarding.hotkey.couldNotRegisterDescription"),
        });
        return false;
      }
      return true;
    } catch (error) {
      logger.error("Failed to register onboarding hotkey", { error }, "onboarding");
      showAlertDialog({
        title: t("onboarding.hotkey.couldNotRegisterTitle"),
        description: t("onboarding.hotkey.couldNotRegisterDescription"),
      });
      return false;
    }
  }, [hotkey, showAlertDialog, t]);

  const saveSettings = useCallback(async () => {
    const hotkeyRegistered = await ensureHotkeyRegistered();
    if (!hotkeyRegistered) {
      return false;
    }
    setDictationKey(hotkey);
    saveAgentName("GigaType");

    localStorage.setItem("authenticationSkipped", "true");
    markGigaTypeOnboardingCompleted();
    localStorage.setItem("skipAuth", "true");
    localStorage.setItem("isSignedIn", "false");

    // Fresh install: write the bundle-migration sentinel so the
    // PostMigrationOnboarding modal doesn't fire on next launch.
    // Migrating users skip onboarding entirely (their flag carries over
    // via productName-keyed userData), so they never reach this code.
    void window.electronAPI?.markBundleMigrated?.();

    try {
      await window.electronAPI?.saveAllKeysToEnv?.();
    } catch (error) {
      logger.error("Failed to persist API keys", { error }, "onboarding");
    }

    return true;
  }, [hotkey, setDictationKey, ensureHotkeyRegistered]);

  const arePermissionsReady = useCallback(() => {
    if (!permissionsHook.micPermissionGranted) return false;
    if (getPlatform() !== "darwin") return true;
    return permissionsHook.accessibilityPermissionGranted;
  }, [permissionsHook.micPermissionGranted, permissionsHook.accessibilityPermissionGranted]);

  useEffect(() => {
    if (currentStep === 0 || arePermissionsReady()) return;

    void logger.warn(
      "Resetting onboarding to permissions step because permissions are missing",
      {
        currentStep,
        micPermissionGranted: permissionsHook.micPermissionGranted,
        accessibilityPermissionGranted: permissionsHook.accessibilityPermissionGranted,
      },
      "onboarding"
    );
    setCurrentStep(0);
  }, [
    currentStep,
    arePermissionsReady,
    permissionsHook.micPermissionGranted,
    permissionsHook.accessibilityPermissionGranted,
    setCurrentStep,
  ]);

  const nextStep = useCallback(async () => {
    if (currentStep >= getMaxStep()) {
      return;
    }

    const newStep = currentStep + 1;
    setCurrentStep(newStep);

  }, [currentStep, setCurrentStep]);

  useEffect(() => {
    if (currentStep !== 0 || !arePermissionsReady()) return;
    void nextStep();
  }, [currentStep, arePermissionsReady, nextStep]);

  const finishOnboarding = useCallback(async () => {
    const saved = await saveSettings();
    if (!saved) {
      return;
    }

    removeCurrentStep();
    onComplete();
  }, [saveSettings, removeCurrentStep, onComplete]);

  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return <PermissionsSection permissions={permissionsHook} />;

      case 1:
        return renderModelStep();

      default:
        return null;
    }
  };

  const renderModelStep = () => {
    const isReady = gigaamStatus?.healthStatus === "ok" || gigaamStatus?.modelStage === "ready";
    const isError = gigaamStatus?.healthStatus === "error" || gigaamStatus?.modelStage === "error";
    const progress = isReady
      ? 100
      : Math.max(0, Math.min(99, Math.floor(gigaamStatus?.modelProgress ?? 0)));
    const downloadedBytes = isReady
      ? gigaamStatus?.modelTotalBytes
      : gigaamStatus?.modelDownloadedBytes;
    const totalBytes = gigaamStatus?.modelTotalBytes;

    let title = "Проверяем модель";
    let description = "GigaType готовит локальную GigaAM для распознавания речи.";

    if (!gigaamStatus) {
      title = "Проверяем модель";
      description = "Получаем статус локальной GigaAM.";
    } else if (!gigaamStatus.available) {
      title = "GigaAM недоступна";
      description = "Локальная модель доступна только в macOS сборке для Apple Silicon.";
    } else if (isError) {
      title = "Не удалось подготовить модель";
      description = gigaamStatus.healthDetail || "Проверьте подключение к интернету и попробуйте ещё раз.";
    } else if (isReady) {
      title = "Модель готова";
      description = "GigaAM загружена и готова к диктовке.";
    } else if (gigaamStatus.modelStage === "loading" || gigaamStatus.modelCacheComplete) {
      title = "Загружаем модель в память";
      description = "Файлы уже на компьютере. Осталось дождаться запуска GigaAM.";
    } else if (gigaamStatus.modelStage === "downloading") {
      title = "Загружаем модель";
      description = "Первый запуск может занять несколько минут.";
    }

    return (
      <div className="mx-auto w-full max-w-[500px] space-y-5">
        <div className="text-center space-y-1">
          <h2 className="text-xl font-semibold text-foreground tracking-tight">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>

        <div className="rounded-lg border border-border bg-neutral-50 p-5">
          <div className="mb-3 flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-2">
              {isError ? (
                <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
              ) : !isReady ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : null}
              <span className="truncate text-sm font-medium text-foreground">GigaAM e2e RNNT</span>
            </div>
            <span className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground">
              {progress}%
            </span>
          </div>

          <Progress value={progress} className="h-2" />

          <div className="mt-3 flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <span>{isReady ? "Готово" : isError ? "Ошибка" : "Подготовка"}</span>
            {totalBytes ? (
              <span className="tabular-nums">
                {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex justify-center">
          {isReady ? (
            <Button onClick={finishOnboarding} size="xl">
              Начать
            </Button>
          ) : isError || gigaamStatus?.healthStatus === "stopped" ? (
            <Button
              onClick={() => restartGigaam()}
              disabled={isRestartingGigaam}
              className="h-10 rounded-full px-7"
            >
              {isRestartingGigaam ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCw className="h-4 w-4" />
              )}
              Повторить
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  // Load Google Font only in the browser
  React.useEffect(() => {
    const link = document.createElement("link");
    link.href =
      "https://fonts.googleapis.com/css2?family=Noto+Sans:wght@300;400;500;600;700&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, []);

  return (
    <div
      className="h-screen flex flex-col bg-background"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <div className="shrink-0 z-10">
        <TitleBar
          showTitle={true}
          showQuitButton={false}
          className="bg-background backdrop-blur-xl border-b border-border shadow-sm"
        ></TitleBar>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-10 md:px-12">
        <div className="mx-auto flex min-h-full w-full max-w-3xl items-center justify-center">
          <div className="w-full">{renderStep()}</div>
        </div>
      </div>

    </div>
  );
}
