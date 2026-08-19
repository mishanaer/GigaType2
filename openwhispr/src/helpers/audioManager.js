import logger from "../utils/logger";
import {
  isBuiltInMicrophone,
  getUserMediaWithDefaultDeviceFallback,
} from "../utils/audioDeviceUtils";
import { isSecureEndpoint } from "../utils/urlUtils";
import {
  isBuiltInGigaamEndpoint,
  resolveGigaamTranscriptionUrl,
} from "../utils/gigaamTranscription";
import { getBaseLanguageCode } from "../utils/languageSupport";
import { normalizeTranscriptionText } from "../utils/transcriptionFormatting";
import {
  createLocalSpeechGateState,
  getLocalSpeechGateDecision,
  recordLocalSpeechWindow,
} from "./localSpeechGate";
import { computeSmartSpacingPrefix } from "../utils/pasteSpacing";
import { getSettings } from "../stores/settingsStore";
import { syncService } from "../services/SyncService.js";

function encodeWAVFromChunks(chunks, inputSampleRate = 48000, outputSampleRate = 16000) {
  const inputLen = chunks.reduce((n, c) => n + c.length, 0);
  const flat = new Float32Array(inputLen);
  let flatOff = 0;
  for (const chunk of chunks) {
    flat.set(chunk, flatOff);
    flatOff += chunk.length;
  }

  let samples;
  if (inputSampleRate === outputSampleRate) {
    samples = flat;
  } else {
    const ratio = inputSampleRate / outputSampleRate;
    const outLen = Math.floor(inputLen / ratio);
    samples = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i * ratio;
      const lo = src | 0;
      const hi = Math.min(lo + 1, inputLen - 1);
      samples[i] = flat[lo] + (flat[hi] - flat[lo]) * (src - lo);
    }
  }

  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const write = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outputSampleRate, true);
  view.setUint32(28, outputSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, numSamples * 2, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

const GIGATYPE_ASR_MODEL = "gigaam-v3-e2e-rnnt";
const MIN_TRANSCRIBABLE_AUDIO_BYTES = 512;
const MIN_TRANSCRIBABLE_DURATION_SECONDS = 0.2;
const WINDOWS_SESSION_AUDIO_SETTLE_MS = 1500;

// All browser audio processing disabled to avoid OS-level side-effects.
// AGC off: Chromium's AGC on Windows mutates the system mic volume via WASAPI (#476).
// Echo cancellation and noise suppression off to avoid latency and speech distortion.
// Stereo recording required — mono WebM breaks silence detection on Linux/PipeWire (#472).
const NO_PROCESSING_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
};

const isNoTextTranscription = (error) => error?.message?.startsWith("No text transcribed");

class AudioManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.isProcessing = false;
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.onAudioLevel = null;
    this.cachedTranscriptionEndpoint = null;
    this.cachedEndpointProvider = null;
    this.cachedEndpointBaseUrl = null;
    this.recordingStartTime = null;
    this.isStreaming = false;
    this.streamingAudioContext = null;
    this.streamingSource = null;
    this.streamingProcessor = null;
    this.streamingStream = null;
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextResolve = null;
    this.streamingTextDebounce = null;
    this.cachedMicDeviceId = null;
    this.persistentAudioContext = null;
    this.workletModuleLoaded = false;
    this.workletBlobUrl = null;
    this.streamingStartInProgress = false;
    this.stopRequestedDuringStreamingStart = false;
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    this.context = "dictation";
    this.sttConfig = null;
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    this._lastPasteInfo = null;
    // Device ids that failed to open this session — skipped so every later
    // dictation doesn't repeat a doomed (slow on Windows) getUserMedia call.
    this._failedMicDeviceIds = new Set();
    this._localSpeechGateState = null;
    this._silenceInterval = null;
    this._silenceCtx = null;
    this._silenceAnalyser = null;
    this._micStream = null;
    this._recordCtx = null;
    this._recordSource = null;
    this._scriptProcessor = null;
    this._pcmChunks = [];
    this._pcmNativeRate = null;
    this._inputRecoveryNotBefore = 0;
    this._forceSystemDefaultMicOnce = false;
  }

  getWorkletBlobUrl() {
    if (this.workletBlobUrl) return this.workletBlobUrl;
    const code = `
const BUFFER_SIZE = 800;
class PCMStreamingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this.port.postMessage(partial.buffer, [partial.buffer]);
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
        }
        this._stopped = true;
      }
    };
  }
  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-streaming-processor", PCMStreamingProcessor);
`;
    this.workletBlobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return this.workletBlobUrl;
  }

  setCallbacks({
    onStateChange,
    onError,
    onTranscriptionComplete,
    onPartialTranscript,
    onAudioLevel,
    onStreamingCommit,
  }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onTranscriptionComplete = onTranscriptionComplete;
    this.onPartialTranscript = onPartialTranscript;
    this.onAudioLevel = onAudioLevel;
    this.onStreamingCommit = onStreamingCommit;
  }

  setContext(context) {
    this.context = context;
  }

  setSttConfig(config) {
    this.sttConfig = config;
  }

  stopAudioLevelMonitoring() {
    if (this._silenceInterval) {
      clearInterval(this._silenceInterval);
      this._silenceInterval = null;
    }
    this._silenceCtx?.close().catch(() => {});
    this._silenceCtx = null;
    this._silenceAnalyser = null;
    this.onAudioLevel?.({ rms: 0, peak: 0 });
  }

  getStreamingProvider() {
    return null;
  }

  getStreamingProviderName() {
    return "gigaam";
  }

  async getAudioConstraints() {
    const { preferBuiltInMic: preferBuiltIn, selectedMicDeviceId: selectedDeviceId } =
      getSettings();

    const noProcessing = { ...NO_PROCESSING_AUDIO_CONSTRAINTS };

    // Fast User Switching redirects Windows audio endpoints between sessions.
    // Chromium can keep the old endpoint alive but silent immediately after
    // unlock, so let the redirect settle and reopen through the current system
    // default once before considering a saved/cached device id again.
    const recoveryDelayMs = Math.max(0, this._inputRecoveryNotBefore - Date.now());
    if (recoveryDelayMs > 0) {
      logger.info(
        "Waiting for Windows audio endpoint recovery",
        { delayMs: recoveryDelayMs },
        "audio"
      );
      await new Promise((resolve) => setTimeout(resolve, recoveryDelayMs));
    }
    this._inputRecoveryNotBefore = 0;

    if (this._forceSystemDefaultMicOnce) {
      this._forceSystemDefaultMicOnce = false;
      logger.info("Reopening the system default microphone after session change", {}, "audio");
      return { audio: noProcessing };
    }

    if (preferBuiltIn) {
      if (this.cachedMicDeviceId && !this._failedMicDeviceIds.has(this.cachedMicDeviceId)) {
        logger.debug(
          "Using cached microphone device ID",
          { deviceId: this.cachedMicDeviceId },
          "audio"
        );
        return { audio: { deviceId: { exact: this.cachedMicDeviceId }, ...noProcessing } };
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");
        const builtInMic = audioInputs.find(
          (d) => isBuiltInMicrophone(d.label) && !this._failedMicDeviceIds.has(d.deviceId)
        );

        if (builtInMic) {
          this.cachedMicDeviceId = builtInMic.deviceId;
          logger.debug(
            "Using built-in microphone (cached for next time)",
            { deviceId: builtInMic.deviceId, label: builtInMic.label },
            "audio"
          );
          return { audio: { deviceId: { exact: builtInMic.deviceId }, ...noProcessing } };
        }
      } catch (error) {
        logger.debug(
          "Failed to enumerate devices for built-in mic detection",
          { error: error.message },
          "audio"
        );
      }
    }

    if (!preferBuiltIn && selectedDeviceId && !this._failedMicDeviceIds.has(selectedDeviceId)) {
      logger.debug("Using selected microphone", { deviceId: selectedDeviceId }, "audio");
      return { audio: { deviceId: { exact: selectedDeviceId }, ...noProcessing } };
    }

    logger.debug("Using default microphone", {}, "audio");
    return { audio: noProcessing };
  }

  invalidateInputDeviceCache(reason = "device-change") {
    this.cachedMicDeviceId = null;
    this._failedMicDeviceIds.clear();
    logger.info("Microphone device cache invalidated", { reason }, "audio");
  }

  /**
   * Tear down capture resources that belong to a Windows interactive session.
   * Fast User Switching preserves the renderer process while Windows redirects
   * the audio endpoint; reusing that graph can produce a live-but-silent stream.
   */
  resetInputAfterSessionChange({
    phase = "active",
    settleMs = WINDOWS_SESSION_AUDIO_SETTLE_MS,
  } = {}) {
    const hadActiveCapture = Boolean(
      this.isRecording ||
      this.isStreaming ||
      this.streamingStartInProgress ||
      this._micStream ||
      this.streamingStream
    );

    logger.info(
      "Resetting microphone capture after Windows session change",
      { phase, hadActiveCapture, settleMs },
      "audio"
    );

    this.stopRequestedDuringStreamingStart = true;
    this.cleanupStreamingAudio();
    this.cleanupStreamingListeners();

    try {
      this._scriptProcessor?.disconnect();
    } catch {
      // The old Windows audio graph may already be detached.
    }
    this._scriptProcessor = null;
    try {
      this._recordSource?.disconnect();
    } catch {
      // The old Windows audio graph may already be detached.
    }
    this._recordSource = null;

    this._micStream?.getTracks?.().forEach((track) => track.stop());
    this._micStream = null;
    this.stopAudioLevelMonitoring();
    this._recordCtx?.close?.().catch(() => {});
    this._recordCtx = null;
    this._pcmChunks = [];
    this._pcmNativeRate = null;
    this._localSpeechGateState = null;
    this.recordingStartTime = null;

    if (this._previewProcessor || this._previewSource || this._previewAudioContext) {
      this.cleanupPreview({ dismiss: true });
    }

    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      this.persistentAudioContext.close().catch(() => {});
    }
    this.persistentAudioContext = null;
    this.workletModuleLoaded = false;

    this.isRecording = false;
    this.isStreaming = false;
    this.streamingStartInProgress = false;
    this.invalidateInputDeviceCache(`windows-session-${phase}`);
    this._forceSystemDefaultMicOnce = true;
    this._inputRecoveryNotBefore = phase === "active" ? Date.now() + Math.max(0, settleMs) : 0;

    if (hadActiveCapture) {
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
    }

    return { hadActiveCapture };
  }

  async cacheMicrophoneDeviceId() {
    if (this.cachedMicDeviceId) return; // Already cached

    if (!getSettings().preferBuiltInMic) return; // Only needed for built-in mic detection

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === "audioinput");
      const builtInMic = audioInputs.find((d) => isBuiltInMicrophone(d.label));
      if (builtInMic) {
        this.cachedMicDeviceId = builtInMic.deviceId;
        logger.debug("Microphone device ID pre-cached", { deviceId: builtInMic.deviceId }, "audio");
      }
    } catch (error) {
      logger.debug("Failed to pre-cache microphone device ID", { error: error.message }, "audio");
    }
  }

  // Reports a failed microphone open (getUserMedia rejection, possibly after
  // the default-device retry) with a structured micAccessFailure so the
  // consumer can localize a precise diagnosis. English title/description are
  // fallbacks only.
  async _reportMicOpenFailure(error) {
    let errorTitle = "Recording Error";
    let errorDescription = `Failed to access microphone: ${error?.message}`;

    if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
      errorTitle = "Microphone Access Denied";
      errorDescription =
        "Please grant microphone permission in your system settings and try again.";
    } else if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
      errorTitle = "No Microphone Found";
      errorDescription = "No microphone was detected. Please connect a microphone and try again.";
    } else if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
      errorTitle = "Microphone In Use";
      errorDescription =
        "The microphone is being used by another application. Please close other apps and try again.";
    }

    // Capture the callback before the async status fetch: cleanup() may null
    // it mid-await and the error would silently vanish.
    const onError = this.onError;

    // The OS-level status turns an opaque NotReadable/NotFound into a precise
    // diagnosis on Windows (privacy toggle vs busy device). Time-boxed so a
    // wedged IPC cannot stall the error toast.
    let winMicAccessStatus = null;
    const electronAPI = typeof window !== "undefined" ? window.electronAPI : null;
    if (electronAPI?.getPlatform?.() === "win32" && electronAPI?.checkMicrophoneAccess) {
      try {
        const statusResult = await Promise.race([
          electronAPI.checkMicrophoneAccess(),
          new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        winMicAccessStatus = statusResult?.status ?? null;
      } catch {
        // status stays unknown — generic texts will be used
      }
    }

    onError?.({
      title: errorTitle,
      description: errorDescription,
      micAccessFailure: {
        name: error?.name ?? null,
        message: error?.message ?? null,
        originalDeviceErrorName: error?.originalDeviceErrorName ?? null,
        winMicAccessStatus,
      },
    });
  }

  async startRecording(options = {}) {
    const { shouldCancelStart } = options;

    try {
      if (this.isRecording || this.isProcessing || this.mediaRecorder?.state === "recording") {
        return false;
      }

      const constraints = await this.getAudioConstraints();
      if (shouldCancelStart?.()) {
        logger.debug("Recording start cancelled before microphone request", {}, "audio");
        return false;
      }

      // A configured device that cannot start must not kill dictation while
      // the system default still works — retry once without a deviceId.
      let fallbackResult;
      try {
        fallbackResult = await getUserMediaWithDefaultDeviceFallback(
          constraints,
          NO_PROCESSING_AUDIO_CONSTRAINTS,
          {
            shouldCancel: shouldCancelStart,
            onFallback: ({ failedDeviceId, error }) => {
              logger.warn(
                "Configured microphone failed to start, retrying with system default",
                { error: error?.name, message: error?.message },
                "audio"
              );
              this._failedMicDeviceIds.add(failedDeviceId);
              this.cachedMicDeviceId = null;
            },
          }
        );
      } catch (error) {
        await this._reportMicOpenFailure(error);
        return false;
      }
      if (!fallbackResult.stream) {
        logger.debug("Recording start cancelled before device fallback", {}, "audio");
        return false;
      }
      const micStream = fallbackResult.stream;
      if (shouldCancelStart?.()) {
        micStream.getTracks().forEach((track) => track.stop());
        logger.debug("Recording start cancelled after microphone opened", {}, "audio");
        return false;
      }

      const audioTrack = micStream.getAudioTracks()[0];
      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
          },
          "audio"
        );
      }

      try {
        this._silenceCtx = new AudioContext();
        this._silenceAnalyser = this._silenceCtx.createAnalyser();
        this._silenceAnalyser.fftSize = 2048;
        const sourceNode = this._silenceCtx.createMediaStreamSource(micStream);
        sourceNode.connect(this._silenceAnalyser);
        this._localSpeechGateState = createLocalSpeechGateState();
        const dataArray = new Uint8Array(this._silenceAnalyser.fftSize);
        this._silenceInterval = setInterval(() => {
          this._silenceAnalyser.getByteTimeDomainData(dataArray);
          let sum = 0;
          let peak = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128;
            sum += v * v;
            const abs = Math.abs(v);
            if (abs > peak) peak = abs;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          recordLocalSpeechWindow(this._localSpeechGateState, rms, peak);
          this.onAudioLevel?.({ rms, peak });
        }, 50);
      } catch (e) {
        logger.warn("Audio level gate setup failed, skipping", { error: e.message }, "audio");
        this._localSpeechGateState = null;
      }

      // Reuse _silenceCtx (already running at native rate) for PCM capture.
      // If it wasn't created (speech gate setup failed), create a fallback context.
      const captureCtx = this._silenceCtx ?? new AudioContext();
      this._recordCtx = captureCtx !== this._silenceCtx ? captureCtx : null;
      this._pcmNativeRate = captureCtx.sampleRate;
      this._pcmChunks = [];
      this._micStream = micStream;
      this.recordingStartTime = Date.now();
      this.recordingMimeType = "audio/wav";

      const srcChannels = micStream.getAudioTracks()[0]?.getSettings?.()?.channelCount || 1;
      const recSource = captureCtx.createMediaStreamSource(micStream);
      this._recordSource = recSource;
      this._scriptProcessor = captureCtx.createScriptProcessor(4096, srcChannels, 1);
      this._scriptProcessor.onaudioprocess = (event) => {
        this._pcmChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      recSource.connect(this._scriptProcessor);
      this._scriptProcessor.connect(captureCtx.destination);
      this.isRecording = true;
      this.onStateChange?.({ isRecording: true, isProcessing: false });

      return true;
    } catch (error) {
      // Errors from the rest of the pipeline (AudioContext, script processor
      // wiring, …) are NOT mic-access failures — no micAccessFailure here, so
      // the consumer shows the generic description instead of sending the
      // user device-hunting for a mic that just opened fine.
      this.onError?.({
        title: "Recording Error",
        description: `Failed to start recording: ${error?.message}`,
      });
      return false;
    }
  }

  stopRecording() {
    if (!this.isRecording || !this._scriptProcessor) return false;

    this._scriptProcessor.disconnect();
    this._scriptProcessor = null;
    this._recordSource?.disconnect();
    this._recordSource = null;

    const chunks = this._pcmChunks || [];
    const nativeRate = this._pcmNativeRate || 48000;
    this._pcmChunks = [];
    this._pcmNativeRate = null;

    // stopAudioLevelMonitoring closes _silenceCtx; _recordCtx is only set if we created a fallback
    this.stopAudioLevelMonitoring();
    this._recordCtx?.close().catch(() => {});
    this._recordCtx = null;

    this.cleanupPreview({ showCleanup: this.shouldShowPreviewCleanupState() });
    this.isRecording = false;
    this.isProcessing = true;
    this.onStateChange?.({ isRecording: false, isProcessing: true });

    const audioBlob = encodeWAVFromChunks(chunks, nativeRate);
    this.lastAudioBlob = audioBlob;

    logger.info(
      "Recording stopped",
      {
        blobSize: audioBlob.size,
        blobType: audioBlob.type,
        chunksCount: chunks.length,
        nativeRate,
      },
      "audio"
    );

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;
    this.recordingStartTime = null;

    this._micStream?.getTracks().forEach((t) => t.stop());
    this._micStream = null;

    void this.processAudio(audioBlob, { durationSeconds });
    return true;
  }

  cancelRecording() {
    if (!this.isRecording || !this._scriptProcessor) return false;

    this._scriptProcessor.disconnect();
    this._scriptProcessor = null;
    this._recordSource?.disconnect();
    this._recordSource = null;
    this._pcmChunks = [];
    this._pcmNativeRate = null;

    this._micStream?.getTracks().forEach((t) => t.stop());
    this._micStream = null;
    this._recordCtx?.close().catch(() => {});
    this._recordCtx = null;

    this.stopAudioLevelMonitoring();
    this.cleanupPreview({ dismiss: true });
    this.isRecording = false;
    this.isProcessing = false;
    this.recordingStartTime = null;
    this.onStateChange?.({ isRecording: false, isProcessing: false });
    return true;
  }

  cancelProcessing() {
    if (this.isProcessing) {
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      return true;
    }
    return false;
  }

  async processAudio(audioBlob, metadata = {}) {
    const pipelineStart = performance.now();
    const speechGateDecision = getLocalSpeechGateDecision(this._localSpeechGateState);
    this._localSpeechGateState = null;
    const durationSeconds = Number.isFinite(metadata?.durationSeconds)
      ? metadata.durationSeconds
      : null;

    if (
      audioBlob.size < MIN_TRANSCRIBABLE_AUDIO_BYTES ||
      (durationSeconds !== null && durationSeconds < MIN_TRANSCRIBABLE_DURATION_SECONDS)
    ) {
      logger.info(
        "Skipping transcription for too-short audio",
        {
          blobSize: audioBlob.size,
          durationSeconds,
          minBytes: MIN_TRANSCRIBABLE_AUDIO_BYTES,
          minDurationSeconds: MIN_TRANSCRIBABLE_DURATION_SECONDS,
        },
        "audio"
      );
      this.isProcessing = false;
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      this.onTranscriptionComplete?.({
        success: true,
        text: "",
        silent: true,
        reason: "too-short-audio",
        audioDurationMs: durationSeconds !== null ? Math.round(durationSeconds * 1000) : null,
        audioSizeBytes: audioBlob.size,
        speechDetected: false,
        stopReason: "too_short",
        transcriptionAttempted: false,
      });
      return;
    }

    if (speechGateDecision.skip && speechGateDecision.reason === "silence") {
      logger.info(
        "Speech gate skipped transcription",
        {
          reason: speechGateDecision.reason,
          peakRms: speechGateDecision.peakRms?.toFixed(4),
          peakAmplitude: speechGateDecision.peakAmplitude?.toFixed(4),
          speechWindowCount: speechGateDecision.speechWindowCount,
          maxConsecutiveSpeechWindows: speechGateDecision.maxConsecutiveSpeechWindows,
        },
        "audio"
      );
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      this.onTranscriptionComplete?.({
        success: true,
        text: "",
        reason: "silence",
        audioDurationMs: durationSeconds !== null ? Math.round(durationSeconds * 1000) : null,
        audioSizeBytes: audioBlob.size,
        speechDetected: false,
        stopReason: "user_stopped",
        transcriptionAttempted: false,
      });
      return;
    }

    const activeModel = this.getTranscriptionModel();

    try {
      logger.debug("Transcription routing", { provider: "gigaam" }, "transcription");

      const result = await this.processWithGigaam(audioBlob, metadata);

      if (!this.isProcessing) {
        return;
      }

      const audioDurationMs = metadata?.durationSeconds
        ? Math.round(metadata.durationSeconds * 1000)
        : Math.round(performance.now() - pipelineStart);

      const roundTripDurationMs = Math.round(performance.now() - pipelineStart);

      this.lastAudioMetadata = {
        durationMs: audioDurationMs,
        provider: result?.source || "gigaam",
        model: activeModel || null,
      };

      result.audioDurationMs = audioDurationMs;
      result.audioSizeBytes = audioBlob.size;
      result.speechDetected = true;
      result.stopReason = "user_stopped";
      result.transcriptionAttempted = true;
      result.model = activeModel || GIGATYPE_ASR_MODEL;
      result.timings = {
        ...(result.timings || {}),
        totalLatencyMs: roundTripDurationMs,
      };

      this.onTranscriptionComplete?.(result);

      const timingData = {
        mode: "gigaam",
        model: activeModel,
        audioDurationMs: metadata.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : null,
        roundTripDurationMs,
        audioSizeBytes: audioBlob.size,
        audioFormat: audioBlob.type,
        outputTextLength: result?.text?.length,
      };

      timingData.transcriptionProcessingDurationMs =
        result?.timings?.transcriptionProcessingDurationMs ?? null;

      logger.info("Pipeline timing", timingData, "performance");
    } catch (error) {
      const errorAtMs = Math.round(performance.now() - pipelineStart);
      const audioDurationMs = durationSeconds !== null ? Math.round(durationSeconds * 1000) : null;

      const shouldSkipFailureStatus = isNoTextTranscription(error);

      if (shouldSkipFailureStatus) {
        logger.info(
          "Pipeline completed without transcribed text",
          {
            errorAtMs,
            durationSeconds: metadata?.durationSeconds ?? null,
            error: error.message,
          },
          "audio"
        );
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
        this.onTranscriptionComplete?.({
          success: false,
          text: "",
          reason: "no_text",
          errorCode: error.code || null,
          audioDurationMs,
          audioSizeBytes: audioBlob.size,
          speechDetected: true,
          stopReason: "user_stopped",
          transcriptionAttempted: true,
          source: "gigaam",
          model: activeModel || GIGATYPE_ASR_MODEL,
          timings: {
            totalLatencyMs: errorAtMs,
            transcriptionProcessingDurationMs: errorAtMs,
          },
        });
      } else if (error.message === "No audio detected") {
        this.onTranscriptionComplete?.({
          success: true,
          text: "",
          silent: true,
          reason: "no-audio-detected",
          audioDurationMs,
          audioSizeBytes: audioBlob.size,
          speechDetected: false,
          stopReason: "user_stopped",
          transcriptionAttempted: false,
          source: "gigaam",
          model: activeModel || GIGATYPE_ASR_MODEL,
          timings: {
            totalLatencyMs: errorAtMs,
            transcriptionProcessingDurationMs: errorAtMs,
          },
        });
      } else {
        logger.error(
          "Pipeline failed",
          {
            errorAtMs,
            error: error.message,
          },
          "performance"
        );

        this.onError?.({
          title: "Transcription Error",
          description: `Transcription failed: ${error.message}`,
          code: error.code,
          messageKey: error.messageKey,
          audioDurationMs,
          audioSizeBytes: audioBlob.size,
          speechDetected: null,
          stopReason: "user_stopped",
          transcriptionAttempted: true,
          source: "gigaam",
          model: activeModel || GIGATYPE_ASR_MODEL,
          silent: true,
          transcriptionLatencyMs: errorAtMs,
          totalLatencyMs: errorAtMs,
        });

        // Save failed transcription with audio so the user can retry later
        if (this.lastAudioBlob) {
          this.saveFailedTranscription(error.message, error.code || null, metadata);
        }
      }
    } finally {
      if (this.isProcessing) {
        this.isProcessing = false;
        this.onStateChange?.({ isRecording: false, isProcessing: false });
      }
    }
  }

  async processTranscription(text, source) {
    const normalizedText = normalizeTranscriptionText(text);

    if (!normalizedText) {
      logger.debug(
        "Transcription text empty after normalization",
        {
          source,
        },
        "transcription"
      );
      return normalizedText;
    }

    logger.debug(
      "Transcription text normalized",
      {
        source,
        textLength: normalizedText.length,
        textPreview: normalizedText.substring(0, 100) + (normalizedText.length > 100 ? "..." : ""),
      },
      "transcription"
    );
    return normalizedText;
  }

  getCustomPrompt() {
    return getSettings().customPrompts.cleanup || undefined;
  }

  getKeyterms() {
    return [];
  }

  async processWithGigaam(audioBlob, metadata = {}) {
    const timings = {};
    const apiSettings = getSettings();
    const language = getBaseLanguageCode(apiSettings.preferredLanguage);

    try {
      const durationSeconds = metadata.durationSeconds ?? null;
      const model = this.getTranscriptionModel();
      const provider = "gigaam";

      logger.debug(
        "Transcription request starting",
        {
          provider,
          model,
          blobSize: audioBlob.size,
          blobType: audioBlob.type,
          durationSeconds,
          language,
        },
        "transcription"
      );

      const optimizedAudio = audioBlob;

      const formData = new FormData();
      // Determine the correct file extension based on the blob type
      const mimeType = optimizedAudio.type || "audio/webm";
      const extension = mimeType.includes("webm")
        ? "webm"
        : mimeType.includes("ogg")
          ? "ogg"
          : mimeType.includes("mp4")
            ? "mp4"
            : mimeType.includes("mpeg")
              ? "mp3"
              : mimeType.includes("wav")
                ? "wav"
                : "webm";

      logger.debug(
        "FormData preparation",
        {
          mimeType,
          extension,
          optimizedSize: optimizedAudio.size,
          auth: "none",
        },
        "transcription"
      );

      formData.append("file", optimizedAudio, `audio.${extension}`);
      formData.append("model", model);

      if (language) {
        formData.append("language", language);
      }

      const endpoint = this.getTranscriptionEndpoint();

      const apiCallStart = performance.now();

      if (isBuiltInGigaamEndpoint(endpoint)) {
        const audio = new Uint8Array(await optimizedAudio.arrayBuffer());
        const result = await window.electronAPI.transcribeLocalGigaam({
          audio,
          model,
          language,
          fileName: `audio.${extension}`,
          contentType: mimeType,
        });
        if (!result?.success) {
          throw new Error(result?.error || "Local GigaAM transcription failed");
        }
        const rawText = result.text || "";
        if (!rawText.trim()) {
          throw new Error(
            "No text transcribed - audio may be too short, silent, or in an unsupported format"
          );
        }
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
        const text = await this.processTranscription(rawText, "gigaam");
        return { success: true, text, rawText, source: "gigaam", timings };
      }

      logger.debug(
        "Making transcription API request",
        {
          endpoint,
          shouldStream: false,
          model,
          provider,
          auth: "none",
        },
        "transcription"
      );

      const headers = {};

      logger.debug(
        "STT request details",
        {
          endpoint,
          method: "POST",
          hasAuthHeader: false,
          formDataFields: [
            "file",
            "model",
            language && language !== "auto" ? "language" : null,
          ].filter(Boolean),
        },
        "transcription"
      );

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: formData,
      });

      const responseContentType = response.headers.get("content-type") || "";

      logger.debug(
        "Transcription API response received",
        {
          status: response.status,
          statusText: response.statusText,
          contentType: responseContentType,
          ok: response.ok,
        },
        "transcription"
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          "Transcription API error response",
          {
            status: response.status,
            errorText,
          },
          "transcription"
        );
        const err = new Error(`API Error: ${response.status} ${errorText}`);
        if (response.status === 401) err.code = "INVALID_KEY";
        else if (response.status === 429) {
          err.code = "LIMIT_REACHED";
          err.messageKey = "hooks.audioRecording.errorDescriptions.dailyLimitReached";
        } else if (response.status >= 500) err.code = "SERVER_ERROR";
        throw err;
      }

      let result;
      const rawText = await response.text();
      logger.debug(
        "Raw API response body",
        {
          rawText: rawText.substring(0, 1000),
          fullLength: rawText.length,
        },
        "transcription"
      );

      try {
        result = JSON.parse(rawText);
      } catch (parseError) {
        logger.error(
          "Failed to parse JSON response",
          {
            parseError: parseError.message,
            rawText: rawText.substring(0, 500),
          },
          "transcription"
        );
        throw new Error(`Failed to parse API response: ${parseError.message}`);
      }

      logger.debug(
        "Parsed transcription result",
        {
          hasText: !!result.text,
          textLength: result.text?.length,
          resultKeys: Object.keys(result),
          fullResult: result,
        },
        "transcription"
      );

      // Check for text - handle both empty string and missing field
      if (result.text && result.text.trim().length > 0) {
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
        const rawText = result.text;

        const text = await this.processTranscription(result.text, "gigaam");

        const source = "gigaam";
        logger.debug(
          "Transcription successful",
          {
            originalLength: result.text.length,
            processedLength: text.length,
            source,
            transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          },
          "transcription"
        );
        return { success: true, text, rawText, source, timings };
      } else {
        // Log at info level so it shows without debug mode
        logger.info(
          "Transcription returned empty - check audio input",
          {
            model,
            provider,
            endpoint,
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            mimeType,
            extension,
            resultText: result.text,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        logger.error(
          "No text in transcription result",
          {
            result,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        throw new Error(
          "No text transcribed - audio may be too short, silent, or in an unsupported format"
        );
      }
    } catch (error) {
      throw error;
    }
  }

  getTranscriptionModel() {
    return GIGATYPE_ASR_MODEL;
  }

  getTranscriptionEndpoint() {
    const s = getSettings();
    const currentProvider = "gigaam";
    const currentBaseUrl = s.gigaamBaseUrl || "";
    const remoteUrl = (s.remoteTranscriptionUrl || "").trim();

    if (
      this.cachedTranscriptionEndpoint &&
      (this.cachedEndpointProvider !== currentProvider ||
        this.cachedEndpointBaseUrl !== currentBaseUrl ||
        this.cachedEndpointRemoteUrl !== remoteUrl)
    ) {
      logger.debug(
        "STT endpoint cache invalidated",
        {
          previousProvider: this.cachedEndpointProvider,
          newProvider: currentProvider,
          previousBaseUrl: this.cachedEndpointBaseUrl,
          newBaseUrl: currentBaseUrl,
          previousRemoteUrl: this.cachedEndpointRemoteUrl,
          newRemoteUrl: remoteUrl,
        },
        "transcription"
      );
      this.cachedTranscriptionEndpoint = null;
    }

    if (this.cachedTranscriptionEndpoint) {
      return this.cachedTranscriptionEndpoint;
    }

    try {
      const base = remoteUrl || currentBaseUrl.trim();
      const endpoint = resolveGigaamTranscriptionUrl(base);

      logger.debug(
        "STT endpoint resolution",
        {
          provider: currentProvider,
          source: remoteUrl ? "remoteTranscriptionUrl" : "gigaamBaseUrl",
          rawBaseUrl: currentBaseUrl,
          remoteUrl,
          endpoint,
        },
        "transcription"
      );

      const cacheResult = (endpoint) => {
        this.cachedTranscriptionEndpoint = endpoint;
        this.cachedEndpointProvider = currentProvider;
        this.cachedEndpointBaseUrl = currentBaseUrl;
        this.cachedEndpointRemoteUrl = remoteUrl;

        logger.debug(
          "STT endpoint resolved",
          {
            endpoint,
            provider: currentProvider,
            usingDefault: false,
          },
          "transcription"
        );

        return endpoint;
      };

      if (!isBuiltInGigaamEndpoint(endpoint) && !isSecureEndpoint(endpoint)) {
        throw new Error(`Insecure GigaAM transcription endpoint: ${endpoint}`);
      }

      return cacheResult(endpoint);
    } catch (error) {
      logger.error(
        "STT endpoint resolution failed",
        { error: error.message, stack: error.stack },
        "transcription"
      );
      this.cachedEndpointProvider = currentProvider;
      this.cachedEndpointBaseUrl = currentBaseUrl;
      this.cachedEndpointRemoteUrl = remoteUrl;
      throw error;
    }
  }

  async safePaste(text, options = {}) {
    try {
      const prefix = computeSmartSpacingPrefix(this._lastPasteInfo, text);
      // verificationText: macOS AX verification and paste checks must match on
      // the raw transcription — a target field may collapse the leading space.
      const result = await window.electronAPI.pasteText(prefix + text, {
        ...options,
        ...(prefix ? { verificationText: text } : {}),
      });
      // Track pastes whose keystroke reached an app. inserted === true is the
      // verified case; "edit-field-unknown" (win32 without the text monitor)
      // and "verification-unavailable" (macOS without an AX target) mean the
      // keystroke was sent and almost certainly landed. Confirmed failures and
      // clipboard-only outcomes reset the state — the user pastes by hand and
      // we no longer know what precedes the cursor.
      const likelyPasted =
        result?.inserted === true ||
        result?.reason === "edit-field-unknown" ||
        result?.reason === "verification-unavailable";
      this._lastPasteInfo = likelyPasted ? { text, pastedAt: Date.now() } : null;
      return result;
    } catch (error) {
      this._lastPasteInfo = null;
      const message =
        error?.message ??
        (typeof error?.toString === "function" ? error.toString() : String(error));
      this.onError?.({
        title: "Paste Error",
        description: `Failed to paste text. Please check accessibility permissions. ${message}`,
      });
      return false;
    }
  }

  async saveTranscription(text, rawText = null, { clientTranscriptionId } = {}) {
    if (!getSettings().dataRetentionEnabled) {
      logger.debug("Skipping transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return true;
    }

    try {
      const result = await window.electronAPI.saveTranscription(text, rawText, {
        clientTranscriptionId,
      });
      if (result?.id) syncService.debouncedPush("transcription", result.id);

      // Save audio if we have a captured blob and the transcription was saved successfully
      if (result?.id && this.lastAudioBlob) {
        try {
          const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
          await window.electronAPI.saveTranscriptionAudio(
            result.id,
            arrayBuffer,
            this.lastAudioMetadata
          );
        } catch (audioErr) {
          // Non-blocking: transcription is saved even if audio save fails
          logger.warn("Failed to save transcription audio", { error: audioErr.message }, "audio");
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  async saveFailedTranscription(errorMessage, errorCode = null, metadata = {}) {
    if (!getSettings().dataRetentionEnabled) {
      logger.debug("Skipping failed transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return;
    }

    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        status: "failed",
        errorMessage,
        errorCode,
      });
      if (result?.id) syncService.debouncedPush("transcription", result.id);

      if (result?.id && this.lastAudioBlob) {
        try {
          const durationMs = metadata?.durationSeconds
            ? Math.round(metadata.durationSeconds * 1000)
            : null;
          const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
          await window.electronAPI.saveTranscriptionAudio(result.id, arrayBuffer, {
            durationMs,
            provider: null,
            model: null,
          });
        } catch (audioErr) {
          logger.warn(
            "Failed to save audio for failed transcription",
            {
              error: audioErr.message,
            },
            "audio"
          );
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }
    } catch (error) {
      logger.error(
        "Failed to save failed transcription record",
        {
          error: error.message,
        },
        "audio"
      );
    }
  }

  getState() {
    return {
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      isStreamingStartInProgress: this.streamingStartInProgress,
    };
  }

  shouldUseStreaming() {
    return false;
  }

  async warmupStreamingConnection() {
    logger.debug("Streaming warmup skipped - GigaAM batch transcription only", {}, "streaming");
    return false;
  }

  async getOrCreateAudioContext() {
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      if (this.persistentAudioContext.state === "suspended") {
        await this.persistentAudioContext.resume();
      }
      return this.persistentAudioContext;
    }
    this.persistentAudioContext = new AudioContext({ sampleRate: 16000 });
    this.workletModuleLoaded = false;
    return this.persistentAudioContext;
  }

  async startStreamingRecording() {
    logger.debug("Streaming recording skipped - GigaAM batch transcription only", {}, "streaming");
    return false;
  }

  async stopStreamingRecording() {
    this.cleanupStreamingAudio();
    this.cleanupStreamingListeners();
    this.isRecording = false;
    this.isStreaming = false;
    this.isProcessing = false;
    this.streamingStartInProgress = false;
    this.stopRequestedDuringStreamingStart = false;
    this.recordingStartTime = null;
    this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
    return true;
  }

  shouldShowPreviewCleanupState() {
    return false;
  }

  cleanupPreview(options = {}) {
    const { dismiss = false, showCleanup = false } = options;

    if (this._previewProcessor) {
      this._previewProcessor.port.postMessage("stop");
      this._previewProcessor.disconnect();
      this._previewProcessor = null;
    }
    if (this._previewSource) {
      this._previewSource.disconnect();
      this._previewSource = null;
    }
    if (this._previewAudioContext) {
      this._previewAudioContext.close().catch(() => {});
      this._previewAudioContext = null;
    }
    if (dismiss) {
      window.electronAPI?.dismissDictationPreview?.();
      return;
    }
    window.electronAPI?.stopDictationPreview?.({ showCleanup });
  }

  cleanupStreamingAudio() {
    if (this.streamingFallbackRecorder?.state === "recording") {
      try {
        this.streamingFallbackRecorder.stop();
      } catch {}
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];

    if (this.streamingProcessor) {
      try {
        this.streamingProcessor.port.postMessage("stop");
        this.streamingProcessor.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingProcessor = null;
    }

    if (this.streamingSource) {
      try {
        this.streamingSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingSource = null;
    }

    if (this.streamingAudioContext && this.streamingAudioContext.state !== "closed") {
      this.streamingAudioContext.close().catch(() => {});
    }
    this.streamingAudioContext = null;

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
    }

    this.isStreaming = false;
  }

  cleanupStreamingListeners() {
    for (const cleanup of this.streamingCleanupFns) {
      try {
        cleanup?.();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextResolve = null;
    clearTimeout(this.streamingTextDebounce);
    this.streamingTextDebounce = null;
  }

  async cleanupStreaming() {
    this.cleanupStreamingAudio();
    this.cleanupStreamingListeners();
  }

  cleanup() {
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    this._lastPasteInfo = null;
    if (this.isStreaming) {
      this.cleanupStreaming();
    }
    if (this.isRecording && this._scriptProcessor) {
      this.stopRecording();
    }
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      this.persistentAudioContext.close().catch(() => {});
      this.persistentAudioContext = null;
      this.workletModuleLoaded = false;
    }
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.onStreamingCommit = null;
  }
}

export default AudioManager;
