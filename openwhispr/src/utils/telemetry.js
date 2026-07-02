export function countWords(value) {
  if (typeof value !== "string") return 0;
  const normalized = value.trim();
  if (!normalized) return 0;
  return normalized.split(/\s+/).filter(Boolean).length;
}

export function textMetrics(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return {
    chars: text.length,
    words: countWords(text),
  };
}

export function getOutputStatus(result) {
  if (!result) return "failed";
  if (result.fallback === true) return "clipboard_fallback";
  if (result.inserted === true && result.verified === true) return "inserted_verified";
  if (result.inserted === true) return "inserted_unverified";
  return "failed";
}

export function getOutputMethod(outputStatus) {
  return outputStatus === "clipboard_fallback" ? "clipboard" : "paste";
}

export async function trackTelemetryEvent(eventName, properties = {}, options = {}) {
  try {
    return await window.electronAPI?.trackTelemetryEvent?.(eventName, properties, options);
  } catch {
    return { queued: false, reason: "telemetry-error" };
  }
}
