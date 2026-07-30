// A hesitation must not end mid-chain: without the dash alternative in the trailing
// lookahead, "А-а-абсолютно" backtracks to a "А-а" match and leaves a stray "-абсолютно".
// Rejecting a boundary that is itself a dash + word character makes the whole match fail
// instead, so ambiguous input is left untouched.
const HESITATION_BOUNDARY = String.raw`(?![\p{L}\p{N}]|[ \t]*[-–—][ \t]*[\p{L}\p{N}])`;
const HESITATION_E_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}])э+(?:(?:[ \t]*[-–—][ \t]*э+)|(?:[ \t]*(?:\.[ \t]*\.[ \t]*\.|…)[ \t]*э*))*` +
    HESITATION_BOUNDARY,
  "giu"
);
const HESITATION_A_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}])а+(?:[ \t]*[-–—][ \t]*а+)+(?:[ \t]*(?:\.[ \t]*\.[ \t]*\.|…))?` +
    HESITATION_BOUNDARY,
  "giu"
);

export function stripSingleTerminalPeriod(text) {
  const normalizedText = typeof text === "string" ? text.trim() : "";

  if (!normalizedText.endsWith(".") || normalizedText.endsWith("..")) {
    return normalizedText;
  }

  return normalizedText.slice(0, -1);
}

export function stripHesitationEs(text) {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  const withoutHesitations = normalizedText
    .replace(HESITATION_E_PATTERN, "")
    .replace(HESITATION_A_PATTERN, "");

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
