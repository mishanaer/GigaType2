import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Check, Shield, Command } from "lucide-react";
import TitleBar from "./TitleBar";
import PermissionsSection from "./ui/PermissionsSection";
import StepProgress from "./ui/StepProgress";
import { AlertDialog, ConfirmDialog } from "./ui/dialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useDialogs } from "../hooks/useDialogs";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useSettings } from "../hooks/useSettings";
import { setAgentName as saveAgentName } from "../utils/agentName";
import { formatHotkeyLabel, getDefaultHotkey, isGlobeLikeHotkey } from "../utils/hotkeys";
import { HotkeyInput } from "./ui/HotkeyInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { getPlatform } from "../utils/platform";
import logger from "../utils/logger";
import {
  ONBOARDING_CURRENT_STEP_KEY,
  markGigaTypeOnboardingCompleted,
} from "../utils/onboardingState";

interface OnboardingFlowProps {
  onComplete: () => void;
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

  const [hotkey, setHotkey] = useState(dictationKey || getDefaultHotkey());
  const [agentName, setAgentName] = useState("GigaType");
  const readableHotkey = formatHotkeyLabel(hotkey);
  const { alertDialog, confirmDialog, showAlertDialog, hideAlertDialog, hideConfirmDialog } =
    useDialogs();
  const autoRegisterInFlightRef = useRef(false);
  const hotkeyStepInitializedRef = useRef(false);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setHotkey(registeredHotkey);
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: false,
  });

  const validateHotkeyForInput = useCallback(
    (hotkey: string) => getValidationMessage(hotkey, getPlatform()),
    []
  );

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

  const steps = useMemo(
    () => [
      { id: "permissions", title: t("onboarding.steps.permissions"), icon: Shield },
      { id: "activation", title: t("onboarding.steps.activation"), icon: Command },
    ],
    [t]
  );

  const showProgress = true;

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

  const activationStepIndex = 1;

  useEffect(() => {
    if (currentStep !== activationStepIndex) {
      // Reset initialization flag when leaving activation step
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
  }, [currentStep, hotkey, registerHotkey, activationStepIndex, setDictationKey]);

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
    saveAgentName(agentName);

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
  }, [hotkey, agentName, setDictationKey, ensureHotkeyRegistered]);

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
    if (currentStep >= steps.length - 1) {
      return;
    }

    const newStep = currentStep + 1;
    setCurrentStep(newStep);

    // Show dictation panel when entering activation step
    if (newStep === activationStepIndex) {
      if (window.electronAPI?.showDictationPanel) {
        window.electronAPI.showDictationPanel();
      }
    }
  }, [currentStep, setCurrentStep, steps.length, activationStepIndex]);

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
        return renderActivationStep();

      default:
        return null;
    }
  };

  const renderActivationStep = () => (
    <div className="space-y-4">
      {/* Header */}
      <div className="text-center space-y-0.5">
        <h2 className="text-lg font-semibold text-foreground tracking-tight">
          {t("onboarding.activation.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("onboarding.activation.description")}</p>
      </div>

      {/* Unified control surface */}
      <div className="rounded-lg border border-border bg-muted overflow-hidden">
        {/* Hotkey section */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t("onboarding.activation.hotkey")}
            </span>
          </div>
          <HotkeyInput
            value={hotkey}
            onChange={async (newHotkey) => {
              const success = await registerHotkey(newHotkey);
              if (success) {
                setHotkey(newHotkey);
              }
            }}
            disabled={isHotkeyRegistering}
            variant="hero"
            validate={validateHotkeyForInput}
          />
        </div>
      </div>

      {/* Test area - minimal chrome */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t("onboarding.activation.test")}
          </span>
          <span className="text-xs text-muted-foreground/60">
            {t("onboarding.activation.holdHotkey", { hotkey: readableHotkey })}
          </span>
        </div>
        <Textarea
          rows={2}
          placeholder={t("onboarding.activation.textareaPlaceholder")}
          className="text-sm resize-none"
        />
      </div>
    </div>
  );

  const canProceed = () => {
    switch (currentStep) {
      case 0:
        return arePermissionsReady();
      case 1:
        return hotkey.trim() !== "";
      default:
        return false;
    }
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
          className="bg-background backdrop-blur-xl border-b border-border shadow-sm"
        ></TitleBar>
      </div>

      {/* Progress Bar */}
      {showProgress && (
        <div className="shrink-0 bg-background/80 backdrop-blur-2xl border-b border-white/5 px-6 md:px-12 py-3 z-10">
          <div className="max-w-3xl mx-auto">
            <StepProgress steps={steps} currentStep={currentStep} />
          </div>
        </div>
      )}

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-10 md:px-12">
        <div className="mx-auto flex min-h-full w-full max-w-3xl items-center justify-center">
          <div className="w-full">{renderStep()}</div>
        </div>
      </div>

      {/* Footer Navigation */}
      {showProgress && currentStep === steps.length - 1 && (
        <div className="shrink-0 bg-background/80 backdrop-blur-2xl border-t border-white/5 px-6 md:px-12 py-3 z-10">
          <div className="max-w-3xl mx-auto flex items-center justify-end">
            <Button
              onClick={finishOnboarding}
              disabled={!canProceed()}
              variant="success"
              className="h-8 px-6 rounded-full text-xs"
            >
              <Check className="w-3.5 h-3.5" />
              {t("common.complete")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
