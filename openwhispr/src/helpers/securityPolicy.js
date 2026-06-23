const path = require("path");
const { fileURLToPath } = require("url");

const SAFE_EXTERNAL_PROTOCOLS = new Set(["https:", "mailto:"]);

function parseUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096) return null;

  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  return host === "localhost" || host === "::1" || host === "0.0.0.0" || host.startsWith("127.");
}

function isSafeExternalUrl(value, { allowLocalHttp = false } = {}) {
  const parsed = parseUrl(value);
  if (!parsed) return false;

  if (SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return true;
  }

  return parsed.protocol === "http:" && allowLocalHttp && isLoopbackHost(parsed.hostname);
}

function isAllowedDevServerUrl(parsed, devServerPort) {
  return (
    parsed.protocol === "http:" &&
    isLoopbackHost(parsed.hostname) &&
    String(parsed.port || "80") === String(devServerPort)
  );
}

function isAllowedAppFileUrl(parsed, appPath) {
  if (parsed.protocol !== "file:" || !appPath) return false;

  try {
    const requestedPath = path.resolve(fileURLToPath(parsed));
    const expectedPath = path.resolve(appPath, "src", "dist", "index.html");
    return requestedPath === expectedPath;
  } catch {
    return false;
  }
}

function isAllowedIpcSenderUrl(value, { appPath, devServerPort } = {}) {
  const parsed = parseUrl(value);
  if (!parsed) return false;

  return isAllowedDevServerUrl(parsed, devServerPort) || isAllowedAppFileUrl(parsed, appPath);
}

function isAllowedAppNavigation(value, { appUrl, appPath, appFilePath, devServerPort } = {}) {
  const parsed = parseUrl(value);
  if (!parsed) return false;

  if (parsed.protocol === "devtools:") {
    return true;
  }

  if (appUrl) {
    const allowed = parseUrl(appUrl);
    return (
      !!allowed &&
      parsed.protocol === allowed.protocol &&
      parsed.hostname === allowed.hostname &&
      String(parsed.port || "") === String(allowed.port || "") &&
      parsed.pathname === allowed.pathname
    );
  }

  if (appFilePath) {
    try {
      return parsed.protocol === "file:" && path.resolve(fileURLToPath(parsed)) === path.resolve(appFilePath);
    } catch {
      return false;
    }
  }

  return isAllowedDevServerUrl(parsed, devServerPort) || isAllowedAppFileUrl(parsed, appPath);
}

module.exports = {
  isAllowedAppNavigation,
  isAllowedIpcSenderUrl,
  isLoopbackHost,
  isSafeExternalUrl,
};
