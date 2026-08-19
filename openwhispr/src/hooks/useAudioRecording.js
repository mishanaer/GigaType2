import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { playStartCue, playStopCue } from "../utils/dictationCues";
import { getSettings } from "../stores/settingsStore";
import {
  getRecordingErrorTitle,
  getRecordingErrorDescription,
  getMicAccessErrorTitle,
  describeMicAccessError,
} from "../utils/recordingErrors";
import { getPlatform } from "../utils/platform";
import {
  getOutputMethod,
  getOutputStatus,
  textMetrics,
  trackTelemetryEvent,
} from "../utils/telemetry";

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const RMS_NOISE_FLOOR = 0.009;
const RMS_ACTIVE_RANGE = 0.018;
const PEAK_NOISE_FLOOR = 0.024;
const PEAK_ACTIVE_RANGE = 0.07;
const AUDIO_LEVEL_ATTACK_SMOOTHING = 0.2;
const AUDIO_LEVEL_RELEASE_SMOOTHING = 0.2;
const MIN_TELEMETRY_SUCCESS_AUDIO_MS = 500;

const normalizeAudioLevel = ({ rms = 0, peak = 0 } = {}) => {
  const rmsLevel = clamp01((rms - RMS_NOISE_FLOOR) / RMS_ACTIVE_RANGE);
  const peakLevel = clamp01((peak - PEAK_NOISE_FLOOR) / PEAK_ACTIVE_RANGE);
  return Math.pow(Math.max(rmsLevel, peakLevel * 0.75), 0.72);
};

