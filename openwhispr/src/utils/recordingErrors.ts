import { TFunction } from "i18next";
import type { Platform } from "./platform";

type RecordingError = {
  code?: string;
  title: string;
  description?: string;
  messageKey?: string;
};

/**
 * Structured description of a failed microphone open (getUserMedia rejection),
 * shared between the onboarding mic test and dictation-time recording errors
 * so both surfaces show the same localized, platform-aware guidance.
 */
export type MicAccessFailure = {
  name?: string | null;
  message?: string | null;
  /** When a default-device retry also failed: the configured device's error name. */
  originalDeviceErrorName?: string | null;
  /** systemPreferences.getMediaAccessStatus result fetched after the failure (win32). */
  winMicAccessStatus?: string | null;
};

const SETTINGS_PATH_KEYS: Record<Platform, string> = {
  win32: "hooks.permissions.paths.windowsMicrophone",
  linux: "hooks.permissions.paths.linuxSound",
  darwin: "hooks.permissions.paths.defaultSound",
};

const PRIVACY_PATH_KEYS: Record<Platform, string> = {
  win32: "hooks.permissions.paths.windowsMicrophone",
  linux: "hooks.permissions.paths.linuxPrivacy",
  darwin: "hooks.permissions.paths.defaultPrivacy",
};

export function getMicAccessErrorTitle(failure: MicAccessFailure, t: TFunction): string {
  const name = failure.name || "";
  if (failure.winMicAccessStatus === "denied" || name === "NotAllowedError" || name === "SecurityError") {
    return t("hooks.audioRecording.errorTitles.micAccessDenied");
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return t("hooks.audioRecording.errorTitles.micNotFound");
  }
  if (name === "OverconstrainedError" || failure.originalDeviceErrorName === "OverconstrainedError") {
    return t("hooks.audioRecording.errorTitles.micUnavailable");
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return t("hooks.audioRecording.errorTitles.micInUse");
  }
  return t("hooks.audioRecording.errorTitles.recordingError");
}

export function describeMicAccessError(
  failure: MicAccessFailure,
  t: TFunction,
  platform: Platform
): string {
  const name = failure.name || "";
  const message = (failure.message || "").toLowerCase();
  const settingsPath = t(SETTINGS_PATH_KEYS[platform]);
  const privacyPath = t(PRIVACY_PATH_KEYS[platform]);

  // Windows blocks desktop apps via a dedicated privacy toggle. When the OS
  // reports "denied", every getUserMedia failure is that toggle — including
  // NotFoundError, because a blocked app enumerates zero audio devices.
  if (platform === "win32" && failure.winMicAccessStatus === "denied") {
    return t("hooks.permissions.micErrors.windowsDesktopAppsBlocked", { privacyPath });
  }

  // A stale configured device is the root cause even when the default-device
  // retry surfaced a different error afterwards.
  if (name === "OverconstrainedError" || failure.originalDeviceErrorName === "OverconstrainedError") {
    return t("hooks.permissions.micErrors.deviceUnavailable", { settingsPath });
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return t("hooks.permissions.micErrors.noMicrophones", { settingsPath });
  }

  if (name === "NotAllowedError" || name === "SecurityError") {
    return t("hooks.permissions.micErrors.permissionDenied", { privacyPath });
  }

  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    if (platform === "win32") {
      return t("hooks.permissions.micErrors.windowsMicBusyOrBlocked", { settingsPath });
    }
    return t("hooks.permissions.micErrors.couldNotStart", { settingsPath });
  }

  if (message.includes("no audio input") || message.includes("not available")) {
    return t("hooks.permissions.micErrors.noActiveInput", { settingsPath });
  }

  return t("hooks.permissions.micErrors.unknown", {
    error: failure.message || t("hooks.permissions.micErrors.unknownFallback"),
  });
}

export function getRecordingErrorTitle(error: RecordingError, t: TFunction): string {
  if (error.code === "NETWORK_ERROR") return t(error.title);
  if (error.code === "AUTH_EXPIRED" || error.code === "AUTH_REQUIRED") {
    return t("hooks.audioRecording.errorTitles.sessionExpired");
  }
  if (error.code === "OFFLINE") return t("hooks.audioRecording.errorTitles.offline");
  if (error.code === "LIMIT_REACHED")
    return t("hooks.audioRecording.errorTitles.dailyLimitReached");
  return error.title;
}

export function getRecordingErrorDescription(error: RecordingError, t: TFunction): string {
  if (error.messageKey) return t(error.messageKey);
  return error.description ?? "";
}
