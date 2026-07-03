#!/usr/bin/env node
// Downloads a slim audio-focused ffmpeg from homebridge/ffmpeg-for-homebridge.
// Replaces the full ffmpeg-static binary (75 MB) with a 21-28 MB build that
// still supports all audio formats needed by this app (Opus/WebM, AAC, WAV, MP3).
//
// macOS and Linux only. Windows uses ffmpeg-static (no suitable slim build).

const fs = require("fs");
const path = require("path");
const {
  fetchLatestRelease,
  downloadFile,
  extractArchive,
  findBinaryInDir,
  setExecutable,
  parseArgs,
} = require("./lib/download-utils");

const HOMEBRIDGE_REPO = "homebridge/ffmpeg-for-homebridge";
const TAG = "v2.2.2";

const ASSET_MAP = {
  "darwin-arm64": "ffmpeg-darwin-arm64.tar.gz",
  "darwin-x64": "ffmpeg-darwin-x86_64.tar.gz",
};

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");
const OUTPUT_NAME = "ffmpeg";

async function downloadForPlatformArch(platformArch) {
  const assetName = ASSET_MAP[platformArch];
  if (!assetName) {
    console.log(`[ffmpeg] Skipping ${platformArch}: no slim build available, using ffmpeg-static`);
    return;
  }

  const outputPath = path.join(BIN_DIR, OUTPUT_NAME);
  if (fs.existsSync(outputPath)) {
    const sizeMB = Math.round(fs.statSync(outputPath).size / 1024 / 1024);
    console.log(`[ffmpeg] Already downloaded: ${outputPath} (${sizeMB} MB)`);
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const release = await fetchLatestRelease(HOMEBRIDGE_REPO, { tag: TAG });
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) throw new Error(`Asset "${assetName}" not found in release ${TAG}`);

  console.log(`[ffmpeg] Downloading ${assetName} (${Math.round(asset.size / 1024 / 1024)} MB)...`);

  const tmpArchive = path.join(BIN_DIR, `_tmp_${assetName}`);
  const tmpExtract = path.join(BIN_DIR, `_tmp_ffmpeg_extract`);

  try {
    await downloadFile(asset.browser_download_url, tmpArchive);

    fs.mkdirSync(tmpExtract, { recursive: true });
    await extractArchive(tmpArchive, tmpExtract);

    const binaryPath = findBinaryInDir(tmpExtract, "ffmpeg");
    if (!binaryPath) throw new Error(`ffmpeg binary not found after extracting ${assetName}`);

    fs.copyFileSync(binaryPath, outputPath);
    setExecutable(outputPath);

    const sizeMB = Math.round(fs.statSync(outputPath).size / 1024 / 1024);
    console.log(`[ffmpeg] Saved: ${outputPath} (${sizeMB} MB)`);
  } finally {
    fs.rmSync(tmpArchive, { force: true });
    fs.rmSync(tmpExtract, { recursive: true, force: true });
  }
}

async function main() {
  const { all, current, platformArch: argPlatformArch } = parseArgs();

  let targets;
  if (all) {
    targets = Object.keys(ASSET_MAP);
  } else if (argPlatformArch) {
    targets = [argPlatformArch];
  } else {
    targets = [`${process.platform}-${process.arch}`];
  }

  for (const t of targets) {
    await downloadForPlatformArch(t);
  }
}

main().catch((err) => {
  console.error("[ffmpeg] Error:", err.message);
  process.exit(1);
});
