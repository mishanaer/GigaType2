import { create } from "zustand";
import { API_ENDPOINTS } from "../config/constants";
import i18n from "../i18n";
import logger from "../utils/logger";
import speechVadConstants from "../constants/speechVad.json";
import type {
  InferenceMode,
  GigaamSidecarStatus,
} from "../types/electron";
import type { GoogleCalendarAccount } from "../types/calendar";
import { PROMPT_KIND_LIST, type PromptKind } from "../config/prompts/registry";
import {
  INFERENCE_SCOPES,
  type InferenceScope,
  type InferenceScopeDefinition,
  type InferenceScopeStoreKeys,
} from "../config/inferenceScopes";
import type {
  TranscriptionSettings,
  CleanupSettings,
  HotkeySettings,
  MicrophoneSettings,
  PrivacySettings,
  ThemeSettings,
  ChatAgentSettings,
} from "../hooks/useSettings";

const isBrowser = typeof window !== "undefined";
const FIXED_UI_LANGUAGE = "ru";
const FIXED_TRANSCRIPTION_LANGUAGE = "ru";
const FIXED_THEME = "auto";
const DEFAULT_ACTIVATION_MODE = "push" as const;
const FIXED_AUDIO_CUES_ENABLED = true;
const FIXED_PAUSE_MEDIA_ON_DICTATION = false;
const FIXED_NOTIFICATIONS_ENABLED = false;
const FIXED_START_MINIMIZED = false;
const AUTH_BACKED_INFERENCE_MODE_KEYS = new Set([
  "cleanupMode",
  "noteFormattingMode",
  "chatAgentMode",
  "dictationAgentMode",
]);
const AUTH_BACKED_CLOUD_MODE_KEYS = new Set([
  "cleanupCloudMode",
  "noteFormattingCloudMode",
  "chatAgentCloudMode",
  "dictationAgentCloudMode",
]);
const DISABLED_CLOUD_PROVIDER_IDS = new Set(["openai", "anthropic", "gemini", "groq"]);
const DEFAULT_LOCAL_PROVIDER = "qwen";

const INFERENCE_STORAGE_SCOPES = [
  {
    modeKey: "cleanupMode",
    providerKey: "cleanupProvider",
    modelKey: "cleanupModel",
    cloudBaseUrlKey: "cleanupCloudBaseUrl",
    remoteUrlKey: "cleanupRemoteUrl",
  },
  {
    modeKey: "noteFormattingMode",
    providerKey: "noteFormattingProvider",
    modelKey: "noteFormattingModel",
    cloudBaseUrlKey: "noteFormattingCloudBaseUrl",
    remoteUrlKey: "noteFormattingRemoteUrl",
  },
  {
    modeKey: "chatAgentMode",
    providerKey: "chatAgentProvider",
    modelKey: "chatAgentModel",
    cloudBaseUrlKey: "chatAgentCloudBaseUrl",
    remoteUrlKey: "chatAgentRemoteUrl",
  },
  {
    modeKey: "dictationAgentMode",
    providerKey: "dictationAgentProvider",
    modelKey: "dictationAgentModel",
    cloudBaseUrlKey: "dictationAgentCloudBaseUrl",
    remoteUrlKey: "dictationAgentRemoteUrl",
  },
] as const;

function normalizeAuthBackedSetting(key: string, value: string): string {
  if (AUTH_BACKED_INFERENCE_MODE_KEYS.has(key) && value === "openwhispr") {
    return "local";
  }
  if (AUTH_BACKED_CLOUD_MODE_KEYS.has(key) && value === "openwhispr") {
    return "byok";
  }
  return value;
}

function readString(key: string, fallback: string): string {
  if (!isBrowser) return fallback;
  return normalizeAuthBackedSetting(key, localStorage.getItem(key) ?? fallback);
}

function readMigratedString(key: string, legacyKey: string, fallback: string): string {
  if (!isBrowser) return fallback;
  const current = localStorage.getItem(key);
  if (current !== null) return normalizeAuthBackedSetting(key, current);
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) {
    localStorage.setItem(key, legacy);
    localStorage.removeItem(legacyKey);
    return normalizeAuthBackedSetting(key, legacy);
  }
  return fallback;
}

function readBoolean(key: string, fallback: boolean): boolean {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  if (fallback === true) return stored !== "false";
  return stored === "true";
}

function normalizeActivationMode(value: unknown): "tap" | "push" {
  return value === "tap" ? "tap" : DEFAULT_ACTIVATION_MODE;
}

function readActivationMode(): "tap" | "push" {
  return normalizeActivationMode(readString("activationMode", DEFAULT_ACTIVATION_MODE));
}

