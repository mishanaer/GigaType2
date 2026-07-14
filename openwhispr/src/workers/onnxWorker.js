const fs = require("fs");
const os = require("os");
const path = require("path");

let logStream = null;

function openLog() {
  const logPath = process.env.OPENWHISPR_ONNX_WORKER_LOG;
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logStream = fs.createWriteStream(logPath, { flags: "a" });
  } catch {
    logStream = null;
  }
}

openLog();

const FBANK_SAMPLE_RATE = 16000;
const FBANK_FRAME_LENGTH_MS = 25;
const FBANK_FRAME_SHIFT_MS = 10;
const FBANK_NUM_MELS = 80;
const FBANK_FRAME_LENGTH = Math.round((FBANK_SAMPLE_RATE * FBANK_FRAME_LENGTH_MS) / 1000);
const FBANK_FRAME_SHIFT = Math.round((FBANK_SAMPLE_RATE * FBANK_FRAME_SHIFT_MS) / 1000);
const FBANK_FFT_SIZE = 512;

const SPEAKER_MAX_SAMPLES = FBANK_SAMPLE_RATE * 8;

const TEXT_EMBED_MAX_TOKENS = 256;
const TEXT_EMBED_DIM = 384;

const intraOpNumThreads = Math.min(4, Math.max(2, Math.floor((os.cpus()?.length || 4) / 2)));

let port = null;
let ort = null;
let speakerSession = null;
let speakerInputName = null;
let textSession = null;
let textTokenizer = null;

function log(level, message, extra) {
  if (!logStream) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    pid: process.pid,
    message,
    ...(extra || {}),
  });
  try {
    logStream.write(line + "\n");
  } catch {
    // Best-effort logging; never throw from log path.
  }
}

function loadOrt() {
  if (ort) return;
  ort = require("onnxruntime-node");
  log("info", "ort loaded");
}

const SESSION_OPTIONS = { intraOpNumThreads, executionMode: "sequential" };

let _melFilterbank = null;
function getMelFilterbank() {
  if (_melFilterbank) return _melFilterbank;

  const numBins = FBANK_FFT_SIZE / 2 + 1;
  const lowFreq = 20;
  const highFreq = FBANK_SAMPLE_RATE / 2;
  const melLow = 1127 * Math.log(1 + lowFreq / 700);
  const melHigh = 1127 * Math.log(1 + highFreq / 700);

  const melPoints = new Float64Array(FBANK_NUM_MELS + 2);
  for (let i = 0; i < melPoints.length; i++) {
    const mel = melLow + ((melHigh - melLow) * i) / (FBANK_NUM_MELS + 1);
    melPoints[i] = 700 * (Math.exp(mel / 1127) - 1);
  }

  const binPoints = new Float64Array(melPoints.length);
  for (let i = 0; i < melPoints.length; i++) {
    binPoints[i] = Math.floor(((FBANK_FFT_SIZE + 1) * melPoints[i]) / FBANK_SAMPLE_RATE);
  }

  _melFilterbank = new Array(FBANK_NUM_MELS);
  for (let m = 0; m < FBANK_NUM_MELS; m++) {
    const filter = new Float32Array(numBins);
    const left = binPoints[m];
    const center = binPoints[m + 1];
    const right = binPoints[m + 2];
    for (let k = 0; k < numBins; k++) {
      if (k >= left && k <= center && center > left) {
        filter[k] = (k - left) / (center - left);
      } else if (k > center && k <= right && right > center) {
        filter[k] = (right - k) / (right - center);
      }
    }
    _melFilterbank[m] = filter;
  }

  return _melFilterbank;
}

function realFFT(frame) {
  const n = FBANK_FFT_SIZE;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < frame.length && i < n; i++) re[i] = frame[i];

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const tmpRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = tmpRe;
      }
    }
  }

  const numBins = n / 2 + 1;
  const powerSpectrum = new Float32Array(numBins);
  for (let i = 0; i < numBins; i++) {
    powerSpectrum[i] = re[i] * re[i] + im[i] * im[i];
  }
  return powerSpectrum;
}

