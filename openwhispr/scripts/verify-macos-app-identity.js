#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const EXPECTED_BUNDLE_ID = "ai.gigatype.app";
const EXPECTED_TEAM_ID = "SBHVKH5UUY";

function parseCodesignDetails(output) {
  const details = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    details[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return details;
}

function readBundleId(appPath, execFileSyncImpl = execFileSync) {
  return execFileSyncImpl(
    "/usr/bin/plutil",
    [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      path.join(appPath, "Contents", "Info.plist"),
    ],
    { encoding: "utf8" }
  ).trim();
}

function readCodesignDetails(appPath, spawnSyncImpl = spawnSync) {
  // `codesign -d` writes its details to stderr even on success, so execFileSync
  // would silently return an empty stdout buffer here.
  const result = spawnSyncImpl("/usr/bin/codesign", ["-d", "--verbose=4", appPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  const details = parseCodesignDetails(output);
  if (result?.error) throw result.error;
  if (result?.status !== 0 && !details.Identifier && !details.TeamIdentifier) {
    throw new Error(output.trim() || `codesign exited with status ${result?.status}`);
  }
  return details;
}

function verifyBundle(appPath, options = {}) {
  const {
    allowUnsigned = false,
    expectedBundleId = EXPECTED_BUNDLE_ID,
    expectedTeamId = EXPECTED_TEAM_ID,
    execFileSyncImpl = execFileSync,
    spawnSyncImpl = spawnSync,
  } = options;
  const bundleId = readBundleId(appPath, execFileSyncImpl);
  if (bundleId !== expectedBundleId) {
    throw new Error(`${appPath}: bundle id ${bundleId} != ${expectedBundleId}`);
  }

  let signing;
  try {
    signing = readCodesignDetails(appPath, spawnSyncImpl);
  } catch (error) {
    if (allowUnsigned) return { appPath, bundleId, teamId: null, unsigned: true };
    throw new Error(`${appPath}: missing or unreadable code signature (${error.message})`);
  }

  const teamId = signing.TeamIdentifier;
  if ((!teamId || teamId === "not set") && allowUnsigned) {
    return { appPath, bundleId, teamId: null, unsigned: true };
  }
  if (teamId !== expectedTeamId) {
    throw new Error(`${appPath}: TeamIdentifier ${teamId || "<missing>"} != ${expectedTeamId}`);
  }
  if (signing.Identifier !== expectedBundleId) {
    throw new Error(
      `${appPath}: signed Identifier ${signing.Identifier || "<missing>"} != ${expectedBundleId}`
    );
  }

  return { appPath, bundleId, teamId, unsigned: false };
}

function verifyMacAppIdentity(appPath, options = {}) {
  const outer = verifyBundle(appPath, options);
  const nested = path.join(appPath, "Contents", "Resources", "bin", "TypeProtectedGigaAM.app");
  const results = [outer];
  if (fs.existsSync(nested)) {
    results.push(verifyBundle(nested, options));
  }
  return results;
}

function main(argv) {
  const allowUnsigned = argv.includes("--allow-unsigned");
  const appPath = argv.find((argument) => argument !== "--allow-unsigned");
  if (!appPath) {
    throw new Error("usage: verify-macos-app-identity.js [--allow-unsigned] /path/to/Type.app");
  }

  const results = verifyMacAppIdentity(path.resolve(appPath), { allowUnsigned });
  for (const result of results) {
    const identity = result.unsigned ? "unsigned (allowed)" : `team ${result.teamId}`;
    console.log(`verified ${result.appPath}: ${result.bundleId}, ${identity}`);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`macOS identity verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPECTED_BUNDLE_ID,
  EXPECTED_TEAM_ID,
  parseCodesignDetails,
  readCodesignDetails,
  verifyBundle,
  verifyMacAppIdentity,
};
