import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./index.css";
import { useAudioRecording } from "./hooks/useAudioRecording";
import Strands from "./components/effects/Strands";

const BASE_STRAND_AMPLITUDE = 0.2;
const STRAND_AMPLITUDE_RANGE = 1.3;
const MIN_STRAND_GLOW = 1;
const MAX_STRAND_GLOW = 3;
const MIN_STRAND_ORB_SIZE = 75;
const MAX_STRAND_ORB_SIZE = 85;
const DICTATION_WINDOW_SIZE = 120;
const STRAND_GLASS_WIDTH_RATIO = 0.92;
const STRAND_ORB_ASPECT_RATIO = 75 / 45;
const STRAND_GLASS_EXPONENT = 3;
const VOICE_RESPONSE_CURVE = 2;

const HIDE_CAPSULE_STORAGE_KEY = "hideCapsule";

const readHideCapsule = () => localStorage.getItem(HIDE_CAPSULE_STORAGE_KEY) === "true";

export default function App() {
  const [hideCapsule, setHideCapsule] = useState(readHideCapsule);
  const {
    isRecording,
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
    const handleStorage = (event) => {
      if (event.key === HIDE_CAPSULE_STORAGE_KEY) {
        setHideCapsule(event.newValue === "true");
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

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
  const visualVoiceLevel = 1 - Math.pow(1 - audioLevel, VOICE_RESPONSE_CURVE);
  const strandAmplitude = BASE_STRAND_AMPLITUDE + visualVoiceLevel * STRAND_AMPLITUDE_RANGE;
  const strandGlow = MIN_STRAND_GLOW + visualVoiceLevel * (MAX_STRAND_GLOW - MIN_STRAND_GLOW);
  const strandOrbSize = MIN_STRAND_ORB_SIZE + visualVoiceLevel * (MAX_STRAND_ORB_SIZE - MIN_STRAND_ORB_SIZE);
  const strandGlassSize = strandOrbSize / (DICTATION_WINDOW_SIZE * STRAND_GLASS_WIDTH_RATIO);

  useEffect(() => {
    if (!isWaveVisible || hideCapsule) {
      window.electronAPI?.hideDictationPanel?.();
    }
  }, [hideCapsule, isWaveVisible]);

  return (
    <div className="dictation-window flex h-screen w-screen items-center justify-center bg-transparent">
      {isWaveVisible && !hideCapsule && (
        <div className="pointer-events-none relative h-full w-full overflow-hidden">
          <div className="dictation-orb-shadow" />
          <Strands
            colors={["#17BE93", "#8dc317", "#11bedb"]}
            count={3}
            speed={1.4}
            amplitude={strandAmplitude}
            waviness={1}
            thickness={0.7}
            glow={strandGlow}
            taper={6}
            spread={1.25}
            intensity={0.7}
            saturation={1.55}
            opacity={1}
            scale={1.5}
            glass
            refraction={0.25}
            dispersion={1}
            glassSize={strandGlassSize}
            glassAspectRatio={STRAND_ORB_ASPECT_RATIO}
            glassExponent={STRAND_GLASS_EXPONENT}
            hueShift={0.14}
          />
        </div>
      )}
    </div>
  );
}
