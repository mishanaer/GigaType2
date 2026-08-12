// electron-builder afterPack hook
//
// Runs after electron-builder assembles the output directory but before the
// final installer (DMG/NSIS/AppImage) is created. Operates only on the output
// directory — never touches source node_modules/.
//
// 1. Strips non-target platform/arch binaries from onnxruntime-node
//    (saves 150–180 MB per build).
// 2. Removes macOS extended attributes that break Developer ID signing.
// 3. Wraps the Linux binary in a shell script that forces XWayland and
//    reads user flags from ~/.config/open-whispr-flags.conf.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Arch } = require("app-builder-lib");
const {
  MODEL_FILES: GIGAAM_MODEL_FILES,
  assertModelDir: assertGigaamModelDir,
} = require("./lib/gigaam-model-package");

// ---------------------------------------------------------------------------
// macOS resource binary signing
// ---------------------------------------------------------------------------

function resolveAppPath(context) {
  if (context.electronPlatformName !== "darwin") {
    return context.appOutDir;
  }

  if (context.appOutDir.endsWith(".app")) {
    return context.appOutDir;
  }

  return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
}

function resolveResourcesDir(context) {
  return context.electronPlatformName === "darwin"
    ? path.join(resolveAppPath(context), "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
}

function collectFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function collectPaths(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const paths = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    paths.push(currentDir);
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile()) {
        paths.push(fullPath);
      }
    }
  }

  return paths;
}