function computeFbank(samples) {
  const numFrames = Math.max(
    0,
    Math.floor((samples.length - FBANK_FRAME_LENGTH) / FBANK_FRAME_SHIFT) + 1
  );
  if (numFrames === 0) return null;

  const hamming = new Float32Array(FBANK_FRAME_LENGTH);
  for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
    hamming[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FBANK_FRAME_LENGTH - 1));
  }

  const melBank = getMelFilterbank();
  const features = new Float32Array(numFrames * FBANK_NUM_MELS);

  for (let f = 0; f < numFrames; f++) {
    const start = f * FBANK_FRAME_SHIFT;
    const frame = new Float32Array(FBANK_FRAME_LENGTH);
    for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
      frame[i] = (samples[start + i] || 0) * hamming[i];
    }
    const power = realFFT(frame);
    for (let m = 0; m < FBANK_NUM_MELS; m++) {
      let energy = 0;
      const filter = melBank[m];
      for (let k = 0; k < power.length; k++) {
        energy += filter[k] * power[k];
      }
      features[f * FBANK_NUM_MELS + m] = Math.log(Math.max(energy, 1e-10));
    }
  }

  return { features, numFrames };
}

async function speakerLoad({ modelPath }) {
  if (speakerSession) return { ok: true };
  loadOrt();
  speakerSession = await ort.InferenceSession.create(modelPath, SESSION_OPTIONS);
  speakerInputName = speakerSession.inputNames[0];
  log("info", "speaker session loaded", { modelPath });
  return { ok: true };
}

async function speakerExtract({ samplesBuffer }) {
  if (!speakerSession) throw new Error("speaker session not loaded");

  const allSamples = new Float32Array(samplesBuffer);
  const samples =
    allSamples.length > SPEAKER_MAX_SAMPLES
      ? allSamples.subarray(allSamples.length - SPEAKER_MAX_SAMPLES)
      : allSamples;

  const fbank = computeFbank(samples);
  if (!fbank) return { embeddingBuffer: null };

  const feeds = {
    [speakerInputName]: new ort.Tensor("float32", fbank.features, [
      1,
      fbank.numFrames,
      FBANK_NUM_MELS,
    ]),
  };
  const results = await speakerSession.run(feeds);
  const output = results[Object.keys(results)[0]];
  const data = new Float32Array(output.data);
  return { embeddingBuffer: data.buffer };
}

function buildTextTokenizer(tokenizerData) {
  const tokenToId = new Map();
  for (const [token, id] of Object.entries(tokenizerData.model.vocab)) {
    tokenToId.set(token, id);
  }
  return {
    tokenToId,
    clsId: tokenToId.get("[CLS]") ?? 101,
    sepId: tokenToId.get("[SEP]") ?? 102,
    unkId: tokenToId.get("[UNK]") ?? 100,
  };
}

function tokenizeText(text) {
  const { tokenToId, clsId, sepId, unkId } = textTokenizer;
  const words = text.toLowerCase().match(/[a-z0-9]+|[^\s\w]/g) || [];
  const tokenIds = [clsId];

  for (const word of words) {
    if (tokenIds.length >= TEXT_EMBED_MAX_TOKENS - 1) break;

    if (tokenToId.has(word)) {
      tokenIds.push(tokenToId.get(word));
      continue;
    }

    let start = 0;
    while (start < word.length) {
      if (tokenIds.length >= TEXT_EMBED_MAX_TOKENS - 1) break;
      let end = word.length;
      let matched = false;
      while (end > start) {
        const subword = start === 0 ? word.slice(start, end) : `##${word.slice(start, end)}`;
        if (tokenToId.has(subword)) {
          tokenIds.push(tokenToId.get(subword));
          start = end;
          matched = true;
          break;
        }
        end--;
      }
      if (!matched) {
        tokenIds.push(unkId);
        start++;
      }
    }
  }

  tokenIds.push(sepId);

  const length = tokenIds.length;
  const inputIds = new BigInt64Array(length);
  const attentionMask = new BigInt64Array(length);
  const tokenTypeIds = new BigInt64Array(length);
  for (let i = 0; i < length; i++) {
    inputIds[i] = BigInt(tokenIds[i]);
    attentionMask[i] = 1n;
    tokenTypeIds[i] = 0n;
  }
  return { inputIds, attentionMask, tokenTypeIds, length };
}

function meanPoolAndNormalize(data, tokenCount, dim) {
  const embedding = new Float32Array(dim);
  for (let t = 0; t < tokenCount; t++) {
    const offset = t * dim;
    for (let d = 0; d < dim; d++) {
      embedding[d] += data[offset + d];
    }
  }
  for (let d = 0; d < dim; d++) {
    embedding[d] /= tokenCount;
  }

  let norm = 0;
  for (let d = 0; d < dim; d++) {
    norm += embedding[d] * embedding[d];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let d = 0; d < dim; d++) {
      embedding[d] /= norm;
    }
  }
  return embedding;
}

