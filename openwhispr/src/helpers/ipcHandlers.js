const { ipcMain, app, shell, BrowserWindow, systemPreferences, net } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { classifyAndLog } = require("./networkErrors");
const GnomeShortcutManager = require("./gnomeShortcut");
const HyprlandShortcutManager = require("./hyprlandShortcut");
const { i18nMain, changeLanguage } = require("./i18nMain");
const AudioStorageManager = require("./audioStorage");
const liveSpeakerIdentifier = require("./liveSpeakerIdentifier");
const MeetingEchoLeakDetector = require("./meetingEchoLeakDetector");
const {
  transcriptsOverlap,
  transcriptsLooselyOverlap,
  buildMergedCandidates,
} = require("./transcriptText");
const {
  applyConfirmedSpeaker,
  applySuggestedSpeaker,
  canAutoRelabelSpeaker,
  isSpeakerLocked,
} = require("./speakerAssignmentPolicy");
const { downsample24kTo16k, pcm16ToWav } = require("../utils/audioUtils");
const postMigrationDetector = require("./postMigrationDetector");
const { repairLegacyAccessibilityIfNeeded } = require("./macosAccessibilityRepair");
const {
  DEFAULT_EXPECTED_SPEAKER_COUNT,
  MAX_SPEAKER_COUNT,
} = require("../constants/speakerDetection.json");
const { DEFAULT_SPEECH_VAD_CONFIG, sanitizeSpeechVadConfig } = require("./speechVadConfig");
const {
  isBuiltInGigaamEndpoint,
  resolveGigaamTranscriptionUrl,
} = require("../utils/gigaamTranscription.cjs");
const DevServerManager = require("./devServerManager");
const { isAllowedIpcSenderUrl, isSafeExternalUrl } = require("./securityPolicy");

const ALLOWED_MEETING_PROVIDERS = new Set(["gigaam"]);
const GIGAAM_TRANSCRIPTION_MODEL = "gigaam-v3-e2e-rnnt";
const MAX_LOG_COPY_BYTES_PER_FILE = 100 * 1024;
const DEBUG_TRANSCRIPTION_LIMIT = 10;
const DEBUG_TRANSCRIPTION_PREVIEW_CHARS = 300;
const MACOS_PASTE_SNAPSHOT_AX_TIMEOUT_MS = 120;
const MACOS_PASTE_SNAPSHOT_QUERY_TIMEOUT_MS = 80;

async function readLogFileTail(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
      return { path: filePath, error: "not a file" };
    }

    const start = Math.max(0, stats.size - MAX_LOG_COPY_BYTES_PER_FILE);
    const length = stats.size - start;
    const file = await fs.promises.open(filePath, "r");

    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, start);
      return {
        path: filePath,
        size: stats.size,
        truncated: start > 0,
        content: buffer.subarray(0, bytesRead).toString("utf8"),
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    return { path: filePath, error: error.message };
  }
}

async function findLatestDebugLog(logsDir) {
  try {
    const entries = await fs.promises.readdir(logsDir, { withFileTypes: true });
    const debugLogs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^debug-.*\.log$/.test(entry.name))
        .map(async (entry) => {
          const filePath = path.join(logsDir, entry.name);
          const stats = await fs.promises.stat(filePath);
          return { filePath, mtimeMs: stats.mtimeMs };
        })
    );

    return debugLogs.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath ?? null;
  } catch {
    return null;
  }
}

function formatLogClipboardSection(section) {
  const header = [`===== ${section.path} =====`];

  if (section.error) {
    return [...header, `Unable to read log file: ${section.error}`].join("\n");
  }

  if (section.truncated) {
    header.push(`Showing last ${MAX_LOG_COPY_BYTES_PER_FILE} bytes of ${section.size} bytes.`);
  }

  return [...header, section.content || "(empty log file)"].join("\n");
}

function previewDebugText(value) {
  if (!value) return "";
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= DEBUG_TRANSCRIPTION_PREVIEW_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, DEBUG_TRANSCRIPTION_PREVIEW_CHARS)}...`;
}

function formatDebugTranscription(transcription) {
  const lines = [
    `#${transcription.id} ${transcription.timestamp || transcription.created_at || "(no timestamp)"}`,
    `status=${transcription.status || "unknown"} provider=${transcription.provider || "unknown"} model=${transcription.model || "unknown"}`,
    `client_transcription_id=${transcription.client_transcription_id || "unknown"}`,
  ];

  if (transcription.error_code || transcription.error_message) {
    lines.push(
      `error=${transcription.error_code || "unknown"} ${transcription.error_message || ""}`.trim()
    );
  }

  if (transcription.audio_duration_ms != null) {
    lines.push(`audio_duration_ms=${transcription.audio_duration_ms}`);
  }

  const textPreview = previewDebugText(transcription.text);
  if (textPreview) {
    lines.push(`text_preview=${JSON.stringify(textPreview)}`);
  }

  const rawTextPreview = previewDebugText(transcription.raw_text);
  if (rawTextPreview && rawTextPreview !== textPreview) {
    lines.push(`raw_text_preview=${JSON.stringify(rawTextPreview)}`);
  }

  return lines.join("\n");
}

function formatDebugTranscriptionsSection(transcriptions) {
  const header = [`===== Last ${DEBUG_TRANSCRIPTION_LIMIT} dictations =====`];

  if (!transcriptions.length) {
    return [...header, "(no dictations found)"].join("\n");
  }

  return [...header, transcriptions.map(formatDebugTranscription).join("\n\n")].join("\n");
}

function parseAttendees(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const AUDIO_MIME_TYPES = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
};