function readStringArray(key: string, fallback: string[]): string[] {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function disableAccountBackedFeatures() {
  if (!isBrowser) return;
  localStorage.setItem("isSignedIn", "false");
  localStorage.setItem("cloudBackupEnabled", "false");
  localStorage.setItem("isSubscribed", "false");
  localStorage.setItem("authenticationSkipped", "true");
  localStorage.setItem("skipAuth", "true");

  for (const key of AUTH_BACKED_INFERENCE_MODE_KEYS) {
    const value = localStorage.getItem(key);
    if (value === "openwhispr" || value === "providers") {
      localStorage.setItem(key, "local");
    }
  }
  for (const key of AUTH_BACKED_CLOUD_MODE_KEYS) {
    if (localStorage.getItem(key) === "openwhispr") {
      localStorage.setItem(key, "byok");
    }
  }
}

// One-time migration for legacy `meetingFollows{Transcription,Reasoning}` flags.
// When the flag was true (the default), meeting/note recordings inherited the
// main dictation/intelligence settings. We've removed the toggle; copy the
// effective values into the dedicated meeting fields so post-migration reads
// (which always go through meeting fields) preserve every existing user's
// behavior. After migration the flag stays at "false" as a marker so this
// never runs again. Safe to delete after a few releases.
const MEETING_TRANSCRIPTION_PAIRS: ReadonlyArray<[string, string]> = [
  ["cloudTranscriptionBaseUrl", "meetingCloudTranscriptionBaseUrl"],
  ["gigaamBaseUrl", "meetingGigaamBaseUrl"],
  ["remoteTranscriptionUrl", "meetingRemoteTranscriptionUrl"],
];
const MEETING_REASONING_PAIRS: ReadonlyArray<[string, string]> = [
  ["reasoningProvider", "meetingReasoningProvider"],
  ["reasoningModel", "meetingReasoningModel"],
  ["reasoningMode", "meetingReasoningMode"],
  ["cloudReasoningMode", "meetingCloudReasoningMode"],
  ["cloudReasoningBaseUrl", "meetingCloudReasoningBaseUrl"],
  ["remoteReasoningType", "meetingRemoteReasoningType"],
  ["remoteReasoningUrl", "meetingRemoteReasoningUrl"],
];

function migrateMeetingFollowFlags() {
  if (!isBrowser) return;
  for (const [flag, pairs] of [
    ["meetingFollowsTranscription", MEETING_TRANSCRIPTION_PAIRS],
    ["meetingFollowsReasoning", MEETING_REASONING_PAIRS],
  ] as const) {
    if (localStorage.getItem(flag) === "false") continue;
    for (const [src, dst] of pairs) {
      const v = localStorage.getItem(src);
      if (v !== null) localStorage.setItem(dst, v);
    }
    localStorage.setItem(flag, "false");
  }
}

migrateMeetingFollowFlags();

const BOOLEAN_SETTINGS = new Set([
  "allowOpenAIFallback",
  "allowLocalFallback",
  "autoGenerateNoteTitle",
  "useCleanupModel",
  "useDictationAgent",
  "preferBuiltInMic",
  "hideCapsule",
  "audioCuesEnabled",
  "pauseMediaOnDictation",
  "startMinimized",
  "meetingProcessDetection",
  "meetingAudioDetection",
  "speakerDiarizationEnabled",
  "dictationSileroEnabled",
  "noteRecordingSileroEnabled",
  "meetingSileroEnabled",
  "isSignedIn",
  "noteFilesEnabled",
  "showTranscriptionPreview",
  "cleanupDisableThinking",
  "dictationAgentDisableThinking",
  "noteFormattingDisableThinking",
  "chatAgentDisableThinking",
  "notificationsEnabled",
  "notifyMeetingDetection",
  "notifyCalendarReminders",
  "notifyUpdates",
  "gcalPrimaryOnly",
]);

const ARRAY_SETTINGS = new Set(["gcalAccounts"]);

const NUMERIC_SETTINGS = new Set([
  "speechVadThreshold",
  "speechVadMinSpeechDurationMs",
  "speechVadMinSilenceDurationMs",
  "speechVadMaxSpeechDurationS",
  "speechVadSpeechPadMs",
  "speechVadSamplesOverlap",
]);

const SPEECH_VAD_DEFAULTS = speechVadConstants.DEFAULTS;
const SPEECH_VAD_LIMITS = speechVadConstants.LIMITS;

type SpeechVadKey = keyof typeof SPEECH_VAD_DEFAULTS;

const clampVadValue = (key: SpeechVadKey, raw: unknown): number => {
  const fallback = SPEECH_VAD_DEFAULTS[key];
  const n = raw === null || raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const { min, max, round } = SPEECH_VAD_LIMITS[key];
  const clamped = Math.min(max, Math.max(min, n));
  return round ? Math.round(clamped) : clamped;
};

const LANGUAGE_MIGRATIONS: Record<string, string> = { zh: "zh-CN" };

function migratePreferredLanguage() {
  if (!isBrowser) return;
  const stored = localStorage.getItem("preferredLanguage");
  if (stored && LANGUAGE_MIGRATIONS[stored]) {
    localStorage.setItem("preferredLanguage", LANGUAGE_MIGRATIONS[stored]);
  }
}

migratePreferredLanguage();

function enforceFixedUiSettings() {
  if (!isBrowser) return;
  localStorage.setItem("uiLanguage", FIXED_UI_LANGUAGE);
  localStorage.setItem("preferredLanguage", FIXED_TRANSCRIPTION_LANGUAGE);
  localStorage.setItem("theme", FIXED_THEME);
}

enforceFixedUiSettings();

function enforceFixedBehaviorSettings() {
  if (!isBrowser) return;
  localStorage.setItem("audioCuesEnabled", String(FIXED_AUDIO_CUES_ENABLED));
  localStorage.setItem("pauseMediaOnDictation", String(FIXED_PAUSE_MEDIA_ON_DICTATION));
  localStorage.setItem("startMinimized", String(FIXED_START_MINIMIZED));
  localStorage.setItem("notificationsEnabled", String(FIXED_NOTIFICATIONS_ENABLED));
  localStorage.setItem("notifyMeetingDetection", String(FIXED_NOTIFICATIONS_ENABLED));
  localStorage.setItem("notifyCalendarReminders", String(FIXED_NOTIFICATIONS_ENABLED));
  localStorage.setItem("notifyUpdates", String(FIXED_NOTIFICATIONS_ENABLED));
}

enforceFixedBehaviorSettings();

const LEGACY_TRANSCRIPTION_LOCALSTORAGE_KEYS = [
  "useLocalWhisper",
  "whisperModel",
  "localTranscriptionProvider",
  "parakeetModel",
  "fallbackWhisperModel",
  "meetingUseLocalWhisper",
  "meetingWhisperModel",
  "meetingLocalTranscriptionProvider",
  "meetingParakeetModel",
  "cloudTranscriptionProvider",
  "cloudTranscriptionModel",
  "cloudTranscriptionMode",
  "meetingCloudTranscriptionProvider",
  "meetingCloudTranscriptionModel",
  "meetingCloudTranscriptionMode",
  "transcriptionMode",
  "meetingTranscriptionMode",
  "remoteTranscriptionType",
  "meetingRemoteTranscriptionType",
] as const;

function enforceGigaamOnlyTranscriptionSettings() {
  if (!isBrowser) return;
  localStorage.setItem("allowOpenAIFallback", "false");
  localStorage.setItem("allowLocalFallback", "false");
  for (const key of LEGACY_TRANSCRIPTION_LOCALSTORAGE_KEYS) {
    localStorage.removeItem(key);
  }
}

enforceGigaamOnlyTranscriptionSettings();

const GIGATYPE_TRANSCRIPTION_SETTING_KEYS = [
  "gigaamBaseUrl",
  "cloudTranscriptionBaseUrl",
  "useCleanupModel",
  "useDictationAgent",
  "remoteTranscriptionUrl",
] as const;
const hadUserTranscriptionSettingsBeforeProviderMigration =
  isBrowser &&
  GIGATYPE_TRANSCRIPTION_SETTING_KEYS.some((key) => localStorage.getItem(key) !== null);

function migrateProviderSettings() {
  if (!isBrowser) return;
  if (localStorage.getItem("_providerSettingsMigrated") === "1") return;

  const legacyBaseUrl = localStorage.getItem("cloudTranscriptionBaseUrl");
  if (legacyBaseUrl && !localStorage.getItem("gigaamBaseUrl")) {
    localStorage.setItem("gigaamBaseUrl", legacyBaseUrl);
  }
  const existingRemoteUrl = localStorage.getItem("remoteTranscriptionUrl");
  if (!existingRemoteUrl && legacyBaseUrl && legacyBaseUrl !== API_ENDPOINTS.TRANSCRIPTION_BASE) {
    localStorage.setItem("remoteTranscriptionUrl", legacyBaseUrl);
  }

  const reasoningMode = localStorage.getItem("cloudReasoningMode");
  const reasoningProvider = localStorage.getItem("reasoningProvider");
  let newReasoningMode: InferenceMode = "local";
  if (reasoningMode === "byok") {
    if (reasoningProvider === "custom") {
      newReasoningMode = "self-hosted";
    } else if (
      reasoningProvider === "bedrock" ||
      reasoningProvider === "azure" ||
      reasoningProvider === "vertex"
    ) {
      newReasoningMode = "enterprise";
    } else if (
      reasoningProvider === "qwen" ||
      reasoningProvider === "llama" ||
      reasoningProvider === "mistral" ||
      reasoningProvider === "openai-oss" ||
      reasoningProvider === "gemma"
    ) {
      newReasoningMode = "local";
    } else {
      newReasoningMode = "local";
    }
  }
  localStorage.setItem("reasoningMode", newReasoningMode);

  if (reasoningProvider === "custom" && reasoningMode === "byok") {
    localStorage.setItem("remoteReasoningType", "openai-compatible");
  }

  localStorage.setItem("_providerSettingsMigrated", "1");
}

migrateProviderSettings();

function migrateAgentMode() {
  if (!isBrowser) return;
  if (localStorage.getItem("_agentModeMigrated") === "1") return;

  const cloudAgentMode = localStorage.getItem("cloudAgentMode");
  const agentProvider = localStorage.getItem("agentProvider");

  let agentInferenceMode: InferenceMode = "local";
  if (cloudAgentMode === "byok") {
    const localProviders = ["qwen", "llama", "mistral", "openai-oss", "gemma"];
    if (agentProvider === "custom") {
      agentInferenceMode = "self-hosted";
    } else if (
      agentProvider === "bedrock" ||
      agentProvider === "azure" ||
      agentProvider === "vertex"
    ) {
      agentInferenceMode = "enterprise";
    } else if (agentProvider && localProviders.includes(agentProvider)) {
      agentInferenceMode = "local";
    } else {
      agentInferenceMode = "local";
    }
  }
  localStorage.setItem("agentInferenceMode", agentInferenceMode);

  localStorage.setItem("_agentModeMigrated", "1");
}

migrateAgentMode();

function migrateCustomPrompts() {
  if (!isBrowser) return;
  if (localStorage.getItem("_promptsMigrated") === "1") return;

  const legacyUnified = localStorage.getItem("customUnifiedPrompt");
  if (legacyUnified) {
    try {
      const parsed = JSON.parse(legacyUnified);
      if (typeof parsed === "string" && parsed.length > 0) {
        if (!localStorage.getItem("customPrompt.cleanup")) {
          localStorage.setItem("customPrompt.cleanup", parsed);
        }
        if (!localStorage.getItem("customPrompt.dictationAgent")) {
          localStorage.setItem("customPrompt.dictationAgent", parsed);
        }
      }
    } catch {}
    localStorage.removeItem("customUnifiedPrompt");
  }

  const legacyChat = localStorage.getItem("agentSystemPrompt");
  if (legacyChat && legacyChat.length > 0 && !localStorage.getItem("customPrompt.chatAgent")) {
    localStorage.setItem("customPrompt.chatAgent", legacyChat);
  }
  if (legacyChat !== null) localStorage.removeItem("agentSystemPrompt");

  localStorage.setItem("_promptsMigrated", "1");
}

migrateCustomPrompts();

// One-time migration of legacy LLM-scope localStorage keys. Safe to delete
// after a few releases.
const LLM_SCOPE_KEY_PAIRS: ReadonlyArray<[string, string]> = [
  ["reasoningModel", "cleanupModel"],
  ["reasoningProvider", "cleanupProvider"],
  ["reasoningMode", "cleanupMode"],
  ["useReasoningModel", "useCleanupModel"],
  ["cloudReasoningMode", "cleanupCloudMode"],
  ["cloudReasoningBaseUrl", "cleanupCloudBaseUrl"],
  ["remoteReasoningUrl", "cleanupRemoteUrl"],
  ["meetingReasoningMode", "noteFormattingMode"],
  ["meetingReasoningProvider", "noteFormattingProvider"],
  ["meetingReasoningModel", "noteFormattingModel"],
  ["meetingCloudReasoningMode", "noteFormattingCloudMode"],
  ["meetingCloudReasoningBaseUrl", "noteFormattingCloudBaseUrl"],
  ["meetingRemoteReasoningUrl", "noteFormattingRemoteUrl"],
  ["agentInferenceMode", "chatAgentMode"],
  ["agentProvider", "chatAgentProvider"],
  ["agentModel", "chatAgentModel"],
  ["cloudAgentMode", "chatAgentCloudMode"],
  ["remoteAgentUrl", "chatAgentRemoteUrl"],
  ["agentKey", "chatAgentKey"],
];

function migrateLLMScopeKeys() {
  if (!isBrowser) return;
  if (localStorage.getItem("_llmScopeKeysMigrated") === "1") return;

  for (const [oldKey, newKey] of LLM_SCOPE_KEY_PAIRS) {
    const value = localStorage.getItem(oldKey);
    if (value === null) continue;
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, value);
    }
    localStorage.removeItem(oldKey);
  }

  localStorage.setItem("_llmScopeKeysMigrated", "1");
}

