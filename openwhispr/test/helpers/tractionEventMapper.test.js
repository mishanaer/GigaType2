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

test("forwards the permission funnel and drops unlisted fields", () => {
  const event = mapEvent("permission_result", {
    event_id: "evt-p",
    permission: "microphone",
    status: "denied",
    os_status: "denied",
    trigger: "user_request",
    raw_error: "must not leave telemetry",
  });
  assert.equal(event.name, "permission_result");
  assert.deepEqual(event.properties, {
    contract_version: CONTRACT_VERSION,
    event_id: "evt-p",
    permission: "microphone",
    status: "denied",
    os_status: "denied",
    trigger: "user_request",
  });
  assert.ok(mapEvent("requirement_status_changed", { requirement: "paste_tool", ready: true }));
  assert.ok(mapEvent("all_required_permissions_granted", { permission_type: "macos_accessibility" }));
});

test("forwards the dictation sub-funnel without free-text", () => {
  for (const name of [
    "dictation_started",
    "dictation_audio_captured",
    "dictation_transcribed",
    "dictation_output_attempted",
    "dictation_output_succeeded",
  ]) {
    const event = mapEvent(name, { session_id: "s1", status: "ok", safe_message: "leak?" });
    assert.equal(event.name, name);
    assert.equal(event.properties.session_id, "s1");
    assert.equal(event.properties.safe_message, undefined);
  }
});