export const useAudioRecording = (toast, options = {}) => {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const audioManagerRef = useRef(null);
  const startLockRef = useRef(false);
  const stopLockRef = useRef(false);
  const pendingStopRef = useRef(false);
  const audioLevelLogRef = useRef(0);
  const dictationSessionRef = useRef(null);
  const { onToggle } = options;
  const notify = useCallback(
    (props) => {
      if (typeof toast === "function") {
        return toast(props);
      }
      return "";
    },
    [toast]
  );

  const getSessionElapsedMs = useCallback((session) => {
    const startedAt = Number.isFinite(session?.startedAt) ? session.startedAt : performance.now();
    return Math.max(0, Math.round(performance.now() - startedAt));
  }, []);

  const finishDictationSession = useCallback(
    (outcome, properties = {}) => {
      const session = dictationSessionRef.current;
      if (!session || session.finished) return;

      session.finished = true;
      void trackTelemetryEvent("dictation_finished", {
        ...properties,
        session_id: session.sessionId,
        activation_mode: session.activationMode,
        trigger: session.trigger,
        total_latency_ms: properties.total_latency_ms ?? getSessionElapsedMs(session),
        outcome,
      });
      dictationSessionRef.current = null;
    },
    [getSessionElapsedMs]
  );

  const getAudioTelemetryProperties = useCallback((session, result, audioDurationMs) => {
    const stopReason =
      result.stopReason || (result.reason === "too-short-audio" ? "too_short" : "user_stopped");

    return {
      session_id: session.sessionId,
      activation_mode: session.activationMode,
      trigger: session.trigger,
      audio_duration_ms: audioDurationMs,
      audio_size_bytes: Number.isFinite(result.audioSizeBytes) ? result.audioSizeBytes : null,
      speech_detected: typeof result.speechDetected === "boolean" ? result.speechDetected : null,
      stop_reason: stopReason,
    };
  }, []);

  const stopActiveRecording = useCallback(async () => {
    if (!audioManagerRef.current) return false;

    const currentState = audioManagerRef.current.getState();
    if (!currentState.isRecording && !currentState.isStreamingStartInProgress) return false;

    window.electronAPI?.unregisterCancelHotkey?.();

    if (currentState.isStreaming || currentState.isStreamingStartInProgress) {
      void playStopCue();
      return await audioManagerRef.current.stopStreamingRecording();
    }

    const didStop = audioManagerRef.current.stopRecording();

    if (didStop) {
      void playStopCue();
    }

    return didStop;
  }, []);

  const performStartRecording = useCallback(
    async (telemetryContext = {}) => {
      if (startLockRef.current) return false;
      pendingStopRef.current = false;
      startLockRef.current = true;
      let didStart = false;
      try {
        if (!audioManagerRef.current) return false;

        const currentState = audioManagerRef.current.getState();
        if (currentState.isRecording || currentState.isProcessing) return false;

        didStart = audioManagerRef.current.shouldUseStreaming()
          ? await audioManagerRef.current.startStreamingRecording()
          : await audioManagerRef.current.startRecording({
              shouldCancelStart: () => pendingStopRef.current,
            });

        if (didStart) {
          const sessionId = crypto.randomUUID();
          const activationMode = telemetryContext.activationMode || "unknown";
          const trigger = telemetryContext.trigger || "unknown";
          dictationSessionRef.current = {
            sessionId,
            startedAt: performance.now(),
            activationMode,
            trigger,
            finished: false,
          };
          void trackTelemetryEvent("dictation_started", {
            session_id: sessionId,
            activation_mode: activationMode,
            trigger,
          });

          if (getSettings().pauseMediaOnDictation) {
            window.electronAPI?.pauseMediaPlayback?.();
          }
          window.electronAPI?.registerCancelHotkey?.("Escape");
          void playStartCue();
        }

        return didStart;
      } finally {
        startLockRef.current = false;
        if (pendingStopRef.current) {
          pendingStopRef.current = false;
          if (didStart) {
            await stopActiveRecording();
          }
        }
      }
    },
    [stopActiveRecording]
  );

  const performStopRecording = useCallback(async () => {
    if (startLockRef.current) {
      pendingStopRef.current = true;
      return true;
    }
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
      return await stopActiveRecording();
    } finally {
      stopLockRef.current = false;
    }
  }, [stopActiveRecording]);

  useEffect(() => {
    audioManagerRef.current = new AudioManager();

    audioManagerRef.current.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, isStreaming }) => {
        if (!isRecording) window.electronAPI?.unregisterCancelHotkey?.();
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setIsStreaming(isStreaming ?? false);
        if (!isRecording) {
          setAudioLevel(0);
        }
        if (!isStreaming) {
          setPartialTranscript("");
        }
      },
      onAudioLevel: (level) => {
        const targetLevel = normalizeAudioLevel(level);
        const now = Date.now();
        if (now - audioLevelLogRef.current > 1000) {
          audioLevelLogRef.current = now;
          logger.info(
            "Audio level sample",
            {
              rms: Number((level?.rms ?? 0).toFixed(4)),
              peak: Number((level?.peak ?? 0).toFixed(4)),
              audioLevel: Number(targetLevel.toFixed(3)),
            },
            "audio"
          );
        }
        setAudioLevel((currentLevel) => {
          const smoothing =
            targetLevel > currentLevel
              ? AUDIO_LEVEL_ATTACK_SMOOTHING
              : AUDIO_LEVEL_RELEASE_SMOOTHING;
          return currentLevel + (targetLevel - currentLevel) * smoothing;
        });
      },
      onError: (error) => {
        const session = dictationSessionRef.current;
        const sessionId = session?.sessionId || null;
        // Failed microphone opens carry a structured micAccessFailure and get
        // the same localized, platform-aware texts as the onboarding mic test.
        const micFailure = error?.micAccessFailure;
        const title = micFailure
          ? getMicAccessErrorTitle(micFailure, t, getPlatform())
          : getRecordingErrorTitle(error, t);
        const description = micFailure
          ? describeMicAccessError(micFailure, t, getPlatform())
          : getRecordingErrorDescription(error, t);
        // Telemetry must stay locale-stable: keep the English fallback title
        // for mic failures instead of the translated toast title.
        const safeMessage = micFailure ? error?.title || "Recording Error" : title;
        const errorArea =
          error?.title === "Paste Error"
            ? "paste"
            : error?.title === "Transcription Error" || error?.transcriptionAttempted
              ? "transcription"
              : "microphone";
        const audioDurationMs = Number.isFinite(error?.audioDurationMs)
          ? error.audioDurationMs
          : null;
        const audioProperties =
          session && (audioDurationMs !== null || Number.isFinite(error?.audioSizeBytes))
            ? getAudioTelemetryProperties(session, error, audioDurationMs)
            : null;

        if (audioProperties) {
          void trackTelemetryEvent("dictation_audio_captured", {
            ...audioProperties,
            status: "captured",
          });
          if (error?.transcriptionAttempted) {
            void trackTelemetryEvent("dictation_transcribed", {
              ...audioProperties,
              provider: error.source || "gigaam",
              model: error.model || "gigaam-v3-e2e-rnnt",
              transcription_latency_ms: error.transcriptionLatencyMs ?? null,
              total_latency_ms: error.totalLatencyMs ?? null,
              status: "failed",
              transcribed: false,
              error_code: error?.code || error?.title || "TRANSCRIPTION_FAILED",
              safe_message: safeMessage,
            });
          }
        }

        if (errorArea !== "paste") {
          void trackTelemetryEvent("error_occurred", {
            session_id: sessionId,
            ...(audioProperties || {}),
            error_area: errorArea,
            error_code: error?.code || error?.title || "RECORDING_ERROR",
            safe_message: safeMessage,
          });
        }
        if (errorArea !== "paste") {
          finishDictationSession(
            errorArea === "transcription" ? "transcription_failed" : "interrupted",
            {
              ...(audioProperties || {}),
              status: "failed",
              transcribed: error?.transcriptionAttempted ? false : null,
              output_attempted: false,
              error_area: errorArea,
              error_code: error?.code || error?.title || "RECORDING_ERROR",
              safe_message: safeMessage,
            }
          );
        }
        if (error?.title !== "Paste Error") {
          window.electronAPI?.hideDictationPreview?.();
        }
        if (!error?.silent) {
          notify({
            title,
            description,
            variant: "destructive",
            duration: error.code === "AUTH_EXPIRED" ? 8000 : undefined,
          });
        }
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.resumeMediaPlayback?.();
        }
      },
      onPartialTranscript: (text) => {
        setPartialTranscript(text);
      },
      onTranscriptionComplete: async (result) => {
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.resumeMediaPlayback?.();
        }

        const session = dictationSessionRef.current || {
          sessionId: crypto.randomUUID(),
          startedAt: performance.now(),
          activationMode: "unknown",
          trigger: "unknown",
          finished: false,
        };
        dictationSessionRef.current = session;
        const sessionId = session.sessionId;
        const audioDurationMs = Number.isFinite(result.audioDurationMs)
          ? result.audioDurationMs
          : null;
        const eligibleForSuccess =
          audioDurationMs === null || audioDurationMs >= MIN_TELEMETRY_SUCCESS_AUDIO_MS;
        const audioProperties = getAudioTelemetryProperties(session, result, audioDurationMs);

        void trackTelemetryEvent("dictation_audio_captured", {
          ...audioProperties,
          status: "captured",
        });

        if (result.success) {
          const transcribedText = result.text?.trim();

          if (!transcribedText) {
            const outcome =
              result.reason === "too-short-audio"
                ? "too_short"
                : result.reason === "silence"
                  ? "silence"
                  : result.reason === "no-audio-detected"
                    ? "no_audio"
                    : "no_text";
            const transcriptionStatus = result.transcriptionAttempted ? "empty" : "skipped";

            window.electronAPI?.hideDictationPreview?.();
            if (result.transcriptionAttempted) {
              void trackTelemetryEvent("dictation_transcribed", {
                ...audioProperties,
                provider: result.source || "gigaam",
                model: result.model || "gigaam-v3-e2e-rnnt",
                transcription_latency_ms: result.timings?.transcriptionProcessingDurationMs ?? null,
                total_latency_ms: result.timings?.totalLatencyMs ?? null,
                status: transcriptionStatus,
                transcribed: false,
                reason: result.reason || "no_text",
              });
            }
            if (!result.silent && eligibleForSuccess) {
              void trackTelemetryEvent("error_occurred", {
                session_id: sessionId,
                ...audioProperties,
                audio_duration_ms: audioDurationMs,
                error_area: "transcription",
                error_code: result.reason || "NO_TRANSCRIBED_TEXT",
                safe_message: "No transcribed text",
              });
            }
            finishDictationSession(outcome, {
              ...audioProperties,
              status: transcriptionStatus,
              transcribed: false,
              output_attempted: false,
              reason: result.reason || outcome,
            });
            if (result.silent) {
              return;
            }
            notify({
              title: t("hooks.audioRecording.noAudio.title"),
              description: t("hooks.audioRecording.noAudio.description"),
              variant: "default",
            });
            return;
          }

          setTranscript(result.text);
          window.electronAPI?.completeDictationPreview?.({ text: result.text });

          const rawMetrics = textMetrics(result.rawText ?? result.text);
          const finalMetrics = textMetrics(result.text);
          const transcriptionProperties = {
            ...audioProperties,
            provider: result.source || "gigaam_local",
            model: result.model || "gigaam-v3-e2e-rnnt",
            audio_duration_ms: audioDurationMs,
            raw_transcript_chars: rawMetrics.chars,
            raw_transcript_words: rawMetrics.words,
            final_output_chars: finalMetrics.chars,
            final_output_words: finalMetrics.words,
            transcription_latency_ms: result.timings?.transcriptionProcessingDurationMs ?? null,
            total_latency_ms: result.timings?.totalLatencyMs ?? null,
            status: "text",
            transcribed: true,
          };
          void trackTelemetryEvent("dictation_transcribed", transcriptionProperties);

          const isStreaming = result.source?.includes("streaming");
          const pasteStart = performance.now();
          const pasteResult = await audioManagerRef.current.safePaste(result.text, {
            ...(isStreaming ? { fromStreaming: true } : {}),
            restoreClipboard: true,
            allowClipboardFallback: true,
          });
          const outputLatencyMs = Math.round(performance.now() - pasteStart);
          const outputStatus = getOutputStatus(pasteResult);
          const outputMethod = getOutputMethod(outputStatus);
          const totalLatencyMs = Math.round(performance.now() - session.startedAt);
          logger.info(
            "Paste timing",
            {
              pasteMs: outputLatencyMs,
              source: result.source,
              textLength: result.text.length,
            },
            "streaming"
          );

          const outputProperties = {
            ...transcriptionProperties,
            output_method: outputMethod,
            output_status: outputStatus,
            output_latency_ms: outputLatencyMs,
            total_latency_ms: totalLatencyMs,
            success: eligibleForSuccess && outputStatus !== "failed",
            status: outputStatus === "failed" ? "failed" : "succeeded",
            output_attempted: true,
          };

          void trackTelemetryEvent("dictation_output_attempted", outputProperties);

          if (eligibleForSuccess && outputStatus !== "failed") {
            void trackTelemetryEvent("dictation_output_succeeded", outputProperties);
          } else if (eligibleForSuccess) {
            void trackTelemetryEvent("error_occurred", {
              ...outputProperties,
              error_area: "paste",
              error_code: "OUTPUT_FAILED",
              safe_message: "Dictation output failed",
            });
          }

          audioManagerRef.current.saveTranscription(result.text, result.rawText ?? result.text, {
            clientTranscriptionId: result.clientTranscriptionId,
          });

          if (audioManagerRef.current.shouldUseStreaming()) {
            audioManagerRef.current.warmupStreamingConnection();
          }

          finishDictationSession(outputStatus === "failed" ? "output_failed" : "succeeded", {
            ...outputProperties,
            error_area: outputStatus === "failed" ? "paste" : null,
            error_code: outputStatus === "failed" ? "OUTPUT_FAILED" : null,
          });
        } else {
          const failedTranscriptionStatus = result.reason === "no_text" ? "empty" : "failed";
          void trackTelemetryEvent("dictation_transcribed", {
            ...audioProperties,
            provider: result.source || "gigaam",
            model: result.model || "gigaam-v3-e2e-rnnt",
            transcription_latency_ms: result.timings?.transcriptionProcessingDurationMs ?? null,
            total_latency_ms: result.timings?.totalLatencyMs ?? null,
            status: failedTranscriptionStatus,
            transcribed: false,
            reason: result.reason || "transcription_failed",
            error_code: result.errorCode || result.reason || "TRANSCRIPTION_FAILED",
            safe_message:
              failedTranscriptionStatus === "empty"
                ? "No transcribed text"
                : "Transcription failed",
          });
          if (eligibleForSuccess && !result.errorReportedByAudioManager) {
            void trackTelemetryEvent("error_occurred", {
              session_id: sessionId,
              ...audioProperties,
              audio_duration_ms: audioDurationMs,
              error_area: "transcription",
              error_code: result.errorCode || result.reason || "TRANSCRIPTION_FAILED",
              safe_message:
                failedTranscriptionStatus === "empty"
                  ? "No transcribed text"
                  : "Transcription failed",
            });
          }
          finishDictationSession(
            failedTranscriptionStatus === "empty" ? "no_text" : "transcription_failed",
            {
              ...audioProperties,
              status: failedTranscriptionStatus,
              transcribed: false,
              output_attempted: false,
              reason: result.reason || "transcription_failed",
              error_area: "transcription",
              error_code: result.errorCode || result.reason || "TRANSCRIPTION_FAILED",
            }
          );
        }
      },
    });

    audioManagerRef.current.setContext("dictation");

    const handleToggle = async () => {
      if (!audioManagerRef.current) return;
      const currentState = audioManagerRef.current.getState();

      if (!currentState.isRecording && !currentState.isProcessing) {
        await performStartRecording({ activationMode: "toggle", trigger: "hotkey" });
      } else if (currentState.isRecording) {
        await performStopRecording();
      }
    };

    const handleStart = async () => {
      const didStart = await performStartRecording({ activationMode: "hold", trigger: "hotkey" });
      if (!didStart) {
        window.electronAPI?.hideDictationPanel?.();
      }
    };

    const handleStop = async () => {
      await performStopRecording();
    };

    const disposeToggle = window.electronAPI.onToggleDictation(() => {
      handleToggle();
      onToggle?.();
    });

    const disposeStart = window.electronAPI.onStartDictation?.(() => {
      handleStart();
      onToggle?.();
    });

    const disposeStop = window.electronAPI.onStopDictation?.(() => {
      handleStop();
      onToggle?.();
    });

    const handleNoAudioDetected = () => {
      if (getSettings().pauseMediaOnDictation) {
        window.electronAPI?.resumeMediaPlayback?.();
      }
      notify({
        title: t("hooks.audioRecording.noAudio.title"),
        description: t("hooks.audioRecording.noAudio.description"),
        variant: "default",
      });
    };

    const disposeNoAudio = window.electronAPI.onNoAudioDetected?.(handleNoAudioDetected);

    const resetWindowsSessionAudio = (phase) => {
      if (getPlatform() !== "win32" || !audioManagerRef.current) return;

      // If getUserMedia is still pending, its shouldCancelStart callback will
      // stop the late stream instead of attaching it to the reactivated session.
      if (startLockRef.current) {
        pendingStopRef.current = true;
      }

      const { hadActiveCapture } = audioManagerRef.current.resetInputAfterSessionChange({
        phase,
        settleMs: phase === "active" ? 1500 : 0,
      });

      if (hadActiveCapture) {
        window.electronAPI?.unregisterCancelHotkey?.();
        window.electronAPI?.hideDictationPreview?.();
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.resumeMediaPlayback?.();
        }
        finishDictationSession("interrupted", {
          status: "interrupted",
          stop_reason: `windows_session_${phase}`,
          transcribed: false,
          output_attempted: false,
        });
      }
    };

    const disposeSessionInactive = window.electronAPI.onSystemSessionInactive?.(() => {
      resetWindowsSessionAudio("inactive");
    });
    const disposeSystemResumed = window.electronAPI.onSystemResumed?.(() => {
      resetWindowsSessionAudio("active");
    });

    const handleAudioDeviceChange = () => {
      if (getPlatform() === "win32") {
        audioManagerRef.current?.invalidateInputDeviceCache("media-device-change");
      }
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", handleAudioDeviceChange);

    // Cleanup
    return () => {
      disposeToggle?.();
      disposeStart?.();
      disposeStop?.();
      disposeNoAudio?.();
      disposeSessionInactive?.();
      disposeSystemResumed?.();
      navigator.mediaDevices?.removeEventListener?.("devicechange", handleAudioDeviceChange);
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
      }
    };
  }, [
    finishDictationSession,
    getAudioTelemetryProperties,
    notify,
    onToggle,
    performStartRecording,
    performStopRecording,
    t,
  ]);

  const cancelRecording = useCallback(async () => {
    if (audioManagerRef.current) {
      window.electronAPI?.unregisterCancelHotkey?.();
      const state = audioManagerRef.current.getState();
      if (getSettings().pauseMediaOnDictation) {
        window.electronAPI?.resumeMediaPlayback?.();
      }
      finishDictationSession("cancelled", {
        stop_reason: "cancelled",
        status: "cancelled",
        transcribed: false,
        output_attempted: false,
      });
      if (state.isStreaming) {
        return await audioManagerRef.current.stopStreamingRecording();
      }
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  }, [finishDictationSession]);

  const cancelProcessing = () => {
    if (audioManagerRef.current) {
      const didCancel = audioManagerRef.current.cancelProcessing();
      if (didCancel) {
        finishDictationSession("cancelled", {
          stop_reason: "cancelled",
          status: "cancelled",
          transcribed: false,
          output_attempted: false,
        });
      }
      return didCancel;
    }
    return false;
  };

  const toggleListening = async () => {
    if (!isRecording && !isProcessing) {
      await performStartRecording({ activationMode: "toggle", trigger: "ui" });
    } else if (isRecording) {
      await performStopRecording();
    }
  };

  return {
    isRecording,
    isProcessing,
    isStreaming,
    audioLevel,
    transcript,
    partialTranscript,
    startRecording: performStartRecording,
    stopRecording: performStopRecording,
    cancelRecording,
    cancelProcessing,
    toggleListening,
  };
};
