import React, { createContext, useContext, useEffect, useRef } from "react";
import { useSettingsStore, initializeSettings } from "../stores/settingsStore";
import logger from "../utils/logger";
import type { InferenceMode } from "../types/electron";

export interface TranscriptionSettings {
  uiLanguage: string;
  allowOpenAIFallback: boolean;
  allowLocalFallback: boolean;
  preferredLanguage: string;
  gigaamBaseUrl?: string;
  remoteTranscriptionUrl: string;
  showTranscriptionPreview: boolean;
}

export interface CleanupSettings {
  autoGenerateNoteTitle: boolean;
  useCleanupModel: boolean;
  useDictationAgent: boolean;
  cleanupModel: string;
  cleanupProvider: string;
  cleanupCloudBaseUrl?: string;
  cleanupCloudMode: string;
  cleanupMode: InferenceMode;
  cleanupRemoteUrl: string;
}

export interface HotkeySettings {
  dictationKey: string;
  meetingKey: string;
  meetingHotkeyLayoutMode: "side-panel" | "full-width";
  activationMode: "tap" | "push";
}

export interface MicrophoneSettings {
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
}

export interface PrivacySettings {
  cloudBackupEnabled: boolean;
  telemetryEnabled: boolean;
  audioRetentionDays: number;
  dataRetentionEnabled: boolean;
}

export interface ThemeSettings {
  theme: "light" | "dark" | "auto";
}

export interface ChatAgentSettings {
  chatAgentModel: string;
  chatAgentProvider: string;
  chatAgentKey: string;
  chatAgentCloudMode: string;
  chatAgentMode: InferenceMode;
  chatAgentCloudBaseUrl: string;
  chatAgentRemoteUrl: string;
}

