import { useState, useCallback, useEffect } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { PasteToolsResult } from "../types/electron";
import { useLocalStorage } from "./useLocalStorage";
import logger from "../utils/logger";
import { getPlatform } from "../utils/platform";
import { describeMicAccessError } from "../utils/recordingErrors";

export interface UsePermissionsReturn {
  // State
  micPermissionGranted: boolean;
  accessibilityPermissionGranted: boolean;
  micPermissionError: string | null;
  pasteToolsInfo: PasteToolsResult | null;
  isCheckingPasteTools: boolean;

  requestMicPermission: () => Promise<void>;
  requestAccessibilityPermission: () => Promise<void>;
  checkPasteToolsAvailability: () => Promise<PasteToolsResult | null>;
  openMicPrivacySettings: () => Promise<void>;
  openSoundInputSettings: () => Promise<void>;
  setMicPermissionGranted: (granted: boolean) => void;
  setAccessibilityPermissionGranted: (granted: boolean) => void;
}

export interface UsePermissionsProps {
  showAlertDialog: (dialog: { title: string; description?: string }) => void;
}

const stopTracks = (stream?: MediaStream) => {
  try {
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    // ignore track cleanup errors
  }
};

const describeMicError = (
  error: unknown,
  t: TFunction,
  winMicAccessStatus: string | null = null
): string => {
  if (!error || typeof error !== "object") {
    return t("hooks.permissions.micErrors.accessFailed");
  }

  const err = error as { name?: string; message?: string };
  return describeMicAccessError(
    { name: err.name, message: err.message, winMicAccessStatus },
    t,
    getPlatform()
  );
};

