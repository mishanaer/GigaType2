import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { playStartCue, playStopCue } from "../utils/dictationCues";
import { getSettings } from "../stores/settingsStore";
import { getRecordingErrorTitle, getRecordingErrorDescription } from "../utils/recordingErrors";

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const RMS_NOISE_FLOOR = 0.009;
const RMS_ACTIVE_RANGE = 0.018;
const PEAK_NOISE_FLOOR = 0.024;
const PEAK_ACTIVE_RANGE = 0.07;

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
  const audioLevelLogRef = useRef(0);
  const { onToggle } = options;

  const performStartRecording = useCallback(async () => {
    if (startLockRef.current) return false;
    startLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (currentState.isRecording || currentState.isProcessing) return false;

      const didStart = audioManagerRef.current.shouldUseStreaming()
        ? await audioManagerRef.current.startStreamingRecording()
        : await audioManagerRef.current.startRecording();

      if (didStart) {
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.pauseMediaPlayback?.();
        }
        window.electronAPI?.registerCancelHotkey?.("Escape");
        void playStartCue();
      }

      return didStart;
    } finally {
      startLockRef.current = false;
    }
  }, []);

  const performStopRecording = useCallback(async () => {
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
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
    } finally {
      stopLockRef.current = false;
    }
  }, []);

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
          const smoothing = targetLevel > currentLevel ? 0.7 : 0.39;
          return currentLevel + (targetLevel - currentLevel) * smoothing;
        });
      },
      onError: (error) => {
        if (error?.title !== "Paste Error") {
          window.electronAPI?.hideDictationPreview?.();
        }
        const title = getRecordingErrorTitle(error, t);
        const description = getRecordingErrorDescription(error, t);
        toast({
          title,
          description,
          variant: "destructive",
          duration: error.code === "AUTH_EXPIRED" ? 8000 : undefined,
        });
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

        if (result.success) {
          const transcribedText = result.text?.trim();

          if (!transcribedText) {
            window.electronAPI?.hideDictationPreview?.();
            toast({
              title: t("hooks.audioRecording.noAudio.title"),
              description: t("hooks.audioRecording.noAudio.description"),
              variant: "default",
            });
            return;
          }

          setTranscript(result.text);
          window.electronAPI?.completeDictationPreview?.({ text: result.text });

          const isStreaming = result.source?.includes("streaming");
          const pasteStart = performance.now();
          await audioManagerRef.current.safePaste(result.text, {
            ...(isStreaming ? { fromStreaming: true } : {}),
            restoreClipboard: true,
            allowClipboardFallback: true,
          });
          logger.info(
            "Paste timing",
            {
              pasteMs: Math.round(performance.now() - pasteStart),
              source: result.source,
              textLength: result.text.length,
            },
            "streaming"
          );

          audioManagerRef.current.saveTranscription(result.text, result.rawText ?? result.text, {
            clientTranscriptionId: result.clientTranscriptionId,
          });

          if (audioManagerRef.current.shouldUseStreaming()) {
            audioManagerRef.current.warmupStreamingConnection();
          }
        }
      },
    });

    audioManagerRef.current.setContext("dictation");

    const handleToggle = async () => {
      if (!audioManagerRef.current) return;
      const currentState = audioManagerRef.current.getState();

      if (!currentState.isRecording && !currentState.isProcessing) {
        await performStartRecording();
      } else if (currentState.isRecording) {
        await performStopRecording();
      }
    };

    const handleStart = async () => {
      await performStartRecording();
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
      toast({
        title: t("hooks.audioRecording.noAudio.title"),
        description: t("hooks.audioRecording.noAudio.description"),
        variant: "default",
      });
    };

    const disposeNoAudio = window.electronAPI.onNoAudioDetected?.(handleNoAudioDetected);

    // Cleanup
    return () => {
      disposeToggle?.();
      disposeStart?.();
      disposeStop?.();
      disposeNoAudio?.();
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
      }
    };
  }, [toast, onToggle, performStartRecording, performStopRecording, t]);

  const cancelRecording = useCallback(async () => {
    if (audioManagerRef.current) {
      window.electronAPI?.unregisterCancelHotkey?.();
      const state = audioManagerRef.current.getState();
      if (getSettings().pauseMediaOnDictation) {
        window.electronAPI?.resumeMediaPlayback?.();
      }
      if (state.isStreaming) {
        return await audioManagerRef.current.stopStreamingRecording();
      }
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  }, []);

  const cancelProcessing = () => {
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelProcessing();
    }
    return false;
  };

  const toggleListening = async () => {
    if (!isRecording && !isProcessing) {
      await performStartRecording();
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