async function textLoad({ modelDir }) {
  if (textSession && textTokenizer) return { ok: true };
  loadOrt();

  const tokenizerData = JSON.parse(fs.readFileSync(path.join(modelDir, "tokenizer.json"), "utf-8"));
  textTokenizer = buildTextTokenizer(tokenizerData);

  textSession = await ort.InferenceSession.create(
    path.join(modelDir, "model.onnx"),
    SESSION_OPTIONS
  );
  log("info", "text session loaded", { modelDir });
  return { ok: true };
}

async function textEmbed({ text }) {
  if (!textSession) throw new Error("text session not loaded");

  const { inputIds, attentionMask, tokenTypeIds, length } = tokenizeText(text);
  const feeds = {
    input_ids: new ort.Tensor("int64", inputIds, [1, length]),
    attention_mask: new ort.Tensor("int64", attentionMask, [1, length]),
    token_type_ids: new ort.Tensor("int64", tokenTypeIds, [1, length]),
  };
  const results = await textSession.run(feeds);
  const output = results.last_hidden_state ?? results.output_0;
  const embedding = meanPoolAndNormalize(output.data, length, TEXT_EMBED_DIM);
  return { embeddingBuffer: embedding.buffer };
}

// ---------------------------------------------------------------------------
// GigaAM v3 e2e-RNN-T ASR (Russian). Featurizer is an exact port of onnx-asr's
// GigaamPreprocessorNumpy v3 (via meetily's Rust port): 16 kHz, n_fft=win=320,
// hop=160, no centering, precomputed window + mel filterbank, power spectrum,
// log(clip(mel, 1e-9, 1e9)), no CMVN. Features shape [1, 64, T].
//
// RNN-T greedy decode (onnx-asr GigaamV2Rnnt semantics):
//   encoder: IN audio_signal f32[1,64,T], length i64[1]
//            OUT encoded f32[1,D,T'], encoded_len i32[1]
//   decoder: IN x i64[1,1], h.1 f32[1,1,320], c.1 f32[1,1,320]
//            OUT dec f32[1,1,320], h, c
//   joiner : IN enc f32[1,D,1], dec f32[1,320,1] → joint f32[1,1,1,V]
// ---------------------------------------------------------------------------

const GIGAAM_N_FFT = 320;
const GIGAAM_HOP = 160;
const GIGAAM_N_MELS = 64;
const GIGAAM_N_FREQ = GIGAAM_N_FFT / 2 + 1; // 161
const GIGAAM_CLAMP_MIN = 1e-9;
const GIGAAM_CLAMP_MAX = 1e9;
const GIGAAM_PRED_HIDDEN = 320;
const GIGAAM_MAX_TOKENS_PER_STEP = 3;

let gigaamSessions = null; // { encoder, decoder, joiner }
let gigaamVocab = null;
let gigaamBlank = 0;
let _gigaamDft = null;

// Precomputed real-DFT twiddle tables for N=320 (not a power of two, so the
// radix-2 realFFT above cannot be reused). Direct DFT: ~103k MACs per 10 ms
// frame — far cheaper than the encoder inference that follows.
function getGigaamDft() {
  if (_gigaamDft) return _gigaamDft;
  const cos = new Float32Array(GIGAAM_N_FREQ * GIGAAM_N_FFT);
  const sin = new Float32Array(GIGAAM_N_FREQ * GIGAAM_N_FFT);
  for (let f = 0; f < GIGAAM_N_FREQ; f++) {
    for (let i = 0; i < GIGAAM_N_FFT; i++) {
      const angle = (2 * Math.PI * f * i) / GIGAAM_N_FFT;
      cos[f * GIGAAM_N_FFT + i] = Math.cos(angle);
      sin[f * GIGAAM_N_FFT + i] = Math.sin(angle);
    }
  }
  _gigaamDft = { cos, sin };
  return _gigaamDft;
}