migrateLLMScopeKeys();

function migrateDisabledCloudProviderModes() {
  if (!isBrowser) return;

  for (const scope of INFERENCE_STORAGE_SCOPES) {
    const mode = localStorage.getItem(scope.modeKey);
    if (mode !== "providers" && mode !== "openwhispr") continue;

    const provider = localStorage.getItem(scope.providerKey);
    if (provider === "custom") {
      localStorage.setItem(scope.modeKey, "self-hosted");
      const cloudBaseUrl = localStorage.getItem(scope.cloudBaseUrlKey);
      if (cloudBaseUrl && !localStorage.getItem(scope.remoteUrlKey)) {
        localStorage.setItem(scope.remoteUrlKey, cloudBaseUrl);
      }
      continue;
    }

    localStorage.setItem(scope.modeKey, "local");
    if (!provider || DISABLED_CLOUD_PROVIDER_IDS.has(provider)) {
      localStorage.setItem(scope.providerKey, DEFAULT_LOCAL_PROVIDER);
      localStorage.setItem(scope.modelKey, "");
    }
  }
}

migrateDisabledCloudProviderModes();
disableAccountBackedFeatures();

export interface SettingsState
  extends
    TranscriptionSettings,
    CleanupSettings,
    HotkeySettings,
    MicrophoneSettings,
    PrivacySettings,
    ThemeSettings,
    ChatAgentSettings {
  isSignedIn: boolean;
  audioCuesEnabled: boolean;
  pauseMediaOnDictation: boolean;
  startMinimized: boolean;
  gcalAccounts: GoogleCalendarAccount[];
  gcalConnected: boolean;
  gcalEmail: string;
  notificationsEnabled: boolean;
  notifyMeetingDetection: boolean;
  notifyCalendarReminders: boolean;
  notifyUpdates: boolean;
  gcalPrimaryOnly: boolean;
  meetingProcessDetection: boolean;
  meetingAudioDetection: boolean;
  speakerDiarizationEnabled: boolean;
  dictationSileroEnabled: boolean;
  noteRecordingSileroEnabled: boolean;
  meetingSileroEnabled: boolean;
  speechVadThreshold: number;
  speechVadMinSpeechDurationMs: number;
  speechVadMinSilenceDurationMs: number;
  speechVadMaxSpeechDurationS: number;
  speechVadSpeechPadMs: number;
  speechVadSamplesOverlap: number;
  showTranscriptionPreview: boolean;
  noteFilesEnabled: boolean;
  noteFilesPath: string;

  remoteTranscriptionUrl: string;
  gigaamBaseUrl: string;
  cleanupMode: InferenceMode;
  cleanupRemoteUrl: string;

  meetingGigaamBaseUrl: string;
  meetingRemoteTranscriptionUrl: string;

  noteFormattingMode: InferenceMode;
  noteFormattingProvider: string;
  noteFormattingModel: string;
  noteFormattingCloudMode: string;
  noteFormattingCloudBaseUrl: string;
  noteFormattingRemoteUrl: string;

  dictationAgentMode: InferenceMode;
  dictationAgentProvider: string;
  dictationAgentModel: string;
  dictationAgentCloudMode: string;
  dictationAgentCloudBaseUrl: string;
  dictationAgentRemoteUrl: string;

  cleanupDisableThinking: boolean;
  dictationAgentDisableThinking: boolean;
  noteFormattingDisableThinking: boolean;
  chatAgentDisableThinking: boolean;

  customPrompts: Record<PromptKind, string>;
  setCustomPrompt: (kind: PromptKind, value: string) => void;

  setDictationAgentMode: (mode: InferenceMode) => void;
  setDictationAgentProvider: (value: string) => void;
  setDictationAgentModel: (value: string) => void;
  setDictationAgentCloudMode: (value: string) => void;
  setDictationAgentCloudBaseUrl: (value: string) => void;
  setDictationAgentRemoteUrl: (url: string) => void;

  setRemoteTranscriptionUrl: (url: string) => void;
  setGigaamBaseUrl: (value: string) => void;
  setCleanupMode: (mode: InferenceMode) => void;
  setCleanupRemoteUrl: (url: string) => void;

  setMeetingGigaamBaseUrl: (value: string) => void;
  setMeetingRemoteTranscriptionUrl: (url: string) => void;

  setNoteFormattingMode: (mode: InferenceMode) => void;
  setNoteFormattingProvider: (value: string) => void;
  setNoteFormattingModel: (value: string) => void;
  setNoteFormattingCloudMode: (value: string) => void;
  setNoteFormattingCloudBaseUrl: (value: string) => void;
  setNoteFormattingRemoteUrl: (url: string) => void;

  setCleanupDisableThinking: (value: boolean) => void;
  setDictationAgentDisableThinking: (value: boolean) => void;
  setNoteFormattingDisableThinking: (value: boolean) => void;
  setChatAgentDisableThinking: (value: boolean) => void;

  setAllowOpenAIFallback: (value: boolean) => void;
  setAllowLocalFallback: (value: boolean) => void;
  setPreferredLanguage: (value: string) => void;
  setCleanupCloudMode: (value: string) => void;
  setCleanupCloudBaseUrl: (value: string) => void;
  setAutoGenerateNoteTitle: (value: boolean) => void;
  setUseCleanupModel: (value: boolean) => void;
  setUseDictationAgent: (value: boolean) => void;
  setCleanupModel: (value: string) => void;
  setCleanupProvider: (value: string) => void;
  setUiLanguage: (language: string) => void;

  // Enterprise providers
  bedrockAuthMode: string;
  bedrockRegion: string;
  bedrockProfile: string;
  azureEndpoint: string;
  azureDeploymentName: string;
  azureApiVersion: string;
  vertexAuthMode: string;
  vertexProject: string;
  vertexLocation: string;
  setBedrockAuthMode: (value: string) => void;
  setBedrockRegion: (value: string) => void;
  setBedrockProfile: (value: string) => void;
  setAzureEndpoint: (value: string) => void;
  setAzureDeploymentName: (value: string) => void;
  setAzureApiVersion: (value: string) => void;
  setVertexAuthMode: (value: string) => void;
  setVertexProject: (value: string) => void;
  setVertexLocation: (value: string) => void;

  setDictationKey: (key: string) => void;
  setMeetingKey: (key: string) => void;
  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => void;
  setActivationMode: (mode: "tap" | "push") => void;

  setPreferBuiltInMic: (value: boolean) => void;
  setSelectedMicDeviceId: (value: string) => void;
  setHideCapsule: (value: boolean) => void;

  setTheme: (value: "light" | "dark" | "auto") => void;
  setTelemetryEnabled: (value: boolean) => void;
  setAudioRetentionDays: (days: number) => void;
  setDataRetentionEnabled: (value: boolean) => void;
  setAudioCuesEnabled: (value: boolean) => void;
  setPauseMediaOnDictation: (value: boolean) => void;
  setStartMinimized: (enabled: boolean) => void;
  setGcalAccounts: (accounts: GoogleCalendarAccount[]) => void;
  setNotificationsEnabled: (value: boolean) => void;
  setNotifyMeetingDetection: (value: boolean) => void;
  setNotifyCalendarReminders: (value: boolean) => void;
  setNotifyUpdates: (value: boolean) => void;
  setGcalPrimaryOnly: (value: boolean) => void;
  setMeetingProcessDetection: (value: boolean) => void;
  setMeetingAudioDetection: (value: boolean) => void;
  setSpeakerDiarizationEnabled: (value: boolean) => void;
  setDictationSileroEnabled: (value: boolean) => void;
  setNoteRecordingSileroEnabled: (value: boolean) => void;
  setMeetingSileroEnabled: (value: boolean) => void;
  setSpeechVadThreshold: (value: number) => void;
  setSpeechVadMinSpeechDurationMs: (value: number) => void;
  setSpeechVadMinSilenceDurationMs: (value: number) => void;
  setSpeechVadMaxSpeechDurationS: (value: number) => void;
  setSpeechVadSpeechPadMs: (value: number) => void;
  setSpeechVadSamplesOverlap: (value: number) => void;
  setShowTranscriptionPreview: (value: boolean) => void;
  setNoteFilesEnabled: (value: boolean) => void;
  setNoteFilesPath: (value: string) => void;
  setIsSignedIn: (value: boolean) => void;

  setChatAgentModel: (value: string) => void;
  setChatAgentProvider: (value: string) => void;
  setChatAgentKey: (key: string) => void;
  setChatAgentCloudMode: (value: string) => void;
  setChatAgentMode: (mode: InferenceMode) => void;
  setChatAgentCloudBaseUrl: (value: string) => void;
  setChatAgentRemoteUrl: (url: string) => void;

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => void;
  updateCleanupSettings: (settings: Partial<CleanupSettings>) => void;
  updateChatAgentSettings: (settings: Partial<ChatAgentSettings>) => void;
}

