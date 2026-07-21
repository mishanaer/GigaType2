const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, safeStorage } = require("electron");
const debugLogger = require("./debugLogger");
const TractionAnalytics = require("./tractionAnalytics");

const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";
const DEFAULT_POSTHOG_API_KEY = "phc_xQjeveprGamdNM3FRBgwuXefAwXfWgctzMaGfswmReQq";
const FLUSH_INTERVAL_MS = 30 * 1000;
const FLUSH_BATCH_SIZE = 20;
const MAX_QUEUE_EVENTS = 1000;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

const ALLOWED_EVENTS = new Set([
  "first_app_opened",
  "app_opened",
  "permission_granted",
  "requirement_status_changed",
  "all_required_permissions_granted",
  "requirements_ready",
  "model_download_started",
  "model_download_succeeded",
  "model_download_failed",
  "model_ready",
  "settings_screen_viewed",
  "dictation_started",
  "dictation_audio_captured",
  "dictation_transcribed",
  "dictation_output_attempted",
  "dictation_finished",
  "dictation_output_succeeded",
  "error_occurred",
  "main_process_error",
  "renderer_process_gone",
  "app_crashed",
]);

const ALLOWED_PROPERTIES = new Set([
  "event_id",
  "anonymous_user_id",
  "install_id",
  "app_version",
  "app_channel",
  "platform",
  "platform_name",
  "os_version",
  "os_version_major",
  "arch",
  "linux_distro",
  "linux_desktop_session",
  "package_format",
  "session_id",
  "permission_type",
  "requirement",
  "ready",
  "microphone_ready",
  "macos_accessibility_ready",
  "windows_paste_tool_ready",
  "linux_paste_tool_ready",
  "provider",
  "model",
  "source",
  "health_status",
  "model_stage",
  "model_progress",
  "model_cache_complete",
  "activation_mode",
  "trigger",
  "audio_duration_ms",
  "audio_size_bytes",
  "speech_detected",
  "stop_reason",
  "status",
  "transcribed",
  "output_attempted",
  "outcome",
  "target_available",
  "raw_transcript_chars",
  "raw_transcript_words",
  "final_output_chars",
  "final_output_words",
  "output_method",
  "output_status",
  "success",
  "total_latency_ms",
  "transcription_latency_ms",
  "output_latency_ms",
  "error_area",
  "error_code",
  "safe_message",
  "stack_hash",
  "reason",
  "exit_code",
  "is_packaged",
  "node_env",
]);

const STRING_ENUM_PROPERTIES = new Set([
  "event_id",
  "anonymous_user_id",
  "install_id",
  "app_version",
  "app_channel",
  "platform",
  "platform_name",
  "os_version",
  "os_version_major",
  "arch",
  "linux_distro",
  "linux_desktop_session",
  "package_format",
  "session_id",
  "permission_type",
  "requirement",
  "provider",
  "model",
  "source",
  "health_status",
  "model_stage",
  "activation_mode",
  "trigger",
  "stop_reason",
  "status",
  "outcome",
  "output_method",
  "output_status",
  "error_area",
  "error_code",
  "safe_message",
  "stack_hash",
  "reason",
  "node_env",
]);

