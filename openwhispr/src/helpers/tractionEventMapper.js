const CONTRACT_VERSION = 2;

const COMMON_PROPERTIES = [
  "event_id",
  "app_version",
  "app_channel",
  "platform",
  "platform_name",
  "arch",
];

const EVENT_PROPERTIES = {
  first_app_opened: [],
  app_opened: [],
  requirements_ready: [
    "microphone_ready",
    "macos_accessibility_ready",
    "windows_paste_tool_ready",
    "linux_paste_tool_ready",
  ],
  model_ready: ["source", "model", "provider"],
  dictation_finished: [
    "session_id",
    "activation_mode",
    "trigger",
    "provider",
    "model",
    "audio_duration_ms",
    "raw_transcript_chars",
    "raw_transcript_words",
    "final_output_chars",
    "final_output_words",
    "output_method",
    "output_status",
    "success",
    "outcome",
    "total_latency_ms",
    "transcription_latency_ms",
    "output_latency_ms",
    "error_area",
    "error_code",
    "reason",
  ],
  error_occurred: ["session_id", "error_area", "error_code", "reason"],
  main_process_error: ["error_area", "error_code", "reason"],
  renderer_process_gone: ["error_area", "error_code", "reason", "exit_code"],
  app_crashed: ["error_area", "error_code", "reason", "exit_code"],
};

function mapEvent(event, properties = {}) {
  const eventKeys = EVENT_PROPERTIES[event];
  if (!eventKeys) return null;

  const allowed = new Set([...COMMON_PROPERTIES, ...eventKeys]);
  const output = { contract_version: CONTRACT_VERSION };
  for (const [key, value] of Object.entries(properties)) {
    if (allowed.has(key) && value != null) output[key] = value;
  }
  return { name: event, event_id: output.event_id || null, properties: output };
}

module.exports = { CONTRACT_VERSION, mapEvent };
