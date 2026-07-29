#!/usr/bin/env node

// Downloads the GigaAM v3 CoreML encoder (Apple Neural Engine) and compiles it
// to the .mlmodelc form the app bundles, in resources/gigaam-ane/.
//
// Source: https://github.com/IsaacClarke2/gigaam-v3-coreml — an fp16 MLProgram
// conversion of the same istupakov/gigaam-v3-onnx weights the ONNX path uses.
// Only the encoder is converted; the RNN-T decoder/joint stay ONNX (7 MB) and
// still come from resources/gigaam-model/.
//
// Usage:
//   node scripts/download-gigaam-ane.js              # fp16 (default)
//   node scripts/download-gigaam-ane.js --variant int8
//   GIGAAM_ANE_VARIANT=int8 node scripts/download-gigaam-ane.js
//   node scripts/download-gigaam-ane.js --force      # re-download / recompile

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { downloadFile, extractZip } = require("./lib/download-utils");

const RELEASE_BASE = "https://github.com/IsaacClarke2/gigaam-v3-coreml/releases/download/v3.0";
const VARIANTS = {
  fp16: { asset: "gigaam-v3-encoder-ane.mlpackage.zip", minBytes: 380 * 1024 * 1024 },
  int8: { asset: "gigaam-v3-encoder-ane-int8.mlpackage.zip", minBytes: 180 * 1024 * 1024 },
};

const COMPILED_NAME = "encoder-ane.mlmodelc";

function log(message) {
  console.log(`[gigaam-ane] ${message}`);
}

function parseVariant() {
  const flagIndex = process.argv.indexOf("--variant");
  const raw =
    (flagIndex !== -1 && process.argv[flagIndex + 1]) || process.env.GIGAAM_ANE_VARIANT || "fp16";
  if (!VARIANTS[raw]) {
    console.error(
      `[gigaam-ane] Unknown variant "${raw}" (expected: ${Object.keys(VARIANTS).join(", ")})`
    );
    process.exit(1);
  }
  return raw;
}

// The compiled model is a directory; treat it as present only when CoreML's
// manifest and weights are both there (a half-written .mlmodelc is worse than
// none — CoreML fails at load time, deep inside the packaged app).
function isCompiledModelUsable(dir) {
  return (
    fs.existsSync(path.join(dir, "model.mil")) &&
    fs.existsSync(path.join(dir, "metadata.json")) &&
    fs.existsSync(path.join(dir, "weights"))
  );
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(full) : fs.statSync(full).size;
  }
  return total;
}

async function main() {
  if (process.platform !== "darwin") {
    log("not macOS — nothing to do");
    return;
  }

  const variant = parseVariant();
  const force = process.argv.includes("--force");
  const { asset, minBytes } = VARIANTS[variant];

  const projectRoot = path.resolve(__dirname, "..");
  const outputDir = path.join(projectRoot, "resources", "gigaam-ane");
  const compiledDir = path.join(outputDir, COMPILED_NAME);
  const variantFile = path.join(outputDir, ".variant");

  if (!force && isCompiledModelUsable(compiledDir)) {
    const current = fs.existsSync(variantFile) ? fs.readFileSync(variantFile, "utf8").trim() : "";
    if (current === variant) {
      log(`${COMPILED_NAME} (${variant}) already present — skipping`);
      return;
    }
    log(`replacing existing ${current || "unknown"} model with ${variant}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const zipPath = path.join(outputDir, asset);
  const needsDownload = force || !fs.existsSync(zipPath) || fs.statSync(zipPath).size < minBytes;
  if (needsDownload) {
    log(`downloading ${asset} …`);
    await downloadFile(`${RELEASE_BASE}/${asset}`, zipPath);
  } else {
    log(`reusing ${asset} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(0)} MB)`);
  }
  if (fs.statSync(zipPath).size < minBytes) {
    throw new Error(`${asset} looks truncated (${fs.statSync(zipPath).size} bytes)`);
  }

  const stagingDir = path.join(outputDir, ".staging");
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  log("extracting …");
  await extractZip(zipPath, stagingDir);

  const packageDir = findMlPackage(stagingDir);
  if (!packageDir) {
    throw new Error(`no .mlpackage found inside ${asset}`);
  }

  // Compile at build time so a fresh install never pays for it (this is what
  // Xcode does with models in an app bundle). The per-device ANE specialization
  // is separate and still happens once, on first load — the helper warms it up
  // during engine startup.
  log("compiling to .mlmodelc (coremlcompiler) …");
  const compileTarget = path.join(outputDir, ".compiled");
  fs.rmSync(compileTarget, { recursive: true, force: true });
  fs.mkdirSync(compileTarget, { recursive: true });
  const compile = spawnSync("xcrun", ["coremlcompiler", "compile", packageDir, compileTarget], {
    stdio: "inherit",
  });
  if (compile.status !== 0) {
    throw new Error(
      "coremlcompiler failed — full Xcode (not just Command Line Tools) is required to prepare the ANE model"
    );
  }
  const produced = fs.readdirSync(compileTarget).find((name) => name.endsWith(".mlmodelc"));
  if (!produced) {
    throw new Error("coremlcompiler produced no .mlmodelc");
  }

  fs.rmSync(compiledDir, { recursive: true, force: true });
  fs.renameSync(path.join(compileTarget, produced), compiledDir);
  fs.rmSync(compileTarget, { recursive: true, force: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.writeFileSync(variantFile, `${variant}\n`);

  if (!isCompiledModelUsable(compiledDir)) {
    throw new Error(`${compiledDir} is missing model.mil/metadata.json/weights after compilation`);
  }
  log(
    `ready: ${path.relative(projectRoot, compiledDir)} (${variant}, ${(
      dirSizeBytes(compiledDir) /
      1024 /
      1024
    ).toFixed(0)} MB)`
  );
}

function findMlPackage(dir, depth = 0) {
  if (depth > 4) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("__MACOSX")) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.endsWith(".mlpackage")) return full;
    const nested = findMlPackage(full, depth + 1);
    if (nested) return nested;
  }
  return null;
}

main().catch((error) => {
  console.error(`[gigaam-ane] ${error.message}`);
  process.exit(1);
});