function useSettingsInternal() {
  const store = useSettingsStore();

  // One-time initialization: sync hotkeys, activation mode, and UI language
  // from the main process / SQLite.
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    initializeSettings().catch((err) => {
      logger.warn(
        "Failed to initialize settings store",
        { error: (err as Error).message },
        "settings"
      );
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.syncStartupPreferences) return;

    window.electronAPI
      .syncStartupPreferences({})
      .catch((err) =>
        logger.warn(
          "Failed to sync startup preferences",
          { error: (err as Error).message },
          "settings"
        )
      );
  }, []);

  return {
    uiLanguage: store.uiLanguage,
    allowOpenAIFallback: store.allowOpenAIFallback,
    allowLocalFallback: store.allowLocalFallback,
    preferredLanguage: store.preferredLanguage,
    gigaamBaseUrl: store.gigaamBaseUrl,
    cleanupCloudBaseUrl: store.cleanupCloudBaseUrl,
    cleanupCloudMode: store.cleanupCloudMode,
    remoteTranscriptionUrl: store.remoteTranscriptionUrl,
    cleanupMode: store.cleanupMode,
    cleanupRemoteUrl: store.cleanupRemoteUrl,
    autoGenerateNoteTitle: store.autoGenerateNoteTitle,
    setAutoGenerateNoteTitle: store.setAutoGenerateNoteTitle,
    cleanupModel: store.cleanupModel,
    cleanupProvider: store.cleanupProvider,
    dictationKey: store.dictationKey,
    meetingKey: store.meetingKey,
    meetingHotkeyLayoutMode: store.meetingHotkeyLayoutMode,
    setMeetingHotkeyLayoutMode: store.setMeetingHotkeyLayoutMode,
    theme: store.theme,
    setUiLanguage: store.setUiLanguage,
    setAllowOpenAIFallback: store.setAllowOpenAIFallback,
    setAllowLocalFallback: store.setAllowLocalFallback,
    setPreferredLanguage: store.setPreferredLanguage,
    setGigaamBaseUrl: store.setGigaamBaseUrl,
    setCleanupCloudBaseUrl: store.setCleanupCloudBaseUrl,
    setCleanupCloudMode: store.setCleanupCloudMode,
    setRemoteTranscriptionUrl: store.setRemoteTranscriptionUrl,
    setCleanupMode: store.setCleanupMode,
    setCleanupRemoteUrl: store.setCleanupRemoteUrl,
    setUseCleanupModel: store.setUseCleanupModel,
    setUseDictationAgent: store.setUseDictationAgent,
    setCleanupModel: store.setCleanupModel,
    setCleanupProvider: store.setCleanupProvider,
    setDictationKey: store.setDictationKey,
    setMeetingKey: store.setMeetingKey,
    setTheme: store.setTheme,
    activationMode: store.activationMode,
    setActivationMode: store.setActivationMode,
    notificationsEnabled: store.notificationsEnabled,
    setNotificationsEnabled: store.setNotificationsEnabled,
    notifyMeetingDetection: store.notifyMeetingDetection,
    setNotifyMeetingDetection: store.setNotifyMeetingDetection,
    notifyCalendarReminders: store.notifyCalendarReminders,
    setNotifyCalendarReminders: store.setNotifyCalendarReminders,
    notifyUpdates: store.notifyUpdates,
    setNotifyUpdates: store.setNotifyUpdates,
    audioCuesEnabled: store.audioCuesEnabled,
    setAudioCuesEnabled: store.setAudioCuesEnabled,
    pauseMediaOnDictation: store.pauseMediaOnDictation,
    setPauseMediaOnDictation: store.setPauseMediaOnDictation,
    floatingIconAutoHide: store.floatingIconAutoHide,
    setFloatingIconAutoHide: store.setFloatingIconAutoHide,
    startMinimized: store.startMinimized,
    setStartMinimized: store.setStartMinimized,
    panelStartPosition: store.panelStartPosition,
    setPanelStartPosition: store.setPanelStartPosition,
    preferBuiltInMic: store.preferBuiltInMic,
    selectedMicDeviceId: store.selectedMicDeviceId,
    setPreferBuiltInMic: store.setPreferBuiltInMic,
    setSelectedMicDeviceId: store.setSelectedMicDeviceId,
    showTranscriptionPreview: store.showTranscriptionPreview,
    setShowTranscriptionPreview: store.setShowTranscriptionPreview,
    noteFilesEnabled: store.noteFilesEnabled,
    setNoteFilesEnabled: store.setNoteFilesEnabled,
    noteFilesPath: store.noteFilesPath,
    setNoteFilesPath: store.setNoteFilesPath,
    dictationSileroEnabled: store.dictationSileroEnabled,
    setDictationSileroEnabled: store.setDictationSileroEnabled,
    noteRecordingSileroEnabled: store.noteRecordingSileroEnabled,
    setNoteRecordingSileroEnabled: store.setNoteRecordingSileroEnabled,
    meetingSileroEnabled: store.meetingSileroEnabled,
    setMeetingSileroEnabled: store.setMeetingSileroEnabled,
    speechVadThreshold: store.speechVadThreshold,
    setSpeechVadThreshold: store.setSpeechVadThreshold,
    speechVadMinSpeechDurationMs: store.speechVadMinSpeechDurationMs,
    setSpeechVadMinSpeechDurationMs: store.setSpeechVadMinSpeechDurationMs,
    speechVadMinSilenceDurationMs: store.speechVadMinSilenceDurationMs,
    setSpeechVadMinSilenceDurationMs: store.setSpeechVadMinSilenceDurationMs,
    speechVadMaxSpeechDurationS: store.speechVadMaxSpeechDurationS,
    setSpeechVadMaxSpeechDurationS: store.setSpeechVadMaxSpeechDurationS,
    speechVadSpeechPadMs: store.speechVadSpeechPadMs,
    setSpeechVadSpeechPadMs: store.setSpeechVadSpeechPadMs,
    speechVadSamplesOverlap: store.speechVadSamplesOverlap,
    setSpeechVadSamplesOverlap: store.setSpeechVadSamplesOverlap,
    cloudBackupEnabled: store.cloudBackupEnabled,
    setCloudBackupEnabled: store.setCloudBackupEnabled,
    telemetryEnabled: store.telemetryEnabled,
    setTelemetryEnabled: store.setTelemetryEnabled,
    audioRetentionDays: store.audioRetentionDays,
    setAudioRetentionDays: store.setAudioRetentionDays,
    dataRetentionEnabled: store.dataRetentionEnabled,
    setDataRetentionEnabled: store.setDataRetentionEnabled,
    updateTranscriptionSettings: store.updateTranscriptionSettings,
    updateCleanupSettings: store.updateCleanupSettings,
  };
}

export type SettingsValue = ReturnType<typeof useSettingsInternal>;

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const value = useSettingsInternal();
  return React.createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return ctx;
}
