const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const { findAvailablePort, resolveBinaryPath } = require("../utils/serverUtils");
const onnxWorkerClient = require("./onnxWorkerClient");
const { downloadFile } = require("./downloadUtils");

// Local GigaAM engine. App-owned requests use Electron IPC so the packaged
// application does not open an inbound TCP listener (and therefore does not
// need a Windows Firewall exception). The legacy loopback HTTP bridge is only
// available as an explicit developer opt-in.

const HOST = "127.0.0.1";
const PORT_RANGE_START = 8765;
const PORT_RANGE_END = 8775;
const MODEL_NAME = "gigaam-v3-e2e-rnnt";
const HF_BASE = "https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/main";
const MODEL_CACHE_REPO_DIR = "models--istupakov--gigaam-v3-onnx";
const ENCODER_FILE = { name: "v3_e2e_rnnt_encoder.onnx", bytes: 885_084_534 };
const DECODER_FILES = [
  { name: "v3_e2e_rnnt_decoder.onnx", bytes: 4_599_910 },
  { name: "v3_e2e_rnnt_joint.onnx", bytes: 2_712_896 },
  { name: "v3_e2e_rnnt_vocab.txt", bytes: 13_354 },
];
const MODEL_FILES = [ENCODER_FILE, ...DECODER_FILES];

// Apple Silicon runs the encoder on the Neural Engine through CoreML instead of
// onnxruntime — same GigaAM v3 weights, converted to an fp16 MLProgram
// (github.com/IsaacClarke2/gigaam-v3-coreml). The 885 MB ONNX encoder is then
// neither bundled nor downloaded; only the 7 MB RNN-T decoder/joint/vocab are.
const ANE_MODEL_DIR_NAME = "gigaam-ane";
const ANE_MODEL_NAME = "encoder-ane.mlmodelc";
const ANE_HELPER_BINARY = "macos-gigaam-encoder";
const MODEL_LOAD_TIMEOUT_MS = 5 * 60 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REQUEST_BYTES = 512 * 1024 * 1024;
const STATUS_EMIT_THROTTLE_MS = 500;
const TARGET_SAMPLE_RATE = 16000;
// GigaAM's direct inference path is intended for short utterances. Large
// tensors can terminate the native ONNX utility process well before the
// encoder's absolute ~200 second positional limit, so keep each request at a
// conservative 25 seconds and combine the results in the HTTP layer.
const MAX_TRANSCRIPTION_CHUNK_SECONDS = 25;
const MAX_TRANSCRIPTION_CHUNK_SAMPLES = TARGET_SAMPLE_RATE * MAX_TRANSCRIPTION_CHUNK_SECONDS;
const LOOPBACK_CORS_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;
const BUILT_IN_API_BASE = "type-local://gigaam/v1";

function getPcmChunkRanges(sampleCount, maxChunkSamples = MAX_TRANSCRIPTION_CHUNK_SAMPLES) {
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new TypeError("sampleCount must be a non-negative integer");
  }
  if (!Number.isInteger(maxChunkSamples) || maxChunkSamples <= 0) {
    throw new TypeError("maxChunkSamples must be a positive integer");
  }

  const ranges = [];
  for (let start = 0; start < sampleCount; start += maxChunkSamples) {
    ranges.push({ start, end: Math.min(start + maxChunkSamples, sampleCount) });
  }
  return ranges;
}

function getExactPcmBuffer(pcm, start, end) {
  if (
    start === 0 &&
    end === pcm.length &&
    pcm.byteOffset === 0 &&
    pcm.buffer.byteLength === pcm.byteLength
  ) {
    return pcm.buffer;
  }

  // A subarray keeps the original backing buffer. Sending subarray.buffer
  // would therefore send the entire long recording to ONNX again.
  return pcm.slice(start, end).buffer;
}