function createStringSetter(key: string) {
  return (value: string) => {
    const nextValue = normalizeAuthBackedSetting(key, value);
    if (isBrowser) localStorage.setItem(key, nextValue);
    useSettingsStore.setState({ [key]: nextValue });
  };
}

function createBooleanSetter(key: string) {
  return (value: boolean) => {
    if (isBrowser) localStorage.setItem(key, String(value));
    useSettingsStore.setState({ [key]: value });
  };
}

const GIGATYPE_ASR_DEFAULTS_APPLIED_KEY = "_gigatypeAsrDefaultsApplied";
const LOCAL_GIGAAM_API_BASE_RE =
  /^http:\/\/127\.0\.0\.1:(?:876[5-9]|877[0-5])\/v1(?:\/audio\/transcriptions)?\/?$/i;

function isLocalGigaamApiBase(value: string | null | undefined): boolean {
  return LOCAL_GIGAAM_API_BASE_RE.test((value || "").trim());
}

function shouldSyncGigaamApiBase(value: string | null | undefined): boolean {
  const trimmed = (value || "").trim();
  return !trimmed || isLocalGigaamApiBase(trimmed);
}

function hasPartialGigaamAsrConfig(): boolean {
  if (!isBrowser) return false;

  return (
    isLocalGigaamApiBase(localStorage.getItem("remoteTranscriptionUrl")) ||
    isLocalGigaamApiBase(localStorage.getItem("gigaamBaseUrl")) ||
    isLocalGigaamApiBase(localStorage.getItem("cloudTranscriptionBaseUrl"))
  );
}

function persistSettingsPatch(patch: Partial<SettingsState>) {
  if (!isBrowser || Object.keys(patch).length === 0) return;

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    localStorage.setItem(key, typeof value === "boolean" ? String(value) : String(value));
  }
  useSettingsStore.setState(patch);
}

async function syncTypeAsrSettings(status?: GigaamSidecarStatus | null): Promise<void> {
  if (!isBrowser) return;

  let sidecarStatus = status;
  if (!sidecarStatus) {
    try {
      sidecarStatus = await window.electronAPI?.getGigaamSidecarStatus?.();
    } catch (err) {
      logger.warn(
        "Failed to read GigaAM sidecar status",
        { error: (err as Error).message },
        "settings"
      );
      return;
    }
  }

  if (!sidecarStatus?.available || !sidecarStatus.apiBaseUrl) return;

  const apiBaseUrl = sidecarStatus.apiBaseUrl.replace(/\/+$/, "");
  const isFreshProfile =
    localStorage.getItem(GIGATYPE_ASR_DEFAULTS_APPLIED_KEY) !== "1" &&
    !hadUserTranscriptionSettingsBeforeProviderMigration;
  const shouldRepairPartialGigaamConfig =
    localStorage.getItem(GIGATYPE_ASR_DEFAULTS_APPLIED_KEY) !== "1" && hasPartialGigaamAsrConfig();
  const patch: Partial<SettingsState> = {};

  if (isFreshProfile || shouldRepairPartialGigaamConfig) {
    Object.assign(patch, {
      remoteTranscriptionUrl: apiBaseUrl,
      gigaamBaseUrl: apiBaseUrl,
      useCleanupModel: false,
      useDictationAgent: false,
      preferredLanguage: "ru",
    });
  } else {
    if (shouldSyncGigaamApiBase(localStorage.getItem("remoteTranscriptionUrl"))) {
      patch.remoteTranscriptionUrl = apiBaseUrl;
    }
    if (
      shouldSyncGigaamApiBase(
        localStorage.getItem("gigaamBaseUrl") || localStorage.getItem("cloudTranscriptionBaseUrl")
      )
    ) {
      patch.gigaamBaseUrl = apiBaseUrl;
    }
  }

  persistSettingsPatch(patch);

  if (isFreshProfile || shouldRepairPartialGigaamConfig) {
    localStorage.setItem(GIGATYPE_ASR_DEFAULTS_APPLIED_KEY, "1");
  }
}

let envPersistTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedPersistToEnv() {
  if (!isBrowser) return;
  if (envPersistTimer) clearTimeout(envPersistTimer);
  envPersistTimer = setTimeout(() => {
    window.electronAPI?.saveRuntimeConfigToEnv?.().catch((err) => {
      logger.warn(
        "Failed to persist runtime config to .env",
        { error: (err as Error).message },
        "settings"
      );
    });
  }, 1000);
}

const STALE_SECRET_LOCALSTORAGE_KEYS = [
  "openaiApiKey",
  "anthropicApiKey",
  "geminiApiKey",
  "groqApiKey",
  "mistralApiKey",
  "customTranscriptionApiKey",
  "customReasoningApiKey",
  "cleanupCustomApiKey",
  "bedrockAccessKeyId",
  "bedrockSecretAccessKey",
  "bedrockSessionToken",
  "azureApiKey",
  "vertexApiKey",
] as const;

