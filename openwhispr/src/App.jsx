import React, { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import "./index.css";
import { useToast } from "./components/ui/useToast";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useSettingsStore } from "./stores/settingsStore";
import CustomSiriWave from "./utils/customSiriWave";

const WAVE_SPEED = 0.12;
const WAVE_MIN_AMPLITUDE = 0;
const WAVE_MAX_AMPLITUDE = 2.4;
const WAVE_WIDTH = 95;
const WAVE_HEIGHT = 90;

const SiriWaveIndicator = ({ audioLevel, isProcessing }) => {
  const containerRef = useRef(null);
  const waveRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return undefined;

    const wave = new CustomSiriWave({
      container: containerRef.current,
      style: "ios9",
      width: WAVE_WIDTH,
      height: WAVE_HEIGHT,
      speed: WAVE_SPEED,
      amplitude: WAVE_MIN_AMPLITUDE,
      autostart: true,
      cover: true,
      lerpSpeed: 0.15,
      edgeFadeStart: 0.82,
      globalCompositeOperation: "lighter",
      ranges: {
        noOfCurves: [3, 5],
        amplitude: [0.3, 1],
        width: [2.5, 5],
        speed: [0.5, 1],
      },
    });

    waveRef.current = wave;

    return () => {
      wave.dispose();
      waveRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!waveRef.current) return;

    const targetAmplitude = isProcessing
      ? WAVE_MIN_AMPLITUDE
      : WAVE_MIN_AMPLITUDE + audioLevel * (WAVE_MAX_AMPLITUDE - WAVE_MIN_AMPLITUDE);

    waveRef.current.setAmplitude(targetAmplitude);
    waveRef.current.setSpeed(WAVE_SPEED);
  }, [audioLevel, isProcessing]);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="pointer-events-none relative z-[1] flex h-[90px] w-[95px] items-center justify-center"
    />
  );
};

export default function App() {
  const { toast, toastCount } = useToast();
  const { t } = useTranslation();

  const floatingIconAutoHide = useSettingsStore((s) => s.floatingIconAutoHide);
  const prevAutoHideRef = useRef(floatingIconAutoHide);

  const setWindowInteractivity = React.useCallback((shouldCapture) => {
    window.electronAPI?.setMainWindowInteractivity?.(shouldCapture);
  }, []);

  useEffect(() => {
    setWindowInteractivity(false);
    return () => setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  useEffect(() => {
    const unsubscribeFallback = window.electronAPI?.onHotkeyFallbackUsed?.((data) => {
      toast({
        title: t("app.toasts.hotkeyChanged.title"),
        description: t("app.toasts.hotkeyChanged.description", {
          original: data.original,
          fallback: data.fallback,
        }),
        duration: 8000,
      });
    });

    const unsubscribeFailed = window.electronAPI?.onHotkeyRegistrationFailed?.(() => {
      toast({
        title: t("app.toasts.hotkeyUnavailable.title"),
        description: t("app.toasts.hotkeyUnavailable.description"),
        duration: 10000,
      });
    });

    return () => {
      unsubscribeFallback?.();
      unsubscribeFailed?.();
    };
  }, [toast, t]);

  useEffect(() => {
    window.electronAPI?.resizeMainWindow?.(toastCount > 0 ? "WITH_TOAST" : "BASE");
  }, [toastCount]);

  const handleDictationToggle = React.useCallback(() => {
    setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  const {
    isRecording,
    isProcessing,
    audioLevel,
    cancelRecording,
  } =
    useAudioRecording(toast, {
      onToggle: handleDictationToggle,
    });

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onFloatingIconAutoHideChanged?.((enabled) => {
      localStorage.setItem("floatingIconAutoHide", String(enabled));
      useSettingsStore.setState({ floatingIconAutoHide: enabled });
    });
    return () => unsubscribe?.();
  }, []);

  const isRecordingRef = useRef(isRecording);

  useLayoutEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCancelHotkeyPressed?.(() => {
      if (isRecordingRef.current) cancelRecording();
    });
    return () => unsubscribe?.();
  }, [cancelRecording]);

  useEffect(() => {
    let hideTimeout;

    if (floatingIconAutoHide && !isRecording && !isProcessing && toastCount === 0) {
      hideTimeout = setTimeout(() => {
        window.electronAPI?.hideWindow?.();
      }, 500);
    } else if (!floatingIconAutoHide && prevAutoHideRef.current) {
      window.electronAPI?.showDictationPanel?.();
    }

    prevAutoHideRef.current = floatingIconAutoHide;
    return () => clearTimeout(hideTimeout);
  }, [isRecording, isProcessing, floatingIconAutoHide, toastCount]);

  useEffect(() => {
    const handleKeyPress = (event) => {
      if (event.key === "Escape") {
        window.electronAPI?.hideWindow?.();
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, []);

  const isWaveVisible = isRecording || isProcessing;

  useEffect(() => {
    setWindowInteractivity(toastCount > 0);
  }, [toastCount, setWindowInteractivity]);

  return (
    <div className="dictation-window">
      {isWaveVisible && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center">
          <div className="relative flex h-[70px] w-[135px] items-center justify-center overflow-hidden rounded-full border border-white/20 bg-black">
            <SiriWaveIndicator audioLevel={audioLevel} isProcessing={isProcessing} />
          </div>
        </div>
      )}
    </div>
  );
}
