const GIGAAM_TRANSCRIPTION_PATH_RE = /\/audio\/(transcriptions|translations)\/?$/i;
const BUILT_IN_GIGAAM_API_BASE = "type-local://gigaam/v1";
const LEGACY_BUILT_IN_GIGAAM_API_BASE_RE =
  /^http:\/\/127\.0\.0\.1:(?:876[5-9]|877[0-5])\/v1(?:\/audio\/transcriptions)?\/?$/i;

function isBuiltInGigaamEndpoint(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  return (
    normalized === BUILT_IN_GIGAAM_API_BASE ||
    normalized === `${BUILT_IN_GIGAAM_API_BASE}/audio/transcriptions` ||
    LEGACY_BUILT_IN_GIGAAM_API_BASE_RE.test(normalized)
  );
}

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
  BUILT_IN_GIGAAM_API_BASE,
  isBuiltInGigaamEndpoint,
  resolveGigaamTranscriptionUrl,
};
