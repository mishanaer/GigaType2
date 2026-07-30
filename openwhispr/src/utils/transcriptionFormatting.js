const HESITATION_E_PATTERN =
  /(?<![\p{L}\p{N}])э+(?:(?:[ \t]*[-–—][ \t]*э+)|(?:[ \t]*(?:\.[ \t]*\.[ \t]*\.|…)[ \t]*э*))*(?![\p{L}\p{N}])/giu;

export function stripSingleTerminalPeriod(text) {
  const normalizedText = typeof text === "string" ? text.trim() : "";

  if (!normalizedText.endsWith(".") || normalizedText.endsWith("..")) {
    return normalizedText;
  }

  return normalizedText.slice(0, -1);
}

export function stripHesitationEs(text) {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  const withoutHesitations = normalizedText.replace(HESITATION_E_PATTERN, "");

  if (withoutHesitations === normalizedText) {
    return normalizedText;
  }

  return withoutHesitations
    .replace(/[,;:][ \t]*([.!?])/g, "$1")
    .replace(/([.!?])[ \t]*[,;:]/g, "$1")
    .replace(/([.!?])(?:[ \t]+[.!?])+/g, "$1")
    .replace(/[ \t]+([,.;:!?…])/g, "$1")
    .replace(/([,;:])(?:[ \t]*[,;:])+/g, "$1")
    .replace(/^[ \t]*[,.;:!?…]+[ \t]*/gm, "")
    .replace(/[ \t]*[,;:]+[ \t]*$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

export function normalizeTranscriptionText(text) {
  return stripSingleTerminalPeriod(stripHesitationEs(text));
}
