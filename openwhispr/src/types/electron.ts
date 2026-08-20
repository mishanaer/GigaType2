export type InferenceMode = "providers" | "local" | "self-hosted";

export type SelfHostedType = "openai-compatible" | "lan";

export type GigaamHealthStatus =
  | "unavailable"
  | "stopped"
  | "starting"
  | "loading"
  | "ok"
  | "error"
  | "unknown";

export interface GigaamSidecarStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  apiBaseUrl: string | null;
  healthStatus: GigaamHealthStatus;
  healthDetail?: string | null;
  modelName?: string;
  modelStage?: "stopped" | "checking" | "downloading" | "loading" | "ready" | "error";
  modelProgress?: number;
  modelDownloadedBytes?: number;
  modelTotalBytes?: number;
  modelCacheComplete?: boolean;
}

export type TranscriptionStatus = "completed" | "failed" | "pending";

export type TranscriptionErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER_ERROR"
  | "OFFLINE"
  | "AUTH_EXPIRED"
  | "AUTH_REQUIRED"
  | "LIMIT_REACHED"
  | "INVALID_KEY"
  | "MODEL_NOT_AVAILABLE"
  | null;

export interface TranscriptionItem {
  id: number;
  text: string;
  raw_text: string | null;
  timestamp: string;
  created_at: string;
  has_audio: number;
  audio_duration_ms: number | null;
  provider: string | null;
  model: string | null;
  status: TranscriptionStatus;
  error_message: string | null;
  error_code: TranscriptionErrorCode;
  client_transcription_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export interface NoteItem {
  id: number;
  title: string;
  content: string;
  enhanced_content: string | null;
  enhancement_prompt: string | null;
  enhanced_at_content_hash: string | null;
  note_type: "personal" | "meeting" | "upload";
  source_file: string | null;
  audio_duration_seconds: number | null;
  folder_id: number | null;
  transcript: string | null;
  calendar_event_id: string | null;
  participants: string | null;
  diarization_enabled: number | null;
  expected_speaker_count: number | null;
  cloud_id: string | null;
  created_at: string;
  updated_at: string;
  client_note_id: string;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
  workspace_id?: string | null;
  team_id?: string | null;
}

export type ShareVisibility = "private" | "link" | "domain" | "invited";

export interface ShareSettings {
  visibility: ShareVisibility;
  token_prefix: string | null;
  domain_allowlist: string[];
  updated_by_user_id: string | null;
  updated_at: string | null;
}

export interface NoteShareInvitation {
  id: string;
  email: string;
  invited_by_user_id: string;
  accepted_at: string | null;
  revoked_at: string | null;
  last_emailed_at: string | null;
  created_at: string;
}

export interface FolderItem {
  id: number;
  name: string;
  is_default: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  client_folder_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
  workspace_id?: string | null;
  team_id?: string | null;
}

export type WorkspaceRole = "owner" | "admin" | "member";
export type TeamRole = "admin" | "member";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  created_by_user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: string;
  status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  seats: number;
  created_at: string;
  updated_at: string;
  role: WorkspaceRole;
}

export interface WorkspaceMember {
  user_id: string;
  role: WorkspaceRole;
  joined_at: string;
  email: string;
  name: string | null;
  image: string | null;
}

export interface Team {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  member_count?: number;
}