function clearLegacySecretLocalStorage() {
  if (!isBrowser) return;
  for (const key of STALE_SECRET_LOCALSTORAGE_KEYS) {
    localStorage.removeItem(key);
  }
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  uiLanguage: FIXED_UI_LANGUAGE,
  allowOpenAIFallback: readBoolean("allowOpenAIFallback", false),
  allowLocalFallback: readBoolean("allowLocalFallback", false),
  preferredLanguage: FIXED_TRANSCRIPTION_LANGUAGE,
  gigaamBaseUrl: readMigratedString(
    "gigaamBaseUrl",
    "cloudTranscriptionBaseUrl",
    API_ENDPOINTS.TRANSCRIPTION_BASE
  ),
  cleanupCloudMode: readString("cleanupCloudMode", "byok"),
  cleanupCloudBaseUrl: readString("cleanupCloudBaseUrl", API_ENDPOINTS.OPENAI_BASE),
  autoGenerateNoteTitle: readBoolean("autoGenerateNoteTitle", true),
  useCleanupModel: readBoolean("useCleanupModel", false),
  useDictationAgent: readBoolean("useDictationAgent", false),
  cleanupModel: readString("cleanupModel", ""),
  cleanupProvider: readString("cleanupProvider", DEFAULT_LOCAL_PROVIDER),

  // Enterprise providers
  bedrockAuthMode: readString("bedrockAuthMode", "sso"),
  bedrockRegion: readString("bedrockRegion", "us-east-1"),
  bedrockProfile: readString("bedrockProfile", ""),
  azureEndpoint: readString("azureEndpoint", ""),
  azureDeploymentName: readString("azureDeploymentName", ""),
  azureApiVersion: readString("azureApiVersion", "2024-10-21"),
  vertexAuthMode: readString("vertexAuthMode", "adc"),
  vertexProject: readString("vertexProject", ""),
  vertexLocation: readString("vertexLocation", "us-central1"),

  dictationKey: readString("dictationKey", ""),
  meetingKey: readString("meetingKey", ""),
  meetingHotkeyLayoutMode: (readString("meetingHotkeyLayoutMode", "full-width") === "side-panel"
    ? "side-panel"
    : "full-width") as "side-panel" | "full-width",
  activationMode: readActivationMode(),

  preferBuiltInMic: readBoolean("preferBuiltInMic", true),
  selectedMicDeviceId: readString("selectedMicDeviceId", ""),
  hideCapsule: readBoolean("hideCapsule", false),

  theme: FIXED_THEME,
  telemetryEnabled: false,
  audioRetentionDays: 0,
  dataRetentionEnabled: false,
  audioCuesEnabled: FIXED_AUDIO_CUES_ENABLED,
  pauseMediaOnDictation: FIXED_PAUSE_MEDIA_ON_DICTATION,
  startMinimized: FIXED_START_MINIMIZED,
  notificationsEnabled: FIXED_NOTIFICATIONS_ENABLED,
  notifyMeetingDetection: FIXED_NOTIFICATIONS_ENABLED,
  notifyCalendarReminders: FIXED_NOTIFICATIONS_ENABLED,
  notifyUpdates: FIXED_NOTIFICATIONS_ENABLED,
  ...(() => {
    let accounts: GoogleCalendarAccount[] = [];
    try {
      const parsed = JSON.parse(readString("gcalAccounts", "[]"));
      if (Array.isArray(parsed)) accounts = parsed;
    } catch {
      /* use empty default */
    }
    return {
      gcalAccounts: accounts,
      gcalConnected: accounts.length > 0,
      gcalEmail: accounts[0]?.email ?? "",
    };
  })(),
  gcalPrimaryOnly: readBoolean("gcalPrimaryOnly", true),
  meetingProcessDetection: readBoolean("meetingProcessDetection", true),
  meetingAudioDetection: readBoolean("meetingAudioDetection", true),
  speakerDiarizationEnabled: readBoolean("speakerDiarizationEnabled", true),
  dictationSileroEnabled: readBoolean("dictationSileroEnabled", true),
  noteRecordingSileroEnabled: readBoolean("noteRecordingSileroEnabled", true),
  meetingSileroEnabled: readBoolean("meetingSileroEnabled", true),
  speechVadThreshold: clampVadValue(
    "threshold",
    readMigratedString("speechVadThreshold", "whisperVadThreshold", "0.5")
  ),
  speechVadMinSpeechDurationMs: clampVadValue(
    "minSpeechDurationMs",
    readMigratedString(
      "speechVadMinSpeechDurationMs",
      "whisperVadMinSpeechDurationMs",
      "250"
    )
  ),
  speechVadMinSilenceDurationMs: clampVadValue(
    "minSilenceDurationMs",
    readMigratedString(
      "speechVadMinSilenceDurationMs",
      "whisperVadMinSilenceDurationMs",
      "200"
    )
  ),
  speechVadMaxSpeechDurationS: clampVadValue(
    "maxSpeechDurationS",
    readMigratedString("speechVadMaxSpeechDurationS", "whisperVadMaxSpeechDurationS", "30")
  ),
  speechVadSpeechPadMs: clampVadValue(
    "speechPadMs",
    readMigratedString("speechVadSpeechPadMs", "whisperVadSpeechPadMs", "100")
  ),
  speechVadSamplesOverlap: clampVadValue(
    "samplesOverlap",
    readMigratedString("speechVadSamplesOverlap", "whisperVadSamplesOverlap", "0.5")
  ),
  showTranscriptionPreview: readBoolean("showTranscriptionPreview", false),
  noteFilesEnabled: readBoolean("noteFilesEnabled", false),
  noteFilesPath: readString("noteFilesPath", ""),
  isSignedIn: false,

  remoteTranscriptionUrl: readString("remoteTranscriptionUrl", ""),
  cleanupMode: (() => {
    const v = readString("cleanupMode", "local");
    if (v === "local" || v === "self-hosted" || v === "enterprise") return v;
    return "local" as InferenceMode;
  })(),
  cleanupRemoteUrl: readString("cleanupRemoteUrl", ""),

  meetingGigaamBaseUrl: readMigratedString(
    "meetingGigaamBaseUrl",
    "meetingCloudTranscriptionBaseUrl",
    ""
  ),
  meetingRemoteTranscriptionUrl: readString("meetingRemoteTranscriptionUrl", ""),

  noteFormattingMode: (() => {
    const v = readString("noteFormattingMode", "local");
    if (v === "local" || v === "self-hosted" || v === "enterprise") return v;
    return "local" as InferenceMode;
  })(),
  noteFormattingProvider: readString("noteFormattingProvider", ""),
  noteFormattingModel: readString("noteFormattingModel", ""),
  noteFormattingCloudMode: readString("noteFormattingCloudMode", ""),
  noteFormattingCloudBaseUrl: readString("noteFormattingCloudBaseUrl", ""),
  noteFormattingRemoteUrl: readString("noteFormattingRemoteUrl", ""),

  setRemoteTranscriptionUrl: createStringSetter("remoteTranscriptionUrl"),
  setGigaamBaseUrl: createStringSetter("gigaamBaseUrl"),
  setCleanupMode: createStringSetter("cleanupMode") as (mode: InferenceMode) => void,
  setCleanupRemoteUrl: createStringSetter("cleanupRemoteUrl"),

  setMeetingGigaamBaseUrl: createStringSetter("meetingGigaamBaseUrl"),
  setMeetingRemoteTranscriptionUrl: createStringSetter("meetingRemoteTranscriptionUrl"),

  setNoteFormattingMode: createStringSetter("noteFormattingMode") as (mode: InferenceMode) => void,
  setNoteFormattingProvider: createStringSetter("noteFormattingProvider"),
  setNoteFormattingModel: createStringSetter("noteFormattingModel"),
  setNoteFormattingCloudMode: createStringSetter("noteFormattingCloudMode"),
  setNoteFormattingCloudBaseUrl: createStringSetter("noteFormattingCloudBaseUrl"),
  setNoteFormattingRemoteUrl: createStringSetter("noteFormattingRemoteUrl"),
  chatAgentModel: readString("chatAgentModel", ""),
  chatAgentProvider: readString("chatAgentProvider", DEFAULT_LOCAL_PROVIDER),
  chatAgentKey: readString("chatAgentKey", ""),
  chatAgentCloudMode: readString("chatAgentCloudMode", "byok"),
  chatAgentMode: (() => {
    const v = readString("chatAgentMode", "local");
    if (v === "local" || v === "self-hosted" || v === "enterprise") return v;
    return "local" as InferenceMode;
  })(),
  chatAgentRemoteUrl: readString("chatAgentRemoteUrl", ""),
  chatAgentCloudBaseUrl: readString("chatAgentCloudBaseUrl", ""),

  dictationAgentMode: (() => {
    const v = readString("dictationAgentMode", "local");
    if (v === "local" || v === "self-hosted" || v === "enterprise") return v;
    return "local" as InferenceMode;
  })(),
  dictationAgentProvider: readString("dictationAgentProvider", ""),
  dictationAgentModel: readString("dictationAgentModel", ""),
  dictationAgentCloudMode: readString("dictationAgentCloudMode", ""),
  dictationAgentCloudBaseUrl: readString("dictationAgentCloudBaseUrl", ""),
  dictationAgentRemoteUrl: readString("dictationAgentRemoteUrl", ""),

  cleanupDisableThinking: readBoolean("cleanupDisableThinking", true),
  dictationAgentDisableThinking: readBoolean("dictationAgentDisableThinking", true),
  noteFormattingDisableThinking: readBoolean("noteFormattingDisableThinking", true),
  chatAgentDisableThinking: readBoolean("chatAgentDisableThinking", true),

  customPrompts: PROMPT_KIND_LIST.reduce(
    (acc, kind) => ({ ...acc, [kind]: readString(`customPrompt.${kind}`, "") }),
    {} as Record<PromptKind, string>
  ),
  setCustomPrompt: (kind, value) => {
    if (isBrowser) localStorage.setItem(`customPrompt.${kind}`, value);
    useSettingsStore.setState((s) => ({
      customPrompts: { ...s.customPrompts, [kind]: value },
    }));
  },

  setDictationAgentMode: createStringSetter("dictationAgentMode") as (mode: InferenceMode) => void,
  setDictationAgentProvider: createStringSetter("dictationAgentProvider"),
  setDictationAgentModel: createStringSetter("dictationAgentModel"),
  setDictationAgentCloudMode: createStringSetter("dictationAgentCloudMode"),
  setDictationAgentCloudBaseUrl: createStringSetter("dictationAgentCloudBaseUrl"),
  setDictationAgentRemoteUrl: createStringSetter("dictationAgentRemoteUrl"),

  setCleanupDisableThinking: createBooleanSetter("cleanupDisableThinking"),
  setDictationAgentDisableThinking: createBooleanSetter("dictationAgentDisableThinking"),
  setNoteFormattingDisableThinking: createBooleanSetter("noteFormattingDisableThinking"),
  setChatAgentDisableThinking: createBooleanSetter("chatAgentDisableThinking"),

  setAllowOpenAIFallback: () => {
    if (isBrowser) localStorage.setItem("allowOpenAIFallback", "false");
    set({ allowOpenAIFallback: false });
  },
  setAllowLocalFallback: () => {
    if (isBrowser) localStorage.setItem("allowLocalFallback", "false");
    set({ allowLocalFallback: false });
  },
  setPreferredLanguage: () => {
    if (isBrowser) localStorage.setItem("preferredLanguage", FIXED_TRANSCRIPTION_LANGUAGE);
    set({ preferredLanguage: FIXED_TRANSCRIPTION_LANGUAGE });
  },
  setCleanupCloudMode: createStringSetter("cleanupCloudMode"),
  setCleanupCloudBaseUrl: createStringSetter("cleanupCloudBaseUrl"),
  setAutoGenerateNoteTitle: createBooleanSetter("autoGenerateNoteTitle"),
  setUseCleanupModel: createBooleanSetter("useCleanupModel"),
  setUseDictationAgent: createBooleanSetter("useDictationAgent"),
  setCleanupProvider: createStringSetter("cleanupProvider"),
  setCleanupModel: createStringSetter("cleanupModel"),

  setUiLanguage: () => {
    if (isBrowser) localStorage.setItem("uiLanguage", FIXED_UI_LANGUAGE);
    set({ uiLanguage: FIXED_UI_LANGUAGE });
    void i18n.changeLanguage(FIXED_UI_LANGUAGE);
    if (isBrowser && window.electronAPI?.setUiLanguage) {
      window.electronAPI.setUiLanguage(FIXED_UI_LANGUAGE).catch((err) => {
        logger.warn(
          "Failed to sync UI language to main process",
          { error: (err as Error).message },
          "settings"
        );
      });
    }
  },

  // Enterprise provider setters
  setBedrockAuthMode: (value: string) => {
    if (isBrowser) localStorage.setItem("bedrockAuthMode", value);
    set({ bedrockAuthMode: value });
  },
  setBedrockRegion: (value: string) => {
    if (isBrowser) localStorage.setItem("bedrockRegion", value);
    set({ bedrockRegion: value });
    window.electronAPI?.saveBedrockRegion?.(value);
    debouncedPersistToEnv();
  },
  setBedrockProfile: (value: string) => {
    if (isBrowser) localStorage.setItem("bedrockProfile", value);
    set({ bedrockProfile: value });
    window.electronAPI?.saveBedrockProfile?.(value);
    debouncedPersistToEnv();
  },
  setAzureEndpoint: (value: string) => {
    if (isBrowser) localStorage.setItem("azureEndpoint", value);
    set({ azureEndpoint: value });
    window.electronAPI?.saveAzureEndpoint?.(value);
    debouncedPersistToEnv();
  },
  setAzureDeploymentName: (value: string) => {
    if (isBrowser) localStorage.setItem("azureDeploymentName", value);
    set({ azureDeploymentName: value });
    window.electronAPI?.saveAzureDeployment?.(value);
    debouncedPersistToEnv();
  },
  setAzureApiVersion: (value: string) => {
    if (isBrowser) localStorage.setItem("azureApiVersion", value);
    set({ azureApiVersion: value });
    window.electronAPI?.saveAzureApiVersion?.(value);
    debouncedPersistToEnv();
  },
  setVertexAuthMode: (value: string) => {
    if (isBrowser) localStorage.setItem("vertexAuthMode", value);
    set({ vertexAuthMode: value });
  },
  setVertexProject: (value: string) => {
    if (isBrowser) localStorage.setItem("vertexProject", value);
    set({ vertexProject: value });
    window.electronAPI?.saveVertexProject?.(value);
    debouncedPersistToEnv();
  },
  setVertexLocation: (value: string) => {
    if (isBrowser) localStorage.setItem("vertexLocation", value);
    set({ vertexLocation: value });
    window.electronAPI?.saveVertexLocation?.(value);
    debouncedPersistToEnv();
  },

  setDictationKey: (key: string) => {
    if (isBrowser) localStorage.setItem("dictationKey", key);
    set({ dictationKey: key });
    if (isBrowser) {
      window.electronAPI?.notifyHotkeyChanged?.(key);
      window.electronAPI?.saveDictationKey?.(key);
    }
  },
  setMeetingKey: (key: string) => {
    if (isBrowser) localStorage.setItem("meetingKey", key);
    set({ meetingKey: key });
  },

  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => {
    if (isBrowser) localStorage.setItem("meetingHotkeyLayoutMode", mode);
    set({ meetingHotkeyLayoutMode: mode });
  },

  setActivationMode: (mode: "tap" | "push") => {
    const nextMode = normalizeActivationMode(mode);
    if (isBrowser) localStorage.setItem("activationMode", nextMode);
    set({ activationMode: nextMode });
    if (isBrowser) {
      window.electronAPI?.notifyActivationModeChanged?.(nextMode);
    }
  },

  setPreferBuiltInMic: createBooleanSetter("preferBuiltInMic"),
  setSelectedMicDeviceId: createStringSetter("selectedMicDeviceId"),
  setHideCapsule: createBooleanSetter("hideCapsule"),

  setTheme: () => {
    if (isBrowser) localStorage.setItem("theme", FIXED_THEME);
    set({ theme: FIXED_THEME });
  },

  setTelemetryEnabled: () => {
    if (isBrowser) localStorage.setItem("telemetryEnabled", "false");
    set({ telemetryEnabled: false });
  },
  setAudioRetentionDays: () => {
    if (isBrowser) localStorage.setItem("audioRetentionDays", "0");
    set({ audioRetentionDays: 0 });
  },
  setDataRetentionEnabled: () => {
    if (isBrowser) localStorage.setItem("dataRetentionEnabled", "false");
    set({ dataRetentionEnabled: false });
    logger.info(
      "Data retention disabled — transcriptions and audio will not be saved",
      {},
      "settings"
    );
  },
  setAudioCuesEnabled: () => {
    if (isBrowser) localStorage.setItem("audioCuesEnabled", String(FIXED_AUDIO_CUES_ENABLED));
    set({ audioCuesEnabled: FIXED_AUDIO_CUES_ENABLED });
  },
  setPauseMediaOnDictation: () => {
    if (isBrowser) {
      localStorage.setItem("pauseMediaOnDictation", String(FIXED_PAUSE_MEDIA_ON_DICTATION));
    }
    set({ pauseMediaOnDictation: FIXED_PAUSE_MEDIA_ON_DICTATION });
  },

  setStartMinimized: (_enabled: boolean) => {
    if (get().startMinimized === FIXED_START_MINIMIZED) return;
    if (isBrowser) localStorage.setItem("startMinimized", String(FIXED_START_MINIMIZED));
    set({ startMinimized: FIXED_START_MINIMIZED });
    if (isBrowser) {
      window.electronAPI?.notifyStartMinimizedChanged?.(FIXED_START_MINIMIZED);
    }
  },

  setGcalAccounts: (accounts: GoogleCalendarAccount[]) => {
    if (isBrowser) localStorage.setItem("gcalAccounts", JSON.stringify(accounts));
    useSettingsStore.setState({
      gcalAccounts: accounts,
      gcalConnected: accounts.length > 0,
      gcalEmail: accounts[0]?.email ?? "",
    });
  },
  setNotificationsEnabled: () => {
    if (isBrowser)
      localStorage.setItem("notificationsEnabled", String(FIXED_NOTIFICATIONS_ENABLED));
    useSettingsStore.setState({ notificationsEnabled: FIXED_NOTIFICATIONS_ENABLED });
  },
  setNotifyMeetingDetection: () => {
    if (isBrowser) {
      localStorage.setItem("notifyMeetingDetection", String(FIXED_NOTIFICATIONS_ENABLED));
    }
    useSettingsStore.setState({ notifyMeetingDetection: FIXED_NOTIFICATIONS_ENABLED });
  },
  setNotifyCalendarReminders: () => {
    if (isBrowser) {
      localStorage.setItem("notifyCalendarReminders", String(FIXED_NOTIFICATIONS_ENABLED));
    }
    useSettingsStore.setState({ notifyCalendarReminders: FIXED_NOTIFICATIONS_ENABLED });
  },
  setNotifyUpdates: () => {
    if (isBrowser) localStorage.setItem("notifyUpdates", String(FIXED_NOTIFICATIONS_ENABLED));
    useSettingsStore.setState({ notifyUpdates: FIXED_NOTIFICATIONS_ENABLED });
  },
  setGcalPrimaryOnly: (value: boolean) => {
    if (isBrowser) localStorage.setItem("gcalPrimaryOnly", String(value));
    useSettingsStore.setState({ gcalPrimaryOnly: value });
    if (isBrowser) window.electronAPI?.gcalSetPrimaryOnly?.(value);
  },
  setMeetingProcessDetection: createBooleanSetter("meetingProcessDetection"),
  setMeetingAudioDetection: createBooleanSetter("meetingAudioDetection"),
  setSpeakerDiarizationEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("speakerDiarizationEnabled", String(value));
    useSettingsStore.setState({ speakerDiarizationEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setSpeakerDiarizationEnabled?.(value);
    }
  },
  setDictationSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("dictationSileroEnabled", String(value));
    useSettingsStore.setState({ dictationSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setSpeechVadConfig?.({ dictationSileroEnabled: value });
    }
  },
  setNoteRecordingSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("noteRecordingSileroEnabled", String(value));
    useSettingsStore.setState({ noteRecordingSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setSpeechVadConfig?.({ noteRecordingSileroEnabled: value });
    }
  },
  setMeetingSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("meetingSileroEnabled", String(value));
    useSettingsStore.setState({ meetingSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setSpeechVadConfig?.({ meetingSileroEnabled: value });
    }
  },
  setSpeechVadThreshold: (value: number) => {
    const next = clampVadValue("threshold", value);
    if (isBrowser) localStorage.setItem("speechVadThreshold", String(next));
    useSettingsStore.setState({ speechVadThreshold: next });
    if (isBrowser) {
      window.electronAPI?.setSpeechVadConfig?.({ threshold: next });
    }
  },
  setSpeechVadMinSpeechDurationMs: (value: number) => {
    const next = clampVadValue("minSpeechDurationMs", value);
    if (isBrowser) localStorage.setItem("speechVadMinSpeechDurationMs", String(next));
    useSettingsStore.setState({ speechVadMinSpeechDurationMs: next });
    if (isBrowser) {
      window.electronAPI?.setSpeechVadConfig?.({ minSpeechDurationMs: next });
    }
  },
  setSpeechVadMinSilenceDurationMs: (value: number) => {
    const next = clampVadValue("minSilenceDurationMs", value);
    if (isBrowser) localStorage.setItem("speechVadMinSilenceDurationMs", String(next));
    useSettingsStore.setState({ speechVadMinSilenceDurationMs: next });
    if (isBrowser) {
      window.electronAPI?.setSpeechVadConfig?.({ minSilenceDurationMs: next });
    }
  },
  setSpeechVadMaxSpeechDurationS: (value: number) => {
    const next = clampVadValue("maxSpeechDurationS", value);
    if (isBrowser) localStorage.setItem("speechVadMaxSpeechDurationS", String(next));
    useSettingsStore.setState({ speechVadMaxSpeechDurationS: next });
    if (isBrowser) {
      window.electronAPI?.setSpeechVadConfig?.({ maxSpeechDurationS: next });
    }
  },
  setSpeechVadSpeechPadMs: (value: number) => {
    const next = clampVadValue("speechPadMs", value);
    if (isBrowser) localStorage.setItem("speechVadSpeechPadMs", String(next));
    useSettingsStore.setState({ speechVadSpeechPadMs: next });
    if (isBrowser) {
      window.electronAPI?.setSpeechVadConfig?.({ speechPadMs: next });
    }
  },
  setSpeechVadSamplesOverlap: (value: number) => {
    const next = clampVadValue("samplesOverlap", value);
    if (isBrowser) localStorage.setItem("speechVadSamplesOverlap", String(next));
    useSettingsStore.setState({ speechVadSamplesOverlap: next });
    if (isBrowser) {
      window.electronAPI?.setSpeechVadConfig?.({ samplesOverlap: next });
    }
  },
  setShowTranscriptionPreview: createBooleanSetter("showTranscriptionPreview"),
  setNoteFilesEnabled: createBooleanSetter("noteFilesEnabled"),
  setNoteFilesPath: createStringSetter("noteFilesPath"),

  setIsSignedIn: () => {
    if (isBrowser) localStorage.setItem("isSignedIn", "false");
    set({ isSignedIn: false });
  },

  setChatAgentModel: createStringSetter("chatAgentModel"),
  setChatAgentProvider: createStringSetter("chatAgentProvider"),
  setChatAgentKey: (key: string) => {
    if (!isBrowser) {
      useSettingsStore.setState({ chatAgentKey: key });
      return;
    }

    const updateAgentHotkey = window.electronAPI?.updateAgentHotkey;
    if (!updateAgentHotkey) {
      localStorage.setItem("chatAgentKey", key);
      useSettingsStore.setState({ chatAgentKey: key });
      window.electronAPI?.saveAgentKey?.(key);
      return;
    }

    const previousKey = get().chatAgentKey;

    void updateAgentHotkey(key)
      .then((result) => {
        if (!result?.success) {
          localStorage.setItem("chatAgentKey", previousKey);
          useSettingsStore.setState({ chatAgentKey: previousKey });
          logger.warn(
            "Failed to update chat agent hotkey",
            { hotkey: key, message: result?.message },
            "settings"
          );
          return;
        }

        localStorage.setItem("chatAgentKey", key);
        useSettingsStore.setState({ chatAgentKey: key });
      })
      .catch((error) => {
        logger.warn(
          "Failed to update chat agent hotkey",
          { hotkey: key, error: error instanceof Error ? error.message : String(error) },
          "settings"
        );
      });
  },
  setChatAgentCloudMode: createStringSetter("chatAgentCloudMode"),
  setChatAgentMode: createStringSetter("chatAgentMode") as (mode: InferenceMode) => void,
  setChatAgentCloudBaseUrl: createStringSetter("chatAgentCloudBaseUrl"),
  setChatAgentRemoteUrl: createStringSetter("chatAgentRemoteUrl"),

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.uiLanguage !== undefined) s.setUiLanguage(settings.uiLanguage);
    if (settings.allowOpenAIFallback !== undefined)
      s.setAllowOpenAIFallback(settings.allowOpenAIFallback);
    if (settings.allowLocalFallback !== undefined)
      s.setAllowLocalFallback(settings.allowLocalFallback);
    if (settings.preferredLanguage !== undefined)
      s.setPreferredLanguage(settings.preferredLanguage);
    if (settings.gigaamBaseUrl !== undefined) s.setGigaamBaseUrl(settings.gigaamBaseUrl);
    if (settings.showTranscriptionPreview !== undefined)
      s.setShowTranscriptionPreview(settings.showTranscriptionPreview);
  },

  updateCleanupSettings: (settings: Partial<CleanupSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.useCleanupModel !== undefined) s.setUseCleanupModel(settings.useCleanupModel);
    if (settings.useDictationAgent !== undefined)
      s.setUseDictationAgent(settings.useDictationAgent);
    if (settings.cleanupModel !== undefined) s.setCleanupModel(settings.cleanupModel);
    if (settings.cleanupProvider !== undefined) s.setCleanupProvider(settings.cleanupProvider);
    if (settings.cleanupCloudBaseUrl !== undefined)
      s.setCleanupCloudBaseUrl(settings.cleanupCloudBaseUrl);
    if (settings.cleanupCloudMode !== undefined) s.setCleanupCloudMode(settings.cleanupCloudMode);
  },

  updateChatAgentSettings: (settings: Partial<ChatAgentSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.chatAgentModel !== undefined) s.setChatAgentModel(settings.chatAgentModel);
    if (settings.chatAgentProvider !== undefined)
      s.setChatAgentProvider(settings.chatAgentProvider);
    if (settings.chatAgentKey !== undefined) s.setChatAgentKey(settings.chatAgentKey);
    if (settings.chatAgentCloudMode !== undefined)
      s.setChatAgentCloudMode(settings.chatAgentCloudMode);
  },
}));