function getTranscriptWords(text) {
  return Array.from(text.matchAll(/\S+/g), (match) => ({
    raw: match[0],
    normalized: match[0]
      .toLocaleLowerCase("ru-RU")
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""),
    end: match.index + match[0].length,
  }));
}

function findDuplicateSeamWordCount(previousText, nextText) {
  const previousWords = getTranscriptWords(previousText);
  const nextWords = getTranscriptWords(nextText);
  if (previousWords.length === 0 || nextWords.length === 0) return 0;

  const previousWord = previousWords.at(-1);
  const nextWord = nextWords[0];
  if (
    !previousWord.normalized ||
    previousWord.normalized !== nextWord.normalized ||
    previousWord.normalized.length < 5 ||
    /[.!?…]["'”’»\p{Pe}\p{Pf}]*$/u.test(previousWord.raw) ||
    !/^[\p{L}\p{N}]/u.test(nextWord.raw) ||
    !/[\p{L}\p{N}]$/u.test(nextWord.raw)
  ) {
    return 0;
  }

  const previousInitial = previousWord.raw.match(/\p{L}/u)?.[0];
  const nextInitial = nextWord.raw.match(/\p{L}/u)?.[0];
  const previousStartsLowercase =
    previousInitial &&
    previousInitial === previousInitial.toLocaleLowerCase("ru-RU") &&
    previousInitial !== previousInitial.toLocaleUpperCase("ru-RU");
  const nextStartsUppercase =
    nextInitial &&
    nextInitial === nextInitial.toLocaleUpperCase("ru-RU") &&
    nextInitial !== nextInitial.toLocaleLowerCase("ru-RU");

  return previousStartsLowercase && nextStartsUppercase ? 1 : 0;
}

function mergeTranscriptChunk(previousText, nextText) {
  const previous = typeof previousText === "string" ? previousText.trim() : "";
  const next = typeof nextText === "string" ? nextText.trim() : "";
  if (!previous) return next;
  if (!next) return previous;

  const duplicateWords = findDuplicateSeamWordCount(previous, next);
  if (duplicateWords === 0) return `${previous} ${next}`;

  const nextWords = getTranscriptWords(next);
  const remainder = next.slice(nextWords[duplicateWords - 1].end).trimStart();
  return remainder ? `${previous} ${remainder}` : previous;
}

async function transcribePcmInChunks(
  pcm,
  requestChunk,
  { maxChunkSamples = MAX_TRANSCRIPTION_CHUNK_SAMPLES } = {}
) {
  if (!(pcm instanceof Float32Array)) {
    throw new TypeError("pcm must be a Float32Array");
  }
  if (typeof requestChunk !== "function") {
    throw new TypeError("requestChunk must be a function");
  }

  const ranges = getPcmChunkRanges(pcm.length, maxChunkSamples);
  if (ranges.length === 0) return { text: "", chunksTotal: 0 };

  let text = "";
  let previousChunkHadText = false;
  for (let index = 0; index < ranges.length; index++) {
    const { start, end } = ranges[index];
    const pcmBuffer = getExactPcmBuffer(pcm, start, end);
    const result = await requestChunk(pcmBuffer, {
      chunkIndex: index + 1,
      chunksTotal: ranges.length,
      samples: end - start,
      startSample: start,
      endSample: end,
    });
    const chunkText = typeof result?.text === "string" ? result.text.trim() : "";
    if (!chunkText) {
      previousChunkHadText = false;
      continue;
    }

    text = previousChunkHadText
      ? mergeTranscriptChunk(text, chunkText)
      : [text, chunkText].filter(Boolean).join(" ");
    previousChunkHadText = true;
  }

  return { text, chunksTotal: ranges.length };
}

function applyLoopbackCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !LOOPBACK_CORS_ORIGIN_PATTERN.test(origin)) return false;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
  return true;
}