function normalizeHost(value) {
  const host = String(value || DEFAULT_POSTHOG_HOST)
    .trim()
    .replace(/\/+$/, "");
  if (!/^https:\/\//i.test(host)) return DEFAULT_POSTHOG_HOST;
  return host;
}

function normalizeBoolEnv(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function getPlatformName(platform = process.platform) {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return "Unknown";
}

function getOsVersionMajor(osVersion) {
  const match = String(osVersion || "").match(/\d+(?:\.\d+)?/);
  return match ? match[0] : "unknown";
}

function getLinuxDistro() {
  if (process.platform !== "linux") return undefined;
  try {
    const text = fs.readFileSync("/etc/os-release", "utf8");
    const values = {};
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (!match) continue;
      values[match[1]] = match[2].replace(/^"|"$/g, "");
    }
    return values.ID || values.NAME || undefined;
  } catch {
    return undefined;
  }
}

function getLinuxSessionType() {
  if (process.platform !== "linux") return undefined;
  const session = String(process.env.XDG_SESSION_TYPE || "").toLowerCase();
  if (session === "wayland" || session === "x11") return session;
  return "unknown";
}

function getPackageFormat() {
  if (process.platform !== "linux") return undefined;
  if (process.env.APPIMAGE) return "appimage";
  if (process.env.SNAP) return "snap";
  if (process.env.FLATPAK_ID) return "flatpak";
  return "unknown";
}

function getSafeOsVersion() {
  try {
    if (typeof os.version === "function") {
      return os.version();
    }
  } catch {}
  return os.release();
}

function countWords(value) {
  if (typeof value !== "string") return 0;
  const normalized = value.trim();
  if (!normalized) return 0;
  return normalized.split(/\s+/).filter(Boolean).length;
}

function sanitizeString(value, maxLength = 200) {
  const normalized = String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\/Users\/[^/\s]+(?:\/[^\s]*)?/g, "[path]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s]*)?/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function safeErrorCode(error) {
  const code = error?.code || error?.name;
  if (code)
    return sanitizeString(code, 80)
      .toUpperCase()
      .replace(/[^A-Z0-9_:-]/g, "_");
  return "UNKNOWN";
}

function safeErrorMessage(error) {
  const message = error?.message || String(error || "Unknown error");
  return sanitizeString(message, 180);
}

function stackHash(error) {
  const stack = error?.stack || error?.message || String(error || "");
  return crypto.createHash("sha256").update(stack).digest("hex").slice(0, 16);
}

class TelemetryService {
  constructor() {
    this.initialized = false;
    this.initializing = null;
    this.enabled = false;
    this.disabledReason = "not-initialized";
    this.apiKey = "";
    this.host = DEFAULT_POSTHOG_HOST;
    this.anonymousUserId = null;
    this.installId = null;
    this.state = { installId: null, once: {} };
    this.flushTimer = null;
    this.flushing = false;
    this.platformProperties = null;
  }

  getTelemetryDir() {
    return path.join(app.getPath("userData"), "telemetry");
  }

  getStatePath() {
    return path.join(this.getTelemetryDir(), "state.json");
  }

  getQueuePath() {
    return path.join(this.getTelemetryDir(), "queue.jsonl");
  }

  getEncryptedAnonymousIdPath() {
    return path.join(this.getTelemetryDir(), "anonymous-user-id.enc");
  }

  getPlainAnonymousIdPath() {
    return path.join(this.getTelemetryDir(), "anonymous-user-id");
  }

  async init() {
    if (this.initialized) return this;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      this.apiKey =
        process.env.GIGATYPE_POSTHOG_API_KEY ||
        process.env.POSTHOG_API_KEY ||
        process.env.POSTHOG_PROJECT_TOKEN ||
        DEFAULT_POSTHOG_API_KEY;
      this.host = normalizeHost(process.env.GIGATYPE_POSTHOG_HOST || process.env.POSTHOG_HOST);
      this.enabled = this._resolveEnabled();
      this.disabledReason = this.enabled ? null : this.disabledReason;

      if (!this.enabled) {
        this.initialized = true;
        debugLogger.info(
          "Telemetry initialized",
          {
            enabled: this.enabled,
            disabledReason: this.disabledReason,
            host: this.host,
            hasApiKey: Boolean(this.apiKey),
          },
          "telemetry"
        );
        return this;
      }

      ensureDir(this.getTelemetryDir());
      this.state = readJson(this.getStatePath(), { installId: null, once: {} });
      this.installId = this._ensureInstallId();
      this.anonymousUserId = this._ensureAnonymousUserId();
      this.platformProperties = this._buildPlatformProperties();
      // Продуктовая статистика Traction: дистиллят тех же событий, свой ingest.
      // Живёт за общим гейтом телеметрии (GIGATYPE_TELEMETRY_ENABLED).
      this.traction = new TractionAnalytics({
        deviceId: this.installId,
        queueDir: this.getTelemetryDir(),
      });
      this.traction.start();
      this.initialized = true;

      this._startFlushTimer();
      setImmediate(() => this.flush().catch(() => {}));

      debugLogger.info(
        "Telemetry initialized",
        {
          enabled: this.enabled,
          disabledReason: this.disabledReason,
          host: this.host,
          hasApiKey: Boolean(this.apiKey),
        },
        "telemetry"
      );

      return this;
    })();

    return this.initializing;
  }

  _resolveEnabled() {
    const override = normalizeBoolEnv(process.env.GIGATYPE_TELEMETRY_ENABLED);
    if (override === false) {
      this.disabledReason = "env-disabled";
      return false;
    }
    if (!this.apiKey) {
      this.disabledReason = "missing-api-key";
      return false;
    }
    return true;
  }

  _ensureInstallId() {
    const current = typeof this.state.installId === "string" ? this.state.installId : null;
    if (current) return current;
    const next = crypto.randomUUID();
    this.state.installId = next;
    this._saveState();
    return next;
  }

  _ensureAnonymousUserId() {
    const fallbackId = this._readAnonymousIdFromFallback();
    if (fallbackId) return fallbackId;

    const next = crypto.randomUUID();
    this._writeAnonymousIdToFallback(next);
    return next;
  }

  _readAnonymousIdFromFallback() {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const encrypted = fs.readFileSync(this.getEncryptedAnonymousIdPath());
        const value = safeStorage.decryptString(encrypted);
        if (this._isUuid(value)) return value;
      } catch {}
    }

    try {
      const value = fs.readFileSync(this.getPlainAnonymousIdPath(), "utf8").trim();
      if (this._isUuid(value)) return value;
    } catch {}

    return null;
  }

  _writeAnonymousIdToFallback(value) {
    ensureDir(this.getTelemetryDir());
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const encrypted = safeStorage.encryptString(value);
        fs.writeFileSync(this.getEncryptedAnonymousIdPath(), encrypted, { mode: 0o600 });
        return;
      } catch (error) {
        debugLogger.warn("Telemetry encrypted fallback write failed", {
          error: error?.message,
        });
      }
    }

    fs.writeFileSync(this.getPlainAnonymousIdPath(), value, { mode: 0o600 });
  }

  _isUuid(value) {
    return (
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    );
  }

  _saveState() {
    writeJsonAtomic(this.getStatePath(), this.state);
  }

  _buildPlatformProperties() {
    const platform = process.platform;
    const osVersion = getSafeOsVersion();
    return {
      anonymous_user_id: this.anonymousUserId,
      install_id: this.installId,
      app_version: app.getVersion(),
      app_channel: process.env.APP_CHANNEL || process.env.GIGATYPE_APP_CHANNEL || "unknown",
      platform,
      platform_name: getPlatformName(platform),
      os_version: osVersion,
      os_version_major: getOsVersionMajor(osVersion),
      arch: ["arm64", "x64", "arm", "ia32"].includes(process.arch) ? process.arch : "unknown",
      linux_distro: getLinuxDistro(),
      linux_desktop_session: getLinuxSessionType(),
      package_format: getPackageFormat(),
    };
  }

  async capture(event, properties = {}, options = {}) {
    await this.init();
    if (!ALLOWED_EVENTS.has(event)) return { queued: false, reason: "event-not-allowed" };
    if (!this.enabled) return { queued: false, reason: this.disabledReason };

    const onceKey = options.onceKey || null;
    if (onceKey && this.state.once?.[onceKey]) {
      return { queued: false, reason: "already-sent" };
    }

    const eventId = properties.event_id || crypto.randomUUID();
    const payload = {
      event,
      distinct_id: this.anonymousUserId,
      timestamp: options.timestamp || new Date().toISOString(),
      properties: this._sanitizeProperties({
        ...this.platformProperties,
        ...properties,
        event_id: eventId,
      }),
    };

    this._enqueue(payload);
    this.traction?.record(event, payload.properties);

    if (onceKey) {
      this.state.once = this.state.once || {};
      this.state.once[onceKey] = true;
      this._saveState();
    }

    if (this._queueLength() >= FLUSH_BATCH_SIZE) {
      setImmediate(() => this.flush().catch(() => {}));
    }

    return { queued: true, event_id: eventId };
  }

  captureError(error, errorArea = "unknown", properties = {}) {
    return this.capture("error_occurred", {
      ...properties,
      error_area: errorArea,
      error_code: properties.error_code || safeErrorCode(error),
      safe_message: properties.safe_message || safeErrorMessage(error),
      stack_hash: properties.stack_hash || stackHash(error),
    });
  }

  _sanitizeProperties(properties) {
    const output = {};
    for (const [key, value] of Object.entries(properties || {})) {
      if (!ALLOWED_PROPERTIES.has(key)) continue;
      if (value == null) continue;

      if (typeof value === "boolean") {
        output[key] = value;
      } else if (typeof value === "number") {
        if (Number.isFinite(value)) output[key] = Math.round(value);
      } else if (typeof value === "string") {
        const normalized = sanitizeString(value, STRING_ENUM_PROPERTIES.has(key) ? 200 : 80);
        output[key] =
          key === "error_code"
            ? normalized.toUpperCase().replace(/[^A-Z0-9_:-]/g, "_")
            : normalized;
      }
    }
    return output;
  }

  _enqueue(eventPayload) {
    const line = JSON.stringify({ queued_at: Date.now(), payload: eventPayload });
    fs.appendFileSync(this.getQueuePath(), `${line}\n`, { encoding: "utf8", mode: 0o600 });
    this._trimQueueIfNeeded();
  }

  _queueLength() {
    try {
      const text = fs.readFileSync(this.getQueuePath(), "utf8");
      if (!text.trim()) return 0;
      return text.trim().split(/\r?\n/).length;
    } catch {
      return 0;
    }
  }

  _readQueue() {
    try {
      const text = fs.readFileSync(this.getQueuePath(), "utf8");
      const now = Date.now();
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((item) => item?.payload && now - Number(item.queued_at || now) <= MAX_EVENT_AGE_MS)
        .slice(-MAX_QUEUE_EVENTS);
    } catch {
      return [];
    }
  }

  _writeQueue(items) {
    const queuePath = this.getQueuePath();
    if (!items.length) {
      try {
        fs.unlinkSync(queuePath);
      } catch {}
      return;
    }
    const text = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
    fs.writeFileSync(queuePath, text, { mode: 0o600 });
  }

  _trimQueueIfNeeded() {
    const items = this._readQueue();
    if (items.length > MAX_QUEUE_EVENTS) {
      this._writeQueue(items.slice(-MAX_QUEUE_EVENTS));
    } else if (items.length === 0) {
      this._writeQueue([]);
    }
  }

  _startFlushTimer() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  async flush() {
    await this.init();
    if (!this.enabled || this.flushing) return { sent: 0 };

    const items = this._readQueue();
    if (!items.length) return { sent: 0 };

    const batch = items.slice(0, FLUSH_BATCH_SIZE);
    const remaining = items.slice(batch.length);
    this.flushing = true;

    try {
      await this._sendBatch(batch.map((item) => item.payload));
      this._writeQueue(remaining);
      return { sent: batch.length };
    } catch (error) {
      debugLogger.warn(
        "Telemetry flush failed",
        { error: error?.message, count: batch.length },
        "telemetry"
      );
      return { sent: 0, error: error?.message };
    } finally {
      this.flushing = false;
    }
  }

  async _sendBatch(batch) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.host}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          batch,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`PostHog batch failed: ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async shutdown() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush().catch(() => {});
    await this.traction?.shutdown().catch(() => {});
  }
}

TelemetryService.countWords = countWords;
TelemetryService.safeErrorCode = safeErrorCode;
TelemetryService.safeErrorMessage = safeErrorMessage;
TelemetryService.stackHash = stackHash;

module.exports = TelemetryService;