export const usePermissions = (
  showAlertDialog?: UsePermissionsProps["showAlertDialog"]
): UsePermissionsReturn => {
  const { t } = useTranslation();
  const [micPermissionGranted, setMicPermissionGranted] = useLocalStorage(
    "micPermissionGranted",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );
  const [micPermissionError, setMicPermissionError] = useState<string | null>(null);
  const [accessibilityPermissionGranted, setAccessibilityPermissionGranted] = useLocalStorage(
    "accessibilityPermissionGranted",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );
  const [pasteToolsInfo, setPasteToolsInfo] = useState<PasteToolsResult | null>(null);
  const [isCheckingPasteTools, setIsCheckingPasteTools] = useState(false);

  const openSystemSettings = useCallback(
    async (
      settingType: "microphone" | "sound" | "accessibility",
      apiMethod: () => Promise<{ success: boolean; error?: string } | undefined> | undefined
    ) => {
      const titles = {
        microphone: t("hooks.permissions.settingsTitles.microphone"),
        sound: t("hooks.permissions.settingsTitles.sound"),
        accessibility: t("hooks.permissions.settingsTitles.accessibility"),
      };
      const unableToOpenDescriptions = {
        microphone: t("hooks.permissions.settingsErrors.unableToOpenMicrophone"),
        sound: t("hooks.permissions.settingsErrors.unableToOpenSound"),
        accessibility: t("hooks.permissions.settingsErrors.unableToOpenAccessibility"),
      };
      try {
        const result = await apiMethod?.();
        if (result && !result.success && result.error) {
          showAlertDialog?.({ title: titles[settingType], description: result.error });
        }
      } catch (error) {
        logger.error(`Failed to open ${settingType} settings:`, error);
        showAlertDialog?.({
          title: titles[settingType],
          description: unableToOpenDescriptions[settingType],
        });
      }
    },
    [showAlertDialog, t]
  );

  const openMicPrivacySettings = useCallback(
    () => openSystemSettings("microphone", window.electronAPI?.openMicrophoneSettings),
    [openSystemSettings]
  );

  const openSoundInputSettings = useCallback(
    () => openSystemSettings("sound", window.electronAPI?.openSoundInputSettings),
    [openSystemSettings]
  );

  const requestMicPermission = useCallback(async () => {
    if (!navigator?.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      const message = t("hooks.permissions.micUnavailable");
      setMicPermissionError(message);
      if (showAlertDialog) {
        showAlertDialog({
          title: t("hooks.permissions.titles.microphoneUnavailable"),
          description: message,
        });
      } else {
        alert(message);
      }
      return;
    }

    setMicPermissionError(null);

    try {
      // macOS hardened runtime requires main-process mic prompt before getUserMedia works
      if (window.electronAPI?.requestMicrophoneAccess) {
        try {
          await window.electronAPI.requestMicrophoneAccess();
        } catch {
          // ignored — getUserMedia below will surface the error
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stopTracks(stream);
      setMicPermissionGranted(true);
      setMicPermissionError(null);
    } catch (err) {
      logger.error("Microphone permission denied:", err);
      let winMicAccessStatus: string | null = null;
      if (getPlatform() === "win32") {
        try {
          winMicAccessStatus =
            (await window.electronAPI?.checkMicrophoneAccess?.())?.status ?? null;
        } catch {
          // status stays unknown — fall back to generic error texts
        }
      }
      const message = describeMicError(err, t, winMicAccessStatus);
      setMicPermissionError(message);
      if (showAlertDialog) {
        showAlertDialog({
          title: t("hooks.permissions.titles.microphonePermissionRequired"),
          description: message,
        });
      } else {
        alert(message);
      }
    }
  }, [showAlertDialog, t, setMicPermissionGranted]);

  const checkPasteToolsAvailability = useCallback(async (): Promise<PasteToolsResult | null> => {
    setIsCheckingPasteTools(true);
    try {
      if (window.electronAPI?.checkPasteTools) {
        const result = await window.electronAPI.checkPasteTools();
        setPasteToolsInfo(result);

        // On Windows and Linux with tools available, auto-grant accessibility
        if (result.platform === "win32") {
          setAccessibilityPermissionGranted(true);
        } else if (result.platform === "linux" && result.available) {
          setAccessibilityPermissionGranted(true);
        }
        return result;
      }
      return null;
    } catch (error) {
      logger.error("Failed to check paste tools:", error);
      return null;
    } finally {
      setIsCheckingPasteTools(false);
    }
  }, [setAccessibilityPermissionGranted]);

  const requestAccessibilityPermission = useCallback(async () => {
    const platform = getPlatform();

    if (platform === "darwin") {
      const alreadyGranted =
        (await window.electronAPI?.promptAccessibilityPermission?.()) ??
        (await window.electronAPI?.checkAccessibilityPermission?.(true));
      if (alreadyGranted) {
        setAccessibilityPermissionGranted(true);
        return;
      }

      await openSystemSettings("accessibility", window.electronAPI?.openAccessibilitySettings);
      return;
    }

    // On Windows, PowerShell SendKeys is always available
    if (platform === "win32") {
      setAccessibilityPermissionGranted(true);
      return;
    }

    // On Linux, auto-paste is optional — grant regardless of paste tool availability
    if (platform === "linux") {
      await checkPasteToolsAvailability();
      setAccessibilityPermissionGranted(true);
    }
  }, [openSystemSettings, checkPasteToolsAvailability, setAccessibilityPermissionGranted]);

  // Check paste tools on mount
  useEffect(() => {
    checkPasteToolsAvailability();
  }, [checkPasteToolsAvailability]);

  // On macOS, re-validate microphone permission on mount to override stale
  // localStorage values (e.g. after TCC reset or app update). Windows is
  // deliberately excluded: getMediaAccessStatus can return not-determined /
  // unknown there (absent ConsentStore registry value on LTSC/managed images)
  // while getUserMedia works fine, so an OS-status downgrade would lock users
  // out of onboarding. The Windows status is only consulted after a real
  // getUserMedia failure (see requestMicPermission).
  useEffect(() => {
    if (getPlatform() !== "darwin") return;
    window.electronAPI?.checkMicrophoneAccess?.().then((result) => {
      if (result) setMicPermissionGranted(result.granted);
    });
  }, [setMicPermissionGranted]);

  // On macOS, re-validate accessibility permission on mount to override stale
  // localStorage values (e.g. after app update changes the code signature).
  useEffect(() => {
    if (getPlatform() !== "darwin") return;
    window.electronAPI?.checkAccessibilityPermission?.(true).then((granted) => {
      setAccessibilityPermissionGranted(granted);
    });
  }, [setAccessibilityPermissionGranted]);

  // Poll for accessibility permission changes on macOS (e.g. user grants in System Settings)
  useEffect(() => {
    if (getPlatform() !== "darwin") return;
    if (accessibilityPermissionGranted) return;

    const interval = setInterval(() => {
      window.electronAPI?.checkAccessibilityPermission?.(true).then((granted) => {
        if (granted) {
          setAccessibilityPermissionGranted(true);
        }
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [accessibilityPermissionGranted, setAccessibilityPermissionGranted]);

  return {
    micPermissionGranted,
    accessibilityPermissionGranted,
    micPermissionError,
    pasteToolsInfo,
    isCheckingPasteTools,
    requestMicPermission,
    requestAccessibilityPermission,
    checkPasteToolsAvailability,
    openMicPrivacySettings,
    openSoundInputSettings,
    setMicPermissionGranted,
    setAccessibilityPermissionGranted,
  };
};