export interface TeamMember {
  user_id: string;
  role: TeamRole;
  joined_at: string;
  email: string;
  name: string | null;
  image: string | null;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  workspace_role: TeamRole;
  team_ids: string[];
  invited_by_user_id: string;
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export interface InvitationPreview {
  id: string;
  email: string;
  workspace_role: TeamRole;
  team_ids: string[];
  expires_at: string;
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  inviter_name: string | null;
  inviter_email: string | null;
}

export interface ActionItem {
  id: number;
  name: string;
  description: string;
  prompt: string;
  icon: string;
  is_builtin: number;
  sort_order: number;
  translation_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface FFmpegAvailabilityResult {
  available: boolean;
  path?: string;
  error?: string;
}

export interface AudioDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  ffmpeg: { available: boolean; path: string | null; error: string | null };
  modelsDir: string;
  models: string[];
}

export type SystemAudioMode = "native" | "loopback" | "portal" | "unsupported";
export type SystemAudioStrategy =
  | "native"
  | "loopback"
  | "browser-portal"
  | "portal-helper"
  | "unsupported";

export interface SystemAudioAccessResult {
  granted: boolean;
  status: "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "unsupported";
  mode: SystemAudioMode;
  supportsPersistentGrant?: boolean;
  supportsPersistentPortalGrant?: boolean;
  supportsNativeCapture?: boolean;
  supportsOnboardingGrant?: boolean;
  requiresRuntimeSharePrompt?: boolean;
  strategy?: SystemAudioStrategy;
  restoreTokenAvailable?: boolean;
  portalVersion?: number | null;
  error?: string;
}

export interface AppVersionResult {
  version: string;
}

export interface PasteToolsResult {
  platform: "darwin" | "win32" | "linux";
  available: boolean;
  method: string | null;
  requiresPermission: boolean;
  isWayland?: boolean;
  xwaylandAvailable?: boolean;
  terminalAware?: boolean;
  hasNativeBinary?: boolean;
  hasUinput?: boolean;
  tools?: string[];
  recommendedInstall?: string;
}

export type GpuBackend = "vulkan" | "cpu" | "metal" | null;

export interface LlamaServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  modelPath: string | null;
  modelName: string | null;
  backend: GpuBackend;
  gpuAccelerated: boolean;
}

export interface VulkanGpuResult {
  available: boolean;
  deviceName?: string;
  reason?: string;
  error?: string;
}

export interface LlamaVulkanStatus {
  supported: boolean;
  downloaded: boolean;
  downloading?: boolean;
  error?: string;
}

export interface ConversationPreview {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
  cloud_id?: string | null;
  client_conversation_id?: string;
  sync_status?: "synced" | "pending" | "error";
  deleted_at?: string | null;
  message_count: number;
  last_message?: string | null;
  last_message_role?: "user" | "assistant" | "system" | null;
}