// Log-mel features for a 16 kHz mono waveform. Returns { features, numFrames }
// where features is row-major [N_MELS, numFrames] (features[mel * T + t]).
function computeGigaamFeatures(waveform) {
  const { gigaamWindow, gigaamMelFbank } = require("./gigaamFbankAssets");
  const n = waveform.length;
  const numFrames = n < GIGAAM_N_FFT ? 0 : Math.floor((n - GIGAAM_N_FFT) / GIGAAM_HOP) + 1;
  if (numFrames === 0) return { features: new Float32Array(0), numFrames: 0 };

  const { cos, sin } = getGigaamDft();
  const features = new Float32Array(GIGAAM_N_MELS * numFrames);
  const frame = new Float32Array(GIGAAM_N_FFT);
  const power = new Float32Array(GIGAAM_N_FREQ);

  for (let t = 0; t < numFrames; t++) {
    const start = t * GIGAAM_HOP;
    for (let i = 0; i < GIGAAM_N_FFT; i++) {
      frame[i] = waveform[start + i] * gigaamWindow[i];
    }
    for (let f = 0; f < GIGAAM_N_FREQ; f++) {
      const base = f * GIGAAM_N_FFT;
      let re = 0;
      let im = 0;
      for (let i = 0; i < GIGAAM_N_FFT; i++) {
        re += frame[i] * cos[base + i];
        im += frame[i] * sin[base + i];
      }
      power[f] = re * re + im * im;
    }
    // mel[m] = Σ_f power[f] * fbank[f * N_MELS + m]; then log(clip).
    for (let m = 0; m < GIGAAM_N_MELS; m++) {
      let acc = 0;
      for (let f = 0; f < GIGAAM_N_FREQ; f++) {
        acc += power[f] * gigaamMelFbank[f * GIGAAM_N_MELS + m];
      }
      features[m * numFrames + t] = Math.log(
        Math.min(Math.max(acc, GIGAAM_CLAMP_MIN), GIGAAM_CLAMP_MAX)
      );
    }
  }
  return { features, numFrames };
}

// Parse a "token id" per-line vocab (id is the last whitespace-separated field).
function loadGigaamVocab(vocabPath) {
  const content = fs.readFileSync(vocabPath, "utf-8");
  const entries = [];
  let maxId = 0;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/[\r\s]+$/, "");
    if (!line) continue;
    const match = line.match(/^(.*)[ \t](\d+)$/);
    if (!match) throw new Error(`bad vocab line: ${JSON.stringify(line)}`);
    const id = parseInt(match[2], 10);
    maxId = Math.max(maxId, id);
    entries.push([id, match[1]]);
  }
  const vocab = new Array(maxId + 1).fill("");
  for (const [id, tok] of entries) vocab[id] = tok;
  return vocab;
}

function gigaamArgmax(data) {
  let best = 0;
  let bestV = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > bestV) {
      bestV = data[i];
      best = i;
    }
  }
  return best;
}

async function gigaamLoad({ encoderPath, decoderPath, joinerPath, vocabPath }) {
  if (gigaamSessions) return { ok: true };
  loadOrt();

  const vocab = loadGigaamVocab(vocabPath);
  const blkIdx = vocab.indexOf("<blk>");
  gigaamBlank = blkIdx >= 0 ? blkIdx : vocab.length - 1;
  gigaamVocab = vocab;

  const [encoder, decoder, joiner] = await Promise.all([
    ort.InferenceSession.create(encoderPath, SESSION_OPTIONS),
    ort.InferenceSession.create(decoderPath, SESSION_OPTIONS),
    ort.InferenceSession.create(joinerPath, SESSION_OPTIONS),
  ]);
  gigaamSessions = { encoder, decoder, joiner };
  log("info", "gigaam sessions loaded", { encoderPath, vocabSize: vocab.length, blank: gigaamBlank });
  return { ok: true };
}

function gigaamUnload() {
  gigaamSessions = null;
  gigaamVocab = null;
  return { ok: true };
}

