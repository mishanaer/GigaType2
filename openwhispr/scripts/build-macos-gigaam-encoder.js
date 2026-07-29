#!/usr/bin/env node

// Compiles resources/macos-gigaam-encoder.swift — the CoreML/ANE helper that
// runs the GigaAM v3 encoder for the ONNX utility process. Same shape as the
// other macos-* helper builders (arch via --arch/TARGET_ARCH, hash + mtime
// caching, Mach-O arch verification), with one difference: the CoreML APIs it
// uses and the fp16 MLProgram it loads both need macOS 14, so the deployment
// target is 14.0 rather than the 11.0/10.15 the other helpers use.

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const isMac = process.platform === "darwin";
if (!isMac) {
  process.exit(0);
}

const archIndex = process.argv.indexOf("--arch");
const targetArch =
  (archIndex !== -1 && process.argv[archIndex + 1]) || process.env.TARGET_ARCH || process.arch;

const ARCH_TO_TARGET = {
  arm64: "arm64-apple-macosx14.0",
  x64: "x86_64-apple-macosx14.0",
};
const swiftTarget = ARCH_TO_TARGET[targetArch];
if (!swiftTarget) {
  console.error(`[gigaam-encoder] Unsupported architecture: ${targetArch}`);
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, "..");
const swiftSource = path.join(projectRoot, "resources", "macos-gigaam-encoder.swift");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "macos-gigaam-encoder");
const hashFile = path.join(outputDir, `.macos-gigaam-encoder.${targetArch}.hash`);
const moduleCacheDir = path.join(outputDir, ".swift-module-cache");

const ARCH_CPU_TYPE = {
  arm64: 0x0100000c, // CPU_TYPE_ARM64
  x64: 0x01000007, // CPU_TYPE_X86_64
};

function log(message) {
  console.log(`[gigaam-encoder] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function verifyBinaryArch(binaryPath, expectedArch) {
  try {
    const fd = fs.openSync(binaryPath, "r");
    const header = Buffer.alloc(8);
    fs.readSync(fd, header, 0, 8, 0);
    fs.closeSync(fd);

    const magic = header.readUInt32LE(0);
    if (magic !== 0xfeedfacf) {
      return false;
    }
    return header.readInt32LE(4) === ARCH_CPU_TYPE[expectedArch];
  } catch {
    return false;
  }
}

if (!fs.existsSync(swiftSource)) {
  console.error(`[gigaam-encoder] Swift source not found at ${swiftSource}`);
  process.exit(1);
}

ensureDir(outputDir);
ensureDir(moduleCacheDir);

let needsBuild = true;
if (fs.existsSync(outputBinary)) {
  if (!verifyBinaryArch(outputBinary, targetArch)) {
    log(`Existing binary is wrong architecture (expected ${targetArch}), rebuild needed`);
  } else {
    try {
      const binaryStat = fs.statSync(outputBinary);
      const sourceStat = fs.statSync(swiftSource);
      if (binaryStat.mtimeMs >= sourceStat.mtimeMs) {
        needsBuild = false;
      }
    } catch {
      needsBuild = true;
    }
  }
}

if (!needsBuild && fs.existsSync(outputBinary)) {
  try {
    const currentHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(swiftSource, "utf8"))
      .digest("hex");
    if (fs.existsSync(hashFile)) {
      if (fs.readFileSync(hashFile, "utf8").trim() !== currentHash) {
        log("Source hash changed, rebuild needed");
        needsBuild = true;
      }
    } else {
      log(`No hash file for ${targetArch}, rebuild needed`);
      needsBuild = true;
    }
  } catch (err) {
    log(`Hash check failed: ${err.message}, forcing rebuild`);
    needsBuild = true;
  }
}

if (!needsBuild) {
  process.exit(0);
}

function attemptCompile(command, args) {
  log(`Compiling with ${[command, ...args].join(" ")}`);
  return spawnSync(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      SWIFT_MODULE_CACHE_PATH: moduleCacheDir,
    },
  });
}

const compileArgs = [
  swiftSource,
  "-O",
  "-target",
  swiftTarget,
  "-module-cache-path",
  moduleCacheDir,
  "-o",
  outputBinary,
  "-framework",
  "CoreML",
  "-framework",
  "Foundation",
];

let result = attemptCompile("xcrun", ["swiftc", ...compileArgs]);

if (result.status !== 0) {
  result = attemptCompile("swiftc", compileArgs);
}

if (result.status !== 0) {
  console.error("[gigaam-encoder] Failed to compile macOS GigaAM ANE encoder helper.");
  process.exit(result.status ?? 1);
}

try {
  fs.chmodSync(outputBinary, 0o755);
} catch (error) {
  console.warn(`[gigaam-encoder] Unable to set executable permissions: ${error.message}`);
}

if (!verifyBinaryArch(outputBinary, targetArch)) {
  console.error(
    `[gigaam-encoder] FATAL: Compiled binary architecture does not match target (${targetArch}). ` +
      `This can happen when cross-compiling without setting TARGET_ARCH env var.`
  );
  process.exit(1);
}

try {
  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(swiftSource, "utf8"))
    .digest("hex");
  fs.writeFileSync(hashFile, hash);
} catch (err) {
  log(`Warning: Could not save source hash: ${err.message}`);
}

log(`Successfully built macOS GigaAM ANE encoder helper (${targetArch}).`);
