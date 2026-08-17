const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const CURRENT_BUNDLE_ID = "ai.gigatype.app";
const LEGACY_BUNDLE_IDS = ["com.gizmolabs.openwhispr", "com.herotools.openwispr"];
const REPAIR_MARKER = ".accessibility-tcc-repaired-v1";

function runTccReset(bundleId, execFileImpl = execFile) {
  return new Promise((resolve) => {
    execFileImpl(
      "/usr/bin/tccutil",
      ["reset", "Accessibility", bundleId],
      { timeout: 5000, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          bundleId,
          success: !error,
          error: error?.message || null,
          output: `${stdout || ""}${stderr || ""}`.trim(),
        });
      }
    );
  });
}

async function repairLegacyAccessibilityIfNeeded(options) {
  const {
    platform,
    isPackaged,
    isTrusted,
    hasExistingUserData,
    userDataPath,
    execFileImpl = execFile,
    fsImpl = fs,
  } = options;

  if (platform !== "darwin" || !isPackaged || isTrusted || !hasExistingUserData || !userDataPath) {
    return { attempted: false, reason: "not-applicable", results: [] };
  }

  const markerPath = path.join(userDataPath, REPAIR_MARKER);
  if (fsImpl.existsSync(markerPath)) {
    return { attempted: false, reason: "already-attempted", results: [] };
  }

  // Old Type builds used different bundle IDs, while some hand-signed builds
  // used the current ID with a different code requirement. System Settings can
  // then show a checked "Type" row that does not authorize this process. Reset
  // only Type's known Accessibility records, after an explicit user click, so
  // macOS can register the currently running signed app again.
  const results = [];
  for (const bundleId of [...LEGACY_BUNDLE_IDS, CURRENT_BUNDLE_ID]) {
    results.push(await runTccReset(bundleId, execFileImpl));
  }

  try {
    fsImpl.writeFileSync(
      markerPath,
      JSON.stringify({ repairedAt: new Date().toISOString(), results }, null, 2),
      { mode: 0o600 }
    );
  } catch {
    // Best effort. A read-only userData directory may repeat the repair on the
    // next explicit permission click, which is safer than blocking onboarding.
  }

  return { attempted: true, reason: "legacy-user", results };
}

module.exports = {
  CURRENT_BUNDLE_ID,
  LEGACY_BUNDLE_IDS,
  REPAIR_MARKER,
  repairLegacyAccessibilityIfNeeded,
  runTccReset,
};