// --- Selectors (derived state, not stored) ---

export const selectEffectiveCleanupProvider = (state: SettingsState) => state.cleanupProvider;

export const selectIsCloudChatAgentMode = (_state: SettingsState) => false;

export const selectIsCloudNoteFormattingMode = (_state: SettingsState) => false;

export interface ResolvedMeetingTranscription {
  gigaamBaseUrl: string;
  remoteTranscriptionUrl: string;
}

export const selectResolvedMeetingTranscription = (
  state: SettingsState
): ResolvedMeetingTranscription => {
  return {
    gigaamBaseUrl: state.meetingGigaamBaseUrl || state.gigaamBaseUrl || "",
    remoteTranscriptionUrl: state.meetingRemoteTranscriptionUrl || state.remoteTranscriptionUrl,
  };
};

export interface ResolvedNoteFormatting {
  provider: string;
  model: string;
  mode: InferenceMode;
  cloudMode: string;
  cloudBaseUrl: string;
  remoteUrl: string;
}

export const selectResolvedNoteFormatting = (state: SettingsState): ResolvedNoteFormatting => {
  const cfg = selectResolvedLLMConfig(state, "noteFormatting");
  return {
    provider: cfg.provider,
    model: cfg.model,
    mode: cfg.mode,
    cloudMode: cfg.cloudMode || "",
    cloudBaseUrl: cfg.cloudBaseUrl || "",
    remoteUrl: cfg.remoteUrl || "",
  };
};