function buildMultipartBody(fileBuffer, fileName, contentType, fields = {}) {
  const boundary = `----Type${Date.now()}`;
  const parts = [];

  parts.push(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  parts.push(fileBuffer);
  parts.push("\r\n");

  for (const [name, value] of Object.entries(fields)) {
    if (value != null) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`
      );
    }
  }

  parts.push(`--${boundary}--\r\n`);

  const bodyParts = parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p));
  return { body: Buffer.concat(bodyParts), boundary };
}

async function postMultipart(url, body, boundary, headers = {}) {
  const response = await net.fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      ...headers,
    },
    body,
    useSessionCookies: false,
  });
  const text = await response.text();
  try {
    return { statusCode: response.status, data: JSON.parse(text) };
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
  }
}

async function transcribeBufferWithGigaam(
  audioBuffer,
  {
    baseUrl,
    model = GIGAAM_TRANSCRIPTION_MODEL,
    fileName = "audio.wav",
    contentType = "audio/wav",
    language,
  } = {},
  localAsrManager = null
) {
  if (isBuiltInGigaamEndpoint(baseUrl)) {
    if (!localAsrManager) {
      throw new Error("Built-in GigaAM engine is unavailable");
    }
    const result = await localAsrManager.transcribeAudioBuffer(audioBuffer);
    return {
      success: true,
      text: typeof result?.text === "string" ? result.text : "",
      source: "gigaam",
      model,
    };
  }
  const transcriptionUrl = resolveGigaamTranscriptionUrl(baseUrl);
  const fields = { model };
  if (language) fields.language = language;
  const { body, boundary } = buildMultipartBody(audioBuffer, fileName, contentType, fields);
  const data = await postMultipart(new URL(transcriptionUrl), body, boundary);

  if (data.statusCode === 401) {
    throw new Error("GigaAM rejected the request.");
  }
  if (data.statusCode === 429) {
    throw new Error("Rate limit exceeded. Please try again later.");
  }
  if (data.statusCode !== 200) {
    throw new Error(
      data.data?.error?.message || data.data?.error || `API error: ${data.statusCode}`
    );
  }

  return {
    success: true,
    text: typeof data.data?.text === "string" ? data.data.text : "",
    source: "gigaam",
    model,
  };
}

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.diarizationManager = managers.diarizationManager;
    this.windowManager = managers.windowManager;
    this.windowsKeyManager = managers.windowsKeyManager;
    this.linuxKeyManager = managers.linuxKeyManager;
    this.textEditMonitor = managers.textEditMonitor;
    this.getTrayManager = managers.getTrayManager;
    this.meetingDetectionEngine = managers.meetingDetectionEngine;
    this.audioTapManager = managers.audioTapManager;
    this.linuxPortalAudioManager = managers.linuxPortalAudioManager;
    this.gigaamLocalAsrManager = managers.gigaamLocalAsrManager;
    this.sessionId = crypto.randomUUID();
    this._hotkeyCaptureMode = false;
    this._hotkeyCaptureRefocusWindow = null;
    this._hotkeyCaptureWindow = null;
    this._activeRecordingPipeline = null;
    this.audioStorageManager = new AudioStorageManager();
    this._audioCleanupInterval = null;
    this._noteFilesEnabled = false;
    this.speakerDiarizationEnabled = true;
    this.activeMeetingSpeakerConfig = null;
    this.speechVadSettings = {
      dictationSileroEnabled: true,
      noteRecordingSileroEnabled: true,
      meetingSileroEnabled: true,
      ...DEFAULT_SPEECH_VAD_CONFIG,
    };
    liveSpeakerIdentifier.setDiarizationManager(this.diarizationManager);
    if (this.windowsKeyManager) {
      this.windowsKeyManager.on("capture", (hotkey) => {
        const captureWindow = this._hotkeyCaptureWindow;
        if (
          this._hotkeyCaptureMode &&
          captureWindow &&
          !captureWindow.isDestroyed() &&
          !captureWindow.webContents.isDestroyed()
        ) {
          captureWindow.webContents.send("windows-hotkey-captured", hotkey);
        }
      });
      this.windowsKeyManager.on("capture-cancel", () => {
        const captureWindow = this._hotkeyCaptureWindow;
        if (
          this._hotkeyCaptureMode &&
          captureWindow &&
          !captureWindow.isDestroyed() &&
          !captureWindow.webContents.isDestroyed()
        ) {
          captureWindow.webContents.send("windows-hotkey-capture-cancelled");
        }
      });
    }
    this._setupAudioCleanup();
    this.setupHandlers();
  }

  _getSpeechVadSettings() {
    const current = this.speechVadSettings || {};
    return {
      dictationSileroEnabled: current.dictationSileroEnabled !== false,
      noteRecordingSileroEnabled: current.noteRecordingSileroEnabled !== false,
      meetingSileroEnabled: current.meetingSileroEnabled !== false,
      ...sanitizeSpeechVadConfig(current),
    };
  }

  _setSpeechVadSettings(update = {}) {
    this.speechVadSettings = { ...this._getSpeechVadSettings(), ...update };
    return this._getSpeechVadSettings();
  }

  _asyncVectorUpsert(note) {
    setImmediate(() => {
      const vectorIndex = require("./vectorIndex");
      if (!vectorIndex.isReady()) return;
      const { LocalEmbeddings } = require("./localEmbeddings");
      const text = LocalEmbeddings.noteEmbedText(note.title, note.content, note.enhanced_content);
      vectorIndex.upsertNote(note.id, text).catch(() => {});
    });
  }

  _asyncVectorDelete(noteId) {
    setImmediate(() => {
      const vectorIndex = require("./vectorIndex");
      if (!vectorIndex.isReady()) return;
      vectorIndex.deleteNote(noteId).catch(() => {});
    });
  }

  _asyncMirrorWrite(note) {
    if (!this._noteFilesEnabled) {
      debugLogger.debug(
        "Mirror write skipped: note files disabled",
        { noteId: note.id },
        "note-files"
      );
      return;
    }
    setImmediate(() => {
      const markdownMirror = require("./markdownMirror");
      const folderName = this._getFolderName(note.folder_id);
      markdownMirror.writeNote(note, folderName);
      if (note.transcript) {
        markdownMirror.writeTranscript(note, folderName, this._buildSpeakerMappings(note.id));
      }
    });
  }

  _asyncMirrorDelete(noteId) {
    if (!this._noteFilesEnabled) {
      debugLogger.debug("Mirror delete skipped: note files disabled", { noteId }, "note-files");
      return;
    }
    setImmediate(() => {
      const markdownMirror = require("./markdownMirror");
      markdownMirror.deleteNote(noteId);
    });
  }

  _buildFolderMap() {
    const folders = this.databaseManager.getFolders();
    const map = {};
    for (const f of folders) {
      map[f.id] = f.name;
    }
    return map;
  }

  _buildSpeakerMappings(noteId) {
    const arr = this.databaseManager.getSpeakerMappings(noteId);
    const map = {};
    for (const m of arr) {
      map[m.speaker_id] = m.display_name;
    }
    return map;
  }

  _parseNonSelfParticipants(participantsJson) {
    if (!participantsJson) return [];
    let participants;
    try {
      participants = JSON.parse(participantsJson);
    } catch (_) {
      return [];
    }
    if (!Array.isArray(participants) || participants.length === 0) return [];
    const googleEmails = new Set(
      this.databaseManager.getGoogleAccounts().map((a) => a.email.toLowerCase())
    );
    return participants.filter(
      (p) => p && p.self !== true && !googleEmails.has((p.email || "").toLowerCase())
    );
  }

  _getNoteNonSelfParticipants(noteId) {
    if (!noteId) return [];
    try {
      const note = this.databaseManager.getNote(noteId);
      return this._parseNonSelfParticipants(note?.participants);
    } catch (_) {
      return [];
    }
  }

  _resolveOneOnOneOtherParticipant(participantsJson) {
    const others = this._parseNonSelfParticipants(participantsJson);
    if (others.length !== 1) return null;
    const displayName = others[0].displayName || others[0].email;
    if (!displayName) return null;
    const email = (others[0].email || "").toLowerCase().trim() || null;
    return { displayName, email };
  }

  _rebuildMirror(basePath) {
    const markdownMirror = require("./markdownMirror");
    if (basePath) markdownMirror.init(basePath);
    const notes = this.databaseManager.getNotes(null, 99999);
    const speakerMappingsMap = {};
    for (const note of notes) {
      if (note.transcript) {
        speakerMappingsMap[note.id] = this._buildSpeakerMappings(note.id);
      }
    }
    markdownMirror.rebuildAll(notes, this._buildFolderMap(), speakerMappingsMap);
  }

  _getFolderName(folderId) {
    if (!folderId) return "Personal";
    const folder = this.databaseManager.db
      .prepare("SELECT name FROM folders WHERE id = ?")
      .get(folderId);
    return folder?.name || "Personal";
  }

  _cleanupTextEditMonitor() {
    // Kept for main-process teardown compatibility. Text edit monitoring no longer
    // registers IPC-owned listeners after removing auto-learn.
  }

  _setupAudioCleanup() {
    const DEFAULT_RETENTION_DAYS = 30;
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

    // Run initial cleanup with default retention
    try {
      this.audioStorageManager.cleanupExpiredAudio(DEFAULT_RETENTION_DAYS, this.databaseManager);
    } catch (error) {
      debugLogger.error("Initial audio cleanup failed", { error: error.message }, "audio-storage");
    }

    // Set up periodic cleanup every 6 hours
    this._audioCleanupInterval = setInterval(() => {
      try {
        this.audioStorageManager.cleanupExpiredAudio(DEFAULT_RETENTION_DAYS, this.databaseManager);
      } catch (error) {
        debugLogger.error(
          "Periodic audio cleanup failed",
          { error: error.message },
          "audio-storage"
        );
      }
    }, SIX_HOURS_MS);
  }

  _syncStartupEnv(setVars, clearVars = []) {
    let changed = false;
    for (const [key, value] of Object.entries(setVars)) {
      if (process.env[key] !== value) {
        process.env[key] = value;
        changed = true;
      }
    }
    for (const key of clearVars) {
      if (process.env[key]) {
        delete process.env[key];
        changed = true;
      }
    }
    if (changed) {
      debugLogger.debug("Synced startup env vars", {
        set: Object.keys(setVars),
        cleared: clearVars.filter((k) => !process.env[k]),
      });
      this.environmentManager.saveRuntimeConfigToEnvFile().catch(() => {});
    }
  }

  _createSecuredIpcHandle() {
    const devServerPort = DevServerManager.DEV_SERVER_PORT;

    return (channel, listener) => {
      ipcMain.handle(channel, async (event, ...args) => {
        const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
        if (
          !isAllowedIpcSenderUrl(senderUrl, {
            appPath: app.getAppPath(),
            devServerPort,
          })
        ) {
          debugLogger.warn(
            "Blocked IPC call from untrusted sender",
            { channel, senderUrl },
            "security"
          );
          throw new Error("Blocked IPC call from untrusted sender");
        }

        return listener(event, ...args);
      });
    };
  }

  setupHandlers() {
    const handle = this._createSecuredIpcHandle();

    handle("window-minimize", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.minimize();
      }
    });

    handle("window-maximize", () => {
      if (this.windowManager.controlPanelWindow) {
        if (this.windowManager.controlPanelWindow.isMaximized()) {
          this.windowManager.controlPanelWindow.unmaximize();
        } else {
          this.windowManager.controlPanelWindow.maximize();
        }
      }
    });

    handle("window-close", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.close();
      }
    });

    handle("window-is-maximized", () => {
      if (this.windowManager.controlPanelWindow) {
        return this.windowManager.controlPanelWindow.isMaximized();
      }
      return false;
    });

    handle("app-quit", () => {
      app.quit();
    });

    handle("hide-window", () => {
      if (process.platform === "darwin") {
        this.windowManager.hideDictationPanel();
      } else {
        this.windowManager.hideDictationPanel();
      }
    });

    handle("show-dictation-panel", () => {
      this.windowManager.showDictationPanel();
    });

    handle("hide-dictation-panel", () => {
      this.windowManager.hideDictationPanel();
    });

    handle("force-stop-dictation", () => {
      if (this.windowManager?.forceStopMacCompoundPush) {
        this.windowManager.forceStopMacCompoundPush("manual");
      }
      return { success: true };
    });

    handle("set-main-window-interactivity", (event, shouldCapture) => {
      this.windowManager.setMainWindowInteractivity(Boolean(shouldCapture));
      return { success: true };
    });

    handle("set-notification-interactivity", (event, interactive) => {
      this.windowManager.setNotificationInteractivity(Boolean(interactive));
      return { success: true };
    });

    handle("resize-main-window", (event, sizeKey) => {
      return this.windowManager.resizeMainWindow(sizeKey);
    });

    handle("resize-control-panel-to-content", (event, height, width) => {
      return this.windowManager.resizeControlPanelToContent(height, width);
    });

    handle("db-save-transcription", async (event, text, rawText, options) => {
      const result = this.databaseManager.saveTranscription(text, rawText, options);
      if (result?.success && result?.transcription) {
        setImmediate(() => {
          this.broadcastToWindows("transcription-added", result.transcription);
        });
      }
      return result;
    });

    handle("db-get-transcriptions", async (event, limit = 50) => {
      return this.databaseManager.getTranscriptions(limit);
    });

    handle("db-clear-transcriptions", async (event) => {
      this.audioStorageManager.deleteAllAudio();
      const result = this.databaseManager.clearTranscriptions();
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("transcriptions-cleared", {
            cleared: result.cleared,
          });
        });
      }
      return result;
    });

    handle("db-delete-transcription", async (event, id) => {
      return this.deleteTranscriptionInternal(id);
    });

    // Audio storage handlers
    handle("save-transcription-audio", async (event, id, audioBuffer, metadata) => {
      const transcription = this.databaseManager.getTranscriptionById(id);
      const timestamp = transcription?.timestamp || null;
      const result = this.audioStorageManager.saveAudio(id, Buffer.from(audioBuffer), timestamp);
      if (result.success) {
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: metadata?.durationMs || null,
          provider: metadata?.provider || null,
          model: metadata?.model || null,
        });
        const updated = this.databaseManager.getTranscriptionById(id);
        if (updated) this.broadcastToWindows("transcription-updated", updated);
      }
      return result;
    });

    handle("get-audio-path", async (event, id) => {
      return this.audioStorageManager.getAudioPath(id);
    });

    handle("show-audio-in-folder", async (event, id) => {
      const filePath = this.audioStorageManager.getAudioPath(id);
      if (!filePath) return { success: false };
      shell.showItemInFolder(filePath);
      return { success: true };
    });

    handle("get-audio-buffer", async (event, id) => {
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      return buffer ? buffer.buffer : null;
    });

    handle("delete-transcription-audio", async (event, id) => {
      const result = this.audioStorageManager.deleteAudio(id);
      if (result.success) {
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 0,
          audioDurationMs: null,
          provider: null,
          model: null,
        });
      }
      return result;
    });

    handle("get-audio-storage-usage", async () => {
      return this.audioStorageManager.getStorageUsage();
    });

    handle("delete-all-audio", async () => {
      const result = this.audioStorageManager.deleteAllAudio();
      try {
        const rows = this.databaseManager.db
          .prepare("SELECT id FROM transcriptions WHERE has_audio = 1")
          .all();
        if (rows.length > 0) {
          this.databaseManager.clearAudioFlags(rows.map((r) => r.id));
        }
      } catch (error) {
        debugLogger.error(
          "Failed to clear audio flags after delete-all",
          { error: error.message },
          "audio-storage"
        );
      }
      return result;
    });

    handle("get-transcription-by-id", async (event, id) => {
      return this.databaseManager.getTranscriptionById(id);
    });

    handle(
      "db-save-note",
      async (event, title, content, noteType, sourceFile, audioDuration, folderId) => {
        const result = this.databaseManager.saveNote(
          title,
          content,
          noteType,
          sourceFile,
          audioDuration,
          folderId
        );
        if (result?.success && result?.note) {
          setImmediate(() => this.broadcastToWindows("note-added", result.note));
          this._asyncVectorUpsert(result.note);
          this._asyncMirrorWrite(result.note);
        }
        return result;
      }
    );

    handle("db-get-note", async (event, id) => {
      return this.databaseManager.getNote(id);
    });

    handle("db-get-notes", async (event, noteType, limit, folderId) => {
      return this.databaseManager.getNotes(noteType, limit, folderId);
    });

    handle("db-update-note", async (event, id, updates) => {
      const result = this.databaseManager.updateNote(id, updates);
      if (result?.success && result?.note) {
        setImmediate(() => this.broadcastToWindows("note-updated", result.note));
        this._asyncVectorUpsert(result.note);
        this._asyncMirrorWrite(result.note);
        if (updates.participants) this._tryAutoLabelOneOnOne(id);
      }
      return result;
    });

    handle("db-delete-note", async (event, id) => {
      return this.deleteNoteInternal(id);
    });

    handle("db-search-notes", async (event, query, limit) => {
      return this.databaseManager.searchNotes(query, limit);
    });

    handle("db-semantic-search-notes", async (event, query, limit = 5) => {
      const vectorIndex = require("./vectorIndex");
      if (!vectorIndex.isReady()) {
        return this.databaseManager.searchNotes(query, limit);
      }

      try {
        const [ftsResults, vectorResults] = await Promise.all([
          this.databaseManager.searchNotes(query, limit * 2),
          vectorIndex.search(query, limit * 2),
        ]);

        // Filter low-confidence semantic matches before RRF
        const filteredVectorResults = vectorResults.filter(({ score }) => score > 0.3);

        // Reciprocal Rank Fusion (K=60, matching cloud implementation)
        const scores = new Map();
        ftsResults.forEach((note, i) => {
          scores.set(note.id, (scores.get(note.id) || 0) + 1 / (60 + i));
        });
        filteredVectorResults.forEach(({ noteId }, i) => {
          scores.set(noteId, (scores.get(noteId) || 0) + 1 / (60 + i));
        });

        const rankedIds = [...scores.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([id]) => id);

        const noteMap = new Map();
        ftsResults.forEach((n) => noteMap.set(n.id, n));
        for (const id of rankedIds) {
          if (!noteMap.has(id)) {
            const note = this.databaseManager.getNote(id);
            if (note) noteMap.set(id, note);
          }
        }

        return rankedIds.map((id) => noteMap.get(id)).filter(Boolean);
      } catch (error) {
        debugLogger.error("Semantic search failed, falling back to FTS5", { error: error.message });
        return this.databaseManager.searchNotes(query, limit);
      }
    });

    handle("db-semantic-reindex-all", async () => {
      const vectorIndex = require("./vectorIndex");
      if (!vectorIndex.isReady()) return { success: false, error: "Vector index not ready" };

      const notes = this.databaseManager.getNotes(null, 100000);
      let done = 0;
      await vectorIndex.reindexAll(notes, (completed, total) => {
        done = completed;
        this.broadcastToWindows("semantic-reindex-progress", { done: completed, total });
      });
      return { success: true, indexed: done };
    });

    handle("db-update-note-cloud-id", async (event, id, cloudId) => {
      return this.databaseManager.updateNoteCloudId(id, cloudId);
    });

    handle("db-get-folders", async () => {
      return this.databaseManager.getFolders();
    });

    handle("db-create-folder", async (event, name) => {
      const result = this.databaseManager.createFolder(name);
      if (result?.success && result?.folder) {
        setImmediate(() => {
          this.broadcastToWindows("folder-created", result.folder);
          if (this._noteFilesEnabled) {
            const markdownMirror = require("./markdownMirror");
            markdownMirror.ensureFolder(result.folder.name);
          }
        });
      }
      return result;
    });

    handle("db-delete-folder", async (event, id) => {
      const folderName = this._noteFilesEnabled ? this._getFolderName(id) : null;
      const result = this.databaseManager.deleteFolder(id);
      if (result?.success) {
        for (const noteId of result.noteIds ?? []) {
          this._asyncVectorDelete(noteId);
        }
        setImmediate(() => {
          this.broadcastToWindows("folder-deleted", { id });
          if (this._noteFilesEnabled && folderName) {
            const markdownMirror = require("./markdownMirror");
            markdownMirror.deleteFolder(folderName);
          }
        });
      }
      return result;
    });

    handle("db-rename-folder", async (event, id, name) => {
      const oldName = this._noteFilesEnabled ? this._getFolderName(id) : null;
      const result = this.databaseManager.renameFolder(id, name);
      if (result?.success && result?.folder) {
        setImmediate(() => {
          this.broadcastToWindows("folder-renamed", result.folder);
          if (this._noteFilesEnabled && oldName) {
            const markdownMirror = require("./markdownMirror");
            markdownMirror.renameFolder(oldName, name);
          }
        });
      }
      return result;
    });

    handle("db-get-folder-note-counts", async () => {
      return this.databaseManager.getFolderNoteCounts();
    });

    handle("db-get-actions", async () => {
      return this.databaseManager.getActions();
    });

    handle("db-get-action", async (event, id) => {
      return this.databaseManager.getAction(id);
    });

    handle("db-create-action", async (event, name, description, prompt, icon) => {
      const result = this.databaseManager.createAction(name, description, prompt, icon);
      if (result?.success && result?.action) {
        setImmediate(() => {
          this.broadcastToWindows("action-created", result.action);
        });
      }
      return result;
    });

    handle("db-update-action", async (event, id, updates) => {
      const result = this.databaseManager.updateAction(id, updates);
      if (result?.success && result?.action) {
        setImmediate(() => {
          this.broadcastToWindows("action-updated", result.action);
        });
      }
      return result;
    });

    handle("db-delete-action", async (event, id) => {
      const result = this.databaseManager.deleteAction(id);
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("action-deleted", { id });
        });
      }
      return result;
    });

    // Agent conversation handlers
    handle("db-create-agent-conversation", async (event, title, noteId) => {
      return this.databaseManager.createAgentConversation(title, noteId);
    });

    handle("db-get-conversations-for-note", async (event, noteId, limit) => {
      return this.databaseManager.getConversationsForNote(noteId, limit);
    });

    handle("db-get-agent-conversations", async (event, limit) => {
      return this.databaseManager.getAgentConversations(limit);
    });

    handle("db-get-agent-conversation", async (event, id) => {
      return this.databaseManager.getAgentConversation(id);
    });

    handle("db-delete-agent-conversation", async (event, id) => {
      const result = this.databaseManager.deleteAgentConversation(id);
      if (this.vectorIndex?.isReady?.()) {
        this.vectorIndex.deleteConversationChunks(id).catch(() => {});
      }
      return result;
    });

    handle("db-update-agent-conversation-title", async (event, id, title) => {
      return this.databaseManager.updateAgentConversationTitle(id, title);
    });

    handle("db-add-agent-message", async (event, conversationId, role, content, metadata) => {
      const result = this.databaseManager.addAgentMessage(conversationId, role, content, metadata);
      if (this.vectorIndex?.isReady?.()) {
        const conv = this.databaseManager.getAgentConversation(conversationId);
        if (conv && conv.messages?.length % 3 === 0) {
          this.vectorIndex
            .upsertConversationChunks(conversationId, conv.title, conv.messages)
            .catch(() => {});
        }
      }
      return result;
    });

    handle("db-get-agent-messages", async (event, conversationId) => {
      return this.databaseManager.getAgentMessages(conversationId);
    });

    handle(
      "db-get-agent-conversations-with-preview",
      async (event, limit, offset, includeArchived) => {
        return this.databaseManager.getAgentConversationsWithPreview(
          limit,
          offset,
          includeArchived
        );
      }
    );

    handle("db-search-agent-conversations", async (event, query, limit) => {
      return this.databaseManager.searchAgentConversations(query, limit);
    });

    handle("db-archive-agent-conversation", async (event, id) => {
      return this.databaseManager.archiveAgentConversation(id);
    });

    handle("db-unarchive-agent-conversation", async (event, id) => {
      return this.databaseManager.unarchiveAgentConversation(id);
    });

    handle("db-update-agent-conversation-cloud-id", async (event, id, cloudId) => {
      return this.databaseManager.updateAgentConversationCloudId(id, cloudId);
    });

    handle("db-semantic-search-conversations", async (event, query, limit) => {
      if (this.vectorIndex?.isReady?.()) {
        try {
          const vectorResults = await this.vectorIndex.searchConversations(query, limit);
          if (vectorResults?.length > 0) {
            const ids = vectorResults.map((r) => r.conversationId);
            const previews = ids
              .map((id) => this.databaseManager.getAgentConversation(id))
              .filter(Boolean)
              .map((c) => ({
                ...c,
                message_count: c.messages?.length ?? 0,
                last_message: c.messages?.[c.messages.length - 1]?.content,
              }));
            if (previews.length > 0) return previews;
          }
        } catch {
          // fall through to keyword search
        }
      }
      return this.databaseManager.searchAgentConversations(query, limit);
    });

    // Notes sync
    handle("db-get-pending-notes", () => this.databaseManager.getPendingNotes());
    handle("db-get-pending-note-deletes", () => this.databaseManager.getPendingNoteDeletes());
    handle("db-get-note-by-client-id", (_, clientNoteId) =>
      this.databaseManager.getNoteByClientId(clientNoteId)
    );
    handle("db-upsert-note-from-cloud", (_, cloudNote, localFolderId) =>
      this.databaseManager.upsertNoteFromCloud(cloudNote, localFolderId)
    );
    handle("db-mark-note-synced", (_, id, cloudId) =>
      this.databaseManager.markNoteSynced(id, cloudId)
    );
    handle("db-mark-note-sync-error", (_, id) => this.databaseManager.markNoteSyncError(id));
    handle("db-hard-delete-note", (_, id) => {
      const result = this.databaseManager.hardDeleteNote(id);
      if (result?.success) {
        this._asyncVectorDelete(id);
        this._asyncMirrorDelete(id);
        setImmediate(() => this.broadcastToWindows("note-deleted", { id }));
      }
      return result;
    });

    // Folders sync
    handle("db-get-pending-folders", () => this.databaseManager.getPendingFolders());
    handle("db-get-folder-by-client-id", (_, clientFolderId) =>
      this.databaseManager.getFolderByClientId(clientFolderId)
    );
    handle("db-upsert-folder-from-cloud", (_, cloudFolder) =>
      this.databaseManager.upsertFolderFromCloud(cloudFolder)
    );
    handle("db-mark-folder-synced", (_, id, cloudId) =>
      this.databaseManager.markFolderSynced(id, cloudId)
    );
    handle("db-get-folder-id-map", () => this.databaseManager.getFolderIdMap());
    handle("db-get-pending-folder-deletes", () => this.databaseManager.getPendingFolderDeletes());
    handle("db-hard-delete-folder", (_, id) => {
      const result = this.databaseManager.hardDeleteFolder(id);
      if (result?.success) {
        for (const noteId of result.noteIds ?? []) {
          this._asyncVectorDelete(noteId);
        }
        setImmediate(() => {
          this.broadcastToWindows("folder-deleted", { id });
          if (this._noteFilesEnabled && result.name) {
            const markdownMirror = require("./markdownMirror");
            markdownMirror.deleteFolder(result.name);
          }
        });
      }
      return result;
    });

    // Conversations sync
    handle("db-get-pending-conversations", () => this.databaseManager.getPendingConversations());
    handle("db-get-pending-conversation-deletes", () =>
      this.databaseManager.getPendingConversationDeletes()
    );
    handle("db-get-conversation-by-client-id", (_, clientId) =>
      this.databaseManager.getConversationByClientId(clientId)
    );
    handle("db-upsert-conversation-from-cloud", (_, cloudConv, messages) =>
      this.databaseManager.upsertConversationFromCloud(cloudConv, messages)
    );
    handle("db-mark-conversation-synced", (_, id, cloudId) =>
      this.databaseManager.markConversationSynced(id, cloudId)
    );
    handle("db-hard-delete-conversation", (_, id) => {
      const result = this.databaseManager.hardDeleteConversation(id);
      if (result?.success) {
        setImmediate(() => this.broadcastToWindows("conversation-deleted", { id }));
      }
      return result;
    });

    // Transcriptions sync
    handle("db-get-pending-transcriptions", () => this.databaseManager.getPendingTranscriptions());
    handle("db-get-transcription-by-client-id", (_, clientId) =>
      this.databaseManager.getTranscriptionByClientId(clientId)
    );
    handle("db-upsert-transcription-from-cloud", (_, cloudTranscription) =>
      this.databaseManager.upsertTranscriptionFromCloud(cloudTranscription)
    );
    handle("db-mark-transcription-synced", (_, id, cloudId) =>
      this.databaseManager.markTranscriptionSynced(id, cloudId)
    );
    handle("db-get-pending-transcription-deletes", () =>
      this.databaseManager.getPendingTranscriptionDeletes()
    );
    handle("db-hard-delete-transcription", (_, id) => {
      const result = this.databaseManager.hardDeleteTranscription(id);
      if (result?.success) {
        setImmediate(() => this.broadcastToWindows("transcription-deleted", { id }));
      }
      return result;
    });

    handle("export-note", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const { dialog } = require("electron");
        const fs = require("fs");
        const ext = format === "txt" ? "txt" : "md";
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${ext}`,
          filters: [
            { name: "Markdown", extensions: ["md"] },
            { name: "Text", extensions: ["txt"] },
          ],
        });

        if (result.canceled || !result.filePath) return { success: false };

        let exportContent;
        if (format === "txt") {
          exportContent = (note.content || "")
            .replace(/#{1,6}\s+/g, "")
            .replace(/[*_~`]+/g, "")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
            .replace(/^>\s+/gm, "")
            .trim();
        } else {
          exportContent = note.enhanced_content || note.content;
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting note", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    handle("export-transcript", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const segments = JSON.parse(note.transcript || "[]");
        if (!segments.length) return { success: false, error: "No transcript available" };

        const speakerMappings = this._buildSpeakerMappings(noteId);

        const { dialog } = require("electron");
        const fs = require("fs");
        const extMap = { srt: "srt", json: "json", md: "md" };
        const ext = extMap[format] || "txt";
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${ext}`,
          filters: [
            { name: "Text", extensions: ["txt"] },
            { name: "SubRip Subtitles", extensions: ["srt"] },
            { name: "JSON", extensions: ["json"] },
            { name: "Markdown", extensions: ["md"] },
          ],
        });

        if (result.canceled || !result.filePath) return { success: false };

        const transcriptFormatter = require("./transcriptFormatter");
        let exportContent;
        if (format === "txt") {
          exportContent = transcriptFormatter.formatTxt(note, segments, speakerMappings);
        } else if (format === "srt") {
          exportContent = transcriptFormatter.formatSrt(segments, speakerMappings);
        } else if (format === "md") {
          exportContent = transcriptFormatter.formatMd(note, segments, speakerMappings);
        } else {
          exportContent = transcriptFormatter.formatJson(note, segments, speakerMappings);
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting transcript", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    handle("select-audio-file", async () => {
      const { dialog } = require("electron");
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [
          {
            name: "Audio Files",
            extensions: ["mp3", "wav", "m4a", "webm", "ogg", "oga", "flac", "aac"],
          },
        ],
      });
      if (result.canceled || !result.filePaths.length) {
        return { canceled: true };
      }
      return { canceled: false, filePath: result.filePaths[0] };
    });

    handle("get-file-size", async (_event, filePath) => {
      const fs = require("fs");
      try {
        const stats = fs.statSync(filePath);
        return stats.size;
      } catch {
        return 0;
      }
    });

    handle("transcribe-audio-file", async (event, filePath, options = {}) => {
      const fs = require("fs");
      try {
        const audioBuffer = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase().replace(".", "");
        const contentType = AUDIO_MIME_TYPES[ext] || "audio/mpeg";
        return await transcribeBufferWithGigaam(
          audioBuffer,
          {
            baseUrl:
              options.baseUrl ||
              options.remoteTranscriptionUrl ||
              options.gigaamBaseUrl ||
              process.env.GIGAAM_API_BASE,
            model: options.model || GIGAAM_TRANSCRIPTION_MODEL,
            fileName: path.basename(filePath),
            contentType,
            language: options.language,
          },
          this.gigaamLocalAsrManager
        );
      } catch (error) {
        debugLogger.error("Audio file transcription error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    handle("transcribe-local-gigaam", async (_event, request = {}) => {
      try {
        const audio = request.audio;
        if (!audio || typeof audio.byteLength !== "number") {
          return { success: false, error: "Audio payload is required" };
        }
        const result = await this.gigaamLocalAsrManager.transcribeAudioBuffer(
          Buffer.from(audio.buffer, audio.byteOffset || 0, audio.byteLength)
        );
        return {
          success: true,
          text: typeof result?.text === "string" ? result.text : "",
          model: request.model || GIGAAM_TRANSCRIPTION_MODEL,
        };
      } catch (error) {
        debugLogger.error("Local GigaAM IPC transcription error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    handle("paste-text", async (event, text, options) => {
      const pasteRequestStartedAt = Date.now();
      const pasteTimings = {};
      const mainWindow = this.windowManager?.mainWindow;
      const targetPid = this.textEditMonitor?.lastTargetPid || null;

      // Activating the target by PID is more reliable than hide()'s implicit
      // focus hand-off for Chromium apps like Claude desktop and Brave (#668).
      let activated = false;
      if (process.platform === "darwin" && this.textEditMonitor) {
        const activationStartedAt = Date.now();
        activated = await this.textEditMonitor.activateTargetPid();
        pasteTimings.activateTargetMs = Date.now() - activationStartedAt;
      }

      if (!activated && mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
        const focusFallbackStartedAt = Date.now();
        if (process.platform === "darwin") {
          mainWindow.hide();
          await new Promise((resolve) => setTimeout(resolve, 120));
          mainWindow.showInactive();
        } else {
          mainWindow.blur();
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        pasteTimings.focusFallbackMs = Date.now() - focusFallbackStartedAt;
      }

      const snapshotStartedAt = Date.now();
      const pasteTargetSnapshot =
        process.platform === "darwin" && targetPid && this.textEditMonitor
          ? await this.textEditMonitor.capturePasteTargetSnapshot(targetPid, {
              enableTimeoutMs: MACOS_PASTE_SNAPSHOT_AX_TIMEOUT_MS,
              queryTimeoutMs: MACOS_PASTE_SNAPSHOT_QUERY_TIMEOUT_MS,
            })
          : null;
      pasteTimings.captureSnapshotMs = Date.now() - snapshotStartedAt;

      const result = await this.clipboardManager.pasteText(text, {
        ...options,
        webContents: event.sender,
        targetPid,
        verifyPaste:
          process.platform === "darwin" && targetPid && this.textEditMonitor
            ? ({ text: pastedText, ...verificationOptions }) =>
                this.textEditMonitor.verifyPasteCompleted(
                  targetPid,
                  pastedText,
                  pasteTargetSnapshot,
                  verificationOptions
                )
            : undefined,
      });
      debugLogger.info(
        "Paste request completed",
        {
          targetPid,
          activated,
          elapsedMs: Date.now() - pasteRequestStartedAt,
          timings: pasteTimings,
          snapshotReadable: pasteTargetSnapshot?.readable === true,
          snapshotReason: pasteTargetSnapshot?.reason,
          result: result
            ? {
                inserted: result.inserted === true,
                verified: result.verified === true,
                fallback: result.fallback === true,
                reason: result.reason,
              }
            : null,
        },
        "clipboard"
      );
      return result;
    });

    handle("check-accessibility-permission", async (_event, silent = false) => {
      return this.clipboardManager.checkAccessibilityPermissions(silent);
    });

    // This handler is called from an explicit user action in onboarding/settings.
    handle("prompt-accessibility-permission", async () => {
      if (process.platform !== "darwin") return true;
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      const repair = await repairLegacyAccessibilityIfNeeded({
        platform: process.platform,
        isPackaged: app.isPackaged,
        isTrusted: trusted,
        hasExistingUserData: postMigrationDetector.hasExistingUserData(),
        userDataPath: app.getPath("userData"),
      });
      if (repair.attempted) {
        debugLogger.info(
          "Repaired legacy macOS Accessibility registrations",
          {
            results: repair.results.map(({ bundleId, success }) => ({ bundleId, success })),
          },
          "permissions"
        );
      }
      return systemPreferences.isTrustedAccessibilityClient(true);
    });

    handle("read-clipboard", async (event) => {
      return this.clipboardManager.readClipboard();
    });

    handle("write-clipboard", async (event, text) => {
      return this.clipboardManager.writeClipboard(text, event.sender);
    });

    handle("copy-debug-logs", async (event) => {
      try {
        debugLogger.ensureFileLogging();

        const logsDir = path.join(app.getPath("userData"), "logs");
        fs.mkdirSync(logsDir, { recursive: true });

        const currentDebugLog = debugLogger.getLogPath();
        const latestDebugLog = currentDebugLog || (await findLatestDebugLog(logsDir));
        const logPaths = [latestDebugLog, path.join(logsDir, "gigaam-sidecar.log")].filter(Boolean);
        const uniqueLogPaths = [...new Set(logPaths)];
        const sections = (await Promise.all(uniqueLogPaths.map(readLogFileTail))).filter(Boolean);
        const transcriptions = this.databaseManager.getTranscriptions(DEBUG_TRANSCRIPTION_LIMIT);

        if (sections.length === 0 && transcriptions.length === 0) {
          return { success: false, error: "No logs or dictations found" };
        }

        const text = [
          formatDebugTranscriptionsSection(transcriptions),
          ...sections.map(formatLogClipboardSection),
        ].join("\n\n");
        await this.clipboardManager.writeClipboard(text, event.sender);

        return {
          success: true,
          bytes: Buffer.byteLength(text, "utf8"),
          files: sections.map((section) => section.path),
          transcriptionCount: transcriptions.length,
        };
      } catch (error) {
        debugLogger.warn("Failed to copy debug logs", { error: error.message }, "debug");
        return { success: false, error: error.message };
      }
    });

    handle("check-paste-tools", async () => {
      return this.clipboardManager.checkPasteTools();
    });

    // Diarization model management
    handle("get-diarization-model-status", async () => {
      return {
        available: this.diarizationManager?.isAvailable() ?? false,
        modelsDownloaded:
          (this.diarizationManager?.isModelDownloaded() ?? false) &&
          (this.diarizationManager?.isVadModelDownloaded() ?? false),
      };
    });

    handle("delete-diarization-models", async () => {
      try {
        await this.diarizationManager.deleteModels();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to delete diarization models", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    handle("cleanup-app", async (event) => {
      const fs = require("fs");
      const os = require("os");
      const errors = [];
      const mainWindow = this.windowManager.mainWindow;

      // Close DB connection before deleting the file
      try {
        this.databaseManager?.db?.close();
      } catch (e) {
        errors.push(`DB close: ${e.message}`);
      }

      // Delete audio files
      try {
        this.audioStorageManager.deleteAllAudio();
      } catch (e) {
        errors.push(`Audio delete: ${e.message}`);
      }

      // Delete database file + WAL/SHM
      try {
        const dbPath = path.join(
          app.getPath("userData"),
          process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
        );
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
        if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
      } catch (e) {
        errors.push(`DB file: ${e.message}`);
      }

      // Delete .env file
      try {
        const envPath = path.join(app.getPath("userData"), ".env");
        if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
      } catch (e) {
        errors.push(`Env file: ${e.message}`);
      }

      // Clear session cookies
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) await win.webContents.session.clearStorageData({ storages: ["cookies"] });
      } catch (e) {
        errors.push(`Cookies: ${e.message}`);
      }

      // Clear localStorage
      if (mainWindow?.webContents) {
        try {
          await mainWindow.webContents.executeJavaScript("localStorage.clear()");
        } catch (e) {
          errors.push(`localStorage: ${e.message}`);
        }
      }

      if (errors.length > 0) {
        debugLogger.warn("Cleanup completed with errors", { errors }, "cleanup");
      }

      return { success: errors.length === 0, message: "Cleanup completed", errors };
    });

    handle("update-hotkey", async (event, hotkey) => {
      return await this.windowManager.updateHotkey(hotkey);
    });

    handle("set-hotkey-listening-mode", async (event, enabled, newHotkey = null) => {
      if (this._hotkeyCaptureMode === enabled) {
        if (enabled && process.platform === "win32" && this.windowsKeyManager) {
          const nativeReady =
            this.windowsKeyManager.currentKey === "__capture__" &&
            this.windowsKeyManager.isReady === true;
          return { success: nativeReady, nativeReady, skipped: true };
        }
        return { success: true, skipped: true };
      }
      let nativeCaptureResult = { success: true };
      this._hotkeyCaptureMode = enabled;
      this.windowManager.setHotkeyListeningMode(enabled);
      ipcMain.emit("hotkey-listening-mode-changed", null, enabled);
      const hotkeyManager = this.windowManager.hotkeyManager;

      // The dictation overlay window is created with focusable:false so it never
      // steals focus during dictation. But that also means the OS never delivers
      // keydown events to it, so hotkey capture (which reads keyboard events in
      // the renderer) silently does nothing there. While capturing, make the
      // capturing window temporarily focusable and focus it; restore on exit.
      if (enabled) {
        const captureWin = BrowserWindow.fromWebContents(event.sender);
        this._hotkeyCaptureWindow = captureWin;
        if (captureWin && !captureWin.isDestroyed() && !captureWin.isFocusable()) {
          this._hotkeyCaptureRefocusWindow = captureWin;
          captureWin.setFocusable(true);
          captureWin.focus();
        }
      } else if (this._hotkeyCaptureRefocusWindow) {
        const captureWin = this._hotkeyCaptureRefocusWindow;
        this._hotkeyCaptureRefocusWindow = null;
        if (!captureWin.isDestroyed()) captureWin.setFocusable(false);
      }
      if (!enabled) {
        this._hotkeyCaptureWindow = null;
      }

      // When exiting capture mode with a new hotkey, use that to avoid reading stale state
      const effectiveHotkey = !enabled && newHotkey ? newHotkey : hotkeyManager.getCurrentHotkey();

      const {
        isGlobeLikeHotkey,
        hasFnOrGlobeToken,
        isModifierOnlyHotkey,
        isRightSideModifier,
        isMouseButtonHotkey,
        isWindowsNativeHotkey,
      } = require("./hotkeyManager");
      const usesNativeListener = (hotkey) =>
        !hotkey ||
        isGlobeLikeHotkey(hotkey) ||
        isMouseButtonHotkey(hotkey) ||
        isModifierOnlyHotkey(hotkey) ||
        isRightSideModifier(hotkey) ||
        isWindowsNativeHotkey(hotkey);

      if (enabled) {
        // Entering capture mode — unregister ALL slots so none intercept keypresses.
        // Dictation is always active; meeting and agent may or may not be set.
        const allSlots = hotkeyManager.slots;
        for (const [slot, info] of allSlots) {
          if (!info?.hotkey) continue;

          if (!usesNativeListener(info.hotkey)) {
            debugLogger.log(
              `[IPC] Unregistering globalShortcut "${info.hotkey}" (slot "${slot}") for capture mode`
            );
            const { globalShortcut } = require("electron");
            try {
              globalShortcut.unregister(info.hotkey);
            } catch {}
          }
        }

        // On Windows, replace the active PTT hook with a one-shot native
        // capture hook. This sees and suppresses Win/CapsLock combinations
        // that Windows does not reliably deliver to Chromium.
        if (process.platform === "win32" && this.windowsKeyManager) {
          debugLogger.log("[IPC] Starting native Windows hotkey capture mode");
          nativeCaptureResult = await this.windowsKeyManager.startCapture();
          if (!nativeCaptureResult.success) {
            debugLogger.warn("[IPC] Native Windows hotkey capture failed to become ready", {
              reason: nativeCaptureResult.reason,
            });
          }
        }

        // On Linux, stop the Linux key listener
        if (process.platform === "linux" && this.linuxKeyManager) {
          debugLogger.log("[IPC] Stopping Linux key listener for hotkey capture mode");
          this.linuxKeyManager.stop();
        }

        // On GNOME, unregister all native keybindings during capture
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager) {
          for (const slot of [...hotkeyManager.gnomeManager.registeredSlots]) {
            debugLogger.log(
              `[IPC] Unregistering GNOME keybinding (slot "${slot}") for capture mode`
            );
            await hotkeyManager.gnomeManager.unregisterKeybinding(slot).catch((err) => {
              debugLogger.warn(`[IPC] Failed to unregister GNOME slot "${slot}":`, err.message);
            });
          }
        }

        // On Hyprland Wayland, unregister the keybinding during capture
        if (hotkeyManager.isUsingHyprland() && hotkeyManager.hyprlandManager) {
          debugLogger.log("[IPC] Unregistering Hyprland keybinding for hotkey capture mode");
          await hotkeyManager.hyprlandManager.unregisterKeybinding().catch((err) => {
            debugLogger.warn("[IPC] Failed to unregister Hyprland keybinding:", err.message);
          });
        }
      } else {
        // Exiting capture mode - re-register globalShortcut if not already registered
        // Skip for KDE/GNOME/Hyprland — updateHotkey handles re-registration via native path
        const hasUnsupportedFnToken =
          process.platform !== "darwin" && hasFnOrGlobeToken(effectiveHotkey);
        const usesNativePath =
          hotkeyManager.isUsingKDE() ||
          hotkeyManager.isUsingGnome() ||
          hotkeyManager.isUsingHyprland();
        if (
          effectiveHotkey &&
          !hasUnsupportedFnToken &&
          !usesNativeListener(effectiveHotkey) &&
          !usesNativePath
        ) {
          const { globalShortcut } = require("electron");
          const accelerator =
            process.platform === "darwin" && effectiveHotkey.startsWith("Fn+")
              ? effectiveHotkey.slice(3)
              : effectiveHotkey;
          if (!globalShortcut.isRegistered(accelerator)) {
            debugLogger.log(
              `[IPC] Re-registering globalShortcut "${accelerator}" after capture mode`
            );
            const callback = this.windowManager.createHotkeyCallback();
            const registered = globalShortcut.register(accelerator, callback);
            if (!registered) {
              debugLogger.warn(
                `[IPC] Failed to re-register globalShortcut "${accelerator}" after capture mode`
              );
            }
          }
        }

        if (process.platform === "win32" && this.windowsKeyManager) {
          const activationMode = this.windowManager.getActivationMode();
          debugLogger.log(
            `[IPC] Exiting hotkey capture mode, activationMode="${activationMode}", hotkey="${effectiveHotkey}"`
          );
          const needsListener =
            effectiveHotkey &&
            !hasUnsupportedFnToken &&
            !isGlobeLikeHotkey(effectiveHotkey) &&
            (activationMode === "push" ||
              isModifierOnlyHotkey(effectiveHotkey) ||
              isRightSideModifier(effectiveHotkey) ||
              isWindowsNativeHotkey(effectiveHotkey));
          if (needsListener) {
            debugLogger.log(`[IPC] Restarting Windows key listener for hotkey: ${effectiveHotkey}`);
            this.windowsKeyManager.start(effectiveHotkey);
          } else {
            this.windowsKeyManager.stop();
          }
        }

        if (process.platform === "linux" && this.linuxKeyManager) {
          const activationMode = this.windowManager.getActivationMode();
          const needsListener =
            effectiveHotkey &&
            !hasUnsupportedFnToken &&
            !isGlobeLikeHotkey(effectiveHotkey) &&
            (activationMode === "push" ||
              isModifierOnlyHotkey(effectiveHotkey) ||
              isRightSideModifier(effectiveHotkey));
          if (needsListener) {
            debugLogger.log(`[IPC] Restarting Linux key listener for hotkey: ${effectiveHotkey}`);
            this.linuxKeyManager.start(effectiveHotkey);
          } else {
            this.linuxKeyManager.stop();
          }
        }

        // On GNOME, re-register the keybinding with the effective hotkey
        if (
          hotkeyManager.isUsingGnome() &&
          hotkeyManager.gnomeManager &&
          effectiveHotkey &&
          !hasUnsupportedFnToken
        ) {
          const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(effectiveHotkey);
          debugLogger.log(
            `[IPC] Re-registering GNOME keybinding "${gnomeHotkey}" after capture mode`
          );
          const success = await hotkeyManager.gnomeManager.registerKeybinding(gnomeHotkey);
          if (success) {
            hotkeyManager.currentHotkey = effectiveHotkey;
          }
        }

        // On Hyprland Wayland, re-register the keybinding with the effective hotkey
        if (
          hotkeyManager.isUsingHyprland() &&
          hotkeyManager.hyprlandManager &&
          effectiveHotkey &&
          !hasUnsupportedFnToken
        ) {
          debugLogger.log(
            `[IPC] Re-registering Hyprland keybinding "${effectiveHotkey}" after capture mode`
          );
          const success = await hotkeyManager.hyprlandManager.registerKeybinding(effectiveHotkey);
          if (success) {
            hotkeyManager.currentHotkey = effectiveHotkey;
          }
        }

        // On KDE (X11 or Wayland), re-register the keybinding with the effective hotkey
        if (
          hotkeyManager.isUsingKDE() &&
          hotkeyManager.kdeManager &&
          effectiveHotkey &&
          !hasUnsupportedFnToken
        ) {
          debugLogger.log(
            `[IPC] Re-registering KDE keybinding "${effectiveHotkey}" after capture mode`
          );
          const callback = this.windowManager.createHotkeyCallback();
          const result = await hotkeyManager.kdeManager.registerKeybinding(
            effectiveHotkey,
            "dictation",
            callback
          );
          if (result === true) {
            hotkeyManager.currentHotkey = effectiveHotkey;
          } else {
            debugLogger.warn(
              `[IPC] Failed to re-register KDE keybinding "${effectiveHotkey}" after capture mode`,
              { result }
            );
          }
        }

        // Re-register non-dictation slots (meeting, agent) that were unregistered on capture enter
        for (const [slot, info] of hotkeyManager.slots) {
          if (slot === "dictation" || slot === "cancel" || !info?.hotkey || !info?.callback)
            continue;
          debugLogger.log(
            `[IPC] Re-registering slot "${slot}" ("${info.hotkey}") after capture mode`
          );
          await hotkeyManager.registerSlot(slot, info.hotkey, info.callback).catch((err) => {
            debugLogger.warn(`[IPC] Failed to re-register slot "${slot}":`, err.message);
          });
        }
      }

      return {
        success: nativeCaptureResult.success,
        nativeReady: nativeCaptureResult.success,
        error: nativeCaptureResult.success ? undefined : nativeCaptureResult.reason,
      };
    });

    handle("get-hotkey-mode-info", async () => {
      const isUsingNativeShortcut = this.windowManager.isUsingNativeShortcutHotkeys();
      const supportsPushToTalk =
        process.platform === "linux"
          ? this.linuxKeyManager?.isAvailable?.() === true
          : !isUsingNativeShortcut;

      return {
        isUsingGnome: this.windowManager.isUsingGnomeHotkeys(),
        isUsingHyprland: this.windowManager.isUsingHyprlandHotkeys(),
        isUsingKDE: this.windowManager.isUsingKDEHotkeys(),
        isUsingNativeShortcut,
        supportsPushToTalk,
      };
    });

    handle("register-cancel-hotkey", async (event, key) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const mainWindow = this.windowManager.mainWindow;
      return hotkeyManager.registerSlot("cancel", key, () => {
        mainWindow?.webContents?.send("cancel-hotkey-pressed");
      });
    });

    handle("unregister-cancel-hotkey", async () => {
      this.windowManager.hotkeyManager.unregisterSlot("cancel");
      return { success: true };
    });

    handle("start-window-drag", async (event) => {
      return await this.windowManager.startWindowDrag();
    });

    handle("stop-window-drag", async (event) => {
      return await this.windowManager.stopWindowDrag();
    });

    handle("open-external", async (event, url) => {
      try {
        if (!isSafeExternalUrl(url, { allowLocalHttp: process.env.NODE_ENV === "development" })) {
          return { success: false, error: "Blocked unsafe external URL" };
        }

        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("get-auto-start-enabled", async () => {
      try {
        const loginSettings = app.getLoginItemSettings();
        return loginSettings.openAtLogin;
      } catch (error) {
        debugLogger.error("Error getting auto-start status:", error);
        return false;
      }
    });

    handle("set-auto-start-enabled", async (event, enabled) => {
      try {
        app.setLoginItemSettings({
          openAtLogin: enabled,
          openAsHidden: true, // Start minimized to tray
        });
        debugLogger.debug("Auto-start setting updated", { enabled });
        return { success: true };
      } catch (error) {
        debugLogger.error("Error setting auto-start:", error);
        return { success: false, error: error.message };
      }
    });

    handle("model-get-all", async () => {
      try {
        debugLogger.debug("model-get-all called", undefined, "ipc");
        const modelManager = require("./modelManagerBridge").default;
        const models = await modelManager.getModelsWithStatus();
        debugLogger.debug("Returning models", { count: models.length }, "ipc");
        return models;
      } catch (error) {
        debugLogger.error("Error in model-get-all:", error);
        throw error;
      }
    });

    handle("model-check", async (_, modelId) => {
      const modelManager = require("./modelManagerBridge").default;
      return modelManager.isModelDownloaded(modelId);
    });

    handle("model-check-runtime", async (event) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.ensureLlamaCpp();
        return { available: true };
      } catch (error) {
        return {
          available: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    // Enterprise provider configuration handlers
    // Enterprise provider test connection
    handle("get-dictation-key", async () => {
      return this.environmentManager.getDictationKey();
    });

    handle("save-dictation-key", async (event, key) => {
      return this.environmentManager.saveDictationKey(key);
    });

    handle("get-active-dictation-key", async () => {
      return this.windowManager?.hotkeyManager?.currentHotkey ?? null;
    });

    handle("get-effective-default-hotkey", async () => {
      return this.windowManager?.hotkeyManager?.getEffectiveDefaultHotkey() ?? null;
    });

    handle("is-fn-hotkey-available", async () => {
      return this.windowManager?.hotkeyManager?.isFnHotkeyAvailable() ?? false;
    });

    handle("get-show-dock-icon", async () => {
      return this.environmentManager.getShowDockIcon();
    });

    handle("set-show-dock-icon", async (_event, enabled) => {
      const visible = Boolean(enabled);
      this.environmentManager.saveShowDockIcon(visible);
      await this.windowManager.setShowDockIcon(visible);
      return { success: true, visible };
    });

    handle("get-activation-mode", async () => {
      return this.environmentManager.getActivationMode();
    });

    handle("save-activation-mode", async (event, mode) => {
      return this.environmentManager.saveActivationMode(mode);
    });

    handle("get-ui-language", async () => {
      return this.environmentManager.getUiLanguage();
    });

    handle("save-ui-language", async (event, language) => {
      return this.environmentManager.saveUiLanguage(language);
    });

    handle("get-app-version", async () => {
      return { version: app.getVersion() };
    });

    handle("get-post-migration-state", async () => ({
      justMigrated: postMigrationDetector.isReturningFromOldBundle(),
    }));

    handle("mark-bundle-migrated", async () => {
      postMigrationDetector.markBundleMigrated();
    });

    handle("mark-bundle-migration-dismissed", async () => {
      postMigrationDetector.markBundleMigrationDismissed();
    });

    handle("set-ui-language", async (event, language) => {
      const result = this.environmentManager.saveUiLanguage(language);
      process.env.UI_LANGUAGE = result.language;
      changeLanguage(result.language);
      this.windowManager?.refreshLocalizedUi?.();
      this.getTrayManager?.()?.updateTrayMenu?.();
      return { success: true, language: result.language };
    });

    handle("save-runtime-config-to-env", async () => {
      return this.environmentManager.saveRuntimeConfigToEnvFile();
    });

    handle("sync-startup-preferences", async (_event, _prefs) => {
      const setVars = {};
      const clearVars = ["LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL"];

      clearVars.push(
        "CLEANUP_PROVIDER",
        "LOCAL_CLEANUP_MODEL",
        "REASONING_PROVIDER",
        "LOCAL_REASONING_MODEL",
        "DICTATION_AGENT_PROVIDER",
        "LOCAL_DICTATION_AGENT_MODEL"
      );

      const modelManager = require("./modelManagerBridge").default;
      modelManager.stopServer().catch((err) => {
        debugLogger.error("Failed to stop llama-server after disabling dictation-agent", {
          error: err.message,
        });
      });

      this._syncStartupEnv(setVars, clearVars);
    });

    handle("process-local-reasoning", async (event, text, modelId, _agentName, config) => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        const result = await LocalReasoningService.processText(text, modelId, config);
        return { success: true, text: result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("check-local-reasoning-available", async () => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        return await LocalReasoningService.isAvailable();
      } catch (error) {
        return false;
      }
    });

    handle("llama-cpp-check", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const isInstalled = await llamaCppInstaller.isInstalled();
        const version = isInstalled ? await llamaCppInstaller.getVersion() : null;
        return { isInstalled, version };
      } catch (error) {
        return { isInstalled: false, error: error.message };
      }
    });

    handle("llama-cpp-uninstall", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const result = await llamaCppInstaller.uninstall();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("llama-server-start", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        modelManager.ensureInitialized();
        const modelInfo = modelManager.findModelById(modelId);
        if (!modelInfo) {
          return { success: false, error: `Model "${modelId}" not found` };
        }

        const modelPath = require("path").join(modelManager.modelsDir, modelInfo.model.fileName);

        await modelManager.serverManager.start(modelPath, { threads: 4 });
        modelManager.currentServerModelId = modelId;

        this.environmentManager.saveRuntimeConfigToEnvFile().catch(() => {});
        return { success: true, port: modelManager.serverManager.port };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("llama-server-stop", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.stopServer();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("llama-server-status", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        return modelManager.getServerStatus();
      } catch (error) {
        return { available: false, running: false, error: error.message };
      }
    });

    handle("llama-gpu-reset", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const previousModelId = modelManager.currentServerModelId;
        modelManager.serverManager.resetGpuDetection();
        await modelManager.stopServer();

        // Restart server with previous model so Vulkan binary is picked up
        if (previousModelId) {
          modelManager.prewarmServer(previousModelId).catch(() => {});
        }

        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("detect-vulkan-gpu", async () => {
      try {
        const { detectVulkanGpu } = require("../utils/vulkanDetection");
        return await detectVulkanGpu();
      } catch (error) {
        return { available: false, error: error.message };
      }
    });

    handle("get-llama-vulkan-status", async () => {
      try {
        if (!this._llamaVulkanManager) {
          const LlamaVulkanManager = require("./llamaVulkanManager");
          this._llamaVulkanManager = new LlamaVulkanManager();
        }
        return this._llamaVulkanManager.getStatus();
      } catch (error) {
        return { supported: false, downloaded: false, error: error.message };
      }
    });

    handle("delete-llama-vulkan-binary", async () => {
      try {
        if (!this._llamaVulkanManager) {
          const LlamaVulkanManager = require("./llamaVulkanManager");
          this._llamaVulkanManager = new LlamaVulkanManager();
        }

        const modelManager = require("./modelManagerBridge").default;
        if (modelManager.serverManager.activeBackend === "vulkan") {
          await modelManager.stopServer();
        }

        const result = await this._llamaVulkanManager.deleteBinary();

        delete process.env.LLAMA_VULKAN_ENABLED;
        delete process.env.LLAMA_GPU_BACKEND;
        modelManager.serverManager.cachedServerBinaryPaths = null;
        this.environmentManager.saveRuntimeConfigToEnvFile().catch(() => {});

        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("get-log-level", async () => {
      return debugLogger.getLevel();
    });

    handle("app-log", async (event, entry) => {
      debugLogger.logEntry(entry);
      return { success: true };
    });

    handle("get-debug-state", async () => {
      debugLogger.ensureFileLogging();
      return {
        enabled: debugLogger.isEnabled(),
        logPath: debugLogger.getLogPath(),
        logLevel: debugLogger.getLevel(),
      };
    });

    handle("set-debug-logging", async (event, enabled) => {
      try {
        const nextLevel = enabled ? "debug" : "info";
        this._syncStartupEnv({ OPENWHISPR_LOG_LEVEL: nextLevel });
        debugLogger.refreshLogLevel();
        debugLogger.ensureFileLogging();

        return {
          success: true,
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
          logLevel: debugLogger.getLevel(),
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("open-logs-folder", async () => {
      try {
        const logsDir = path.join(app.getPath("userData"), "logs");
        fs.mkdirSync(logsDir, { recursive: true });
        const error = await shell.openPath(logsDir);
        return error ? { success: false, error } : { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("get-ydotool-status", async () => {
      try {
        return require("./ensureYdotool").getYdotoolStatus();
      } catch (error) {
        debugLogger.warn("Failed to get ydotool status", { error: error.message }, "clipboard");
        return {
          isLinux: process.platform === "linux",
          isWayland: false,
          hasYdotool: false,
          hasYdotoold: false,
          daemonRunning: false,
          hasService: false,
          hasUinput: false,
          hasUdevRule: false,
          hasGroup: false,
          allGood: false,
        };
      }
    });

    const SYSTEM_SETTINGS_URLS = {
      darwin: {
        microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        sound: "x-apple.systempreferences:com.apple.preference.sound?input",
        accessibility:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        systemAudio:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      },
      win32: {
        microphone: "ms-settings:privacy-microphone",
        sound: "ms-settings:sound",
      },
    };

    const openSystemSettings = async (settingType) => {
      const platform = process.platform;
      const urls = SYSTEM_SETTINGS_URLS[platform];
      const url = urls?.[settingType];

      if (!url) {
        // Platform doesn't support this settings URL
        const messages = {
          microphone: i18nMain.t("systemSettings.microphone"),
          sound: i18nMain.t("systemSettings.sound"),
          accessibility: i18nMain.t("systemSettings.accessibility"),
          systemAudio: i18nMain.t("systemSettings.systemAudio"),
        };
        return {
          success: false,
          error:
            messages[settingType] || `${settingType} settings are not available on this platform.`,
        };
      }

      try {
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        debugLogger.error(`Failed to open ${settingType} settings:`, error);
        return { success: false, error: error.message };
      }
    };

    handle("open-microphone-settings", () => openSystemSettings("microphone"));
    handle("open-sound-input-settings", () => openSystemSettings("sound"));
    handle("open-accessibility-settings", () => openSystemSettings("accessibility"));
    handle("open-system-audio-settings", () => openSystemSettings("systemAudio"));

    handle("toggle-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.toggleMedia();
    });

    handle("pause-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.pauseMedia();
    });

    handle("resume-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.resumeMedia();
    });

    // On Windows there is no prompt API — access is governed by the privacy
    // settings ("Allow desktop apps to access your microphone"). The status
    // can also be "not-determined"/"unknown" (absent ConsentStore registry
    // value on LTSC/managed images) while the mic works, so only an explicit
    // "denied" counts as not granted.
    const readWindowsMicAccess = () => {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      return { granted: status !== "denied", status };
    };

    handle("request-microphone-access", async () => {
      if (process.platform === "darwin") {
        const granted = await systemPreferences.askForMediaAccess("microphone");
        return { granted };
      }
      if (process.platform === "win32") {
        return readWindowsMicAccess();
      }
      return { granted: true, status: "granted" };
    });

    handle("check-microphone-access", () => {
      if (process.platform === "darwin") {
        const status = systemPreferences.getMediaAccessStatus("microphone");
        return { granted: status === "granted", status };
      }
      if (process.platform === "win32") {
        return readWindowsMicAccess();
      }
      return { granted: true, status: "granted" };
    });

    const buildSystemAudioAccess = (partial = {}) => ({
      granted: false,
      status: "unsupported",
      mode: "unsupported",
      supportsPersistentGrant: false,
      supportsPersistentPortalGrant: false,
      supportsNativeCapture: false,
      supportsOnboardingGrant: false,
      requiresRuntimeSharePrompt: false,
      strategy: "unsupported",
      restoreTokenAvailable: false,
      portalVersion: null,
      ...partial,
    });

    const getLinuxSystemAudioAccess = async () => {
      const capability = await this.linuxPortalAudioManager?.getCapability().catch((error) => ({
        available: false,
        supportsPersistentGrant: false,
        supportsPersistentPortalGrant: false,
        supportsNativeCapture: false,
        portalVersion: null,
        error: error.message,
      }));
      const supportsPersistentGrant = !!capability?.supportsPersistentGrant;
      const supportsPersistentPortalGrant = !!capability?.supportsPersistentPortalGrant;
      const supportsNativeCapture = !!capability?.supportsNativeCapture;
      const restoreTokenAvailable =
        supportsPersistentGrant && !!this.linuxPortalAudioManager?.hasStoredRestoreToken();
      const helperError =
        typeof capability?.error === "string" &&
        !capability.error.includes("helper binary not found")
          ? capability.error
          : undefined;

      return buildSystemAudioAccess({
        granted: restoreTokenAvailable,
        status: supportsPersistentGrant
          ? restoreTokenAvailable
            ? "granted"
            : "not-determined"
          : "unknown",
        mode: "portal",
        supportsPersistentGrant,
        supportsPersistentPortalGrant,
        supportsNativeCapture,
        supportsOnboardingGrant: supportsPersistentGrant,
        requiresRuntimeSharePrompt: !supportsPersistentGrant || !restoreTokenAvailable,
        strategy: supportsPersistentGrant ? "portal-helper" : "browser-portal",
        restoreTokenAvailable,
        portalVersion: capability?.portalVersion ?? null,
        error: helperError,
      });
    };

    const getSystemAudioAccess = async () => {
      if (process.platform === "win32") {
        return buildSystemAudioAccess({
          granted: true,
          status: "granted",
          mode: "loopback",
          strategy: "loopback",
        });
      }

      if (process.platform === "linux") {
        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      const result = this.audioTapManager.checkAccess();
      return buildSystemAudioAccess({
        granted: result.granted,
        status: result.status,
        mode: "native",
        strategy: "native",
      });
    };

    handle("check-system-audio-access", () => getSystemAudioAccess());

    handle("request-system-audio-access", async () => {
      if (process.platform === "win32") {
        return buildSystemAudioAccess({
          granted: true,
          status: "granted",
          mode: "loopback",
          strategy: "loopback",
        });
      }

      if (process.platform === "linux") {
        const currentAccess = await getLinuxSystemAudioAccess();
        if (!currentAccess.supportsOnboardingGrant) {
          return currentAccess;
        }

        try {
          await this.linuxPortalAudioManager?.requestAccess();
        } catch (error) {
          debugLogger.warn(
            "Linux system audio persistent grant failed",
            { error: error.message },
            "meeting"
          );
        }

        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      try {
        const result = await this.audioTapManager.requestAccess();
        if (result.granted) {
          return buildSystemAudioAccess({
            granted: true,
            status: "granted",
            mode: "native",
            strategy: "native",
          });
        }
      } catch {
        // Falls through to opening System Settings
      }

      await openSystemSettings("systemAudio");
      const status = this.audioTapManager.getPermissionStatus();
      return buildSystemAudioAccess({
        granted: false,
        status,
        mode: "native",
        strategy: "native",
      });
    });

    handle("retry-transcription", async (event, id, settings) => {
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      if (!buffer) return { success: false, error: "Audio file not found" };
      try {
        let result;
        const preferredLanguage = settings?.preferredLanguage;
        const language =
          preferredLanguage && preferredLanguage !== "auto"
            ? preferredLanguage.split("-")[0]
            : undefined;

        result = await transcribeBufferWithGigaam(
          buffer,
          {
            baseUrl:
              settings?.remoteTranscriptionUrl ||
              settings?.gigaamBaseUrl ||
              process.env.GIGAAM_API_BASE,
            model: GIGAAM_TRANSCRIPTION_MODEL,
            fileName: "audio.webm",
            contentType: "audio/webm",
            language,
          },
          this.gigaamLocalAsrManager
        );

        if (!result?.text) {
          return { success: false, error: "No transcription engine available" };
        }

        this.databaseManager.updateTranscriptionText(id, result.text, result.text);
        this.databaseManager.updateTranscriptionStatus(id, "completed");
        const providerName = result.source || "local";
        const modelName = result.model || null;
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: null,
          provider: providerName,
          model: modelName,
        });
        const updated = this.databaseManager.getTranscriptionById(id);
        if (updated) {
          setImmediate(() => {
            this.broadcastToWindows("transcription-updated", updated);
          });
        }
        return { success: true, transcription: updated };
      } catch (error) {
        debugLogger.error(
          "Retry transcription failed",
          { id, error: error.message, code: error.code },
          "audio-storage"
        );
        if (error.code) {
          return { success: false, error: error.message, code: error.code, ...error };
        }
        return { success: false, error: error.message };
      }
    });

    let meetingTranscriptionStartInProgress = false;

    const DUPLICATE_TRANSCRIPT_WINDOW_MS = 6000;
    const DUPLICATE_TRANSCRIPT_MERGE_LIMIT = 3;
    const LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS = 4500;

    const buildNearbyTranscriptCandidates = (
      targetSource,
      timestamp,
      { extraSegment = null } = {}
    ) => {
      const relevant = meetingDiarizationSegments.filter(
        (candidate) =>
          candidate.source === targetSource && candidate.timestamp != null && candidate.text
      );

      return buildMergedCandidates({
        segments: relevant,
        timestamp,
        windowMs: DUPLICATE_TRANSCRIPT_WINDOW_MS,
        mergeLimit: DUPLICATE_TRANSCRIPT_MERGE_LIMIT,
        extraSegment,
      });
    };

    const hasNearbyTranscriptMatch = (targetSource, text, timestamp, options = {}) => {
      if (!text) return false;

      const matcher = options.relaxed ? transcriptsLooselyOverlap : transcriptsOverlap;
      const candidates = buildNearbyTranscriptCandidates(targetSource, timestamp, options);
      for (const candidateText of candidates) {
        if (matcher(text, candidateText)) {
          return true;
        }
      }

      return false;
    };

    const shouldSkipDuplicateMicSegment = (text, timestamp, suppression = null) => {
      if (suppression?.likelyRenderBleed || suppression?.hasBleedEvidence) {
        if (hasNearbyTranscriptMatch("system", text, timestamp)) {
          return true;
        }
      }

      if (suppression?.reason === "double_talk") {
        return hasNearbyTranscriptMatch("system", text, timestamp, { relaxed: true });
      }

      return false;
    };

    const isWithinMeetingStartupWarmup = () =>
      meetingStartedAt != null && Date.now() - meetingStartedAt < MEETING_STARTUP_WARMUP_MS;

    const hasRiskyMicDuplicateProfile = (suppression = null) => {
      if (isWithinMeetingStartupWarmup()) {
        return true;
      }
      if (suppression?.systemSpeaking) {
        return true;
      }
      return (
        !!suppression &&
        (suppression.reason === "double_talk" ||
          suppression.hasBleedEvidence ||
          suppression.likelyRenderBleed)
      );
    };

    const removeRacingMicEntriesFor = (systemText, systemTimestamp) => {
      const removed = [];
      for (let i = meetingDiarizationSegments.length - 1; i >= 0; i -= 1) {
        const candidate = meetingDiarizationSegments[i];
        if (candidate.source !== "mic" || candidate.timestamp == null) continue;
        if (systemTimestamp != null && Math.abs(candidate.timestamp - systemTimestamp) > 4000) {
          if (candidate.timestamp < systemTimestamp) break;
          continue;
        }
        const hasMicDuplicateRisk =
          candidate.likelyRenderBleed ||
          candidate.hasBleedEvidence ||
          candidate.suppressionReason === "double_talk";
        const overlapsSystem = hasNearbyTranscriptMatch(
          "system",
          candidate.text,
          candidate.timestamp,
          {
            extraSegment: {
              text: systemText,
              timestamp: systemTimestamp,
            },
            relaxed: candidate.suppressionReason === "double_talk",
          }
        );
        if (hasMicDuplicateRisk && overlapsSystem) {
          meetingDiarizationSegments.splice(i, 1);
          removed.push(candidate);
        }
      }
      return removed;
    };

    const appendMeetingLocalTranscript = (text) => {
      if (!text) return;
      meetingLocalTranscript += `${meetingLocalTranscript ? " " : ""}${text}`;
    };

    const storeMeetingDiarizationSegment = (text, source, timestamp, micSuppression = null) => {
      meetingDiarizationSegments.push({
        text,
        source,
        timestamp,
        suppressionReason: source === "mic" ? micSuppression?.reason || null : null,
        hasBleedEvidence: source === "mic" ? !!micSuppression?.hasBleedEvidence : false,
        likelyRenderBleed: source === "mic" ? !!micSuppression?.likelyRenderBleed : false,
      });
    };

    const sendMeetingFinalSegment = ({
      text,
      source,
      timestamp,
      micSuppression = null,
      send = null,
      includeInLocalTranscript = false,
    }) => {
      if (includeInLocalTranscript) {
        appendMeetingLocalTranscript(text);
      }

      storeMeetingDiarizationSegment(text, source, timestamp, micSuppression);

      if (send) {
        send("meeting-transcription-segment", {
          text,
          source,
          type: "final",
          timestamp,
        });
      }
    };

    function flushPendingMicFinals(force = false) {
      if (meetingPendingMicFinals.length === 0) {
        if (meetingPendingMicFinalTimer) {
          clearTimeout(meetingPendingMicFinalTimer);
          meetingPendingMicFinalTimer = null;
        }
        return;
      }

      const ready = [];
      const deferred = [];
      const now = Date.now();

      for (const pending of meetingPendingMicFinals) {
        if (!force && pending.releaseAt > now) {
          deferred.push(pending);
          continue;
        }

        if (
          shouldSkipDuplicateMicSegment(pending.text, pending.timestamp, pending.micSuppression)
        ) {
          debugLogger.debug(
            "Dropping buffered mic segment after system context confirmed duplicate",
            {
              text: pending.text.slice(0, 80),
              averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
              averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
            }
          );
          continue;
        }

        ready.push(pending);
      }

      meetingPendingMicFinals = deferred;
      schedulePendingMicFinalFlush();

      for (const pending of ready) {
        if (pending.micSuppression?.hasBleedEvidence) {
          debugLogger.debug("Dropping flagged-bleed mic segment after holdback", {
            text: pending.text.slice(0, 80),
            holdbackMs: pending.holdbackMs,
            averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
            averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
          });
          continue;
        }
        debugLogger.debug("Releasing buffered mic segment after duplicate holdback", {
          text: pending.text.slice(0, 80),
          holdbackMs: pending.holdbackMs,
          averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
          averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
        });
        pending.emit();
      }
    }

    const schedulePendingMicFinalFlush = () => {
      if (meetingPendingMicFinalTimer) {
        clearTimeout(meetingPendingMicFinalTimer);
        meetingPendingMicFinalTimer = null;
      }

      if (meetingPendingMicFinals.length === 0) {
        return;
      }

      const nextDelay = Math.max(0, meetingPendingMicFinals[0].releaseAt - Date.now());
      meetingPendingMicFinalTimer = setTimeout(() => {
        meetingPendingMicFinalTimer = null;
        flushPendingMicFinals();
      }, nextDelay);
    };

    const resetPendingMicFinals = () => {
      meetingPendingMicFinals = [];
      if (meetingPendingMicFinalTimer) {
        clearTimeout(meetingPendingMicFinalTimer);
        meetingPendingMicFinalTimer = null;
      }
    };

    const removePendingMicFinalsFor = (systemText, systemTimestamp) => {
      const removed = [];
      meetingPendingMicFinals = meetingPendingMicFinals.filter((candidate) => {
        const overlapsSystem = hasNearbyTranscriptMatch(
          "system",
          candidate.text,
          candidate.timestamp,
          {
            extraSegment: {
              text: systemText,
              timestamp: systemTimestamp,
            },
            relaxed: candidate.micSuppression?.reason === "double_talk",
          }
        );
        if (!overlapsSystem) {
          return true;
        }
        removed.push(candidate);
        return false;
      });
      schedulePendingMicFinalFlush();
      return removed;
    };

    const queuePendingMicFinal = ({ text, timestamp, micSuppression, holdbackMs, emit }) => {
      meetingPendingMicFinals.push({
        text,
        timestamp,
        micSuppression,
        holdbackMs,
        releaseAt: Date.now() + holdbackMs,
        emit,
      });
      meetingPendingMicFinals.sort((left, right) => left.releaseAt - right.releaseAt);
      schedulePendingMicFinalFlush();
    };

    const captureMeetingDiarizationState = async () => {
      const diarizationPcmPath = meetingDiarizationPath;
      const diarizationSegments = meetingDiarizationSegments;
      const diarizationStartedAt = meetingDiarizationStartedAt;
      if (meetingDiarizationStream) {
        await new Promise((resolve) => meetingDiarizationStream.end(resolve));
        meetingDiarizationStream = null;
      }
      meetingDiarizationPath = null;
      meetingDiarizationStartedAt = null;
      meetingDiarizationSegments = [];
      return { diarizationPcmPath, diarizationSegments, diarizationStartedAt };
    };

    const getMeetingSystemAudioCapabilityMode = () => {
      if (this.audioTapManager?.isSupported()) return "native";
      if (process.platform === "win32") return "loopback";
      if (process.platform === "linux") return "portal";
      return "unsupported";
    };

    const getMeetingSystemAudioMode = () => getMeetingSystemAudioCapabilityMode();

    const getMeetingSystemAudioPlan = async () => {
      const mode = getMeetingSystemAudioMode();
      if (mode === "unsupported") {
        return { mode, strategy: "unsupported" };
      }

      if (mode === "native") {
        return { mode, strategy: "native" };
      }

      if (mode === "loopback") {
        return { mode, strategy: "loopback" };
      }

      const linuxAccess = await getLinuxSystemAudioAccess();
      return {
        mode,
        strategy: linuxAccess.strategy === "portal-helper" ? "portal-helper" : "browser-portal",
      };
    };

    const hasNativeMeetingSystemAudio = () => getMeetingSystemAudioMode() === "native";

    const MEETING_MIC_REFERENCE_ALIGNMENT_MS = 320;
    const MEETING_STARTUP_WARMUP_MS = 1500;
    const MEETING_MIC_BLEED_RMS_CEILING = 0.018;
    const MEETING_MIC_BLEED_PEAK_CEILING = 0.07;
    let meetingStartedAt = null;
    const meetingEchoLeakDetector = new MeetingEchoLeakDetector();

    const fs = require("fs");
    let meetingDiarizationStream = null;
    let meetingDiarizationPath = null;
    let meetingDiarizationStartedAt = null;
    let meetingDiarizationSegments = [];
    let meetingLiveSpeakerActive = false;
    let meetingLiveSpeakerState = null;
    let meetingLiveSpeakerStartedAt = null;
    let meetingReclusterTimer = null;
    let meetingSpeakerRemapper = (id) => id;

    const createSpeakerRemapper = (maxSpeakers) => {
      const cap = Math.max(1, Math.floor(maxSpeakers) || 1);
      const map = new Map();
      return (internalId) => {
        if (!internalId) return internalId;
        const existing = map.get(internalId);
        if (existing !== undefined) return existing;
        const index = map.size < cap ? map.size : cap - 1;
        const label = `speaker_${index}`;
        map.set(internalId, label);
        return label;
      };
    };

    let meetingLocalMode = false;
    let meetingLocalBuffers = { mic: [], system: [] };
    let meetingLocalTimer = null;
    let meetingLocalWin = null;
    let meetingLocalTranscript = "";
    let meetingGigaamBaseUrl = null;
    let meetingGigaamModel = GIGAAM_TRANSCRIPTION_MODEL;
    let meetingLanguage = null;
    let meetingLocalTranscribing = false;
    let meetingPendingMicChunks = [];
    let meetingPendingMicFinals = [];
    let meetingPendingMicFinalTimer = null;
    let meetingOneOnOneAttendee = null;
    let meetingOneOnOneProfileBound = false;
    let meetingNoteId = null;

    const getLiveSpeakerProfiles = () => {
      const attendees = this._getNoteNonSelfParticipants(meetingNoteId);
      const attendeeEmails = new Set();
      for (const p of attendees) {
        const email = (p.email || "").toLowerCase().trim();
        if (email) attendeeEmails.add(email);
      }
      if (attendeeEmails.size === 0) return [];
      return this.databaseManager
        .getSpeakerProfiles(true)
        .filter((p) => p.email && attendeeEmails.has(p.email.toLowerCase()));
    };
    const shouldSuppressMicTranscriptSegment = (startedAt, endedAt = Date.now()) =>
      meetingEchoLeakDetector.shouldSuppressMicSegment(startedAt, endedAt);

    const resolveOneOnOneAttendeeForNote = (noteId) => {
      if (!noteId) return null;
      try {
        const note = this.databaseManager.getNote(noteId);
        return this._resolveOneOnOneOtherParticipant(note?.participants);
      } catch (_) {
        return null;
      }
    };

    const resolveDiarizationEnabled = () =>
      (this.activeMeetingSpeakerConfig?.enabled ?? this.speakerDiarizationEnabled) !== false;

    const resolveSessionMaxSpeakers = () => {
      const count = this.activeMeetingSpeakerConfig?.expectedCount;
      const total = count ? Math.min(count, MAX_SPEAKER_COUNT) : DEFAULT_EXPECTED_SPEAKER_COUNT;
      return Math.max(1, total - 1);
    };

    const bindOneOnOneAttendeeToSpeaker = (speakerId) => {
      if (!meetingOneOnOneAttendee || meetingOneOnOneProfileBound || !speakerId) return;
      if (!resolveDiarizationEnabled()) return;
      const embedding = liveSpeakerIdentifier.getSpeakerEmbedding(speakerId);
      if (!embedding) return;
      try {
        const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
        const profile = this.databaseManager.upsertSpeakerProfile(
          meetingOneOnOneAttendee.displayName,
          meetingOneOnOneAttendee.email,
          buffer
        );
        liveSpeakerIdentifier.mapSpeaker(
          speakerId,
          profile.id,
          meetingOneOnOneAttendee.displayName,
          null
        );
        meetingOneOnOneProfileBound = true;
      } catch (error) {
        debugLogger.warn(
          "1-on-1 attendee profile binding failed",
          { error: error.message },
          "speaker"
        );
      }
    };

    const dispatchMeetingAudioBuffer = (buffer, source) => {
      if (meetingLocalMode) {
        meetingLocalBuffers[source].push(buffer);
      }
    };

    const flushPendingMeetingMicChunks = (force = false) => {
      if (!meetingPendingMicChunks.length) {
        return;
      }

      const now = Date.now();
      while (meetingPendingMicChunks.length > 0) {
        const next = meetingPendingMicChunks[0];
        if (!force && now - next.queuedAt < MEETING_MIC_REFERENCE_ALIGNMENT_MS) {
          break;
        }

        meetingPendingMicChunks.shift();
        const analysis = meetingEchoLeakDetector.analyzeMicChunk(next.buffer);
        if (next.analysisOnly) {
          continue;
        }
        if (analysis?.shouldMute) {
          if (!meetingLocalMode) {
            dispatchMeetingAudioBuffer(Buffer.alloc(next.buffer.length), "mic");
          }
          continue;
        }

        dispatchMeetingAudioBuffer(next.buffer, "mic");
      }
    };

    const stopLiveSpeakerIdentification = async () => {
      if (!meetingLiveSpeakerActive) {
        return null;
      }

      if (meetingReclusterTimer) {
        clearInterval(meetingReclusterTimer);
        meetingReclusterTimer = null;
      }

      meetingLiveSpeakerActive = false;
      meetingLiveSpeakerState = await liveSpeakerIdentifier.stop();
      return meetingLiveSpeakerState;
    };

    const startLiveSpeakerIdentification = async (win, systemAudioMode) => {
      await stopLiveSpeakerIdentification();

      if (systemAudioMode !== "native" || !liveSpeakerIdentifier.isAvailable()) {
        return false;
      }

      const diarizationEnabled = resolveDiarizationEnabled();
      if (!diarizationEnabled) {
        return false;
      }

      meetingLiveSpeakerState = null;
      meetingLiveSpeakerStartedAt = Date.now();
      meetingSpeakerRemapper = createSpeakerRemapper(resolveSessionMaxSpeakers());
      const started = await liveSpeakerIdentifier.start(
        (identification) => {
          if (!win || win.isDestroyed()) {
            return;
          }

          const publicSpeakerId = meetingSpeakerRemapper(identification.speakerId);
          bindOneOnOneAttendeeToSpeaker(publicSpeakerId);

          const displayName = meetingOneOnOneAttendee
            ? meetingOneOnOneAttendee.displayName
            : identification.displayName;

          const startTime = Math.max(
            meetingLiveSpeakerStartedAt || 0,
            (meetingLiveSpeakerStartedAt || 0) + identification.startTime * 1000
          );
          const endTime = Math.max(
            startTime,
            (meetingLiveSpeakerStartedAt || 0) + identification.endTime * 1000
          );
          const enrichedIdentification = {
            ...identification,
            speakerId: publicSpeakerId,
            displayName,
            startTime,
            endTime,
          };

          win.webContents.send("meeting-speaker-identified", enrichedIdentification);

          for (const seg of meetingDiarizationSegments) {
            if (
              seg.source === "system" &&
              seg.timestamp != null &&
              seg.timestamp >= startTime &&
              seg.timestamp <= endTime &&
              (!seg.speaker || seg.speakerIsPlaceholder)
            ) {
              applyConfirmedSpeaker(seg, {
                speaker: publicSpeakerId,
                speakerName: displayName || seg.speakerName,
                speakerIsPlaceholder: false,
              });
            }
          }
        },
        {
          getSpeakerProfiles: getLiveSpeakerProfiles,
          maxSpeakers: resolveSessionMaxSpeakers(),
          enabled: true,
        }
      );

      if (started) {
        meetingLiveSpeakerActive = true;
        meetingReclusterTimer = setInterval(async () => {
          if (!meetingLiveSpeakerActive || !win || win.isDestroyed()) return;

          const merges = await liveSpeakerIdentifier.recluster();
          if (!merges.length) return;

          const publicMerges = merges.map(({ keep, remove, displayName, similarity }) => ({
            keep: meetingSpeakerRemapper(keep),
            remove: meetingSpeakerRemapper(remove),
            displayName,
            similarity,
          }));
          for (const { keep, remove, displayName } of publicMerges) {
            if (keep === remove) continue;
            for (const seg of meetingDiarizationSegments) {
              if (seg.speaker === remove) {
                seg.speaker = keep;
                if (displayName) seg.speakerName = displayName;
              }
            }
          }

          win.webContents.send("meeting-speakers-merged", publicMerges);
        }, 30_000);
      } else {
        meetingLiveSpeakerStartedAt = null;
      }

      return started;
    };

    const transcribeLocalMeetingChunk = async (source) => {
      const chunks = meetingLocalBuffers[source];
      if (!chunks.length) return;

      const pcm24k = Buffer.concat(chunks);
      meetingLocalBuffers[source] = [];

      const pcm16k = downsample24kTo16k(pcm24k);

      const samples = new Int16Array(pcm16k.buffer, pcm16k.byteOffset, pcm16k.length / 2);
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < samples.length; i++) {
        const n = samples[i] / 0x7fff;
        sumSq += n * n;
        const abs = n < 0 ? -n : n;
        if (abs > peak) peak = abs;
      }
      const rms = Math.sqrt(sumSq / samples.length);
      if (rms < 0.0015 && peak < 0.05) {
        debugLogger.debug("Skipping silent meeting chunk", {
          source,
          rms: rms.toFixed(4),
          peak: peak.toFixed(4),
        });
        return;
      }

      if (
        source === "mic" &&
        rms < MEETING_MIC_BLEED_RMS_CEILING &&
        peak < MEETING_MIC_BLEED_PEAK_CEILING &&
        meetingEchoLeakDetector.isSystemSpeaking(Date.now() - 5000)
      ) {
        debugLogger.debug("Skipping system-dominant mic chunk", {
          source,
          rms: rms.toFixed(4),
          peak: peak.toFixed(4),
        });
        return;
      }

      const wav = pcm16ToWav(pcm16k);

      try {
        const result = await transcribeBufferWithGigaam(
          wav,
          {
            baseUrl: meetingGigaamBaseUrl || process.env.GIGAAM_API_BASE,
            model: meetingGigaamModel,
            fileName: `${source}.wav`,
            contentType: "audio/wav",
            language: meetingLanguage,
          },
          this.gigaamLocalAsrManager
        );

        if (result?.success && result.text?.trim()) {
          const text = result.text.trim();
          const segTimestamp = Date.now();
          let micSuppression = null;
          if (source === "mic") {
            const chunkDurationMs = (pcm24k.length / 2 / 24000) * 1000;
            micSuppression = shouldSuppressMicTranscriptSegment(
              segTimestamp - chunkDurationMs,
              segTimestamp
            );
            debugLogger.debug("Local meeting transcription candidate", {
              source,
              text: text.slice(0, 80),
              suppress: micSuppression.suppress,
              reason: micSuppression.reason,
              hasBleedEvidence: micSuppression.hasBleedEvidence,
              likelyRenderBleed: micSuppression.likelyRenderBleed,
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
            });
            if (micSuppression.suppress) {
              debugLogger.debug("Suppressing contaminated local mic segment", {
                reason: micSuppression.reason,
                averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
                averageResidual: micSuppression.averageResidual?.toFixed(3),
                text: text.slice(0, 80),
              });
              return;
            }

            if (shouldSkipDuplicateMicSegment(text, segTimestamp, micSuppression)) {
              debugLogger.debug("Skipping duplicate local mic segment that matches system audio", {
                text: text.slice(0, 80),
                averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
                averageResidual: micSuppression.averageResidual?.toFixed(3),
              });
              return;
            }
          } else {
            debugLogger.debug("Local meeting transcription candidate", {
              source,
              text: text.slice(0, 80),
            });
          }

          if (source === "system") {
            const pending = removePendingMicFinalsFor(text, segTimestamp);
            if (pending.length > 0) {
              debugLogger.debug(
                "Dropping buffered local mic segments after system transcript arrived",
                {
                  count: pending.length,
                  text: text.slice(0, 80),
                }
              );
            }

            const retracted = removeRacingMicEntriesFor(text, segTimestamp);
            for (const stale of retracted) {
              if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
                meetingLocalWin.webContents.send("meeting-transcription-segment", {
                  text: stale.text,
                  source: "mic",
                  type: "retract",
                  timestamp: stale.timestamp,
                });
              }
            }
          }

          const sendLocalSegment = (channel, payload) => {
            if (channel !== "meeting-transcription-segment") {
              return;
            }

            if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
              meetingLocalWin.webContents.send(channel, payload);
            }
          };

          if (source === "mic" && hasRiskyMicDuplicateProfile(micSuppression)) {
            debugLogger.debug("Buffering risky local mic segment before renderer commit", {
              text: text.slice(0, 80),
              holdbackMs: LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS,
              reason: micSuppression?.reason,
              hasBleedEvidence: micSuppression?.hasBleedEvidence,
            });
            queuePendingMicFinal({
              text,
              timestamp: segTimestamp,
              micSuppression,
              holdbackMs: LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS,
              emit: () =>
                sendMeetingFinalSegment({
                  text,
                  source,
                  timestamp: segTimestamp,
                  micSuppression,
                  send: sendLocalSegment,
                  includeInLocalTranscript: true,
                }),
            });
            return;
          }

          sendMeetingFinalSegment({
            text,
            source,
            timestamp: segTimestamp,
            micSuppression,
            send: sendLocalSegment,
            includeInLocalTranscript: true,
          });
        }
      } catch (error) {
        debugLogger.error("Local meeting transcription chunk failed", {
          source,
          error: error.message,
        });
        if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
          meetingLocalWin.webContents.send("meeting-transcription-error", error.message);
        }
      }
    };

    const transcribeAllLocalBuffers = async () => {
      if (meetingLocalTranscribing) return;
      meetingLocalTranscribing = true;
      try {
        await transcribeLocalMeetingChunk("system");
        await transcribeLocalMeetingChunk("mic");
      } finally {
        meetingLocalTranscribing = false;
      }
    };

    const resetMeetingLocalState = () => {
      if (meetingLocalTimer) {
        clearInterval(meetingLocalTimer);
        meetingLocalTimer = null;
      }
      if (meetingReclusterTimer) {
        clearInterval(meetingReclusterTimer);
        meetingReclusterTimer = null;
      }
      void stopLiveSpeakerIdentification();
      meetingLiveSpeakerState = null;
      meetingLiveSpeakerStartedAt = null;
      meetingOneOnOneAttendee = null;
      meetingOneOnOneProfileBound = false;
      meetingNoteId = null;
      meetingLocalMode = false;
      meetingLocalBuffers = { mic: [], system: [] };
      if (meetingDiarizationStream) {
        meetingDiarizationStream.end();
        meetingDiarizationStream = null;
      }
      if (meetingDiarizationPath) {
        fs.unlink(meetingDiarizationPath, () => {});
        meetingDiarizationPath = null;
      }
      meetingDiarizationStartedAt = null;
      meetingDiarizationSegments = [];
      meetingLocalWin = null;
      meetingLocalTranscript = "";
      meetingGigaamBaseUrl = null;
      meetingGigaamModel = GIGAAM_TRANSCRIPTION_MODEL;
      meetingLanguage = null;
      meetingLocalTranscribing = false;
      meetingPendingMicChunks = [];
      resetPendingMicFinals();
      meetingStartedAt = null;
      meetingEchoLeakDetector.reset();
    };

    let dictationPreviewMode = false;
    let dictationPreviewSessionActive = false;

    const resetDictationPreviewState = ({ preserveSession = false } = {}) => {
      dictationPreviewMode = false;
      if (!preserveSession) {
        dictationPreviewSessionActive = false;
      }
    };

    const rollbackMeetingTranscriptionStart = async () => {
      if (this.audioTapManager) {
        await this.audioTapManager.stop().catch(() => {});
      }
      if (this.linuxPortalAudioManager) {
        await this.linuxPortalAudioManager.stop().catch(() => {});
      }
      await stopLiveSpeakerIdentification().catch(() => {});
      resetMeetingLocalState();
    };

    handle("meeting-transcription-prepare", async (_event, options = {}) => {
      if (meetingTranscriptionStartInProgress) {
        debugLogger.debug("Meeting transcription prepare already in progress, ignoring");
        return { success: false, error: "Operation in progress" };
      }

      if (!ALLOWED_MEETING_PROVIDERS.has(options.provider)) {
        return { success: false, error: `Unsupported provider: ${options.provider}` };
      }

      return { success: true };
    });

    handle("meeting-transcription-cancel", async () => {
      if (meetingLocalTimer) {
        return { success: false, reason: "recording-active" };
      }
      meetingTranscriptionStartInProgress = false;
      return { success: true };
    });

    handle("meeting-transcription-start", async (event, options = {}) => {
      if (meetingTranscriptionStartInProgress) {
        debugLogger.debug("Meeting transcription start already in progress, ignoring");
        return { success: false, error: "Operation in progress" };
      }

      meetingTranscriptionStartInProgress = true;
      meetingStartedAt = Date.now();
      this.meetingDetectionEngine?.setUserRecording(true);
      try {
        const systemAudioPlan = await getMeetingSystemAudioPlan();
        let { mode: systemAudioMode, strategy: systemAudioStrategy } = systemAudioPlan;
        meetingEchoLeakDetector.reset();
        meetingOneOnOneAttendee = resolveOneOnOneAttendeeForNote(options.noteId);
        meetingOneOnOneProfileBound = false;
        meetingNoteId = options.noteId ?? null;

        if (options.provider === "gigaam") {
          meetingLocalMode = true;
          meetingGigaamBaseUrl =
            options.baseUrl ||
            options.remoteTranscriptionUrl ||
            options.gigaamBaseUrl ||
            process.env.GIGAAM_API_BASE ||
            null;
          meetingGigaamModel = options.model || GIGAAM_TRANSCRIPTION_MODEL;
          meetingLanguage = options.language || null;
          meetingLocalWin = BrowserWindow.fromWebContents(event.sender);
          meetingLocalBuffers = { mic: [], system: [] };
          meetingLocalTranscript = "";

          await startLiveSpeakerIdentification(meetingLocalWin, systemAudioMode);

          meetingLocalTimer = setInterval(() => {
            transcribeAllLocalBuffers();
          }, 5000);

          ({ systemAudioMode, systemAudioStrategy } = await startMeetingSystemAudio(
            event,
            systemAudioMode,
            systemAudioStrategy,
            "in local meeting mode"
          ));

          debugLogger.debug("Meeting transcription started in GigaAM mode", {
            provider: "gigaam",
            model: meetingGigaamModel,
            systemAudioMode,
            systemAudioStrategy,
          });

          return {
            success: true,
            systemAudioMode,
            systemAudioStrategy,
            oneOnOneAttendee: meetingOneOnOneAttendee,
          };
        }

        if (!ALLOWED_MEETING_PROVIDERS.has(options.provider)) {
          return { success: false, error: `Unsupported provider: ${options.provider}` };
        }

        return { success: false, error: `Unsupported provider: ${options.provider}` };
      } catch (error) {
        await rollbackMeetingTranscriptionStart();
        this.meetingDetectionEngine?.setUserRecording(false);
        debugLogger.error("Meeting transcription start error", { error: error.message });
        return { success: false, error: error.message };
      } finally {
        meetingTranscriptionStartInProgress = false;
      }
    });

    const sendMeetingAudio = (audioBuffer, source) => {
      const outboundBuffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);

      if (source === "system") {
        const receivedAt = Date.now();
        meetingEchoLeakDetector.recordSystemChunk(outboundBuffer, receivedAt);
        flushPendingMeetingMicChunks();

        if (meetingLiveSpeakerActive) {
          void liveSpeakerIdentifier.feedAudio(outboundBuffer);
        }

        if (!meetingDiarizationStream) {
          const os = require("os");
          meetingDiarizationPath = path.join(os.tmpdir(), `ow-diarize-raw-${Date.now()}.pcm`);
          meetingDiarizationStream = fs.createWriteStream(meetingDiarizationPath);
          meetingDiarizationStartedAt = receivedAt;
        }
        meetingDiarizationStream.write(outboundBuffer);
        dispatchMeetingAudioBuffer(outboundBuffer, "system");
        return;
      }

      if (source === "mic") {
        if (!hasNativeMeetingSystemAudio()) {
          const analysis = meetingEchoLeakDetector.analyzeMicChunk(outboundBuffer);
          if (analysis?.shouldMute) {
            if (!meetingLocalMode) {
              dispatchMeetingAudioBuffer(Buffer.alloc(outboundBuffer.length), "mic");
            }
            return;
          }

          dispatchMeetingAudioBuffer(outboundBuffer, "mic");
          return;
        }

        meetingPendingMicChunks.push({
          buffer: outboundBuffer,
          queuedAt: Date.now(),
        });
        flushPendingMeetingMicChunks();
        return;
      }
    };

    const startNativeMeetingSystemAudio = async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      await this.audioTapManager.start({
        onChunk: (chunk) => {
          sendMeetingAudio(chunk, "system");
        },
        onError: (error) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("meeting-transcription-error", error.message);
          }
        },
      });
    };

    const startLinuxMeetingSystemAudio = async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      await this.linuxPortalAudioManager.start({
        onChunk: (chunk) => {
          sendMeetingAudio(chunk, "system");
        },
        onError: (error) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("meeting-transcription-error", error.message);
          }
        },
        onWarning: (warning) => {
          debugLogger.warn(
            "Linux portal system audio warning",
            { code: warning.code, message: warning.message },
            "meeting"
          );
        },
      });
    };

    const startMeetingSystemAudio = async (
      event,
      systemAudioMode,
      systemAudioStrategy,
      context
    ) => {
      if (systemAudioMode === "native") {
        try {
          await startNativeMeetingSystemAudio(event);
          return { systemAudioMode, systemAudioStrategy };
        } catch (error) {
          debugLogger.warn(
            `Native system audio tap failed ${context}, falling back to mic-only`,
            { error: error.message },
            "meeting"
          );
          await stopLiveSpeakerIdentification().catch(() => {});
          return { systemAudioMode: "unsupported", systemAudioStrategy: "unsupported" };
        }
      }

      if (systemAudioStrategy !== "portal-helper") {
        return { systemAudioMode, systemAudioStrategy };
      }

      try {
        await startLinuxMeetingSystemAudio(event);
        return { systemAudioMode, systemAudioStrategy };
      } catch (error) {
        debugLogger.warn(
          `Linux portal helper failed ${context}, falling back to browser portal`,
          { error: error.message },
          "meeting"
        );
        return { systemAudioMode, systemAudioStrategy: "browser-portal" };
      }
    };

    ipcMain.on("meeting-transcription-send", (_event, audioBuffer, source) => {
      sendMeetingAudio(audioBuffer, source);
    });

    handle("meeting-transcription-stop", async () => {
      this.meetingDetectionEngine?.setUserRecording(false);
      try {
        if (this.audioTapManager) {
          await this.audioTapManager.stop();
        }
        if (this.linuxPortalAudioManager) {
          await this.linuxPortalAudioManager.stop().catch(() => {});
        }

        flushPendingMeetingMicChunks(true);

        const liveSpeakerState = await stopLiveSpeakerIdentification().catch(() => null);

        const diarizationSessionId = `diar-${Date.now()}`;
        const diarizationWin = meetingLocalWin || this.windowManager.controlPanelWindow;

        if (meetingLocalMode) {
          if (meetingLocalTimer) {
            clearInterval(meetingLocalTimer);
            meetingLocalTimer = null;
          }
          try {
            await transcribeAllLocalBuffers();
          } catch (err) {
            debugLogger.error("Local meeting final transcription failed", { error: err.message });
          }
          flushPendingMicFinals(true);
          const { diarizationPcmPath, diarizationSegments, diarizationStartedAt } =
            await captureMeetingDiarizationState();
          const transcript =
            diarizationSegments
              .map((segment) => segment.text)
              .join(" ")
              .trim() || meetingLocalTranscript;
          const sessionSpeakerConfigSnapshot = this.activeMeetingSpeakerConfig;
          const noteIdSnapshot = meetingNoteId;
          this.activeMeetingSpeakerConfig = null;
          resetMeetingLocalState();

          // Fire-and-forget background diarization (or notify skip)
          this._startOrSkipDiarization(
            diarizationSessionId,
            diarizationPcmPath,
            diarizationStartedAt,
            diarizationSegments,
            diarizationWin,
            liveSpeakerState,
            sessionSpeakerConfigSnapshot,
            noteIdSnapshot
          );

          return { success: true, transcript, diarizationSessionId };
        }

        const { diarizationPcmPath, diarizationSegments, diarizationStartedAt } =
          await captureMeetingDiarizationState();
        const transcript = diarizationSegments
          .map((segment) => segment.text)
          .join(" ")
          .trim();

        const sessionSpeakerConfigSnapshot = this.activeMeetingSpeakerConfig;
        const noteIdSnapshot = meetingNoteId;
        this.activeMeetingSpeakerConfig = null;

        // Fire-and-forget background diarization (or notify skip)
        this._startOrSkipDiarization(
          diarizationSessionId,
          diarizationPcmPath,
          diarizationStartedAt,
          diarizationSegments,
          diarizationWin,
          liveSpeakerState,
          sessionSpeakerConfigSnapshot,
          noteIdSnapshot
        );

        return { success: true, transcript, diarizationSessionId };
      } catch (error) {
        debugLogger.error("Meeting transcription stop error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    handle("dismiss-dictation-preview", async () => {
      resetDictationPreviewState();
      this.windowManager.hideTranscriptionPreview();
      return { success: true };
    });

    handle("complete-dictation-preview", async (_event, { text } = {}) => {
      if (!dictationPreviewSessionActive) {
        return { success: true };
      }
      if (typeof text === "string" && text.trim()) {
        this.windowManager.completeTranscriptionPreview(text);
      } else {
        resetDictationPreviewState();
        this.windowManager.hideTranscriptionPreview();
      }
      return { success: true };
    });

    handle("hide-dictation-preview", async () => {
      resetDictationPreviewState();
      this.windowManager.hideTranscriptionPreview();
      return { success: true };
    });

    handle("resize-transcription-preview-window", async (_event, width, height) => {
      if (!dictationPreviewSessionActive) {
        return { success: false, error: "Preview session not active" };
      }
      return this.windowManager.resizeTranscriptionPreview(width, height);
    });

    handle("stop-dictation-preview", async (_event, options = {}) => {
      if (!dictationPreviewMode && !dictationPreviewSessionActive) {
        return { success: true };
      }
      resetDictationPreviewState({ preserveSession: true });
      if (!dictationPreviewSessionActive) {
        return { success: true };
      }
      this.windowManager.holdTranscriptionPreview(options);
      return { success: true };
    });

    handle("update-transcription-text", async (_event, id, text, rawText) => {
      try {
        this.databaseManager.updateTranscriptionText(id, text, rawText);
        const updated = this.databaseManager.getTranscriptionById(id);
        return { success: true, transcription: updated };
      } catch (error) {
        debugLogger.error(
          "Failed to update transcription text",
          { id, error: error.message },
          "audio-storage"
        );
        return { success: false, error: error.message };
      }
    });

    handle("acquire-recording-lock", async (_event, pipeline) => {
      if (this._activeRecordingPipeline && this._activeRecordingPipeline !== pipeline) {
        return { success: false, holder: this._activeRecordingPipeline };
      }
      this._activeRecordingPipeline = pipeline;
      return { success: true };
    });

    handle("release-recording-lock", async (_event, pipeline) => {
      if (this._activeRecordingPipeline === pipeline) {
        this._activeRecordingPipeline = null;
      }
      return { success: true };
    });

    handle("search-contacts", async (_event, query) => {
      try {
        const contacts = this.databaseManager.searchContacts(query);
        return { success: true, contacts };
      } catch (error) {
        return { success: false, contacts: [] };
      }
    });

    handle("upsert-contact", async (_event, contact) => {
      try {
        this.databaseManager.upsertContacts([contact]);
        return { success: true };
      } catch (error) {
        return { success: false };
      }
    });

    handle("meeting-detection-get-preferences", async () => {
      try {
        return { success: true, preferences: this.meetingDetectionEngine.getPreferences() };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("meeting-detection-set-preferences", async (_event, prefs) => {
      try {
        this.meetingDetectionEngine.setPreferences(prefs);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    const NOTIFICATION_PREF_KEYS = new Set([
      "notificationsEnabled",
      "notifyMeetingDetection",
      "notifyUpdates",
    ]);

    handle("sync-notification-preferences", async (_event, prefs) => {
      try {
        if (!prefs || typeof prefs !== "object") {
          return { success: false, error: "Invalid preferences" };
        }
        for (const k of NOTIFICATION_PREF_KEYS) {
          this.windowManager.notificationPrefs[k] = false;
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("meeting-set-speaker-diarization-enabled", async (_event, payload) => {
      try {
        this.speakerDiarizationEnabled = payload?.enabled !== false;
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("speech-vad-get-config", async () => {
      try {
        return { success: true, config: this._getSpeechVadSettings() };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("speech-vad-set-config", async (_event, payload) => {
      try {
        const config = this._setSpeechVadSettings(payload || {});
        return { success: true, config };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("meeting-set-session-speaker-config", async (_event, payload) => {
      try {
        const enabled = payload?.enabled !== false;
        const expectedCount = Math.max(
          1,
          Math.min(
            MAX_SPEAKER_COUNT,
            Number(payload?.expectedCount) || DEFAULT_EXPECTED_SPEAKER_COUNT
          )
        );
        this.activeMeetingSpeakerConfig = { enabled, expectedCount };
        liveSpeakerIdentifier.setEnabled(enabled);
        liveSpeakerIdentifier.setMaxSpeakers(expectedCount);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("meeting-notification-respond", async (_event, detectionId, action) => {
      try {
        await this.meetingDetectionEngine.handleNotificationResponse(detectionId, action);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    handle("get-meeting-notification-data", async () => {
      return this.windowManager?._pendingNotificationData ?? null;
    });

    handle("meeting-notification-ready", async () => {
      this.windowManager?.showNotificationWindow();
    });

    // Note files (markdown mirror) handlers
    handle("note-files-set-enabled", async (_event, enabled, customPath, options) => {
      try {
        this._noteFilesEnabled = !!enabled;
        if (!enabled) return { success: true };
        const basePath = customPath || path.join(app.getPath("userData"), "notes");
        if (options?.skipRebuild) {
          require("./markdownMirror").init(basePath);
        } else {
          this._rebuildMirror(basePath);
        }
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to set note-files enabled",
          { error: error.message },
          "note-files"
        );
        return { success: false, error: error.message };
      }
    });

    handle("note-files-set-path", async (_event, newPath) => {
      try {
        if (!this._noteFilesEnabled) return { success: false, error: "Note files not enabled" };
        this._rebuildMirror(newPath);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to set note-files path", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    handle("note-files-rebuild", async () => {
      try {
        if (!this._noteFilesEnabled) return { success: false, error: "Note files not enabled" };
        this._rebuildMirror();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to rebuild note files", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    handle("note-files-get-default-path", async () => {
      return path.join(app.getPath("userData"), "notes");
    });

    handle("show-note-file", async (_event, noteId) => {
      try {
        const markdownMirror = require("./markdownMirror");
        const filePath = markdownMirror.getNotePath(noteId);
        if (!filePath) return { success: false };
        shell.showItemInFolder(filePath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show note file",
          { noteId, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    handle("show-folder-in-explorer", async (_event, folderName) => {
      try {
        const markdownMirror = require("./markdownMirror");
        const dirPath = markdownMirror.getFolderPath(folderName);
        if (!dirPath) return { success: false };
        await shell.openPath(dirPath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show folder",
          { folderName, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    handle("note-files-pick-folder", async () => {
      try {
        const { dialog } = require("electron");
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        return { canceled: false, path: result.filePaths[0] };
      } catch (error) {
        debugLogger.error("Failed to pick folder", { error: error.message }, "note-files");
        return { canceled: true };
      }
    });

    handle("get-speaker-mappings", async (_event, noteId) => {
      return this.databaseManager.getSpeakerMappings(noteId);
    });

    handle(
      "set-speaker-mapping",
      async (_event, noteId, speakerId, displayName, email, profileId) => {
        const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
        const noteSpeakerEmbedding = embeddings.find((e) => e.speaker_id === speakerId);
        const liveSpeakerEmbedding = liveSpeakerIdentifier.getSpeakerEmbedding(speakerId);
        const speakerEmbeddingBuffer =
          noteSpeakerEmbedding?.embedding ||
          (liveSpeakerEmbedding ? Buffer.from(liveSpeakerEmbedding.buffer) : null);

        let resolvedProfileId = profileId ?? null;
        if (speakerEmbeddingBuffer) {
          const profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email || null,
            speakerEmbeddingBuffer,
            resolvedProfileId
          );
          resolvedProfileId = profile.id;
          this._retroactiveMapping(profile);
        }

        this.databaseManager.setSpeakerMapping(noteId, speakerId, resolvedProfileId, displayName);
        liveSpeakerIdentifier.mapSpeaker(speakerId, resolvedProfileId, displayName, noteId);
        return { success: true, profileId: resolvedProfileId };
      }
    );

    handle("remove-speaker-mapping", async (_event, noteId, speakerId) => {
      this.databaseManager.removeSpeakerMapping(noteId, speakerId);
      return { success: true };
    });

    handle("get-speaker-profiles", async () => {
      return this.databaseManager.getSpeakerProfiles();
    });

    handle("attach-speaker-email", async (_event, profileId, email) => {
      try {
        const profile = this.databaseManager.attachEmailToProfile(profileId, email);
        this._retroactiveMapping(profile);
        return {
          success: true,
          profile: {
            id: profile.id,
            display_name: profile.display_name,
            email: profile.email,
            sample_count: profile.sample_count,
          },
        };
      } catch (error) {
        debugLogger.error(
          "Failed to attach email to speaker profile",
          { error: error.message },
          "speaker"
        );
        return { success: false, error: error.message };
      }
    });

    handle("save-note-speaker-embeddings", async (_event, noteId, embeddingsObj) => {
      const buffers = {};
      for (const [speakerId, arr] of Object.entries(embeddingsObj)) {
        buffers[speakerId] = Buffer.from(new Float32Array(arr).buffer);
      }
      this.databaseManager.saveNoteSpeakerEmbeddings(noteId, buffers);
      this._tryAutoLabelOneOnOne(noteId);
      return { success: true };
    });
  }

  _retroactiveMapping(profile) {
    setImmediate(async () => {
      try {
        const speakerEmbeddings = require("./speakerEmbeddings");
        const noteIds = this.databaseManager.getNotesWithUnmappedSpeakers();

        const profileEmb = new Float32Array(
          profile.embedding.buffer,
          profile.embedding.byteOffset,
          profile.embedding.byteLength / 4
        );

        for (const noteId of noteIds) {
          const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
          const existing = this.databaseManager.getSpeakerMappings(noteId);
          const mappedSpeakers = new Set(existing.map((m) => m.speaker_id));
          for (const emb of embeddings) {
            if (mappedSpeakers.has(emb.speaker_id)) continue;

            const speakerEmb = new Float32Array(
              emb.embedding.buffer,
              emb.embedding.byteOffset,
              emb.embedding.byteLength / 4
            );
            const similarity = speakerEmbeddings.cosineSimilarity(profileEmb, speakerEmb);

            if (similarity > 0.6) {
              this.databaseManager.setSpeakerMapping(
                noteId,
                emb.speaker_id,
                profile.id,
                profile.display_name
              );

              const note = this.databaseManager.getNote(noteId);
              if (note?.transcript) {
                try {
                  const segments = JSON.parse(note.transcript);
                  let changed = false;
                  for (const seg of segments) {
                    if (seg.speaker === emb.speaker_id && !seg.speakerName) {
                      if (canAutoRelabelSpeaker(seg)) {
                        applyConfirmedSpeaker(seg, {
                          speakerName: profile.display_name,
                          speakerIsPlaceholder: false,
                        });
                      } else {
                        seg.speakerName = profile.display_name;
                        seg.speakerIsPlaceholder = false;
                      }
                      changed = true;
                    }
                  }
                  if (changed) {
                    this.databaseManager.updateNote(noteId, {
                      transcript: JSON.stringify(segments),
                    });
                  }
                } catch (_) {}
              }
            }
          }
        }
      } catch (err) {
        debugLogger.warn("Retroactive speaker mapping failed", { error: err.message });
      }
    });
  }

  _tryAutoLabelOneOnOne(noteId) {
    setImmediate(async () => {
      try {
        const note = this.databaseManager.getNote(noteId);
        const other = this._resolveOneOnOneOtherParticipant(note?.participants);
        if (!other) return;
        const { displayName, email } = other;

        const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
        if (!embeddings.length) return;

        const existingMappings = this.databaseManager.getSpeakerMappings(noteId);
        const mappedSpeakers = new Set(existingMappings.map((m) => m.speaker_id));

        const transcript = note.transcript ? JSON.parse(note.transcript) : [];
        const systemSpeakers = new Set(
          transcript.filter((s) => s.source !== "mic" && s.speaker).map((s) => s.speaker)
        );

        const unmapped = embeddings.filter(
          (e) => !mappedSpeakers.has(e.speaker_id) && systemSpeakers.has(e.speaker_id)
        );
        if (!unmapped.length) return;

        let profile = null;
        for (const emb of unmapped) {
          profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email,
            emb.embedding,
            profile?.id ?? null
          );
          this.databaseManager.setSpeakerMapping(noteId, emb.speaker_id, profile.id, displayName);
          liveSpeakerIdentifier.mapSpeaker(emb.speaker_id, profile.id, displayName, noteId);
        }

        const unmappedSystemSpeakers = new Set(unmapped.map((e) => e.speaker_id));
        let changed = false;
        for (const seg of transcript) {
          if (!unmappedSystemSpeakers.has(seg.speaker)) continue;
          if (seg.speakerName && !seg.speakerIsPlaceholder) continue;
          if (canAutoRelabelSpeaker(seg)) {
            applyConfirmedSpeaker(seg, { speakerName: displayName, speakerIsPlaceholder: false });
          } else {
            seg.speakerName = displayName;
            seg.speakerIsPlaceholder = false;
          }
          changed = true;
        }

        if (changed) {
          this.databaseManager.updateNote(noteId, { transcript: JSON.stringify(transcript) });
          const updated = this.databaseManager.getNote(noteId);
          if (updated) this.broadcastToWindows("note-updated", updated);
        }

        if (profile) this._retroactiveMapping(profile);

        debugLogger.info(
          "Auto-labeled 1-on-1 meeting speakers",
          { noteId, displayName, speakerCount: unmapped.length },
          "speaker"
        );
      } catch (err) {
        debugLogger.warn("Auto-label 1-on-1 failed", { noteId, error: err.message }, "speaker");
      }
    });
  }

  _applySpeakerName(segments, speakerId, displayName) {
    if (!displayName) {
      return;
    }

    for (const segment of segments) {
      if (segment.speaker !== speakerId) {
        continue;
      }

      applyConfirmedSpeaker(segment, {
        speakerName: displayName,
        speakerIsPlaceholder: false,
        suggestedName: undefined,
        suggestedProfileId: undefined,
      });
    }
  }

  _reconcileLiveSpeakerState(liveSpeakerState, speakerEmbeddingsMap, enrichedSegments) {
    if (!liveSpeakerState || !speakerEmbeddingsMap) {
      return new Set();
    }

    const speakerEmbeddings = require("./speakerEmbeddings");
    const reconciledSpeakers = new Set();
    const usedLiveSpeakers = new Set();
    const noteMappings = new Map();

    const liveEntries = Object.entries(liveSpeakerState)
      .map(([speakerId, data]) => ({
        speakerId,
        displayName: data?.displayName || null,
        profileId: data?.profileId ?? null,
        noteId: data?.noteId ?? null,
        embedding: Array.isArray(data?.embedding) ? new Float32Array(data.embedding) : null,
      }))
      .filter((entry) => entry.embedding);

    const getMappingsForNote = (noteId) => {
      if (!noteMappings.has(noteId)) {
        noteMappings.set(noteId, this.databaseManager.getSpeakerMappings(noteId));
      }
      return noteMappings.get(noteId);
    };

    for (const [mappedId, embeddingArray] of Object.entries(speakerEmbeddingsMap)) {
      let bestEntry = null;
      let bestSimilarity = 0;

      for (const entry of liveEntries) {
        if (usedLiveSpeakers.has(entry.speakerId)) {
          continue;
        }

        const similarity = speakerEmbeddings.cosineSimilarity(
          new Float32Array(embeddingArray),
          entry.embedding
        );
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestEntry = entry;
        }
      }

      if (!bestEntry || bestSimilarity <= 0.6) {
        continue;
      }

      usedLiveSpeakers.add(bestEntry.speakerId);
      reconciledSpeakers.add(mappedId);

      let displayName = bestEntry.displayName;
      let profileId = bestEntry.profileId;

      if (bestEntry.noteId) {
        const liveMapping = getMappingsForNote(bestEntry.noteId).find(
          (mapping) => mapping.speaker_id === bestEntry.speakerId
        );
        if (liveMapping) {
          displayName = liveMapping.display_name || displayName;
          profileId = liveMapping.profile_id ?? profileId;
          this.databaseManager.setSpeakerMapping(
            bestEntry.noteId,
            mappedId,
            profileId,
            displayName
          );
          this.databaseManager.removeSpeakerMapping(bestEntry.noteId, bestEntry.speakerId);
        } else if (displayName) {
          this.databaseManager.setSpeakerMapping(
            bestEntry.noteId,
            mappedId,
            profileId,
            displayName
          );
        }
      }

      this._applySpeakerName(enrichedSegments, mappedId, displayName);
    }

    return reconciledSpeakers;
  }

  _resolveSpeakerExpectation({ sessionConfig, noteId, observedSpeakerIds }) {
    if (sessionConfig?.expectedCount) {
      const total = Math.min(sessionConfig.expectedCount, MAX_SPEAKER_COUNT);
      const numSpeakers = Math.max(1, total - 1);
      return { numSpeakers, cap: numSpeakers };
    }

    let attendees = [];
    if (noteId) {
      try {
        const note = this.databaseManager.getNote(noteId);
        attendees = parseAttendees(note?.participants);
      } catch (_) {
        attendees = [];
      }
    }
    if (attendees.length >= 2) {
      const numSpeakers = Math.min(attendees.length, MAX_SPEAKER_COUNT);
      return { numSpeakers, cap: numSpeakers };
    }

    if (observedSpeakerIds.size >= 2) {
      const numSpeakers = Math.min(observedSpeakerIds.size, MAX_SPEAKER_COUNT);
      return { numSpeakers, cap: numSpeakers };
    }

    return { numSpeakers: -1, cap: DEFAULT_EXPECTED_SPEAKER_COUNT };
  }

  _startOrSkipDiarization(
    sessionId,
    rawPcmPath,
    audioStartedAt,
    transcriptSegments,
    win,
    liveSpeakerState = null,
    sessionConfig = null,
    noteId = null
  ) {
    const send = (payload) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-diarization-complete", { sessionId, ...payload });
      }
    };

    const diarizationEnabled = (sessionConfig?.enabled ?? this.speakerDiarizationEnabled) !== false;

    if (!diarizationEnabled || !this.diarizationManager?.isAvailable() || !rawPcmPath) {
      send({
        segments: transcriptSegments.map((segment, index) => ({
          ...segment,
          id: segment.id || `segment-${index}`,
        })),
      });
      return;
    }

    const fs = require("fs");

    (async () => {
      let tmpWav = null;
      try {
        tmpWav = await this.diarizationManager.convertRawPcmToWav(rawPcmPath, 24000);
        const observedSpeakerIds = new Set(
          transcriptSegments
            .filter((segment) => segment.source === "system" && segment.speaker)
            .map((segment) => segment.speaker)
        );
        for (const speakerId of Object.keys(liveSpeakerState || {})) {
          observedSpeakerIds.add(speakerId);
        }

        if (observedSpeakerIds.size > 10) {
          debugLogger.warn("Excessive speaker count from live identification", {
            observedSpeakers: observedSpeakerIds.size,
          });
        }

        const { numSpeakers, cap } = this._resolveSpeakerExpectation({
          sessionConfig,
          noteId,
          observedSpeakerIds,
        });
        let diarizationSegments = await this.diarizationManager.diarize(
          tmpWav,
          numSpeakers > 0 ? { numSpeakers } : {}
        );
        if (cap != null) {
          diarizationSegments = this.diarizationManager.capSpeakerClusters(
            diarizationSegments,
            cap
          );
        }

        const startMs =
          (Number.isFinite(audioStartedAt) && audioStartedAt) ||
          transcriptSegments.find((segment) => segment.source === "system")?.timestamp ||
          transcriptSegments[0]?.timestamp ||
          0;
        const isEpochMs = startMs > 1e9;
        const normalized = transcriptSegments.map((seg) => ({
          ...seg,
          timestamp:
            seg.timestamp != null
              ? isEpochMs
                ? (seg.timestamp - startMs) / 1000
                : seg.timestamp
              : undefined,
        }));

        const enrichedSegments = this.diarizationManager.mergeWithTranscript(
          normalized,
          diarizationSegments
        );

        const speakerSet = new Set(diarizationSegments.map((d) => d.speaker));
        const speakerRenumber = new Map();
        let sIdx = 0;
        for (const sp of speakerSet) {
          speakerRenumber.set(sp, `speaker_${sIdx}`);
          sIdx++;
        }

        let speakerEmbeddingsMap = null;
        const speakerEmb = require("./speakerEmbeddings");
        try {
          if (speakerEmb.isAvailable() && tmpWav) {
            const speakerIds = [...new Set(diarizationSegments.map((s) => s.speaker))];
            speakerEmbeddingsMap = {};

            for (const spk of speakerIds) {
              const segs = diarizationSegments.filter((s) => s.speaker === spk);
              const sorted = segs.sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 3);
              const embeddings = [];
              for (const seg of sorted) {
                if (seg.end - seg.start < 1.5) continue;
                const emb = await speakerEmb.extractEmbedding(tmpWav, seg.start, seg.end);
                if (emb) embeddings.push(emb);
              }
              if (embeddings.length > 0) {
                const centroid = speakerEmb.computeCentroid(embeddings);
                const mappedId = speakerRenumber.get(spk) || spk;
                speakerEmbeddingsMap[mappedId] = Array.from(centroid);
              }
            }
          }
        } catch (err) {
          debugLogger.debug("Speaker embedding extraction skipped", { error: err.message });
        }

        const reconciledSpeakers = this._reconcileLiveSpeakerState(
          liveSpeakerState,
          speakerEmbeddingsMap,
          enrichedSegments
        );

        if (speakerEmbeddingsMap) {
          try {
            const profiles = this.databaseManager.getSpeakerProfiles(true);

            if (profiles.length > 0) {
              for (const [mappedId, embArr] of Object.entries(speakerEmbeddingsMap)) {
                const alreadyMapped = enrichedSegments.some(
                  (segment) => segment.speaker === mappedId && segment.speakerName
                );
                if (reconciledSpeakers.has(mappedId) || alreadyMapped) {
                  continue;
                }

                const emb = new Float32Array(embArr);
                let bestProfile = null;
                let bestSim = 0;

                for (const profile of profiles) {
                  const profileEmb = new Float32Array(
                    profile.embedding.buffer,
                    profile.embedding.byteOffset,
                    profile.embedding.byteLength / 4
                  );
                  const sim = speakerEmb.cosineSimilarity(emb, profileEmb);
                  if (sim > bestSim) {
                    bestSim = sim;
                    bestProfile = profile;
                  }
                }

                if (bestProfile && bestSim > 0.6) {
                  for (const seg of enrichedSegments) {
                    if (seg.speaker === mappedId) {
                      applyConfirmedSpeaker(seg, {
                        speakerName: bestProfile.display_name,
                        speakerIsPlaceholder: false,
                        suggestedName: undefined,
                        suggestedProfileId: undefined,
                      });
                    }
                  }
                } else if (bestProfile && bestSim > 0.5) {
                  for (const seg of enrichedSegments) {
                    if (seg.speaker === mappedId) {
                      if (isSpeakerLocked(seg)) {
                        continue;
                      }
                      applySuggestedSpeaker(seg, {
                        suggestedName: bestProfile.display_name,
                        suggestedProfileId: bestProfile.id,
                      });
                    }
                  }
                }
              }
            }
          } catch (err) {
            debugLogger.debug("Auto speaker recognition skipped", { error: err.message });
          }
        }

        send({ segments: enrichedSegments, speakerEmbeddings: speakerEmbeddingsMap });
      } catch (err) {
        debugLogger.warn("Background diarization failed", { error: err.message });
        send({ segments: [] });
      } finally {
        try {
          fs.unlinkSync(rawPcmPath);
        } catch (_) {}
        if (tmpWav) {
          try {
            fs.unlinkSync(tmpWav);
          } catch (_) {}
        }
      }
    })();
  }

  deleteTranscriptionInternal(id) {
    this.audioStorageManager.deleteAudio(id);
    const result = this.databaseManager.deleteTranscription(id);
    if (result?.success) {
      setImmediate(() => {
        this.broadcastToWindows("transcription-deleted", { id });
      });
    }
    return result;
  }

  deleteNoteInternal(id) {
    const result = this.databaseManager.deleteNote(id);
    if (result?.success) {
      setImmediate(() => this.broadcastToWindows("note-deleted", { id }));
      this._asyncVectorDelete(id);
      this._asyncMirrorDelete(id);
    }
    return result;
  }

  broadcastToWindows(channel, payload) {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    });
  }
}

module.exports = IPCHandlers;