declare global {
  interface Window {
    electronAPI: {
      // Basic window operations
      pasteText: (
        text: string,
        options?: {
          fromStreaming?: boolean;
          restoreClipboard?: boolean;
          allowClipboardFallback?: boolean;
        }
      ) => Promise<void>;
      hideWindow: () => Promise<void>;
      hideDictationPanel?: () => Promise<void>;
      showDictationPanel: () => Promise<void>;
      resizeMainWindow?: (
        sizeKey: "BASE" | "WITH_MENU" | "WITH_TOAST" | "EXPANDED"
      ) => Promise<{ success: boolean; message?: string }>;
      resizeControlPanelToContent?: (
        height: number,
        width?: number
      ) => Promise<{
        success: boolean;
        message?: string;
        bounds?: { x: number; y: number; width: number; height: number };
      }>;
      onToggleDictation: (callback: () => void) => () => void;
      onStartDictation?: (callback: () => void) => () => void;
      onStopDictation?: (callback: () => void) => () => void;
      onSystemResumed?: (callback: () => void) => () => void;

      // Database operations
      saveTranscription: (
        text: string,
        rawText?: string | null,
        options?: {
          status?: TranscriptionStatus;
          errorMessage?: string | null;
          errorCode?: TranscriptionErrorCode;
          clientTranscriptionId?: string;
        }
      ) => Promise<{ id: number; success: boolean; transcription?: TranscriptionItem }>;
      getTranscriptions: (limit?: number) => Promise<TranscriptionItem[]>;
      clearTranscriptions: () => Promise<{ cleared: number; success: boolean }>;
      deleteTranscription: (id: number) => Promise<{ success: boolean }>;
      getTranscriptionById: (id: number) => Promise<TranscriptionItem | null>;

      // Audio retention operations
      saveTranscriptionAudio: (
        id: number,
        audioBuffer: ArrayBuffer,
        metadata?: { durationMs?: number; provider?: string; model?: string }
      ) => Promise<{ success: boolean; path?: string }>;
      getAudioPath: (id: number) => Promise<string | null>;
      showAudioInFolder: (id: number) => Promise<{ success: boolean }>;
      getAudioBuffer: (id: number) => Promise<ArrayBuffer | null>;
      deleteTranscriptionAudio: (id: number) => Promise<{ success: boolean }>;
      getAudioStorageUsage: () => Promise<{ fileCount: number; totalBytes: number }>;
      deleteAllAudio: () => Promise<{ deleted: number }>;
      retryTranscription: (
        id: number,
        settings?: {
          gigaamBaseUrl?: string;
          preferredLanguage?: string;
          remoteTranscriptionUrl?: string;
        }
      ) => Promise<{
        success: boolean;
        transcription?: TranscriptionItem;
        error?: string;
        code?: TranscriptionErrorCode;
      }>;
      updateTranscriptionText: (
        id: number,
        text: string,
        rawText: string
      ) => Promise<{ success: boolean; transcription?: TranscriptionItem; error?: string }>;

      // Note operations
      saveNote: (
        title: string,
        content: string,
        noteType?: string,
        sourceFile?: string | null,
        audioDuration?: number | null,
        folderId?: number | null
      ) => Promise<{ success: boolean; note?: NoteItem }>;
      getNote: (id: number) => Promise<NoteItem | null>;
      getNotes: (
        noteType?: string | null,
        limit?: number,
        folderId?: number | null
      ) => Promise<NoteItem[]>;
      updateNote: (
        id: number,
        updates: {
          title?: string;
          content?: string;
          enhanced_content?: string | null;
          enhancement_prompt?: string | null;
          enhanced_at_content_hash?: string | null;
          folder_id?: number | null;
          transcript?: string | null;
          calendar_event_id?: string | null;
          participants?: string | null;
          diarization_enabled?: number | null;
          expected_speaker_count?: number | null;
        }
      ) => Promise<{ success: boolean; note?: NoteItem }>;
      deleteNote: (id: number) => Promise<{ success: boolean }>;
      exportNote: (
        noteId: number,
        format: "txt" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      exportTranscript: (
        noteId: number,
        format: "txt" | "srt" | "json" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      searchNotes: (query: string, limit?: number) => Promise<NoteItem[]>;
      semanticSearchNotes: (query: string, limit?: number) => Promise<NoteItem[]>;
      semanticReindexAll: () => Promise<{ success: boolean; indexed?: number; error?: string }>;
      onSemanticReindexProgress: (
        callback: (data: { done: number; total: number }) => void
      ) => () => void;
      updateNoteCloudId: (id: number, cloudId: string) => Promise<NoteItem>;

      // Folder operations
      getFolders: () => Promise<FolderItem[]>;
      createFolder: (
        name: string
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      deleteFolder: (id: number) => Promise<{ success: boolean; error?: string }>;
      renameFolder: (
        id: number,
        name: string
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      getFolderNoteCounts: () => Promise<Array<{ folder_id: number; count: number }>>;

      // Note files (markdown mirror)
      noteFilesSetEnabled?: (
        enabled: boolean,
        customPath?: string,
        options?: { skipRebuild?: boolean }
      ) => Promise<{ success: boolean; error?: string }>;
      noteFilesSetPath?: (path: string) => Promise<{ success: boolean; error?: string }>;
      noteFilesRebuild?: () => Promise<{ success: boolean; error?: string }>;
      noteFilesGetDefaultPath?: () => Promise<string>;
      noteFilesPickFolder?: () => Promise<{ canceled: boolean; path?: string }>;
      showNoteFile?: (noteId: number) => Promise<{ success: boolean }>;
      showFolderInExplorer?: (folderName: string) => Promise<{ success: boolean }>;

      // Action operations
      getActions: () => Promise<ActionItem[]>;
      getAction: (id: number) => Promise<ActionItem | null>;
      createAction: (
        name: string,
        description: string,
        prompt: string,
        icon?: string
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      updateAction: (
        id: number,
        updates: {
          name?: string;
          description?: string;
          prompt?: string;
          icon?: string;
          sort_order?: number;
        }
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      deleteAction: (id: number) => Promise<{ success: boolean; id?: number; error?: string }>;
      onActionCreated?: (callback: (action: ActionItem) => void) => () => void;
      onActionUpdated?: (callback: (action: ActionItem) => void) => () => void;
      onActionDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Audio file operations
      selectAudioFile: () => Promise<{ canceled: boolean; filePath?: string }>;
      getFileSize?: (filePath: string) => Promise<number>;
      transcribeAudioFile: (
        filePath: string,
        options?: {
          provider?: "gigaam";
          model?: string;
          language?: string;
          baseUrl?: string;
          remoteTranscriptionUrl?: string;
          gigaamBaseUrl?: string;
          [key: string]: unknown;
        }
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      transcribeLocalGigaam: (request: {
        audio: Uint8Array;
        model?: string;
        language?: string;
        fileName?: string;
        contentType?: string;
      }) => Promise<{ success: boolean; text?: string; error?: string; model?: string }>;
      getPathForFile: (file: File) => string;

      // Note event listeners
      onNoteAdded?: (callback: (note: NoteItem) => void) => () => void;
      onNoteUpdated?: (callback: (note: NoteItem) => void) => () => void;
      onNoteDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Database event listeners
      onTranscriptionAdded?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionUpdated?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onTranscriptionsCleared?: (callback: (payload: { cleared: number }) => void) => () => void;

      getUiLanguage: () => Promise<string>;
      saveUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      setUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      saveRuntimeConfigToEnv: () => Promise<{ success: boolean; path: string }>;
      syncStartupPreferences: (prefs?: Record<string, never>) => Promise<void>;

      // Clipboard operations
      checkAccessibilityPermission: (silent?: boolean) => Promise<boolean>;
      promptAccessibilityPermission: () => Promise<boolean>;
      readClipboard: () => Promise<string>;
      writeClipboard: (text: string) => Promise<{ success: boolean }>;
      copyDebugLogs?: () => Promise<{
        success: boolean;
        bytes?: number;
        files?: string[];
        transcriptionCount?: number;
        error?: string;
      }>;
      checkPasteTools: () => Promise<PasteToolsResult>;

      // Audio
      onNoAudioDetected: (callback: (event: any, data?: any) => void) => () => void;

      // Local AI model management
      modelGetAll: () => Promise<any[]>;
      modelCheck: (modelId: string) => Promise<boolean>;
      modelCheckRuntime: () => Promise<{
        available: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;

      // Local reasoning
      processLocalReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      checkLocalReasoningAvailable: () => Promise<boolean>;

      // llama.cpp management
      llamaCppCheck: () => Promise<{ isInstalled: boolean; version?: string }>;
      llamaCppUninstall: () => Promise<{ success: boolean; error?: string }>;

      // llama-server
      llamaServerStart: (
        modelId: string
      ) => Promise<{ success: boolean; port?: number; error?: string }>;
      llamaServerStop: () => Promise<{ success: boolean; error?: string }>;
      llamaServerStatus: () => Promise<LlamaServerStatus>;
      llamaGpuReset: () => Promise<{ success: boolean; error?: string }>;
      detectVulkanGpu?: () => Promise<VulkanGpuResult>;
      getLlamaVulkanStatus?: () => Promise<LlamaVulkanStatus>;
      deleteLlamaVulkanBinary?: () => Promise<{
        success: boolean;
        deletedCount?: number;
        error?: string;
      }>;
      // Window control operations
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
      windowIsMaximized: () => Promise<boolean>;
      getPlatform: () => string;
      startWindowDrag: () => Promise<void>;
      stopWindowDrag: () => Promise<void>;
      setMainWindowInteractivity: (interactive: boolean) => Promise<void>;
      setNotificationInteractivity: (interactive: boolean) => Promise<void>;

      // App management
      appQuit: () => Promise<void>;
      cleanupApp: () => Promise<{ success: boolean; message: string; errors?: string[] }>;

      getAppVersion: () => Promise<AppVersionResult>;
      getPostMigrationState: () => Promise<{ justMigrated: boolean }>;
      markBundleMigrated: () => Promise<void>;
      markBundleMigrationDismissed: () => Promise<void>;

      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;

      // Hotkey management
      updateHotkey: (key: string) => Promise<{ success: boolean; message: string }>;
      setHotkeyListeningMode?: (
        enabled: boolean,
        newHotkey?: string | null
      ) => Promise<{
        success: boolean;
        nativeReady?: boolean;
        skipped?: boolean;
        error?: string;
      }>;
      getHotkeyModeInfo?: () => Promise<{
        isUsingGnome: boolean;
        isUsingHyprland: boolean;
        isUsingNativeShortcut: boolean;
        supportsPushToTalk: boolean;
      }>;

      // Wayland paste diagnostics
      getYdotoolStatus?: () => Promise<{
        isLinux: boolean;
        isWayland: boolean;
        hasYdotool: boolean;
        hasYdotoold: boolean;
        daemonRunning: boolean;
        hasService: boolean;
        hasUinput: boolean;
        hasUdevRule: boolean;
        hasGroup: boolean;
        isNixOS: boolean;
        allGood: boolean;
      }>;

      // Globe key listener for hotkey capture (macOS only)
      onGlobeKeyPressed?: (callback: () => void) => () => void;
      onGlobeKeyReleased?: (callback: () => void) => () => void;
      onWindowsHotkeyCaptured?: (callback: (hotkey: string) => void) => () => void;
      onWindowsHotkeyCaptureCancelled?: (callback: () => void) => () => void;

      // Hotkey registration events
      onHotkeyFallbackUsed?: (
        callback: (data: { original: string; fallback: string }) => void
      ) => () => void;
      onHotkeyRegistrationFailed?: (
        callback: (data: { hotkey: string; error: string; suggestions: string[] }) => void
      ) => () => void;
      onSettingUpdated?: (callback: (data: { key: string; value: unknown }) => void) => () => void;
      onDictationKeyActive?: (callback: (key: string) => void) => () => void;
      onLinuxPttPermissionDenied?: (callback: () => void) => () => void;

      // Settings shortcut (Cmd+, / Ctrl+,)
      onShowSettings?: (callback: () => void) => () => void;

      // Accessibility permission events (macOS)
      onAccessibilityMissing?: (callback: () => void) => () => void;
      checkAccessibilityTrusted?: () => Promise<boolean>;

      // Dictation key persistence (file-based for reliable startup)
      getDictationKey?: () => Promise<string | null>;
      getActiveDictationKey?: () => Promise<string>;
      getEffectiveDefaultHotkey?: () => Promise<string>;
      isFnHotkeyAvailable?: () => Promise<boolean>;
      saveDictationKey?: (key: string) => Promise<void>;

      // Activation mode persistence (file-based for reliable startup)
      getActivationMode?: () => Promise<"tap" | "push">;
      saveActivationMode?: (mode: "tap" | "push") => Promise<void>;
      getShowDockIcon?: () => Promise<boolean>;
      setShowDockIcon?: (enabled: boolean) => Promise<{ success: boolean; visible: boolean }>;

      // Debug logging
      getLogLevel?: () => Promise<string>;
      log?: (entry: {
        level: string;
        message: string;
        meta?: any;
        scope?: string;
        source?: string;
      }) => Promise<void>;
      getDebugState: () => Promise<{
        enabled: boolean;
        logPath: string | null;
        logLevel: string;
      }>;
      setDebugLogging: (enabled: boolean) => Promise<{
        success: boolean;
        enabled?: boolean;
        logPath?: string | null;
        error?: string;
      }>;
      openLogsFolder: () => Promise<{ success: boolean; error?: string }>;
      getGigaamSidecarStatus?: () => Promise<GigaamSidecarStatus>;
      restartGigaamSidecar?: () => Promise<GigaamSidecarStatus>;
      onGigaamSidecarStatus?: (callback: (status: GigaamSidecarStatus) => void) => () => void;

      // FFmpeg availability
      checkFFmpegAvailability: () => Promise<FFmpegAvailabilityResult>;
      getAudioDiagnostics: () => Promise<AudioDiagnosticsResult>;

      // System settings helpers
      requestMicrophoneAccess?: () => Promise<{ granted: boolean; status?: string }>;
      checkMicrophoneAccess?: () => Promise<{ granted: boolean; status: string }>;
      checkSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      requestSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      openMicrophoneSettings?: () => Promise<{ success: boolean; error?: string }>;
      openSoundInputSettings?: () => Promise<{ success: boolean; error?: string }>;
      openAccessibilitySettings?: () => Promise<{ success: boolean; error?: string }>;
      openSystemAudioSettings?: () => Promise<{ success: boolean; error?: string }>;
      toggleMediaPlayback?: () => Promise<boolean>;
      pauseMediaPlayback?: () => Promise<boolean>;
      resumeMediaPlayback?: () => Promise<boolean>;
      // Windows Push-to-Talk notifications
      notifyActivationModeChanged?: (mode: "tap" | "push") => void;
      notifyHotkeyChanged?: (hotkey: string) => void;
      notifyStartMinimizedChanged?: (enabled: boolean) => void;

      // Auto-start at login
      getAutoStartEnabled?: () => Promise<boolean>;
      setAutoStartEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

      onUploadTranscriptionProgress?: (
        callback: (data: { stage: string; chunksTotal: number; chunksCompleted: number }) => void
      ) => () => void;

      // Agent Mode
      updateAgentHotkey?: (hotkey: string) => Promise<{ success: boolean; message: string }>;
      getAgentKey?: () => Promise<string>;
      saveAgentKey?: (key: string) => Promise<void>;
      createAgentConversation?: (
        title: string,
        noteId?: number
      ) => Promise<{
        id: number;
        title: string;
        note_id?: number | null;
        created_at: string;
        updated_at: string;
      }>;
      getConversationsForNote?: (
        noteId: number,
        limit?: number
      ) => Promise<
        Array<{
          id: number;
          title: string;
          created_at: string;
          updated_at: string;
          message_count: number;
        }>
      >;
      getAgentConversations?: (limit?: number) => Promise<
        Array<{
          id: number;
          title: string;
          archived_at?: string;
          cloud_id?: string;
          client_conversation_id?: string;
          created_at: string;
          updated_at: string;
        }>
      >;
      getAgentConversation?: (id: number) => Promise<{
        id: number;
        title: string;
        archived_at?: string;
        cloud_id?: string;
        created_at: string;
        updated_at: string;
        messages: Array<{
          id: number;
          conversation_id: number;
          role: "user" | "assistant" | "system";
          content: string;
          metadata?: string;
          created_at: string;
        }>;
      } | null>;
      deleteAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      updateAgentConversationTitle?: (id: number, title: string) => Promise<{ success: boolean }>;
      addAgentMessage?: (
        conversationId: number,
        role: "user" | "assistant" | "system",
        content: string,
        metadata?: Record<string, unknown>
      ) => Promise<{
        id: number;
        conversation_id: number;
        role: string;
        content: string;
        metadata?: string;
        created_at: string;
      }>;
      getAgentMessages?: (conversationId: number) => Promise<
        Array<{
          id: number;
          conversation_id: number;
          role: "user" | "assistant" | "system";
          content: string;
          metadata?: string;
          created_at: string;
        }>
      >;
      getAgentConversationsWithPreview?: (
        limit?: number,
        offset?: number,
        includeArchived?: boolean
      ) => Promise<ConversationPreview[]>;
      searchAgentConversations?: (query: string, limit?: number) => Promise<ConversationPreview[]>;
      archiveAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      unarchiveAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      updateAgentConversationCloudId?: (
        id: number,
        cloudId: string
      ) => Promise<{ success: boolean }>;
      semanticSearchConversations?: (
        query: string,
        limit?: number
      ) => Promise<ConversationPreview[]>;

      // Contacts
      searchContacts: (query: string) => Promise<{
        success: boolean;
        contacts: Array<{ email: string; display_name: string | null }>;
      }>;
      upsertContact: (contact: {
        email: string;
        displayName?: string | null;
      }) => Promise<{ success: boolean }>;

      // Meeting transcription (streaming, dual-channel)
      meetingTranscriptionPrepare?: (options: {
        provider?: string;
        model?: string;
        language?: string;
      }) => Promise<{ success: boolean; alreadyPrepared?: boolean; error?: string }>;
      meetingTranscriptionStart?: (options: {
        provider?: string;
        model?: string;
        language?: string;
        noteId?: number | null;
      }) => Promise<{
        success: boolean;
        error?: string;
        systemAudioMode?: SystemAudioMode;
        systemAudioStrategy?: SystemAudioStrategy;
        oneOnOneAttendee?: { displayName: string; email: string | null } | null;
      }>;
      meetingTranscriptionSend?: (buffer: ArrayBuffer, source: "mic" | "system") => void;
      meetingTranscriptionStop?: () => Promise<{
        success: boolean;
        transcript?: string;
        diarizationSessionId?: string;
        error?: string;
      }>;
      meetingTranscriptionCancel?: () => Promise<{
        success: boolean;
        reason?: "recording-active";
      }>;
      onMeetingTranscriptionSegment?: (
        callback: (data: {
          text: string;
          source: "mic" | "system";
          type: "partial" | "final" | "retract";
          timestamp?: number;
        }) => void
      ) => () => void;
      onMeetingSpeakerIdentified?: (
        callback: (data: {
          speakerId: string;
          displayName?: string | null;
          startTime: number;
          endTime: number;
        }) => void
      ) => () => void;
      onMeetingSpeakersMerged?: (
        callback: (
          merges: Array<{
            keep: string;
            remove: string;
            displayName?: string | null;
            similarity: number;
          }>
        ) => void
      ) => () => void;
      onMeetingTranscriptionError?: (callback: (error: string) => void) => () => void;

      // Speaker diarization
      getDiarizationModelStatus?: () => Promise<{
        available: boolean;
        modelsDownloaded: boolean;
      }>;
      deleteDiarizationModels?: () => Promise<{ success: boolean }>;
      onMeetingDiarizationComplete?: (
        callback: (data: {
          sessionId?: string;
          segments: Array<{
            id: string;
            text: string;
            source: "mic" | "system";
            timestamp?: number;
            speaker?: string;
            speakerName?: string;
            speakerIsPlaceholder?: boolean;
            suggestedName?: string;
            suggestedProfileId?: number;
            speakerStatus?: "provisional" | "confirmed" | "suggested" | "locked";
            speakerLocked?: boolean;
            speakerLockSource?: "user" | "diarization" | "suggestion";
          }>;
          speakerEmbeddings?: Record<string, number[]> | null;
        }) => void
      ) => () => void;

      // Speaker name mapping
      getSpeakerMappings?: (noteId: number) => Promise<
        Array<{
          note_id: number;
          speaker_id: string;
          profile_id: number | null;
          display_name: string;
        }>
      >;
      setSpeakerMapping?: (
        noteId: number,
        speakerId: string,
        displayName: string,
        email?: string | null,
        profileId?: number | null
      ) => Promise<{ success: boolean; profileId: number | null }>;
      removeSpeakerMapping?: (noteId: number, speakerId: string) => Promise<{ success: boolean }>;
      getSpeakerProfiles?: () => Promise<
        Array<{
          id: number;
          display_name: string;
          email: string | null;
          sample_count: number;
          created_at: string;
          updated_at: string;
        }>
      >;
      attachSpeakerEmail?: (
        profileId: number,
        email: string | null
      ) => Promise<{
        success: boolean;
        error?: string;
        profile?: {
          id: number;
          display_name: string;
          email: string | null;
          sample_count: number;
        };
      }>;
      saveNoteSpeakerEmbeddings?: (
        noteId: number,
        embeddings: Record<string, number[]>
      ) => Promise<{ success: boolean }>;

      // Google Calendar event listeners

      meetingDetectionGetPreferences?: () => Promise<{ success: boolean; preferences?: any }>;
      meetingDetectionSetPreferences?: (
        prefs: Record<string, boolean>
      ) => Promise<{ success: boolean }>;
      syncNotificationPreferences?: (
        prefs: Record<string, boolean>
      ) => Promise<{ success: boolean }>;
      setSpeakerDiarizationEnabled?: (
        enabled: boolean
      ) => Promise<{ success: boolean; error?: string }>;
      setMeetingSessionSpeakerConfig?: (config: {
        enabled: boolean;
        expectedCount: number;
      }) => Promise<{ success: boolean; error?: string }>;
      getSpeechVadConfig?: () => Promise<{
        success: boolean;
        config?: {
          dictationSileroEnabled: boolean;
          noteRecordingSileroEnabled: boolean;
          meetingSileroEnabled: boolean;
          threshold: number;
          minSpeechDurationMs: number;
          minSilenceDurationMs: number;
          maxSpeechDurationS: number;
          speechPadMs: number;
          samplesOverlap: number;
        };
        error?: string;
      }>;
      setSpeechVadConfig?: (config: {
        dictationSileroEnabled?: boolean;
        noteRecordingSileroEnabled?: boolean;
        meetingSileroEnabled?: boolean;
        threshold?: number;
        minSpeechDurationMs?: number;
        minSilenceDurationMs?: number;
        maxSpeechDurationS?: number;
        speechPadMs?: number;
        samplesOverlap?: number;
      }) => Promise<{ success: boolean; config?: Record<string, unknown>; error?: string }>;
      onMeetingDetected?: (callback: (data: any) => void) => () => void;
      onMeetingDetectedStartRecording?: (callback: (data: any) => void) => () => void;
      onMeetingNotificationData?: (callback: (data: any) => void) => () => void;
      getMeetingNotificationData?: () => Promise<any>;
      meetingNotificationReady?: () => Promise<void>;
      meetingNotificationRespond?: (
        detectionId: string,
        action: string
      ) => Promise<{ success: boolean }>;
      onPreviewText?: (callback: (text: string) => void) => () => void;
      onPreviewAppend?: (callback: (text: string) => void) => () => void;
      onPreviewHold?: (callback: (payload: { showCleanup: boolean }) => void) => () => void;
      onPreviewResult?: (callback: (payload: { text: string }) => void) => () => void;
      onPreviewHide?: (callback: () => void) => () => void;
      stopDictationPreview?: (opts?: { showCleanup?: boolean }) => Promise<{ success: boolean }>;
      dismissDictationPreview?: () => Promise<{ success: boolean }>;
      completeDictationPreview?: (payload: { text?: string }) => Promise<{ success: boolean }>;
      hideDictationPreview?: () => Promise<{ success: boolean }>;
      resizeTranscriptionPreviewWindow?: (
        width: number,
        height: number
      ) => Promise<{
        success: boolean;
        bounds?: { x: number; y: number; width: number; height: number };
      }>;

      // Sync operations
      getPendingNotes?: () => Promise<NoteItem[]>;
      getPendingNoteDeletes?: () => Promise<NoteItem[]>;
      getNoteByClientId?: (clientNoteId: string) => Promise<NoteItem | null>;
      upsertNoteFromCloud?: (
        cloudNote: Record<string, unknown>,
        localFolderId: number | null
      ) => Promise<NoteItem>;
      markNoteSynced?: (id: number, cloudId: string) => Promise<void>;
      markNoteSyncError?: (id: number) => Promise<void>;
      hardDeleteNote?: (id: number) => Promise<void>;

      getPendingFolders?: () => Promise<FolderItem[]>;
      getFolderByClientId?: (clientFolderId: string) => Promise<FolderItem | null>;
      upsertFolderFromCloud?: (cloudFolder: Record<string, unknown>) => Promise<FolderItem>;
      markFolderSynced?: (id: number, cloudId: string) => Promise<void>;
      getFolderIdMap?: () => Promise<FolderItem[]>;
      getPendingFolderDeletes?: () => Promise<FolderItem[]>;
      hardDeleteFolder?: (id: number) => Promise<{ success: boolean; id: number }>;

      getPendingConversations?: () => Promise<ConversationPreview[]>;
      getPendingConversationDeletes?: () => Promise<ConversationPreview[]>;
      getConversationByClientId?: (clientId: string) => Promise<ConversationPreview | null>;
      upsertConversationFromCloud?: (
        cloudConv: Record<string, unknown>,
        messages: Array<Record<string, unknown>>
      ) => Promise<void>;
      markConversationSynced?: (id: number, cloudId: string) => Promise<void>;
      hardDeleteConversation?: (id: number) => Promise<void>;

      getPendingTranscriptions?: () => Promise<TranscriptionItem[]>;
      getTranscriptionByClientId?: (clientId: string) => Promise<TranscriptionItem | null>;
      upsertTranscriptionFromCloud?: (
        cloudTranscription: Record<string, unknown>
      ) => Promise<TranscriptionItem>;
      markTranscriptionSynced?: (id: number, cloudId: string) => Promise<void>;
      getPendingTranscriptionDeletes?: () => Promise<TranscriptionItem[]>;
      hardDeleteTranscription?: (id: number) => Promise<{ success: boolean; id: number }>;
    };

    api?: {
      sendDebugLog: (message: string) => void;
    };
  }
}