function isMachOBinary(filePath) {
  try {
    const description = execFileSync("file", ["-b", filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return description.includes("Mach-O");
  } catch {
    return false;
  }
}

function registerMacResourceBinariesForSigning(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const resourcesDir = resolveResourcesDir(context);
  const machOFiles = collectFiles(resourcesDir).filter(isMachOBinary);

  if (machOFiles.length === 0) {
    return;
  }

  const macConfig = context.packager.platformSpecificBuildOptions;
  const existingBinaries = Array.isArray(macConfig.binaries) ? macConfig.binaries : [];

  macConfig.binaries = [...new Set([...existingBinaries, ...machOFiles])];

  console.log(
    `  afterPack: registered ${machOFiles.length} Mach-O files under Contents/Resources for signing`
  );
}

function clearMacExtendedAttributes(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = resolveAppPath(context);
  if (!fs.existsSync(appPath)) {
    return;
  }

  try {
    execFileSync("xattr", ["-cr", appPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    const disallowedAttrs = [
      "com.apple.FinderInfo",
      "com.apple.fileprovider.fpfs#P",
      "com.apple.ResourceFork",
      "com.apple.quarantine",
    ];

    for (const filePath of collectPaths(appPath)) {
      for (const attr of disallowedAttrs) {
        try {
          execFileSync("xattr", ["-d", attr, filePath], {
            stdio: ["ignore", "ignore", "ignore"],
          });
        } catch {
          // Missing xattrs are expected for almost every file.
        }
      }
    }

    console.log("  afterPack: cleared macOS extended attributes before signing");
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`Failed to clear macOS extended attributes: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// onnxruntime-node binary stripping
// ---------------------------------------------------------------------------

function stripOnnxruntimeBinaries(context) {
  const platform = context.electronPlatformName; // darwin | linux | win32
  const archName = Arch[context.arch]; // x64 | arm64 | ia32 | universal

  // Resolve the resources directory inside the packed output
  const resourcesDir = resolveResourcesDir(context);

  const onnxBinDir = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v6"
  );

  if (!fs.existsSync(onnxBinDir)) return;

  // For universal macOS builds keep both arm64 and x64 under darwin/
  const keepArchs = archName === "universal" ? ["arm64", "x64"] : [archName];

  const platformDirs = fs.readdirSync(onnxBinDir);
  let totalRemoved = 0;

  for (const dir of platformDirs) {
    const fullPath = path.join(onnxBinDir, dir);
    if (!fs.statSync(fullPath).isDirectory()) continue;

    if (dir !== platform) {
      // Wrong platform — remove entirely
      fs.rmSync(fullPath, { recursive: true, force: true });
      totalRemoved++;
      continue;
    }

    // Right platform — strip non-target architectures
    const archDirs = fs.readdirSync(fullPath);
    for (const arch of archDirs) {
      const archPath = path.join(fullPath, arch);
      if (!fs.statSync(archPath).isDirectory()) continue;
      if (!keepArchs.includes(arch)) {
        fs.rmSync(archPath, { recursive: true, force: true });
        totalRemoved++;
      }
    }
  }

  if (totalRemoved > 0) {
    console.log(
      `  afterPack: stripped ${totalRemoved} non-target onnxruntime-node directories (keeping ${platform}/${keepArchs.join(",")})`
    );
  }

  // The app only uses the CPU execution provider (see SESSION_OPTIONS in
  // onnxWorker.js), so onnxruntime-node's DirectML provider payload (~36 MB)
  // is dead weight on Windows. onnxruntime.dll loads these lazily and only
  // when the DML EP is requested.
  if (platform === "win32") {
    const dmlFiles = ["DirectML.dll", "dxcompiler.dll", "dxil.dll"];
    let dmlRemoved = 0;
    for (const arch of keepArchs) {
      for (const name of dmlFiles) {
        const dmlPath = path.join(onnxBinDir, platform, arch, name);
        if (fs.existsSync(dmlPath)) {
          fs.rmSync(dmlPath, { force: true });
          dmlRemoved++;
        }
      }
    }
    if (dmlRemoved > 0) {
      console.log(`  afterPack: removed ${dmlRemoved} DirectML provider DLLs (CPU EP only)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Resource bin stripping
// ---------------------------------------------------------------------------

function stripResourceBinaries(context) {
  const platform = context.electronPlatformName; // darwin | linux | win32
  const archName = Arch[context.arch]; // x64 | arm64 | ia32 | universal

  const resourcesDir = resolveResourcesDir(context);
  const binDir = path.join(resourcesDir, "bin");

  if (!fs.existsSync(binDir)) return;

  const keepArchs = archName === "universal" ? ["arm64", "x64"] : [archName];
  let totalRemoved = 0;

  for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    const fullPath = path.join(binDir, name);

    // Wrong-platform artifacts by file type — protects cross-builds when the
    // shared resources/bin holds binaries from another target platform.
    if (
      platform !== "darwin" &&
      (name.endsWith(".dylib") || (entry.isFile() && isMachOBinary(fullPath)))
    ) {
      fs.rmSync(fullPath, { force: true });
      totalRemoved++;
      continue;
    }
    if (platform !== "win32" && (name.endsWith(".dll") || name.endsWith(".exe"))) {
      fs.rmSync(fullPath, { force: true });
      totalRemoved++;
      continue;
    }
    if (platform !== "linux" && /\.so(\.|$)/.test(name)) {
      fs.rmSync(fullPath, { force: true });
      totalRemoved++;
      continue;
    }

    // OS-prefixed binaries: windows-*, linux-*, macos-*
    if (name.startsWith("windows-") && platform !== "win32") {
      fs.rmSync(fullPath, { force: true });
      totalRemoved++;
      continue;
    }
    if (name.startsWith("linux-") && platform !== "linux") {
      fs.rmSync(fullPath, { force: true });
      totalRemoved++;
      continue;
    }
    if (name.startsWith("macos-") && platform !== "darwin") {
      fs.rmSync(fullPath, { force: true });
      totalRemoved++;
      continue;
    }

    // Platform+arch suffix: {name}-{platform}-{arch}
    // e.g. gigatype-sidecar-darwin-arm64, qdrant-linux-x64, llama-server-win32-x64
    const platformArchMatch = name.match(/^(.+)-(darwin|linux|win32)-(x64|arm64|ia32)(.*)$/);
    if (platformArchMatch) {
      const filePlatform = platformArchMatch[2];
      const fileArch = platformArchMatch[3];
      if (filePlatform !== platform || !keepArchs.includes(fileArch)) {
        fs.rmSync(fullPath, { force: true });
        totalRemoved++;
      }
      continue;
    }

    // Platform-only suffix: {name}-{platform}
    // e.g. sherpa-onnx-diarize-darwin
    const platformMatch = name.match(/^(.+)-(darwin|linux|win32)(.*)$/);
    if (platformMatch) {
      const filePlatform = platformMatch[2];
      if (filePlatform !== platform) {
        fs.rmSync(fullPath, { force: true });
        totalRemoved++;
      }
      continue;
    }
  }

  if (totalRemoved > 0) {
    console.log(
      `  afterPack: stripped ${totalRemoved} non-target resource binaries from bin/ (keeping ${platform}/${keepArchs.join(",")})`
    );
  }
}

// ---------------------------------------------------------------------------
// Fat Mach-O thinning
// ---------------------------------------------------------------------------

// lipo arch names differ from electron-builder's: x64 -> x86_64.
const LIPO_ARCH = { arm64: "arm64", x64: "x86_64" };

function thinFatBinaries(context) {
  if (context.electronPlatformName !== "darwin") return;

  const archName = Arch[context.arch];
  if (archName === "universal") return;

  const lipoArch = LIPO_ARCH[archName];
  if (!lipoArch) return;

  const binDir = path.join(resolveResourcesDir(context), "bin");
  let thinned = 0;
  let savedBytes = 0;

  for (const filePath of collectFiles(binDir)) {
    let archs;
    try {
      archs = execFileSync("lipo", ["-archs", filePath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split(/\s+/);
    } catch {
      continue; // not a Mach-O file
    }

    if (archs.length < 2 || !archs.includes(lipoArch)) continue;

    const before = fs.statSync(filePath).size;
    execFileSync("lipo", ["-thin", lipoArch, "-output", filePath, filePath]);
    savedBytes += before - fs.statSync(filePath).size;
    thinned++;
  }

  if (thinned > 0) {
    console.log(
      `  afterPack: thinned ${thinned} fat binaries to ${lipoArch} (saved ${(savedBytes / 1024 / 1024).toFixed(1)} MB)`
    );
  }
}

// ---------------------------------------------------------------------------
// onnxruntime dylib dedupe (macOS)
// ---------------------------------------------------------------------------

// sherpa-onnx dylibs in Resources/bin link @rpath/libonnxruntime.<ver>.dylib,
// and onnxruntime-node ships the identical official ORT dylib inside
// app.asar.unpacked. When the versioned filenames match exactly, replace the
// bin copy with a relative symlink so only one ~34 MB runtime ships. On a
// version mismatch both copies are kept (safe fallback).
function dedupeOnnxruntimeDylib(context) {
  if (context.electronPlatformName !== "darwin") return;

  const archName = Arch[context.arch];
  if (archName !== "arm64" && archName !== "x64") return;

  const resourcesDir = resolveResourcesDir(context);
  const binDir = path.join(resourcesDir, "bin");
  if (!fs.existsSync(binDir)) return;

  const ortDir = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v6",
    "darwin",
    archName
  );
  if (!fs.existsSync(ortDir)) return;

  for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/^libonnxruntime\.[\d.]+\.dylib$/.test(entry.name)) continue;

    const target = path.join(ortDir, entry.name);
    if (!fs.existsSync(target)) {
      console.log(`  afterPack: keeping ${entry.name} (no matching dylib in onnxruntime-node)`);
      continue;
    }

    const binPath = path.join(binDir, entry.name);
    const saved = fs.statSync(binPath).size;
    fs.rmSync(binPath);
    fs.symlinkSync(path.relative(binDir, target), binPath);
    console.log(
      `  afterPack: symlinked bin/${entry.name} -> onnxruntime-node copy (saved ${(saved / 1024 / 1024).toFixed(1)} MB)`
    );
  }
}

// ---------------------------------------------------------------------------
// Linux XWayland wrapper
// ---------------------------------------------------------------------------

function wrapLinuxBinary(context) {
  if (context.electronPlatformName !== "linux") return;

  const appDir = context.appOutDir;
  const binaryName = context.packager.executableName;
  const binaryPath = path.join(appDir, binaryName);
  const realBinaryPath = path.join(appDir, binaryName + "-app");

  fs.renameSync(binaryPath, realBinaryPath);

  const wrapper = `#!/bin/bash
# Type launcher
# User flags: ~/.config/${binaryName}-flags.conf (one per line, # = comment)

HERE="$(dirname "$(readlink -f "\${BASH_SOURCE[0]}")")"
FLAGS=()

# Wayland: forces XWayland (overlay positioning requires X11)
if [ "$XDG_SESSION_TYPE" = "wayland" ]; then
  FLAGS+=(--ozone-platform=x11)
fi

# User flags
FLAGS_FILE="\${XDG_CONFIG_HOME:-$HOME/.config}/${binaryName}-flags.conf"
if [ -f "$FLAGS_FILE" ]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    FLAGS+=("$line")
  done < "$FLAGS_FILE"
fi

exec -a "$0" "$HERE/${binaryName}-app" "\${FLAGS[@]}" "$@"
`;

  fs.writeFileSync(binaryPath, wrapper, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Electron locale pruning
// ---------------------------------------------------------------------------

const KEEP_LOCALE_PREFIXES = ["en", "ru"];

function stripElectronLocales(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = resolveAppPath(context);
  const frameworkRes = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Resources"
  );
  if (!fs.existsSync(frameworkRes)) return;

  let removed = 0;
  for (const entry of fs.readdirSync(frameworkRes, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".lproj")) continue;
    const lang = entry.name.replace(/\.lproj$/, "");
    const keep = KEEP_LOCALE_PREFIXES.some(
      (p) => lang === p || lang.startsWith(p + "_") || lang.startsWith(p + "-")
    );
    if (!keep) {
      fs.rmSync(path.join(frameworkRes, entry.name), { recursive: true, force: true });
      removed++;
    }
  }

  if (removed > 0) {
    console.log(
      `  afterPack: removed ${removed} Electron locale directories (kept: ${KEEP_LOCALE_PREFIXES.join(", ")})`
    );
  }
}

// ---------------------------------------------------------------------------
// GigaAM encoder pruning (macOS, per arch)
// ---------------------------------------------------------------------------

// mac.extraResources is shared by both macOS architectures, so both encoders get
// copied in and the one this arch cannot use is removed here. arm64 normally
// runs the CoreML encoder on the Neural Engine; GIGAAM_MAC_ENCODER=onnx keeps a
// custom ONNX encoder instead when no matching CoreML conversion exists.
function shouldKeepGigaamOnnxEncoder(archName, env = process.env) {
  return archName !== "arm64" || env.GIGAAM_MAC_ENCODER === "onnx";
}

function pruneGigaamEncoders(context) {
  if (context.electronPlatformName !== "darwin") return;

  const resourcesDir = resolveResourcesDir(context);
  if (fs.existsSync(path.join(resourcesDir, "protected-gigaam", "required.json"))) {
    for (const target of [
      path.join(resourcesDir, "gigaam-model"),
      path.join(resourcesDir, "gigaam-ane"),
      path.join(resourcesDir, "bin", "macos-gigaam-encoder"),
    ]) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    return;
  }
  const archName = Arch[context.arch];
  const onnxEncoder = path.join(resourcesDir, "gigaam-model", "v3_e2e_rnnt_encoder.onnx");
  const aneModelDir = path.join(resourcesDir, "gigaam-ane");
  const aneHelper = path.join(resourcesDir, "bin", "macos-gigaam-encoder");

  const remove = (target, label) => {
    if (!fs.existsSync(target)) return;
    const bytes = fs.statSync(target).isDirectory()
      ? collectFiles(target).reduce((sum, file) => sum + fs.statSync(file).size, 0)
      : fs.statSync(target).size;
    fs.rmSync(target, { recursive: true, force: true });
    console.log(
      `  afterPack: removed ${label} for ${archName} (${(bytes / 1024 / 1024).toFixed(0)} MB)`
    );
  };

  const useOnnxEncoder = shouldKeepGigaamOnnxEncoder(archName);

  if (!useOnnxEncoder) {
    if (!fs.existsSync(path.join(aneModelDir, "encoder-ane.mlmodelc", "model.mil"))) {
      throw new Error(
        "arm64 build is missing resources/gigaam-ane/encoder-ane.mlmodelc — run npm run download:gigaam-ane"
      );
    }
    if (!fs.existsSync(aneHelper)) {
      throw new Error(
        "arm64 build is missing resources/bin/macos-gigaam-encoder — run TARGET_ARCH=arm64 npm run compile:gigaam-encoder"
      );
    }
    remove(onnxEncoder, "ONNX encoder (superseded by the CoreML/ANE encoder)");
  } else {
    if (!fs.existsSync(onnxEncoder)) {
      throw new Error(
        `${archName} build is missing resources/gigaam-model/v3_e2e_rnnt_encoder.onnx`
      );
    }
    remove(aneModelDir, "CoreML/ANE encoder (Apple Silicon only)");
    remove(aneHelper, "CoreML/ANE encoder helper (Apple Silicon only)");
    if (archName === "arm64") {
      console.log("  afterPack: keeping the bundled ONNX encoder for arm64");
    }
  }
}

function validateProtectedBundledGigaam(context) {
  if (context.electronPlatformName !== "darwin") return;
  const resourcesDir = resolveResourcesDir(context);
  const dir = path.join(resourcesDir, "protected-gigaam");
  const markerPath = path.join(dir, "required.json");
  // Standard and pull-request builds continue to use the existing model
  // packaging. The marker is created only by prepare:protected-gigaam and
  // turns all protected-release checks into fail-closed requirements.
  if (!fs.existsSync(markerPath)) return;
  const modelPath = path.join(dir, "gigaam-en-ru.memento-model");
  const helperPath = path.join(resourcesDir, "bin", "type-protected-gigaam");
  for (const required of [markerPath, modelPath, helperPath]) {
    if (!fs.existsSync(required)) {
      throw new Error(`protected macOS GigaAM release is missing ${required}`);
    }
  }
  const expected = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  const inspected = JSON.parse(
    execFileSync(helperPath, ["--inspect", "--model", modelPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    })
  );
  for (const field of ["modelId", "releaseId", "keyId", "containerBytes", "containerSha256"]) {
    if (inspected[field] !== expected[field]) {
      throw new Error(`protected GigaAM ${field} changed after build preparation`);
    }
  }
  console.log(
    `  afterPack: verified protected GigaAM ${inspected.releaseId} (${(
      inspected.containerBytes /
      1024 /
      1024
    ).toFixed(0)} MB)`
  );
}

// Windows releases promise an offline first run. Fail while electron-builder
// still has a readable app directory if the pinned wired model was omitted,
// truncated, or came from an unverified source package.
function validateBundledGigaamModel(context) {
  if (context.electronPlatformName !== "win32") return;

  const modelDir = path.join(resolveResourcesDir(context), "gigaam-model");
  assertGigaamModelDir(modelDir, { requireManifest: true });
  const totalBytes = GIGAAM_MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0);
  console.log(
    `  afterPack: verified bilingual GigaAM model (${(totalBytes / 1024 / 1024).toFixed(0)} MB)`
  );
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

exports.default = async function (context) {
  validateProtectedBundledGigaam(context);
  pruneGigaamEncoders(context);
  validateBundledGigaamModel(context);
  stripOnnxruntimeBinaries(context);
  stripResourceBinaries(context);
  thinFatBinaries(context);
  dedupeOnnxruntimeDylib(context);
  stripElectronLocales(context);
  clearMacExtendedAttributes(context);
  wrapLinuxBinary(context);
  registerMacResourceBinariesForSigning(context);
};

exports._testing = {
  shouldKeepGigaamOnnxEncoder,
  validateBundledGigaamModel,
  validateProtectedBundledGigaam,
};