function findBundledOnnxEncoder(resourcesPath) {
  if (!resourcesPath) return null;
  const encoderPath = path.join(resourcesPath, "gigaam-model", ENCODER_FILE.name);
  return fs.existsSync(encoderPath) ? encoderPath : null;
}

function shouldPreferBundledModel(
  platform = process.platform,
  isPackaged = Boolean(app?.isPackaged)
) {
  return platform === "win32" && isPackaged;
}

class GigaamLocalAsrManager extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.port = null;
    this.ready = false;
    this.healthStatus = "stopped";
    this.healthDetail = null;
    this.startupPromise = null;
    this.modelDownloadedBytes = 0;
    this.aneUnavailableReason = null; // set when a packaged arm64 build lacks the CoreML encoder
    this.aneEncoder = this._resolveAneEncoder();
    this.encoderRuntime = null; // set from the worker's gigaam.load reply
    this.modelTotalBytes = this._requiredModelFiles().reduce((sum, f) => sum + f.bytes, 0);
    this.modelProgress = 0;
    this.modelStage = "stopped";
    this._lastProgressEmit = 0;
    this.httpBridgeEnabled = process.env.GIGAAM_HTTP_BRIDGE === "1";
    // Set from the worker's gigaam.load reply: the ANE window is fixed at
    // 33.6 s, wider than the conservative ONNX chunk.
    this.maxChunkSamples = MAX_TRANSCRIPTION_CHUNK_SAMPLES;
  }

  // CoreML encoder config for the ONNX worker, or null when this build/platform
  // uses the ONNX encoder. Apple Silicon only: the ANE is what makes it worth
  // the fixed-window trade-off, and the converted model needs macOS 14+.
  _resolveAneEncoder() {
    if (process.platform !== "darwin" || process.arch !== "arm64") return null;
    if (process.env.GIGAAM_DISABLE_ANE === "1") {
      debugLogger.info("GigaAM ANE encoder disabled via GIGAAM_DISABLE_ANE");
      return null;
    }

    const candidates = [];
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, ANE_MODEL_DIR_NAME, ANE_MODEL_NAME));
    }
    candidates.push(
      path.join(__dirname, "..", "..", "resources", ANE_MODEL_DIR_NAME, ANE_MODEL_NAME)
    );

    const modelPath = candidates.find((candidate) =>
      fs.existsSync(path.join(candidate, "model.mil"))
    );
    const helperPath = modelPath ? resolveBinaryPath(ANE_HELPER_BINARY) : null;

    if (!modelPath || !helperPath) {
      const missing = !modelPath ? `${ANE_MODEL_DIR_NAME}/${ANE_MODEL_NAME}` : ANE_HELPER_BINARY;
      const bundledOnnxEncoder = findBundledOnnxEncoder(process.resourcesPath);
      const hasBundledOnnxFallback = Boolean(bundledOnnxEncoder);

      // Normal arm64 releases contain the CoreML encoder only, so a missing ANE
      // resource is fatal there. Explicit ONNX builds keep the bundled encoder
      // and can safely use it as the packaged fallback (for example, when
      // shipping model weights that do not have a matching CoreML conversion).
      if (app?.isPackaged && !hasBundledOnnxFallback) {
        this.aneUnavailableReason = `Apple Silicon build is missing its CoreML encoder (${missing})`;
        debugLogger.error("GigaAM ANE encoder unavailable in packaged build", { missing });
      } else {
        debugLogger.warn("GigaAM ANE encoder unavailable — using the ONNX encoder", {
          missing,
          encoderPath: hasBundledOnnxFallback ? bundledOnnxEncoder : undefined,
          hint: hasBundledOnnxFallback ? undefined : "npm run download:gigaam-ane",
        });
      }
      return null;
    }

    return {
      helperPath,
      modelPath,
      computeUnits: process.env.GIGAAM_ANE_COMPUTE_UNITS || "cpu_ane",
    };
  }

  // The ANE build has no ONNX encoder to bundle or download.
  _requiredModelFiles() {
    return this.aneEncoder ? DECODER_FILES : MODEL_FILES;
  }

  // The local engine ships with the app on every platform.
  isAvailable() {
    return true;
  }

  getHfHome() {
    return path.join(app.getPath("userData"), "model-cache", "huggingface");
  }

  // Snapshot dir of the legacy Python-sidecar HuggingFace cache, so existing
  // installs don't re-download ~890 MB after updating.
  _findLegacySnapshotDir() {
    const snapshotsDir = path.join(this.getHfHome(), "hub", MODEL_CACHE_REPO_DIR, "snapshots");
    let entries = [];
    try {
      entries = fs.readdirSync(snapshotsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(snapshotsDir, entry.name);
      if (this._requiredModelFiles().every((f) => fs.existsSync(path.join(dir, f.name)))) {
        return dir;
      }
    }
    return null;
  }

  getModelDir() {
    return path.join(app.getPath("userData"), "model-cache", "gigaam", MODEL_NAME);
  }

  // Model files shipped inside the app bundle (electron-builder extraResources
  // → Contents/Resources/gigaam-model/), so a fresh install transcribes
  // offline without the ~851 MB first-run download. Returns null when running
  // unpackaged (dev) or when the bundle omits the model.
  _getBundledModelDir() {
    if (!process.resourcesPath) return null;
    const dir = path.join(process.resourcesPath, "gigaam-model");
    if (this._requiredModelFiles().every((f) => fs.existsSync(path.join(dir, f.name)))) {
      return dir;
    }
    return null;
  }

  // Directory containing all model files, or null when not downloaded yet.
  _resolveModelBaseDir() {
    const bundled = this._getBundledModelDir();
    // The Windows installer carries the pinned bilingual model specifically so
    // it is the default on both clean installs and upgrades with a legacy cache.
    if (bundled && shouldPreferBundledModel()) return bundled;

    const legacy = this._findLegacySnapshotDir();
    if (legacy) return legacy;
    const dir = this.getModelDir();
    if (this._requiredModelFiles().every((f) => fs.existsSync(path.join(dir, f.name)))) {
      return dir;
    }
    if (bundled) return bundled;
    return null;
  }

  _isModelCacheComplete() {
    return this._resolveModelBaseDir() !== null;
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

  async start() {
    if (this.startupPromise) return this.startupPromise;
    if (this.ready) return;

    this.startupPromise = this._doStart();
    try {
      await this.startupPromise;
    } catch (error) {
      this.ready = false;
      this.healthStatus = "error";
      this.healthDetail = error.message;
      this.modelStage = "error";
      this._emitStatus();
      throw error;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart() {
    if (this.server) await this.stop();

    this.port = null;
    this.healthStatus = "loading";
    this.healthDetail = "starting local ASR";
    this.modelStage = "checking";
    this.modelProgress = 0;
    this._emitStatus();

    if (this.httpBridgeEnabled) {
      this.port = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);
      await this._startServer();
      debugLogger.warn("GigaAM developer HTTP bridge enabled", {
        port: this.port,
        apiBaseUrl: this.getApiBaseUrl(),
      });
    }

    try {
      if (this.aneUnavailableReason) throw new Error(this.aneUnavailableReason);
      const baseDir = await this._ensureModelFiles();

      this.modelStage = "loading";
      this.modelProgress = 99;
      this.modelDownloadedBytes = this.modelTotalBytes;
      this.healthDetail = "loading model";
      this._emitStatus();

      const loadResult = await onnxWorkerClient.request(
        "gigaam.load",
        {
          encoderPath: this.aneEncoder ? null : path.join(baseDir, ENCODER_FILE.name),
          decoderPath: path.join(baseDir, "v3_e2e_rnnt_decoder.onnx"),
          joinerPath: path.join(baseDir, "v3_e2e_rnnt_joint.onnx"),
          vocabPath: path.join(baseDir, "v3_e2e_rnnt_vocab.txt"),
          aneEncoder: this.aneEncoder,
        },
        [],
        { timeoutMs: MODEL_LOAD_TIMEOUT_MS }
      );

      // The CoreML encoder always pays for its full fixed window, so chunking
      // shorter than the window would only add seams and cost extra passes.
      this.maxChunkSamples = Number.isInteger(loadResult?.maxChunkSamples)
        ? loadResult.maxChunkSamples
        : MAX_TRANSCRIPTION_CHUNK_SAMPLES;
      this.encoderRuntime = loadResult?.encoder || "onnx";

      this.ready = true;
      this.healthStatus = "ok";
      this.healthDetail = null;
      this.modelStage = "ready";
      this.modelProgress = 100;
      this._emitStatus();
      debugLogger.info("GigaAM local ASR ready", {
        transport: this.httpBridgeEnabled ? "loopback-http" : "electron-ipc",
        port: this.port,
        modelDir: baseDir,
        encoderRuntime: this.encoderRuntime,
        encoderModel: this.aneEncoder?.modelPath || path.join(baseDir, ENCODER_FILE.name),
        maxChunkSeconds: this.maxChunkSamples / TARGET_SAMPLE_RATE,
        aneInfo: loadResult?.aneInfo || null,
      });
    } catch (error) {
      debugLogger.error("GigaAM local ASR startup failed", { error: error.message });
      this.ready = false;
      this.healthStatus = "error";
      this.healthDetail = error.message;
      this.modelStage = "error";
      this._emitStatus();
      // Keep the server up: /health reports the error state.
    }
  }

  async _ensureModelFiles() {
    const existing = this._resolveModelBaseDir();
    if (existing) {
      debugLogger.info("GigaAM model found on disk", { dir: existing });
      return existing;
    }

    const dir = this.getModelDir();
    fs.mkdirSync(dir, { recursive: true });

    this.modelStage = "downloading";
    this._emitStatus();

    let completedBytes = 0;
    for (const file of this._requiredModelFiles()) {
      const dest = path.join(dir, file.name);
      if (fs.existsSync(dest)) {
        completedBytes += file.bytes;
        continue;
      }
      debugLogger.info("Downloading GigaAM model file", { file: file.name });
      await downloadFile(`${HF_BASE}/${file.name}`, dest, {
        expectedSize: file.bytes,
        onProgress: (downloaded) => {
          this.modelDownloadedBytes = Math.min(completedBytes + downloaded, this.modelTotalBytes);
          this.modelProgress = Math.min(
            99,
            Math.floor((this.modelDownloadedBytes / this.modelTotalBytes) * 100)
          );
          this._emitStatusThrottled();
        },
      });
      completedBytes += file.bytes;
    }

    this.modelDownloadedBytes = this.modelTotalBytes;
    return dir;
  }

  _startServer() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handleRequest(req, res).catch((error) => {
          debugLogger.error("GigaAM local ASR request failed", { error: error.message });
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify({ error: { message: error.message } }));
        });
      });
      server.on("error", reject);
      server.listen(this.port, HOST, () => {
        server.removeListener("error", reject);
        this.server = server;
        resolve();
      });
    });
  }

  async _handleRequest(req, res) {
    const url = req.url || "/";
    const corsAllowed = applyLoopbackCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(corsAllowed ? 204 : 403);
      res.end();
      return;
    }

    if (req.method === "GET" && url.startsWith("/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: this.healthStatus,
          ...(this.healthDetail ? { detail: this.healthDetail } : {}),
          model: MODEL_NAME,
        })
      );
      return;
    }

    if (req.method === "POST" && /\/audio\/(transcriptions|translations)\/?$/.test(url)) {
      if (this.healthStatus !== "ok") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `model not ready (${this.healthStatus}: ${this.healthDetail || ""})`,
            },
          })
        );
        return;
      }

      const body = await this._readBody(req);
      const contentType = req.headers["content-type"] || "";
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
      if (!boundaryMatch) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "missing multipart boundary" } }));
        return;
      }

      const { file } = parseMultipart(body, boundaryMatch[1] || boundaryMatch[2]);
      if (!file || file.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "missing audio file field" } }));
        return;
      }

      const pcm = await this._decodeToPcm(file);
      const { text } = await this._transcribePcm(pcm);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }

  async _transcribePcm(pcm) {
    const startedAt = Date.now();
    const options = { maxChunkSamples: this.maxChunkSamples };
    const result = await transcribePcmInChunks(
      pcm,
      async (pcmBuffer, chunk) => {
        debugLogger.info("GigaAM chunk transcription starting", {
          chunkIndex: chunk.chunkIndex,
          chunksTotal: chunk.chunksTotal,
          durationSeconds: chunk.samples / TARGET_SAMPLE_RATE,
        });

        // MessagePortMain transfer lists only accept MessagePorts, so the exact
        // chunk buffer is structured-cloned into the ONNX utility process.
        const response = await this._requestGigaamChunk(pcmBuffer);

        debugLogger.info("GigaAM chunk transcription completed", {
          chunkIndex: chunk.chunkIndex,
          chunksTotal: chunk.chunksTotal,
          textLength: typeof response?.text === "string" ? response.text.length : 0,
        });
        return response;
      },
      options
    );

    debugLogger.info("GigaAM transcription chunks combined", {
      chunksTotal: result.chunksTotal,
      textLength: result.text.length,
      totalMs: Date.now() - startedAt,
    });
    return result;
  }

  async transcribeAudioBuffer(audioBuffer) {
    if (!this.ready || this.healthStatus !== "ok") {
      throw new Error(
        `GigaAM model not ready (${this.healthStatus}: ${this.healthDetail || "initializing"})`
      );
    }
    const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
    if (buffer.length > MAX_REQUEST_BYTES) {
      throw new Error("audio payload is too large");
    }
    const pcm = await this._decodeToPcm(buffer);
    return this._transcribePcm(pcm);
  }

  _requestGigaamChunk(pcmBuffer) {
    return onnxWorkerClient.request("gigaam.transcribe", { pcmBuffer }, [], {
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    });
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_REQUEST_BYTES) {
          reject(new Error("request too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  // Decode arbitrary audio bytes to 16 kHz mono Float32. WAV/PCM is handled
  // natively (the dictation path always sends 16 kHz mono s16 WAV); anything
  // else falls back to ffmpeg when available.
  async _decodeToPcm(buffer) {
    const wav = tryDecodeWav(buffer);
    if (wav) return wav;
    return this._decodeWithFfmpeg(buffer);
  }

  _decodeWithFfmpeg(buffer) {
    const ffmpegPath = this.getFfmpegPath();
    if (!ffmpegPath) {
      throw new Error("unsupported audio format and ffmpeg is not available");
    }
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        String(TARGET_SAMPLE_RATE),
        "pipe:1",
      ]);
      const out = [];
      let stderr = "";
      proc.stdout.on("data", (chunk) => out.push(chunk));
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg decode failed (${code}): ${stderr.slice(0, 200)}`));
          return;
        }
        const data = Buffer.concat(out);
        resolve(new Float32Array(data.buffer, data.byteOffset, Math.floor(data.length / 4)));
      });
      proc.stdin.on("error", () => {});
      proc.stdin.end(buffer);
    });
  }

  async stop() {
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      await onnxWorkerClient.request("gigaam.unload", {});
    } catch {
      // Worker may be down already; unload is best-effort.
    }
    this.ready = false;
    this.port = null;
    this.healthStatus = "stopped";
    this.healthDetail = null;
    this.modelStage = "stopped";
    this.modelProgress = 0;
    this.modelDownloadedBytes = 0;
    this._emitStatus();
  }

  getApiBaseUrl() {
    return this.port ? `http://${HOST}:${this.port}/v1` : BUILT_IN_API_BASE;
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready,
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
      encoderRuntime: this.encoderRuntime || (this.aneEncoder ? "ane" : "onnx"),
    };
  }

  _emitStatus() {
    this._lastProgressEmit = Date.now();
    this.emit("status", this.getStatus());
  }

  _emitStatusThrottled() {
    if (Date.now() - this._lastProgressEmit >= STATUS_EMIT_THROTTLE_MS) {
      this._emitStatus();
    }
  }
}

