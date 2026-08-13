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

// Next text that attaches to the previous word without a space:
// whitespace, closing punctuation/brackets/quotes, percent/degree signs.
const NO_SPACE_BEFORE = /^[\s.,!?;:…)\]}»›”’'"%°]/u;

// Previous text endings that don't need a space after them:
// whitespace/newline, opening brackets/quotes, dashes, slash.
const NO_SPACE_AFTER = /[\s([{«‹“‘'"—–\-/]$/u;

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
    now - previousPaste.pastedAt > SMART_SPACING_WINDOW_MS ||
    now < previousPaste.pastedAt
  ) {
    return "";
  }
  if (NO_SPACE_AFTER.test(previousPaste.text)) {
    return "";
  }
  if (NO_SPACE_BEFORE.test(nextText)) {
    return "";
  }
  return " ";
}
