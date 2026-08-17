#!/usr/bin/env node

// Compiles the protected-helper launcher (resources/macos-protected-gigaam-launcher.c).
//
// Signed protected builds ship the real helper inside a nested
// `TypeProtectedGigaAM.app` so it can carry an embedded provisioning profile —
// the only way AMFI grants it the Secure Enclave (keychain-access-groups)
// entitlements. This launcher keeps the spawn path the app uses
// (`Resources/bin/type-protected-gigaam`) pointing at something that execs the
// real helper inside that bundle. `afterPack.js` does the assembly.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "darwin") {
  process.exit(0);
}

const archIndex = process.argv.indexOf("--arch");
const targetArch =
  (archIndex !== -1 && process.argv[archIndex + 1]) || process.env.TARGET_ARCH || process.arch;

const ARCH_TO_CLANG = { arm64: "arm64", x64: "x86_64" };
const clangArch = ARCH_TO_CLANG[targetArch];
if (!clangArch) {
  console.error(`[protected-launcher] Unsupported architecture: ${targetArch}`);
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, "..");
const source = path.join(projectRoot, "resources", "macos-protected-gigaam-launcher.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const output = path.join(outputDir, "type-protected-gigaam-launcher");

if (!fs.existsSync(source)) {
  console.error(`[protected-launcher] Missing source: ${source}`);
  process.exit(1);
}
fs.mkdirSync(outputDir, { recursive: true });

// macOS 15 is the protected build's floor (the fp16 CoreML encoder loads from
// memory through an API introduced there), so the launcher matches it.
const result = spawnSync(
  "clang",
  [
    "-arch",
    clangArch,
    "-mmacosx-version-min=15.0",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    output,
    source,
  ],
  { stdio: "inherit" }
);

if (result.error) {
  console.error(`[protected-launcher] clang failed to run: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[protected-launcher] clang exited with ${result.status}`);
  process.exit(result.status ?? 1);
}

fs.chmodSync(output, 0o755);
console.log(`[protected-launcher] built ${path.relative(projectRoot, output)} (${clangArch})`);
