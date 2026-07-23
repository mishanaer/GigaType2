const assert = require("node:assert/strict");
const test = require("node:test");

const { CONTRACT_VERSION, mapEvent } = require("../../src/helpers/tractionEventMapper");

test("forwards every dictation outcome with the shared event id", () => {
  const event = mapEvent("dictation_finished", {
    event_id: "evt-1",
    outcome: "transcription_failed",
    audio_duration_ms: 4200,
    final_output_words: 0,
    total_latency_ms: 980,
    safe_message: "must not leave telemetry",
  });

  assert.equal(event.name, "dictation_finished");
  assert.equal(event.event_id, "evt-1");
  assert.deepEqual(event.properties, {
    contract_version: CONTRACT_VERSION,
    event_id: "evt-1",
    outcome: "transcription_failed",
    audio_duration_ms: 4200,
    final_output_words: 0,
    total_latency_ms: 980,
  });
});

test("keeps funnel events and rejects unrelated telemetry", () => {
  assert.deepEqual(mapEvent("requirements_ready", { event_id: "evt-2", microphone_ready: true }), {
    name: "requirements_ready",
    event_id: "evt-2",
    properties: { contract_version: CONTRACT_VERSION, event_id: "evt-2", microphone_ready: true },
  });
  assert.equal(mapEvent("settings_screen_viewed", { event_id: "evt-3" }), null);
});