// pcmBuffer: ArrayBuffer of little-endian f32 samples, 16 kHz mono.
async function gigaamTranscribe({ pcmBuffer }) {
  if (!gigaamSessions) throw new Error("gigaam sessions not loaded");

  const waveform = new Float32Array(pcmBuffer);
  const startedAt = Date.now();
  const { features, numFrames } = computeGigaamFeatures(waveform);
  if (numFrames === 0) return { text: "" };
  const featureMs = Date.now() - startedAt;

  const { encoder, decoder, joiner } = gigaamSessions;

  const encOut = await encoder.run({
    audio_signal: new ort.Tensor("float32", features, [1, GIGAAM_N_MELS, numFrames]),
    length: new ort.Tensor("int64", BigInt64Array.from([BigInt(numFrames)]), [1]),
  });
  const encoded = encOut.encoded;
  const encDim = encoded.dims[1];
  const encTp = encoded.dims[2];
  const encData = encoded.data;
  let encLen = Number(encOut.encoded_len.data[0]);
  if (!Number.isFinite(encLen) || encLen < 0) encLen = encTp;
  encLen = Math.min(encLen, encTp);

  // Greedy transducer decode. The prediction-network state (h, c) is committed
  // only when a real token is emitted; the frame advances on blank or after
  // MAX_TOKENS_PER_STEP emissions.
  let h = new ort.Tensor("float32", new Float32Array(GIGAAM_PRED_HIDDEN), [1, 1, GIGAAM_PRED_HIDDEN]);
  let c = new ort.Tensor("float32", new Float32Array(GIGAAM_PRED_HIDDEN), [1, 1, GIGAAM_PRED_HIDDEN]);
  const tokens = [];
  const encFrame = new Float32Array(encDim);
  let tIdx = 0;
  let emitted = 0;

  while (tIdx < encLen) {
    const lastToken = tokens.length > 0 ? tokens[tokens.length - 1] : gigaamBlank;
    for (let d = 0; d < encDim; d++) {
      encFrame[d] = encData[d * encTp + tIdx];
    }

    const decOut = await decoder.run({
      x: new ort.Tensor("int64", BigInt64Array.from([BigInt(lastToken)]), [1, 1]),
      "h.1": h,
      "c.1": c,
    });

    const jointOut = await joiner.run({
      enc: new ort.Tensor("float32", encFrame.slice(), [1, encDim, 1]),
      dec: new ort.Tensor("float32", decOut.dec.data, [1, GIGAAM_PRED_HIDDEN, 1]),
    });
    const token = gigaamArgmax(jointOut.joint.data);

    if (token !== gigaamBlank) {
      h = decOut.h;
      c = decOut.c;
      tokens.push(token);
      emitted += 1;
    }
    if (token === gigaamBlank || emitted >= GIGAAM_MAX_TOKENS_PER_STEP) {
      tIdx += 1;
      emitted = 0;
    }
  }

  // Token ids → text: concat vocab entries, SentencePiece ▁ → space, trim.
  let text = "";
  for (const id of tokens) {
    if (id < gigaamVocab.length) text += gigaamVocab[id];
  }
  text = text.replace(/▁/g, " ").trim();

  log("info", "gigaam transcribe done", {
    samples: waveform.length,
    numFrames,
    encLen,
    tokens: tokens.length,
    featureMs,
    totalMs: Date.now() - startedAt,
  });
  return { text };
}

const handlers = {
  ping: () => ({
    ok: true,
    sessions: { speaker: !!speakerSession, text: !!textSession, gigaam: !!gigaamSessions },
  }),
  "speaker.load": speakerLoad,
  "speaker.extract": speakerExtract,
  "text.load": textLoad,
  "text.embed": textEmbed,
  "gigaam.load": gigaamLoad,
  "gigaam.unload": gigaamUnload,
  "gigaam.transcribe": gigaamTranscribe,
  shutdown: () => {
    log("info", "shutdown requested");
    setImmediate(() => process.exit(0));
    return { ok: true };
  },
};

async function dispatch({ id, method, payload }) {
  const handler = handlers[method];
  if (!handler) {
    return { reply: { id, error: { message: `unknown method: ${method}` } }, transferList: [] };
  }
  try {
    const result = await handler(payload || {});
    // MessagePortMain transfer lists only accept MessagePorts; ArrayBuffers in
    // the message are structured-cloned instead.
    return { reply: { id, result }, transferList: [] };
  } catch (err) {
    log("error", "handler threw", { method, error: err?.message, stack: err?.stack });
    return { reply: { id, error: { message: err?.message || String(err) } }, transferList: [] };
  }
}

process.on("uncaughtException", (err) => {
  log("fatal", "uncaughtException", { error: err?.message, stack: err?.stack });
  process.stderr.write(`onnx worker uncaughtException: ${err?.stack || err?.message}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  log("fatal", "unhandledRejection", { error: err?.message, stack: err?.stack });
  process.stderr.write(`onnx worker unhandledRejection: ${err?.stack || err?.message}\n`);
  process.exit(1);
});

if (!process.parentPort) {
  process.stderr.write("onnx worker: process.parentPort is undefined\n");
  process.exit(1);
}

process.parentPort.once("message", ({ data, ports }) => {
  if (data === "init" && ports?.length) {
    port = ports[0];
    port.on("message", async (event) => {
      const message = event.data;
      const { reply, transferList } = await dispatch(message);
      port.postMessage(reply, transferList);
    });
    port.on("close", () => {
      log("info", "port closed");
      process.exit(0);
    });
    port.start();
    log("info", "worker initialized", { intraOpNumThreads });
  }
});

log("info", "worker boot", { intraOpNumThreads, pid: process.pid });
