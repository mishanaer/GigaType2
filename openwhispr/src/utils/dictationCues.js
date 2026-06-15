import logger from "./logger";
import tapDownUrl from "../assets/sounds/tap_02.wav";
import tapUpUrl from "../assets/sounds/tap_01.wav";
import { getSettings } from "../stores/settingsStore";

const cueAudio = new Map();
const CUE_VOLUME = 0.6;

const getCueAudio = (url) => {
  if (typeof window === "undefined") {
    return null;
  }

  if (!cueAudio.has(url)) {
    const audio = new Audio(url);
    audio.preload = "auto";
    cueAudio.set(url, audio);
  }

  return cueAudio.get(url);
};

const isEnabled = () => getSettings().audioCuesEnabled;

const playCue = async (url) => {
  try {
    if (!isEnabled()) return;

    const audio = getCueAudio(url);
    if (!audio) return;

    audio.pause();
    audio.currentTime = 0;
    audio.volume = CUE_VOLUME;
    await audio.play();
  } catch (error) {
    logger.debug(
      "Failed to play dictation cue",
      { error: error instanceof Error ? error.message : String(error) },
      "audio"
    );
  }
};

export const playStartCue = () => playCue(tapUpUrl);

export const playStopCue = () => playCue(tapDownUrl);
