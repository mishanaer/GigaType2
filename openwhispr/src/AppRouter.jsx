import React, { Suspense, useEffect, useState } from "react";
import App from "./App.jsx";
import AppLoadingFallback from "./components/AppLoadingFallback.tsx";
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
const AppShowcase = React.lazy(() => import("./components/AppShowcase.tsx"));
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

  if (!micGranted) {
    state.reason = "microphone-missing";
    resetOnboardingToPermissionsStep();
    return false;
  }

  if (platform === "darwin" && accessibilityGranted !== true) {
    state.reason = "accessibility-missing";
    resetOnboardingToPermissionsStep();
    return false;
  }

  return areRequiredPermissionsMet(micGranted, platform, accessibilityGranted);
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

  if (params.includes("storybook=true") || params.includes("showcase=true")) {
    return (
      <Suspense fallback={<AppLoadingFallback />}>
        <AppShowcase />
      </Suspense>
    );
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
    return <AppLoadingFallback />;
  }

  if (isControlPanel && showOnboarding) {
    return (
      <Suspense fallback={<AppLoadingFallback />}>
        <OnboardingFlow onComplete={handleOnboardingComplete} />
      </Suspense>
    );
  }

  return isControlPanel ? (
    <Suspense fallback={<AppLoadingFallback />}>
      <ControlPanel />
    </Suspense>
  ) : (
    <App />
  );
}