export interface ResolvedLLMConfig {
  scope: InferenceScope;
  mode: InferenceMode;
  provider: string;
  model: string;
  cloudMode?: string;
  cloudBaseUrl?: string;
  remoteUrl?: string;
  disableThinking: boolean;
}

export const selectResolvedLLMConfig = (
  state: SettingsState,
  scope: InferenceScope
): ResolvedLLMConfig => {
  const def: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
  const fallback = def.fallbackScope
    ? selectResolvedLLMConfig(state, def.fallbackScope as InferenceScope)
    : undefined;

  const read = (field: keyof InferenceScopeStoreKeys): string | undefined => {
    const key = def.storeKeys[field];
    if (!key) return undefined;
    return (state[key] as string | undefined) || undefined;
  };

  const disableThinkingKey = def.storeKeys.disableThinking;
  const disableThinking = disableThinkingKey ? (state[disableThinkingKey] as boolean) : true;

  return {
    scope,
    mode: normalizeAuthBackedSetting(
      def.storeKeys.mode as string,
      state[def.storeKeys.mode] as string
    ) as InferenceMode,
    provider: read("provider") || fallback?.provider || "",
    model: read("model") || fallback?.model || "",
    cloudMode:
      (def.storeKeys.cloudMode
        ? normalizeAuthBackedSetting(def.storeKeys.cloudMode as string, read("cloudMode") || "")
        : undefined) || fallback?.cloudMode,
    cloudBaseUrl: read("cloudBaseUrl") || fallback?.cloudBaseUrl,
    remoteUrl: read("remoteUrl") || fallback?.remoteUrl,
    disableThinking,
  };
};

export function setResolvedLLMConfig(
  scope: InferenceScope,
  patch: Partial<Omit<ResolvedLLMConfig, "scope">>
): void {
  const def: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
  const updates: Partial<SettingsState> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const storeKey = def.storeKeys[field as keyof InferenceScopeStoreKeys];
    if (!storeKey) continue;
    const storedValue =
      typeof value === "string" ? normalizeAuthBackedSetting(storeKey as string, value) : value;
    if (isBrowser) {
      localStorage.setItem(
        storeKey as string,
        typeof storedValue === "boolean" ? String(storedValue) : (storedValue as string)
      );
    }
    (updates as Record<string, unknown>)[storeKey as string] = storedValue;
  }
  if (Object.keys(updates).length > 0) useSettingsStore.setState(updates);
}

