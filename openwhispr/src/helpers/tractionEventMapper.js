const CONTRACT_VERSION = 2;

const COMMON_PROPERTIES = [
  "event_id",
  "app_version",
  "app_channel",
  "platform",
  "platform_name",
  "arch",
];

// Shared by dictation_output_attempted / _succeeded (identical payload).
const DICTATION_OUTPUT_PROPERTIES = [
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
  "output_latency_ms",
  "total_latency_ms",
  "transcription_latency_ms",
  "success",
  "status",
  "output_attempted",
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
  // --- Permission funnel (mirrors MultiTool's "Запрошенные permissions") ---
  // OS permission prompts: how many installs are asked and how many grant/deny.
  permission_result: ["permission", "status", "os_status", "trigger"],
  // Per-requirement status transitions (mic / accessibility / paste tool) and
  // the "everything required is granted" milestone. Both were ALREADY emitted
  // by the renderer but dropped here, so setup drop-off was invisible.
  requirement_status_changed: [
    "requirement",
    "ready",
    "permission_type",
    "microphone_ready",
    "macos_accessibility_ready",
    "windows_paste_tool_ready",
    "linux_paste_tool_ready",
  ],
  all_required_permissions_granted: [
    "permission_type",
    "microphone_ready",
    "macos_accessibility_ready",
    "windows_paste_tool_ready",
    "linux_paste_tool_ready",
  ],
  // --- Dictation sub-funnel ---
  // dictation_finished is the outcome; these expose WHERE a dictation drops off
  // (started → audio captured → transcribed → output). All were already emitted
  // and silently dropped, so only end-to-end successes/failures were visible.
  dictation_started: ["session_id", "activation_mode", "trigger"],
  dictation_audio_captured: [
    "session_id",
    "activation_mode",
    "trigger",
    "audio_duration_ms",
    "status",
  ],
  dictation_transcribed: [
    "session_id",
    "activation_mode",
    "trigger",
    "provider",
    "model",
    "audio_duration_ms",
    "raw_transcript_chars",
    "raw_transcript_words",
    "transcription_latency_ms",
    "total_latency_ms",
    "status",
    "transcribed",
    "error_code",
  ],
  dictation_output_attempted: DICTATION_OUTPUT_PROPERTIES,
  dictation_output_succeeded: DICTATION_OUTPUT_PROPERTIES,
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
