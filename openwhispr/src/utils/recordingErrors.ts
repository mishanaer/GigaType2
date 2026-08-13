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

type MicFailureKind =
  | "windows-blocked"
  | "permission"
  | "not-found"
  | "device-unavailable"
  | "busy"
  | "no-active-input"
  | "unknown";

// One shared root-cause resolution so the toast title and body can never
// contradict each other (e.g. a "No Microphone Found" title paired with a
// "choose another device" body when the device list is empty).
function resolveMicFailureKind(failure: MicAccessFailure, platform: Platform): MicFailureKind {
  const name = failure.name || "";
  const message = (failure.message || "").toLowerCase();

  // Windows blocks desktop apps via a dedicated privacy toggle. When the OS
  // reports "denied", every getUserMedia failure is that toggle — including
  // NotFoundError, because a blocked app enumerates zero audio devices.
  if (platform === "win32" && failure.winMicAccessStatus === "denied") {
    return "windows-blocked";
  }
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "permission";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "not-found";
  }
  // A stale configured device is the root cause when the default-device retry
  // only surfaced a transient error afterwards (busy default mic). Permission
  // and empty-device-list errors above stay authoritative — they describe the
  // current blocker, not the stale setting.
  if (
    name === "OverconstrainedError" ||
    name === "ConstraintNotSatisfiedError" ||
    failure.originalDeviceErrorName === "OverconstrainedError" ||
    failure.originalDeviceErrorName === "ConstraintNotSatisfiedError"
  ) {
    return "device-unavailable";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "busy";
  }
  if (message.includes("no audio input") || message.includes("not available")) {
    return "no-active-input";
  }
  return "unknown";
}

const MIC_FAILURE_TITLE_KEYS: Record<MicFailureKind, string> = {
  "windows-blocked": "hooks.audioRecording.errorTitles.micAccessDenied",
  permission: "hooks.audioRecording.errorTitles.micAccessDenied",
  "not-found": "hooks.audioRecording.errorTitles.micNotFound",
  "device-unavailable": "hooks.audioRecording.errorTitles.micUnavailable",
  busy: "hooks.audioRecording.errorTitles.micInUse",
  "no-active-input": "hooks.audioRecording.errorTitles.micNotFound",
  unknown: "hooks.audioRecording.errorTitles.recordingError",
};

export function getMicAccessErrorTitle(
  failure: MicAccessFailure,
  t: TFunction,
  platform: Platform
): string {
  return t(MIC_FAILURE_TITLE_KEYS[resolveMicFailureKind(failure, platform)]);
}

export function describeMicAccessError(
  failure: MicAccessFailure,
  t: TFunction,
  platform: Platform
): string {
  const settingsPath = t(SETTINGS_PATH_KEYS[platform]);
  const privacyPath = t(PRIVACY_PATH_KEYS[platform]);

  switch (resolveMicFailureKind(failure, platform)) {
    case "windows-blocked":
      return t("hooks.permissions.micErrors.windowsDesktopAppsBlocked", { privacyPath });
    case "permission":
      return t("hooks.permissions.micErrors.permissionDenied", { privacyPath });
    case "not-found":
      return t("hooks.permissions.micErrors.noMicrophones", { settingsPath });
    case "device-unavailable":
      return t("hooks.permissions.micErrors.deviceUnavailable", { settingsPath });
    case "busy":
      if (platform === "win32") {
        return t("hooks.permissions.micErrors.windowsMicBusyOrBlocked", { settingsPath });
      }
      return t("hooks.permissions.micErrors.couldNotStart", { settingsPath });
    case "no-active-input":
      return t("hooks.permissions.micErrors.noActiveInput", { settingsPath });
    default:
      return t("hooks.permissions.micErrors.unknown", {
        error: failure.message || t("hooks.permissions.micErrors.unknownFallback"),
      });
  }
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