export function isCloudChatAgentMode() {
  return selectIsCloudChatAgentMode(useSettingsStore.getState());
}

// --- Convenience getters for non-React code ---

export function getSettings() {
  return useSettingsStore.getState();
}

// --- Initialization ---

let hasInitialized = false;

export async function initializeSettings(): Promise<void> {
  if (hasInitialized) return;
  hasInitialized = true;

  if (!isBrowser) return;

  clearLegacySecretLocalStorage();

  const state = useSettingsStore.getState();

  if (window.electronAPI) {
    // Sync dictation key from main process.
    // localStorage holds the user's preferred hotkey. Only populate from .env
    // when localStorage is empty (fresh install / cleared data).
    try {
      if (!state.dictationKey) {
        const envKey = await window.electronAPI.getDictationKey?.();
        if (envKey) {
          createStringSetter("dictationKey")(envKey);
        }
      }
    } catch (err) {
      logger.warn(
        "Failed to sync dictation key on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Show the active hotkey in UI (zustand only, not localStorage).
    // May return constructor default during early startup; corrected by dictation-key-active event later.
    try {
      const activeKey = await window.electronAPI?.getActiveDictationKey?.();
      if (activeKey) {
        useSettingsStore.setState({ dictationKey: activeKey });
      }
    } catch (err) {
      logger.warn(
        "Failed to sync active dictation key on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync chat agent hotkey from main process
    try {
      const envKey = await window.electronAPI.getAgentKey?.();
      if (envKey && envKey !== state.chatAgentKey) {
        createStringSetter("chatAgentKey")(envKey);
      }
    } catch (err) {
      logger.warn(
        "Failed to sync chat agent hotkey on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      let activationMode = state.activationMode;
      if (localStorage.getItem("activationMode") === null) {
        activationMode = normalizeActivationMode(
          await window.electronAPI.getActivationMode?.()
        );
        localStorage.setItem("activationMode", activationMode);
      }

      enforceFixedBehaviorSettings();
      useSettingsStore.setState({
        activationMode,
        audioCuesEnabled: FIXED_AUDIO_CUES_ENABLED,
        pauseMediaOnDictation: FIXED_PAUSE_MEDIA_ON_DICTATION,
        notificationsEnabled: FIXED_NOTIFICATIONS_ENABLED,
        notifyMeetingDetection: FIXED_NOTIFICATIONS_ENABLED,
        notifyCalendarReminders: FIXED_NOTIFICATIONS_ENABLED,
        notifyUpdates: FIXED_NOTIFICATIONS_ENABLED,
      });
      await window.electronAPI.saveActivationMode?.(activationMode);
      window.electronAPI.notifyActivationModeChanged?.(activationMode);
    } catch (err) {
      logger.warn(
        "Failed to sync runtime settings on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // UI and transcription languages are fixed to Russian in Type.
    try {
      enforceFixedUiSettings();
      if (state.uiLanguage !== FIXED_UI_LANGUAGE) {
        useSettingsStore.setState({ uiLanguage: FIXED_UI_LANGUAGE });
      }
      if (state.preferredLanguage !== FIXED_TRANSCRIPTION_LANGUAGE) {
        useSettingsStore.setState({ preferredLanguage: FIXED_TRANSCRIPTION_LANGUAGE });
      }
      await i18n.changeLanguage(FIXED_UI_LANGUAGE);
      await window.electronAPI.setUiLanguage?.(FIXED_UI_LANGUAGE);
    } catch (err) {
      logger.warn(
        "Failed to sync UI language on startup",
        { error: (err as Error).message },
        "settings"
      );
      void i18n.changeLanguage(FIXED_UI_LANGUAGE);
    }

    await syncTypeAsrSettings();

    // Sync meeting detection preferences to main process
    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.meetingDetectionSetPreferences?.({
        processDetection: currentState.meetingProcessDetection,
        audioDetection: currentState.meetingAudioDetection,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync meeting detection preferences on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      await window.electronAPI.syncNotificationPreferences?.({
        notificationsEnabled: FIXED_NOTIFICATIONS_ENABLED,
        notifyMeetingDetection: FIXED_NOTIFICATIONS_ENABLED,
        notifyCalendarReminders: FIXED_NOTIFICATIONS_ENABLED,
        notifyUpdates: FIXED_NOTIFICATIONS_ENABLED,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync notification preferences on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.gcalSetPrimaryOnly?.(currentState.gcalPrimaryOnly);
    } catch (err) {
      logger.warn(
        "Failed to sync gcal primary-only on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.setSpeakerDiarizationEnabled?.(
        currentState.speakerDiarizationEnabled
      );
    } catch (err) {
      logger.warn(
        "Failed to sync speaker diarization preference on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.setSpeechVadConfig?.({
        dictationSileroEnabled: currentState.dictationSileroEnabled,
        noteRecordingSileroEnabled: currentState.noteRecordingSileroEnabled,
        meetingSileroEnabled: currentState.meetingSileroEnabled,
        threshold: currentState.speechVadThreshold,
        minSpeechDurationMs: currentState.speechVadMinSpeechDurationMs,
        minSilenceDurationMs: currentState.speechVadMinSilenceDurationMs,
        maxSpeechDurationS: currentState.speechVadMaxSpeechDurationS,
        speechPadMs: currentState.speechVadSpeechPadMs,
        samplesOverlap: currentState.speechVadSamplesOverlap,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync speech VAD config on startup",
        { error: (err as Error).message },
        "settings"
      );
    }
  }

  // Sync Zustand store when another window writes to localStorage
  window.addEventListener("storage", (event) => {
    if (!event.key || event.storageArea !== localStorage || event.newValue === null) return;

    const { key, newValue } = event;

    if (key === "uiLanguage" || key === "preferredLanguage" || key === "theme") {
      enforceFixedUiSettings();
      useSettingsStore.setState({
        uiLanguage: FIXED_UI_LANGUAGE,
        preferredLanguage: FIXED_TRANSCRIPTION_LANGUAGE,
        theme: FIXED_THEME,
      });
      void i18n.changeLanguage(FIXED_UI_LANGUAGE);
      return;
    }

    if (key.startsWith("customPrompt.")) {
      const kind = key.slice("customPrompt.".length) as PromptKind;
      if (!PROMPT_KIND_LIST.includes(kind)) return;
      useSettingsStore.setState((s) => ({
        customPrompts: { ...s.customPrompts, [kind]: newValue },
      }));
      return;
    }

    const state = useSettingsStore.getState();
    if (!(key in state) || typeof (state as unknown as Record<string, unknown>)[key] === "function")
      return;

    let value: unknown;
    if (BOOLEAN_SETTINGS.has(key)) {
      value = newValue === "true";
    } else if (ARRAY_SETTINGS.has(key)) {
      try {
        const parsed = JSON.parse(newValue);
        value = Array.isArray(parsed) ? parsed : [];
      } catch {
        value = [];
      }
    } else if (NUMERIC_SETTINGS.has(key)) {
      const parsed = Number(newValue);
      if (Number.isNaN(parsed)) {
        value = (state as unknown as Record<string, unknown>)[key];
      } else {
        value = parsed;
      }
    } else {
      value = newValue;
    }

    useSettingsStore.setState({ [key]: value });

    if (key === "gcalAccounts" && Array.isArray(value)) {
      const accounts = value as GoogleCalendarAccount[];
      useSettingsStore.setState({
        gcalConnected: accounts.length > 0,
        gcalEmail: accounts[0]?.email ?? "",
      });
    }

    if (key === "uiLanguage" && typeof value === "string") {
      void i18n.changeLanguage(FIXED_UI_LANGUAGE);
    }
  });

  // Active hotkey updates from backend — zustand only, not localStorage.
  window.electronAPI?.onDictationKeyActive?.((key: string) => {
    useSettingsStore.setState({ dictationKey: key });
  });

  // Sync settings pushed from main process (e.g., hotkey changed in control panel)
  window.electronAPI?.onSettingUpdated?.((data: { key: string; value: unknown }) => {
    const state = useSettingsStore.getState();
    if (
      data.key in state &&
      typeof (state as unknown as Record<string, unknown>)[data.key] !== "function"
    ) {
      if (data.key === "uiLanguage" || data.key === "preferredLanguage" || data.key === "theme") {
        enforceFixedUiSettings();
        useSettingsStore.setState({
          uiLanguage: FIXED_UI_LANGUAGE,
          preferredLanguage: FIXED_TRANSCRIPTION_LANGUAGE,
          theme: FIXED_THEME,
        });
        void i18n.changeLanguage(FIXED_UI_LANGUAGE);
        return;
      }
      localStorage.setItem(
        data.key,
        typeof data.value === "string" ? data.value : JSON.stringify(data.value)
      );
      useSettingsStore.setState({ [data.key]: data.value });
    }
  });

  window.electronAPI?.onGigaamSidecarStatus?.((status: GigaamSidecarStatus) => {
    void syncTypeAsrSettings(status);
  });
}
