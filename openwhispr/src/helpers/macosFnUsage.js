const { spawnSync } = require("child_process");

const APPLE_FN_USAGE_TYPE = Object.freeze({
  DO_NOTHING: 0,
  CHANGE_INPUT_SOURCE: 1,
  SHOW_EMOJI_AND_SYMBOLS: 2,
  START_DICTATION: 3,
});

const KNOWN_USAGE_TYPES = new Set(Object.values(APPLE_FN_USAGE_TYPE));

function parseAppleFnUsageType(rawValue) {
  const normalized = String(rawValue ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;

  const usageType = Number.parseInt(normalized, 10);
  return KNOWN_USAGE_TYPES.has(usageType) ? usageType : null;
}

function readAppleFnUsageType({
  platform = process.platform,
  spawnSyncFn = spawnSync,
} = {}) {
  if (platform !== "darwin") return null;

  try {
    const result = spawnSyncFn(
      "/usr/bin/defaults",
      ["read", "com.apple.HIToolbox", "AppleFnUsageType"],
      {
        encoding: "utf8",
        timeout: 1000,
        windowsHide: true,
      }
    );

    if (result?.error || result?.status !== 0) return null;
    return parseAppleFnUsageType(result.stdout);
  } catch {
    return null;
  }
}

function isFnUsageAvailable(usageType) {
  return usageType === APPLE_FN_USAGE_TYPE.DO_NOTHING;
}

function getMacosDefaultHotkey(usageType) {
  return isFnUsageAvailable(usageType) ? "GLOBE" : "RightOption";
}

module.exports = {
  APPLE_FN_USAGE_TYPE,
  getMacosDefaultHotkey,
  isFnUsageAvailable,
  parseAppleFnUsageType,
  readAppleFnUsageType,
};
