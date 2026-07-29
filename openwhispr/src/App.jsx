import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./index.css";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { GolosCapsule } from "./components/GolosCapsule";

const HIDE_CAPSULE_STORAGE_KEY = "hideCapsule";

const readHideCapsule = () => localStorage.getItem(HIDE_CAPSULE_STORAGE_KEY) === "true";

export default function App() {
  const [hideCapsule, setHideCapsule] = useState(readHideCapsule);
  const [resumeGeneration, setResumeGeneration] = useState(0);
  const { isRecording, isProcessing, audioLevel, cancelRecording } = useAudioRecording();

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
    return window.electronAPI?.onSystemResumed?.(() => {
      setResumeGeneration((generation) => generation + 1);
    });
  }, []);

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

  const isCapsuleVisible = isRecording || isProcessing;

  useEffect(() => {
    if (isCapsuleVisible && !hideCapsule) {
      window.electronAPI?.showDictationPanel?.();
    } else {
      window.electronAPI?.hideDictationPanel?.();
    }
  }, [hideCapsule, isCapsuleVisible, resumeGeneration]);

  return (
    <div className="dictation-window flex h-screen w-screen items-center justify-center bg-transparent">
      {isCapsuleVisible && !hideCapsule && (
        <GolosCapsule phase={isProcessing ? "transcribing" : "listening"} audioLevel={audioLevel} />
      )}
    </div>
  );
}
