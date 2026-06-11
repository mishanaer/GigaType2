const { DEFAULTS, LIMITS } = require("../constants/speechVad.json");

const DEFAULT_SPEECH_VAD_CONFIG = Object.freeze({ ...DEFAULTS });
const VAD_LIMITS = Object.freeze(LIMITS);

function clampVadField(key, value) {
  const fallback = DEFAULTS[key];
  const n = value === null || value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const { min, max, round } = LIMITS[key];
  const clamped = Math.min(max, Math.max(min, n));
  return round ? Math.round(clamped) : clamped;
}

function sanitizeSpeechVadConfig(input = {}) {
  const merged = { ...DEFAULTS, ...(input || {}) };
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    out[key] = clampVadField(key, merged[key]);
  }
  return out;
}

module.exports = {
  DEFAULT_SPEECH_VAD_CONFIG,
  VAD_LIMITS,
  clampVadField,
  sanitizeSpeechVadConfig,
};
