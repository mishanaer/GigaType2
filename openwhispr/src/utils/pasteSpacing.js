// Smart spacing between consecutive dictation pastes.
//
// Auto-paste inserts the transcription verbatim at the cursor, so two
// dictations in a row produce "…не куритьПотому что…". When the previous
// paste is recent and ended mid-word, prepend a single space.
//
// The time window bounds the main failure mode — the user moving the cursor
// to a different field/app between dictations, where a leading space may be
// unwanted (a leading space at a field start is harmless next to glued words).

export const SMART_SPACING_WINDOW_MS = 3 * 60 * 1000;

// Whitelist: only prepend a space when the next text starts like a word or an
// opening bracket/quote. A blacklist would inject spaces before slash-commands
// ("/remind" in Slack), "@mentions", "#tags" and other non-word starts, which
// can change their meaning entirely.
const NEEDS_SPACE_BEFORE = /^[\p{L}\p{N}([{«‹“‘]/u;

// Previous text endings that don't need a space after them: whitespace or
// newline, opening brackets, opening typographic quotes, hyphen (compound
// words like "кто-то" split across chunks), slash. Deliberately excluded:
// straight quotes ' and " (side-ambiguous — usually CLOSING at the end of a
// chunk, so a space is required) and em/en dashes (Russian typography spaces
// the dash on both sides: "Москва — столица").
const NO_SPACE_AFTER = /[\s([{«‹“‘\-/]$/u;

/**
 * @param {{ text: string, pastedAt: number } | null | undefined} previousPaste
 * @param {string} nextText
 * @param {number} [now]
 * @returns {"" | " "} prefix to prepend to nextText before pasting
 */
export function computeSmartSpacingPrefix(previousPaste, nextText, now = Date.now()) {
  if (!previousPaste || typeof previousPaste.text !== "string" || !previousPaste.text) {
    return "";
  }
  if (typeof nextText !== "string" || nextText.length === 0) {
    return "";
  }
  if (
    !Number.isFinite(previousPaste.pastedAt) ||
    Math.abs(now - previousPaste.pastedAt) > SMART_SPACING_WINDOW_MS
  ) {
    return "";
  }
  if (NO_SPACE_AFTER.test(previousPaste.text)) {
    return "";
  }
  if (!NEEDS_SPACE_BEFORE.test(nextText)) {
    return "";
  }
  return " ";
}
