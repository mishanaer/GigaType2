import React, { Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import App from "./App.jsx";
import MeetingNotificationOverlay from "./components/MeetingNotificationOverlay.tsx";
import TranscriptionPreviewOverlay from "./components/TranscriptionPreviewOverlay.tsx";
import UpdateNotificationOverlay from "./components/UpdateNotificationOverlay.tsx";
import { useTheme } from "./hooks/useTheme";
import logger from "./utils/logger";
import {
  GIGATYPE_ONBOARDING_COMPLETED_KEY,
  LEGACY_ONBOARDING_COMPLETED_KEY,
  ONBOARDING_CURRENT_STEP_KEY,
  isGigaTypeOnboardingCompleted,
  markGigaTypeOnboardingCompleted,
  resetOnboardingToPermissionsStep,
} from "./utils/onboardingState";
import { areRequiredPermissionsMet } from "./utils/permissions";

const ControlPanel = React.lazy(() => import("./components/ControlPanel.tsx"));
const OnboardingFlow = React.lazy(() => import("./components/OnboardingFlow.tsx"));
const ONBOARDING_ACTIVATION_STEP_INDEX = 1;

const getPlatform = () => window.electronAPI?.getPlatform?.() || "browser";

async function checkOnboardingPermissions(platform, state) {
  if (platform !== "darwin") {
    return true;
  }

  const checkMicrophone = async () => {
    if (!window.electronAPI?.checkMicrophoneAccess) {
      return null;
    }
    try {
      return await window.electronAPI.checkMicrophoneAccess();
    } catch (error) {
      await logger.warn("Microphone permission check failed", { error }, "onboarding");
      return null;
    }
  };

  const checkAccessibility = async () => {
    if (!window.electronAPI?.checkAccessibilityPermission) {
      return null;
    }
    try {
      return await window.electronAPI.checkAccessibilityPermission(true);
    } catch (error) {
      await logger.warn("Accessibility permission check failed", { error }, "onboarding");
      return null;
    }
  };

  const [micResult, accessibilityGranted] = await Promise.all([
    checkMicrophone(),
    checkAccessibility(),
  ]);

  state.microphone = micResult;
  state.accessibilityGranted = accessibilityGranted;

  const micGranted = micResult ? micResult.granted === true : true;

  if (!areRequiredPermissionsMet(micGranted)) {
    state.reason = "microphone-missing";
    resetOnboardingToPermissionsStep();
    return false;
  }

  return true;
}

async function resolveOnboardingRequirement() {
  const platform = getPlatform();
  const completed = isGigaTypeOnboardingCompleted();
  const legacyCompleted = localStorage.getItem(LEGACY_ONBOARDING_COMPLETED_KEY) === "true";
  const state = {
    key: GIGATYPE_ONBOARDING_COMPLETED_KEY,
    completed,
    legacyCompleted,
    platform,
    microphone: null,
    accessibilityGranted: null,
    reason: "completed",
  };

  if (!completed) {
    state.reason = legacyCompleted ? "missing-gigatype-completion" : "not-completed";
    await checkOnboardingPermissions(platform, state);
    await logger.info("Onboarding required", state, "onboarding");
    return true;
  }

  if (platform !== "darwin") {
    await logger.info("Onboarding skipped", state, "onboarding");
    return false;
  }

  if (!(await checkOnboardingPermissions(platform, state))) {
    await logger.warn("Onboarding required because permissions are missing", state, "onboarding");
    return true;
  }

  await logger.info("Onboarding skipped", state, "onboarding");
  return false;
}

export default function AppRouter() {
  useTheme();
  const params = window.location.search;

  if (params.includes("meeting-notification=true")) {
    return <MeetingNotificationOverlay />;
  }

  if (params.includes("update-notification=true")) {
    return <UpdateNotificationOverlay />;
  }

  if (params.includes("transcription-preview=true")) {
    return <TranscriptionPreviewOverlay />;
  }

  return <MainApp />;
}

function MainApp() {
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const isControlPanel =
    window.location.pathname.includes("control") || window.location.search.includes("panel=true");
  const isDictationPanel = !isControlPanel;

  useEffect(() => {
    if (isControlPanel) {
      import("./components/ControlPanel.tsx").catch(() => {});

      if (!isGigaTypeOnboardingCompleted()) {
        import("./components/OnboardingFlow.tsx").catch(() => {});
      }
    }
  }, [isControlPanel]);

  useEffect(() => {
    let cancelled = false;

    const checkOnboarding = async () => {
      const onboardingRequired = await resolveOnboardingRequirement();
      if (cancelled) {
        return;
      }

      if (isControlPanel) {
        setShowOnboarding(onboardingRequired);
      }

      if (isDictationPanel && onboardingRequired) {
        const rawStep = parseInt(localStorage.getItem(ONBOARDING_CURRENT_STEP_KEY) || "0");
        const currentStep = Math.max(0, Math.min(rawStep, ONBOARDING_ACTIVATION_STEP_INDEX));
        if (currentStep < ONBOARDING_ACTIVATION_STEP_INDEX) {
          window.electronAPI?.hideWindow?.();
        }
      }

      setIsLoading(false);
    };

    checkOnboarding();

    return () => {
      cancelled = true;
    };
  }, [isControlPanel, isDictationPanel]);

  const handleOnboardingComplete = () => {
    setShowOnboarding(false);
    markGigaTypeOnboardingCompleted();
  };

  if (isLoading) {
    return <LoadingFallback />;
  }

  if (isControlPanel && showOnboarding) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <OnboardingFlow onComplete={handleOnboardingComplete} />
      </Suspense>
    );
  }

  return isControlPanel ? (
    <Suspense fallback={<LoadingFallback />}>
      <ControlPanel />
    </Suspense>
  ) : (
    <App />
  );
}

function LoadingFallback({ message }) {
  const { t } = useTranslation();
  const fallbackMessage = message || t("common.loading");

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 animate-[scale-in_300ms_ease-out]">
        <svg
          viewBox="0 0 1024 1024"
          className="w-12 h-12 drop-shadow-[0_2px_8px_rgba(37,99,235,0.18)] dark:drop-shadow-[0_2px_12px_rgba(100,149,237,0.25)]"
          aria-label="GigaType"
        >
          <rect width="1024" height="1024" rx="241" fill="#2056DF" />
          <circle cx="512" cy="512" r="314" fill="#2056DF" stroke="white" strokeWidth="74" />
          <path d="M512 383V641" stroke="white" strokeWidth="74" strokeLinecap="round" />
          <path d="M627 457V568" stroke="white" strokeWidth="74" strokeLinecap="round" />
          <path d="M397 457V568" stroke="white" strokeWidth="74" strokeLinecap="round" />
        </svg>
        <div className="w-7 h-7 rounded-full border-[2.5px] border-transparent border-t-primary animate-[spinner-rotate_0.8s_cubic-bezier(0.4,0,0.2,1)_infinite] motion-reduce:animate-none motion-reduce:border-t-muted-foreground motion-reduce:opacity-50" />
        {fallbackMessage && (
          <p className="text-[13px] font-medium text-muted-foreground dark:text-foreground/60 tracking-normal">
            {fallbackMessage}
          </p>
        )}
      </div>
    </div>
  );
}
