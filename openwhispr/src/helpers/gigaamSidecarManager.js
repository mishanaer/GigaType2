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
const BINARY_NAME = "gigatype-sidecar-darwin-arm64";
const STARTUP_TIMEOUT_MS = 30000;
const STARTUP_POLL_INTERVAL_MS = 100;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;

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
    this.logStream = null;
  }

  getBinaryPath() {
    if (process.platform !== "darwin" || process.arch !== "arm64") return null;
    return resolveBinaryPath(BINARY_NAME);
  }

  getFfmpegPath() {
    return resolveBinaryPath("ffmpeg");
  }

  getFfprobePath() {
    return resolveBinaryPath("ffprobe");
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

    const hfHome = path.join(app.getPath("userData"), "model-cache", "huggingface");
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
      GIGATYPE_LOG_LEVEL: process.env.GIGATYPE_LOG_LEVEL || "info",
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

    let stderrBuffer = "";
    let exitCode = null;

    const writeLog = (source, data) => {
      const text = data.toString();
      this.logStream?.write(`[${new Date().toISOString()}] [${source}] ${text}`);
      debugLogger.debug(`GigaAM sidecar ${source}`, { data: text.trim() });
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
      this._closeLogStream();
      sidecarPidFile.clear(SIDECAR_NAME);
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

    if (!this.process) {
      this.ready = false;
      this.port = null;
      this.healthStatus = "stopped";
      this.healthDetail = null;
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
    };
  }

  _emitStatus() {
    this.emit("status", this.getStatus());
  }
}

module.exports = GigaamSidecarManager;
