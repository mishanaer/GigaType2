export function stripSingleTerminalPeriod(text) {
  const normalizedText = typeof text === "string" ? text.trim() : "";

  if (!normalizedText.endsWith(".") || normalizedText.endsWith("..")) {
    return normalizedText;
  }

  return normalizedText.slice(0, -1);
}
