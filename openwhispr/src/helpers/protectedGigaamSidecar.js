const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { resolveBinaryPath } = require("../utils/serverUtils");

const MODEL_FILE = "gigaam-en-ru.memento-model";
const REQUIRED_MARKER = "required.json";
const START_TIMEOUT_MS = 5 * 60 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

function protectedModelDir(resourcesPath = process.resourcesPath) {
  return resourcesPath ? path.join(resourcesPath, "protected-gigaam") : null;
}

function resolveProtectedGigaamConfig({
  resourcesPath = process.resourcesPath,
  env = process.env,
  helperPath = resolveBinaryPath("type-protected-gigaam"),
} = {}) {
  const override = env.TYPE_PROTECTED_GIGAAM_MODEL;
  const dir = protectedModelDir(resourcesPath);
  const modelPath = override || (dir ? path.join(dir, MODEL_FILE) : null);
  const required =
    Boolean(override) ||
    env.TYPE_PROTECTED_GIGAAM_REQUIRED === "1" ||
    Boolean(dir && fs.existsSync(path.join(dir, REQUIRED_MARKER)));
  const available = Boolean(modelPath && helperPath && fs.existsSync(modelPath));
  return { available, required, modelPath, helperPath };
}

class ProtectedGigaamSidecar {
  constructor({ helperPath, modelPath, helperArgs, log }) {
    this.helperPath = helperPath;
    this.modelPath = modelPath;
    this.helperArgs = helperArgs || ["--model", modelPath];
    this.log = log || (() => {});
    this.child = null;
    this.readyInfo = null;
    this.pending = null;
    this.queue = [];
    this.chunks = [];
    this.buffered = 0;
    this.exitError = null;
  }

  isRunning() {
    return Boolean(this.child && !this.exitError);
  }

  start() {
    if (this.child) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._crash(new Error("protected GigaAM did not become ready in time"));
      }, START_TIMEOUT_MS);
      this._onReady = (info) => {
        clearTimeout(timer);
        resolve(info);
      };
      this._onStartFailure = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });

    this.child = spawn(this.helperPath, this.helperArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RUST_LOG: process.env.RUST_LOG || "info" },
    });
    this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.child.stdin.on("error", (error) => {
      this._crash(new Error(`protected GigaAM stdin failed: ${error.message}`));
    });
    this.child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.log("info", "protected GigaAM sidecar", { message });
    });
    this.child.once("error", (error) =>
      this._crash(new Error(`protected GigaAM failed to spawn: ${error.message}`))
    );
    this.child.once("exit", (code, signal) => {
      this.child = null;
      this._fail(new Error(`protected GigaAM exited (code ${code}, signal ${signal})`));
    });
    return this.readyPromise;
  }

  transcribe(pcmBuffer) {
    if (!this.child) throw this.exitError || new Error("protected GigaAM is not running");
    const bytes = Buffer.from(pcmBuffer);
    if (bytes.length === 0 || bytes.length % 4 !== 0) {
      throw new Error("protected GigaAM requires non-empty f32 PCM");
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ bytes, resolve, reject });
      this._drain();
    });
  }

  stop() {
    const child = this.child;
    this.child = null;
    this._fail(new Error("protected GigaAM stopped"));
    if (!child) return;
    try {
      const header = Buffer.alloc(4);
      child.stdin.end(header);
    } catch {}
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 2000);
    if (typeof timer.unref === "function") timer.unref();
  }

  _drain() {
    if (this.pending || this.queue.length === 0 || !this.readyInfo) return;
    if (!this.child) {
      const job = this.queue.shift();
      job.reject(this.exitError || new Error("protected GigaAM is not running"));
      return;
    }
    const job = this.queue.shift();
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(job.bytes.length, 0);
    const timer = setTimeout(() => {
      this._crash(new Error("protected GigaAM transcription timed out"));
    }, TRANSCRIBE_TIMEOUT_MS);
    this.pending = { resolve: job.resolve, reject: job.reject, timer };
    this.child.stdin.write(header);
    this.child.stdin.write(job.bytes, (error) => {
      if (error) this._crash(new Error(`protected GigaAM write failed: ${error.message}`));
    });
  }

  _onStdout(chunk) {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this._parse();
  }

  _take(byteCount) {
    if (this.buffered < byteCount) return null;
    const merged =
      this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    const frame = Buffer.from(merged.subarray(0, byteCount));
    const rest = merged.subarray(byteCount);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return frame;
  }

  _peekLength() {
    if (this.buffered < 4) return null;
    const merged =
      this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    this.chunks = [merged];
    return merged.readUInt32LE(0);
  }

  _parse() {
    for (;;) {
      const length = this._peekLength();
      if (length === null) return;
      if (length === 0 || length > MAX_REPLY_BYTES) {
        this._crash(new Error(`protected GigaAM sent invalid frame length ${length}`));
        return;
      }
      if (this.buffered < 4 + length) return;
      const frame = this._take(4 + length);
      let reply;
      try {
        reply = JSON.parse(frame.subarray(4).toString("utf8"));
      } catch (error) {
        this._crash(new Error(`protected GigaAM sent invalid JSON: ${error.message}`));
        return;
      }

      if (!this.readyInfo) {
        if (reply.type !== "ready") {
          this._crash(new Error(reply.message || "protected GigaAM rejected activation"));
          return;
        }
        this.readyInfo = reply;
        this._onReady?.(reply);
        this._onReady = null;
        this._onStartFailure = null;
        this._drain();
        continue;
      }

      const pending = this.pending;
      if (!pending) {
        this._crash(new Error("protected GigaAM replied without a pending request"));
        return;
      }
      clearTimeout(pending.timer);
      this.pending = null;
      if (reply.type === "transcript") {
        pending.resolve({ text: typeof reply.text === "string" ? reply.text : "" });
      } else {
        pending.reject(new Error(reply.message || "protected GigaAM inference failed"));
      }
      this._drain();
    }
  }

  _crash(error) {
    if (!this.exitError) this.exitError = error;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    this._fail(this.exitError);
  }

  _fail(error) {
    if (!this.exitError) this.exitError = error;
    const reason = this.exitError;
    this._onStartFailure?.(reason);
    this._onStartFailure = null;
    this._onReady = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(reason);
      this.pending = null;
    }
    for (const job of this.queue.splice(0)) job.reject(reason);
  }
}

module.exports = {
  MODEL_FILE,
  ProtectedGigaamSidecar,
  protectedModelDir,
  resolveProtectedGigaamConfig,
};
