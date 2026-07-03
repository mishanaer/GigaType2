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
    if (!entry.isFile()) continue;
    const name = entry.name;
    const fullPath = path.join(binDir, name);

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
    const keep = KEEP_LOCALE_PREFIXES.some((p) => lang === p || lang.startsWith(p + "_") || lang.startsWith(p + "-"));
    if (!keep) {
      fs.rmSync(path.join(frameworkRes, entry.name), { recursive: true, force: true });
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`  afterPack: removed ${removed} Electron locale directories (kept: ${KEEP_LOCALE_PREFIXES.join(", ")})`);
  }
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

exports.default = async function (context) {
  stripOnnxruntimeBinaries(context);
  stripResourceBinaries(context);
  stripElectronLocales(context);
  clearMacExtendedAttributes(context);
  wrapLinuxBinary(context);
  registerMacResourceBinariesForSigning(context);
};
