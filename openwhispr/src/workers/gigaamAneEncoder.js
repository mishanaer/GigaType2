// Client for the macos-gigaam-encoder helper: runs the GigaAM v3 encoder on the
// Apple Neural Engine via CoreML, which is only reachable from a native process.
// The helper is a long-lived child of the ONNX utility process; see
// resources/macos-gigaam-encoder.swift for the framing it speaks.
//
// Requests are serialized — the helper owns one MLModel and one input buffer,
// and processes the stream strictly in order.

const { spawn } = require("child_process");

const HELLO_MAGIC = 0x4745_4e48; // "GENH"
const REQUEST_MAGIC = 0x4745_4e51; // "GENQ"
const RESPONSE_MAGIC = 0x4745_4e52; // "GENR"

const HELLO_HEADER_BYTES = 8;
const RESPONSE_HEADER_BYTES = 24;
const REQUEST_HEADER_BYTES = 16;

// First load on a machine pays a one-time ANE specialization (~40 s on an M1
// Pro), so the ready handshake gets a generous window.
const START_TIMEOUT_MS = 4 * 60 * 1000;
const ENCODE_TIMEOUT_MS = 2 * 60 * 1000;

class GigaamAneEncoder {
  constructor({ helperPath, modelPath, computeUnits = "cpu_ane", log }) {
    this.helperPath = helperPath;
    this.modelPath = modelPath;
    this.computeUnits = computeUnits;
    this.log = log || (() => {});

    this.child = null;
    this.info = null; // hello payload: { encDim, windowFrames, nMels, subsample, … }
    this.nextRequestId = 1;
    this.pending = null; // { id, resolve, reject, timer }
    this.queue = [];
    this.chunks = [];
    this.buffered = 0;
    this.exitError = null;
  }

  get windowFrames() {
    return this.info?.windowFrames ?? 3360;
  }

  isRunning() {
    return !!this.child && !this.exitError;
  }

