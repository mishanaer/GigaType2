const test = require("node:test");
const assert = require("node:assert/strict");

test("sanitizeSpeechVadConfig applies defaults and clamps invalid values", async () => {
  const { DEFAULT_SPEECH_VAD_CONFIG, sanitizeSpeechVadConfig } = await import(
    "../../src/helpers/speechVadConfig.js"
  );

  const cfg = sanitizeSpeechVadConfig({
    threshold: 99,
    minSpeechDurationMs: -20,
    minSilenceDurationMs: "bad",
    maxSpeechDurationS: 0,
    speechPadMs: null,
    samplesOverlap: -1,
  });

  assert.deepEqual(cfg, {
    threshold: 0.95,
    minSpeechDurationMs: 50,
    minSilenceDurationMs: DEFAULT_SPEECH_VAD_CONFIG.minSilenceDurationMs,
    maxSpeechDurationS: 5,
    speechPadMs: DEFAULT_SPEECH_VAD_CONFIG.speechPadMs,
    samplesOverlap: 0,
  });
});
