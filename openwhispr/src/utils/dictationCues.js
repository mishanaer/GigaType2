import logger from "./logger";
import transitionDownUrl from "../assets/sounds/transition_down.wav";
import transitionUpUrl from "../assets/sounds/transition_up.wav";
import { getSettings } from "../stores/settingsStore";

const cueAudio = new Map();

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
    await audio.play();
  } catch (error) {
    logger.debug(
      "Failed to play dictation cue",
      { error: error instanceof Error ? error.message : String(error) },
      "audio"
    );
  }
};

export const playStartCue = () => playCue(transitionUpUrl);

export const playStopCue = () => playCue(transitionDownUrl);