// Minimal multipart/form-data parser for the known clients (renderer FormData
// and main-process retry): returns the first file part plus text fields.
function parseMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  let file = null;

  let index = body.indexOf(delimiter);
  while (index !== -1) {
    const partStart = index + delimiter.length;
    // Closing delimiter is "--boundary--".
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break;

    const next = body.indexOf(delimiter, partStart);
    if (next === -1) break;

    // Part = \r\n headers \r\n\r\n content \r\n
    const headerEnd = body.indexOf("\r\n\r\n", partStart);
    if (headerEnd === -1 || headerEnd >= next) {
      index = next;
      continue;
    }

    const headers = body.toString("utf-8", partStart, headerEnd);
    const content = body.subarray(headerEnd + 4, next - 2); // strip trailing \r\n
    const nameMatch = headers.match(/\bname="([^"]*)"/i);
    const isFile = /\bfilename="/i.test(headers);

    if (isFile && !file) {
      file = content;
    } else if (nameMatch) {
      fields[nameMatch[1]] = content.toString("utf-8");
    }

    index = next;
  }

  return { fields, file };
}

// Decode a RIFF/WAVE buffer to 16 kHz mono Float32, or null when the buffer
// isn't a WAV/PCM format this parser understands.
function tryDecodeWav(buffer) {
  if (buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkEnd = Math.min(offset + 8 + chunkSize, buffer.length);
    if (chunkId === "fmt ") {
      fmt = {
        format: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      };
    } else if (chunkId === "data") {
      data = buffer.subarray(offset + 8, chunkEnd);
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (!fmt || !data || !fmt.channels || !fmt.sampleRate) return null;

  const { format, channels, sampleRate, bitsPerSample } = fmt;
  const frameBytes = (bitsPerSample / 8) * channels;
  const frames = Math.floor(data.length / frameBytes);
  if (frames === 0) return new Float32Array(0);

  let mono;
  if (format === 1 && bitsPerSample === 16) {
    mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let ch = 0; ch < channels; ch++) {
        sum += data.readInt16LE(i * frameBytes + ch * 2);
      }
      mono[i] = sum / channels / 32768;
    }
  } else if (format === 3 && bitsPerSample === 32) {
    mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let ch = 0; ch < channels; ch++) {
        sum += data.readFloatLE(i * frameBytes + ch * 4);
      }
      mono[i] = sum / channels;
    }
  } else {
    return null; // unusual encodings go through ffmpeg
  }

  if (sampleRate === TARGET_SAMPLE_RATE) return mono;

  // Linear resample (same approach as the renderer's encodeWAVFromChunks).
  const ratio = sampleRate / TARGET_SAMPLE_RATE;
  const outLength = Math.floor(mono.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, mono.length - 1);
    const frac = pos - left;
    out[i] = mono[left] * (1 - frac) + mono[right] * frac;
  }
  return out;
}

module.exports = GigaamLocalAsrManager;
module.exports._testing = {
  MAX_TRANSCRIPTION_CHUNK_SECONDS,
  MAX_TRANSCRIPTION_CHUNK_SAMPLES,
  findDuplicateSeamWordCount,
  findBundledOnnxEncoder,
  getPcmChunkRanges,
  mergeTranscriptChunk,
  shouldPreferBundledModel,
  transcribePcmInChunks,
};
