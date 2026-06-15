const GIGAAM_TRANSCRIPTION_PATH_RE = /\/audio\/(transcriptions|translations)\/?$/i;

function resolveGigaamTranscriptionUrl(baseUrl) {
  const base = String(baseUrl || "").trim();
  if (!base) {
    throw new Error("GigaAM transcription endpoint is not configured");
  }

  const trimmed = base.replace(/\/+$/, "");
  if (GIGAAM_TRANSCRIPTION_PATH_RE.test(trimmed)) return trimmed;
  return `${trimmed}/audio/transcriptions`;
}

module.exports = {
  resolveGigaamTranscriptionUrl,
};
