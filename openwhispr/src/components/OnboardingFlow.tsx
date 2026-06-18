import { useState, useEffect, useCallback, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
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
import { useAppshotsAppleSkin } from "../hooks/useAppshotsAppleSkin";
import { getPlatform } from "../utils/platform";
import logger from "../utils/logger";
import GigaamModelPreparationStep from "./GigaamModelPreparationStep";
import { areRequiredPermissionsMet } from "../utils/permissions";
import {
  ONBOARDING_CURRENT_STEP_KEY,
  markGigaTypeOnboardingCompleted,
} from "../utils/onboardingState";

interface OnboardingFlowProps {
  onComplete: () => void;
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t } = useTranslation();
  useAppshotsAppleSkin();

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
  const {
    status: gigaamStatus,
    restart: restartGigaam,
    isRestarting: isRestartingGigaam,
  } = useGigaamSidecarStatus();

  const [hotkey, setHotkey] = useState(dictationKey || getDefaultHotkey());
  const { alertDialog, confirmDialog, showAlertDialog, hideAlertDialog, hideConfirmDialog } =
    useDialogs();
  const autoRegisterInFlightRef = useRef(false);
  const hotkeyStepInitializedRef = useRef(false);
  const appshotsContentRef = useRef<HTMLDivElement | null>(null);
  const resizeFrameRef = useRef<number | null>(null);

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
      await window.electronAPI?.saveRuntimeConfigToEnv?.();
    } catch (error) {
      logger.error("Failed to persist runtime config", { error }, "onboarding");
    }

    return true;
  }, [hotkey, setDictationKey, ensureHotkeyRegistered]);

  const arePermissionsReady = useCallback(() => {
    return areRequiredPermissionsMet(
      permissionsHook.micPermissionGranted,
      getPlatform(),
      permissionsHook.accessibilityPermissionGranted
    );
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
        return <PermissionsSection permissions={permissionsHook} variant="appshots" />;

      case 1:
        return renderModelStep();

      default:
        return null;
    }
  };

  const renderModelStep = () => {
    return (
      <GigaamModelPreparationStep
        status={gigaamStatus}
        restart={restartGigaam}
        isRestarting={isRestartingGigaam}
        showReadyAction
        readyActionLabel="Начать"
        onReadyAction={finishOnboarding}
      />
    );
  };

  const resizeAppshotsWindowToContent = useCallback(() => {
    if (resizeFrameRef.current !== null) {
      cancelAnimationFrame(resizeFrameRef.current);
    }

    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      const content = appshotsContentRef.current;
      if (!content) return;

      const height = Math.ceil(content.getBoundingClientRect().height);
      window.electronAPI?.resizeControlPanelToContent?.(height, 500)?.catch(() => undefined);
    });
  }, []);

  useLayoutEffect(() => {
    resizeAppshotsWindowToContent();

    const content = appshotsContentRef.current;
    if (!content) return undefined;

    const observer = new ResizeObserver(resizeAppshotsWindowToContent);
    observer.observe(content);

    return () => {
      observer.disconnect();
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, [currentStep, resizeAppshotsWindowToContent]);

  return (
    <div
      ref={appshotsContentRef}
      className="appshots-permissions-window flex w-[500px] flex-col overflow-hidden"
    >
      <div className="appshots-window-drag-layer" aria-hidden="true" />

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

      <div className="appshots-window-content overflow-hidden p-0">
        <div className="mx-auto w-full">
          <div className="w-full">{renderStep()}</div>
        </div>
      </div>
    </div>
  );
}