  start() {
    if (this.child) return this.readyPromise;

    // Resolvers first: the handshake frame must never arrive before there is
    // something to hand it to.
    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`ANE encoder helper did not become ready within ${START_TIMEOUT_MS} ms`));
        this.stop();
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

    this.child = spawn(this.helperPath, [this.modelPath, "--compute-units", this.computeUnits], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.log("info", "gigaam ane helper", { message: text });
    });

    this.child.on("error", (error) =>
      this._fail(new Error(`ANE encoder helper failed to spawn: ${error.message}`))
    );
    this.child.on("exit", (code, signal) => {
      this._fail(new Error(`ANE encoder helper exited (code ${code}, signal ${signal})`));
    });

    return this.readyPromise;
  }

  stop() {
    const child = this.child;
    this.child = null;
    this._fail(new Error("ANE encoder helper stopped"));
    if (child) {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      child.kill("SIGTERM");
      // The helper only blocks in read(2)/CoreML, so SIGTERM is enough; the
      // timer is a belt-and-braces guard against a wedged prediction.
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 2000);
      if (typeof killTimer.unref === "function") killTimer.unref();
    }
  }

  // features: Float32Array, row-major [nMels][numFrames] (features[mel * numFrames + t]).
  // Resolves { data: Float32Array, dim, frames } with data row-major [dim][frames].
  async encode(features, numFrames) {
    if (!this.child) throw this.exitError || new Error("ANE encoder helper is not running");
    if (numFrames < 1) throw new Error("numFrames must be positive");
    if (numFrames > this.windowFrames) {
      throw new Error(
        `chunk of ${numFrames} mel frames exceeds the fixed ANE window of ${this.windowFrames}`
      );
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ features, numFrames, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    if (this.pending || this.queue.length === 0) return;
    if (!this.child) {
      const job = this.queue.shift();
      job.reject(this.exitError || new Error("ANE encoder helper is not running"));
      return;
    }

    const job = this.queue.shift();
    const id = this.nextRequestId++;
    const floats = job.numFrames * (this.info?.nMels ?? 64);

    const header = Buffer.allocUnsafe(REQUEST_HEADER_BYTES);
    header.writeUInt32LE(REQUEST_MAGIC, 0);
    header.writeUInt32LE(id, 4);
    header.writeUInt32LE(job.numFrames, 8);
    header.writeUInt32LE(floats, 12);

    // A timeout leaves the request unanswered mid-stream, so the helper has to
    // go: whatever it writes later would be parsed as the next reply.
    const timer = setTimeout(() => {
      this._crash(new Error(`ANE encoder timed out after ${ENCODE_TIMEOUT_MS} ms`));
    }, ENCODE_TIMEOUT_MS);

    this.pending = { id, resolve: job.resolve, reject: job.reject, timer };
    this.child.stdin.write(header);
    this.child.stdin.write(
      Buffer.from(job.features.buffer, job.features.byteOffset, floats * 4),
      (error) => {
        if (error) this._fail(new Error(`ANE encoder write failed: ${error.message}`));
      }
    );
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
    const frame = merged.subarray(0, byteCount);
    const rest = merged.subarray(byteCount);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return frame;
  }

  _peekU32(offset) {
    if (this.buffered < offset + 4) return null;
    const merged =
      this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    this.chunks = [merged];
    return merged.readUInt32LE(offset);
  }

  _parse() {
    // Loop until the buffer holds less than one complete frame.
    for (;;) {
      const magic = this._peekU32(0);
      if (magic === null) return;

      if (magic === HELLO_MAGIC) {
        const jsonLength = this._peekU32(4);
        if (jsonLength === null) return;
        if (this.buffered < HELLO_HEADER_BYTES + jsonLength) return;
        const frame = this._take(HELLO_HEADER_BYTES + jsonLength);
        let info = {};
        try {
          info = JSON.parse(frame.subarray(HELLO_HEADER_BYTES).toString("utf8"));
        } catch {
          info = {};
        }
        this.info = info;
        this.log("info", "gigaam ane encoder ready", info);
        this._onReady?.(info);
        continue;
      }

      if (magic !== RESPONSE_MAGIC) {
        this._crash(new Error(`ANE encoder sent an unknown frame magic 0x${magic.toString(16)}`));
        return;
      }
      if (this.buffered < RESPONSE_HEADER_BYTES) return;

      const status = this._peekU32(8);
      const dim = this._peekU32(12);
      const frames = this._peekU32(16);
      const messageLength = this._peekU32(20);
      const payloadBytes = status === 0 ? dim * frames * 4 : messageLength;
      if (this.buffered < RESPONSE_HEADER_BYTES + payloadBytes) return;

      const frame = this._take(RESPONSE_HEADER_BYTES + payloadBytes);
      const id = frame.readUInt32LE(4);
      const payload = frame.subarray(RESPONSE_HEADER_BYTES);
      const pending = this.pending;

      if (!pending || pending.id !== id) {
        this._crash(new Error(`ANE encoder replied to unknown request id ${id}`));
        return;
      }
      clearTimeout(pending.timer);
      this.pending = null;

      if (status !== 0) {
        pending.reject(new Error(payload.toString("utf8") || "ANE encoder failed"));
      } else {
        // Copy out of the socket buffer — the underlying chunk is reused.
        const data = new Float32Array(dim * frames);
        Buffer.from(data.buffer).set(payload);
        pending.resolve({ data, dim, frames });
      }
      this._drain();
    }
  }

  // Unrecoverable protocol/timeout failure: tear the helper down so the worker
  // starts a fresh one on the next request instead of talking to a desynced pipe.
  _crash(error) {
    if (!this.exitError) this.exitError = error;
    this.stop();
  }

  _fail(error) {
    if (!this.exitError) this.exitError = error;
    // Always report the first failure — it is the root cause, whereas a later
    // "stopped" is just the teardown it triggered.
    const reason = this.exitError;
    this._onStartFailure?.(reason);
    this._onStartFailure = null;
    this._onReady = null;

    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    const queue = this.queue;
    this.queue = [];
    for (const job of queue) job.reject(reason);
  }
}

module.exports = { GigaamAneEncoder };
