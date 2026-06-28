const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { EventEmitter } = require("events");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const {
  findAvailablePort,
  resolveBinaryPath,
  gracefulStopProcess,
} = require("../utils/serverUtils");
const sidecarPidFile = require("./sidecarPidFile");

const SIDECAR_NAME = "gigaam";
const HOST = "127.0.0.1";
const PORT_RANGE_START = 8765;
const PORT_RANGE_END = 8775;
const MODEL_NAME = "gigaam-v3-e2e-rnnt";
const MODEL_CACHE_REPO_DIR = "models--istupakov--gigaam-v3-onnx";
const MODEL_TOTAL_BYTES = 892_410_829;
const MODEL_REQUIRED_FILES = [
  "config.json",
  "v3_e2e_rnnt_encoder.onnx",
  "v3_e2e_rnnt_decoder.onnx",
  "v3_e2e_rnnt_joint.onnx",
  "v3_e2e_rnnt_vocab.txt",
];
const BINARY_NAMES = {
  arm64: "gigatype-sidecar-darwin-arm64",
  x64: "gigatype-sidecar-darwin-x64",
};
const STARTUP_TIMEOUT_MS = 30000;
const STARTUP_POLL_INTERVAL_MS = 100;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const MODEL_PROGRESS_INTERVAL_MS = 1000;

class GigaamSidecarManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.port = null;
    this.ready = false;
    this.healthStatus = "stopped";
    this.healthDetail = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.modelProgressInterval = null;
    this.logStream = null;
    this.modelDownloadedBytes = 0;
    this.modelTotalBytes = MODEL_TOTAL_BYTES;
    this.modelProgress = 0;
    this.modelStage = "stopped";
  }

  getBinaryPath() {
    if (process.platform !== "darwin") return null;
    const binaryName = BINARY_NAMES[process.arch];
    if (!binaryName) return null;
    return resolveBinaryPath(binaryName);
  }

  getFfmpegPath() {
    const fromBin = resolveBinaryPath("ffmpeg");
    if (fromBin) return fromBin;
    if (process.resourcesPath) {
      const unpacked = path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "ffmpeg-static",
        "ffmpeg"
      );
      if (fs.existsSync(unpacked)) return unpacked;
    }
    return null;
  }

  getFfprobePath() {
    const fromBin = resolveBinaryPath("ffprobe");
    if (fromBin) return fromBin;
    if (process.resourcesPath) {
      const platform = `${process.platform}-${process.arch}`;
      const unpacked = path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        `@ffprobe-installer`,
        platform,
        "ffprobe"
      );
      if (fs.existsSync(unpacked)) return unpacked;
    }
    return null;
  }

  getHfHome() {
    return path.join(app.getPath("userData"), "model-cache", "huggingface");
  }

  getModelCacheDir() {
    return path.join(this.getHfHome(), "hub", MODEL_CACHE_REPO_DIR);
  }

  _sumRegularFileBytes(rootDir) {
    let total = 0;

    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        try {
          total += fs.statSync(entryPath).size;
        } catch {
          // Ignore files that are being moved by HuggingFace while we poll.
        }
      }
    };

    walk(rootDir);
    return total;
  }

  _isModelCacheComplete() {
    const snapshotsDir = path.join(this.getModelCacheDir(), "snapshots");
    let snapshots = [];
    try {
      snapshots = fs.readdirSync(snapshotsDir, { withFileTypes: true });
    } catch {
      return false;
    }

    return snapshots.some((entry) => {
      if (!entry.isDirectory()) return false;
      const snapshotDir = path.join(snapshotsDir, entry.name);
      return MODEL_REQUIRED_FILES.every((fileName) => fs.existsSync(path.join(snapshotDir, fileName)));
    });
  }

  _updateModelProgress(stageOverride = null) {
    const downloadedBytes = Math.min(
      this._sumRegularFileBytes(this.getModelCacheDir()),
      MODEL_TOTAL_BYTES
    );
    const cacheComplete = this._isModelCacheComplete();
    const modelReady = this.healthStatus === "ok";

    this.modelDownloadedBytes = modelReady ? MODEL_TOTAL_BYTES : downloadedBytes;
    this.modelTotalBytes = MODEL_TOTAL_BYTES;

    if (modelReady) {
      this.modelProgress = 100;
      this.modelStage = "ready";
    } else if (stageOverride) {
      this.modelStage = stageOverride;
      this.modelProgress = Math.min(99, Math.floor((downloadedBytes / MODEL_TOTAL_BYTES) * 100));
    } else if (this.healthStatus === "error") {
      this.modelStage = "error";
      this.modelProgress = Math.min(99, Math.floor((downloadedBytes / MODEL_TOTAL_BYTES) * 100));
    } else if (cacheComplete) {
      this.modelStage = "loading";
      this.modelProgress = 99;
    } else if (downloadedBytes > 0) {
      this.modelStage = "downloading";
      this.modelProgress = Math.min(99, Math.floor((downloadedBytes / MODEL_TOTAL_BYTES) * 100));
    } else if (this.process) {
      this.modelStage = "checking";
      this.modelProgress = 0;
    } else {
      this.modelStage = "stopped";
      this.modelProgress = 0;
    }

    this._emitStatus();
  }

  _startModelProgressPolling() {
    this._stopModelProgressPolling();
    this._updateModelProgress();
    this.modelProgressInterval = setInterval(() => {
      this._updateModelProgress();
      if (this.modelStage === "ready" || this.modelStage === "error" || this.modelStage === "stopped") {
        this._stopModelProgressPolling();
      }
    }, MODEL_PROGRESS_INTERVAL_MS);
  }

  _stopModelProgressPolling() {
    if (this.modelProgressInterval) {
      clearInterval(this.modelProgressInterval);
      this.modelProgressInterval = null;
    }
  }

  isAvailable() {
    return Boolean(this.getBinaryPath());
  }

  async start() {
    if (this.startupPromise) return this.startupPromise;
    if (this.ready && this.process) return;
    if (this.process) await this.stop();

    this.startupPromise = this._doStart();
    try {
      await this.startupPromise;
    } catch (error) {
      this.ready = false;
      this.healthStatus = "error";
      this.healthDetail = error.message;
      this._updateModelProgress("error");
      this._stopModelProgressPolling();
      this._emitStatus();
      throw error;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart() {
    const binaryPath = this.getBinaryPath();
    if (!binaryPath) throw new Error("GigaAM sidecar binary not found");

    const ffmpegPath = this.getFfmpegPath();
    const ffprobePath = this.getFfprobePath();
    if (!ffmpegPath) throw new Error("Bundled ffmpeg not found");
    if (!ffprobePath) throw new Error("Bundled ffprobe not found");

    this.port = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);
    this.healthStatus = "starting";
    this.healthDetail = null;
    this._emitStatus();

    const hfHome = this.getHfHome();
    fs.mkdirSync(hfHome, { recursive: true });

    const logsDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, "gigaam-sidecar.log");
    this.logStream = fs.createWriteStream(logPath, { flags: "a" });

    const env = {
      ...process.env,
      GIGATYPE_HOST: HOST,
      GIGATYPE_PORT: String(this.port),
      GIGATYPE_MODEL: MODEL_NAME,
      GIGAAM_MODEL: MODEL_NAME,
      GIGATYPE_LOG_LEVEL: process.env.GIGATYPE_LOG_LEVEL || "debug",
      FFMPEG_BIN: ffmpegPath,
      FFPROBE_BIN: ffprobePath,
      HF_HOME: hfHome,
    };

    debugLogger.info("Starting GigaAM sidecar", {
      binaryPath,
      port: this.port,
      apiBaseUrl: this.getApiBaseUrl(),
      ffmpegPath,
      ffprobePath,
      hfHome,
      logPath,
    });

    this.process = spawn(binaryPath, [], {
      cwd: path.dirname(binaryPath),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      env,
    });
    sidecarPidFile.write(SIDECAR_NAME, this.process.pid);
    this._startModelProgressPolling();

    let stderrBuffer = "";
    let exitCode = null;

    const writeLog = (source, data) => {
      const text = data.toString();
      this.logStream?.write(`[${new Date().toISOString()}] [${source}] ${text}`);
      debugLogger.debug(`GigaAM sidecar ${source}`, { data: text.trim() });
      if (text.includes("model load ok")) {
        this.healthStatus = "ok";
        this._updateModelProgress("ready");
      } else if (text.includes("model load start")) {
        this._updateModelProgress("checking");
      } else if (text.includes("Fetching") || text.includes("download")) {
        this._updateModelProgress("downloading");
      }
    };

    this.process.stdout.on("data", (data) => writeLog("stdout", data));
    this.process.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
      writeLog("stderr", data);
    });

    this.process.on("error", (error) => {
      debugLogger.error("GigaAM sidecar process error", { error: error.message });
      this.ready = false;
      this.healthStatus = "error";
      this.healthDetail = error.message;
      this._emitStatus();
    });

    this.process.on("close", (code) => {
      exitCode = code;
      debugLogger.info("GigaAM sidecar process exited", { code });
      this.ready = false;
      this.healthStatus = "stopped";
      this.healthDetail = null;
      this.process = null;
      this.port = null;
      this._stopHealthCheck();
      this._stopModelProgressPolling();
      this._closeLogStream();
      sidecarPidFile.clear(SIDECAR_NAME);
      this._updateModelProgress("stopped");
      this._emitStatus();
    });

    await this._waitForResponsive(() => ({ stderr: stderrBuffer, exitCode }));
    this._startHealthCheck();

    debugLogger.info("GigaAM sidecar started", {
      port: this.port,
      apiBaseUrl: this.getApiBaseUrl(),
      healthStatus: this.healthStatus,
    });
  }

  async _waitForResponsive(getProcessInfo) {
    const started = Date.now();
    let pollCount = 0;

    while (Date.now() - started < STARTUP_TIMEOUT_MS) {
      if (!this.process || this.process.killed) {
        const info = getProcessInfo ? getProcessInfo() : {};
        const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
        const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
        throw new Error(`GigaAM sidecar died during startup${details ? `: ${details}` : ""}`);
      }

      pollCount += 1;
      const health = await this._fetchHealth();
      if (health.ok) {
        this.ready = true;
        this.healthStatus = health.status || "unknown";
        this.healthDetail = health.detail || null;
        this._updateModelProgress();
        this._emitStatus();
        debugLogger.debug("GigaAM sidecar responsive", {
          startupTimeMs: Date.now() - started,
          pollCount,
          healthStatus: this.healthStatus,
        });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
    }

    throw new Error(`GigaAM sidecar failed to start within ${STARTUP_TIMEOUT_MS}ms`);
  }

  _fetchHealth() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: HOST,
          port: this.port,
          path: "/health",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            try {
              const payload = JSON.parse(body || "{}");
              resolve({
                ok: res.statusCode >= 200 && res.statusCode < 500,
                status: payload.status,
                detail: payload.detail,
              });
            } catch {
              resolve({ ok: res.statusCode >= 200 && res.statusCode < 500 });
            }
          });
        }
      );

      req.on("error", () => resolve({ ok: false }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false });
      });
      req.end();
    });
  }

  _startHealthCheck() {
    this._stopHealthCheck();
    this.healthCheckInterval = setInterval(async () => {
      if (!this.process) {
        this._stopHealthCheck();
        return;
      }

      const health = await this._fetchHealth();
      if (!health.ok) {
        debugLogger.warn("GigaAM sidecar health check failed");
        this.ready = false;
        this._emitStatus();
        return;
      }

      const previousStatus = this.healthStatus;
      const previousDetail = this.healthDetail;
      const wasReady = this.ready;
      this.ready = true;
      this.healthStatus = health.status || "unknown";
      this.healthDetail = health.detail || null;
      this._updateModelProgress();
      if (
        previousStatus !== this.healthStatus ||
        previousDetail !== this.healthDetail ||
        wasReady !== this.ready
      ) {
        this._emitStatus();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  _stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  _closeLogStream() {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  async stop() {
    this._stopHealthCheck();
    this._stopModelProgressPolling();

    if (!this.process) {
      this.ready = false;
      this.port = null;
      this.healthStatus = "stopped";
      this.healthDetail = null;
      this._updateModelProgress("stopped");
      this._closeLogStream();
      sidecarPidFile.clear(SIDECAR_NAME);
      this._emitStatus();
      return;
    }

    debugLogger.info("Stopping GigaAM sidecar", { pid: this.process.pid, port: this.port });

    try {
      await gracefulStopProcess(this.process);
    } catch (error) {
      debugLogger.error("Error stopping GigaAM sidecar", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.healthStatus = "stopped";
    this.healthDetail = null;
    this._updateModelProgress("stopped");
    this._closeLogStream();
    sidecarPidFile.clear(SIDECAR_NAME);
    this._emitStatus();
  }

  getApiBaseUrl() {
    return this.port ? `http://${HOST}:${this.port}/v1` : null;
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
      apiBaseUrl: this.getApiBaseUrl(),
      healthStatus: this.healthStatus,
      healthDetail: this.healthDetail,
      modelName: MODEL_NAME,
      modelStage: this.modelStage,
      modelProgress: this.modelProgress,
      modelDownloadedBytes: this.modelDownloadedBytes,
      modelTotalBytes: this.modelTotalBytes,
      modelCacheComplete: this._isModelCacheComplete(),
    };
  }

  _emitStatus() {
    this.emit("status", this.getStatus());
  }
}

module.exports = GigaamSidecarManager;
