import { useEffect, useLayoutEffect, useRef } from "react";
import "./index.css";
import { useAudioRecording } from "./hooks/useAudioRecording";
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
  const {
    isRecording,
    isProcessing,
    audioLevel,
    cancelRecording,
  } = useAudioRecording();

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
    const handleKeyPress = (event) => {
      if (event.key === "Escape") {
        window.electronAPI?.hideDictationPanel?.();
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, []);

  const isWaveVisible = isRecording;

  useEffect(() => {
    if (!isWaveVisible) {
      window.electronAPI?.hideDictationPanel?.();
    }
  }, [isWaveVisible]);

  return (
    <div className="dictation-window flex h-screen w-screen items-center justify-center">
      {isWaveVisible && (
        <div className="pointer-events-none relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border border-white/20 bg-black">
          <SiriWaveIndicator audioLevel={audioLevel} isProcessing={isProcessing} />
        </div>
      )}
    </div>
  );
}
