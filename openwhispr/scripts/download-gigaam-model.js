#!/usr/bin/env node
/*
 * Download the pinned bilingual GigaAM v3 RNN-T ONNX package from the public
 * Yandex Disk link, verify it, and place only the fp32 runtime files in
 * resources/gigaam-model/ for electron-builder's wired Windows model.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const unzipper = require("unzipper");
const {
  ARCHIVE,
  MANIFEST_FILE,
  MODEL_FILES,
  PUBLIC_DOWNLOAD_API,
  PUBLIC_RESOURCES_API,
  PUBLIC_URL,
  assertModelDir,
  expectedArchiveEntry,
  modelManifest,
  publicApiUrl,
} = require("./lib/gigaam-model-package");

const PROJECT_ROOT = path.join(__dirname, "..");
const RESOURCES_DIR = path.join(PROJECT_ROOT, "resources");
const OUT_DIR = path.join(RESOURCES_DIR, "gigaam-model");
const DOWNLOAD_DIR = path.join(RESOURCES_DIR, ".gigaam-model-download");
const ARCHIVE_PATH = path.join(DOWNLOAD_DIR, ARCHIVE.name);
const PART_PATH = `${ARCHIVE_PATH}.part`;
const MAX_ATTEMPTS = 4;
const STALL_TIMEOUT_MS = 60_000;
const USER_AGENT = "Type-Build/2.0";

function log(message) {
  console.log(`[gigaam-model] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  return response.json();
}

async function resolveDownloadUrl() {
  const metadata = await fetchJson(publicApiUrl(PUBLIC_RESOURCES_API));
  if (metadata.type !== "file") {
    throw new Error(`Yandex Disk resource is ${metadata.type || "unknown"}, expected file`);
  }
  if (metadata.name !== ARCHIVE.name) {
    throw new Error(`archive name mismatch: expected ${ARCHIVE.name}, got ${metadata.name}`);
  }
  if (metadata.size !== ARCHIVE.bytes) {
    throw new Error(`archive size mismatch: expected ${ARCHIVE.bytes}, got ${metadata.size}`);
  }
  if (String(metadata.sha256 || "").toLowerCase() !== ARCHIVE.sha256) {
    throw new Error("archive SHA-256 from Yandex Disk metadata does not match the pinned value");
  }

  const download = await fetchJson(publicApiUrl(PUBLIC_DOWNLOAD_API));
  if (typeof download.href !== "string" || !download.href.startsWith("https://")) {
    throw new Error("Yandex Disk API did not return an HTTPS download URL");
  }
  return download.href;
}

async function downloadOnce(url, partPath, expectedSize) {
  let startOffset = 0;
  try {
    startOffset = fs.statSync(partPath).size;
  } catch {
    // No partial download yet.
  }
  if (startOffset > expectedSize) {
    fs.rmSync(partPath, { force: true });
    startOffset = 0;
  }
  if (startOffset === expectedSize) return;

  const headers = { "User-Agent": USER_AGENT };
  if (startOffset > 0) headers.Range = `bytes=${startOffset}-`;

  const controller = new AbortController();
  let stallTimer;
  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort("download stalled"), STALL_TIMEOUT_MS);
  };

  try {
    resetStallTimer();
    const response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });

    let append = startOffset > 0;
    if (response.status === 200 && startOffset > 0) {
      append = false;
      startOffset = 0;
    } else if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel();
      throw new Error(`download failed with HTTP ${response.status}`);
    }

    if (response.status === 206) {
      const match = String(response.headers.get("content-range") || "").match(/^bytes (\d+)-/);
      if (!match || Number(match[1]) !== startOffset) {
        await response.body?.cancel();
        throw new Error("server returned an invalid Content-Range");
      }
    }
    if (!response.body) throw new Error("download response has no body");

    let downloaded = startOffset;
    let lastPercent = -1;
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        resetStallTimer();
        downloaded += chunk.length;
        const percent = Math.floor((downloaded / expectedSize) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          process.stdout.write(`\r[gigaam-model] downloading ${percent}%`);
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body),
      progress,
      fs.createWriteStream(partPath, { flags: append ? "a" : "w" })
    );
    process.stdout.write("\n");

    const actualSize = fs.statSync(partPath).size;
    if (actualSize !== expectedSize) {
      throw new Error(`incomplete download: expected ${expectedSize}, got ${actualSize}`);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw Object.assign(new Error("download stalled for 60 seconds"), { retryable: true });
    }
    throw Object.assign(error, { retryable: true });
  } finally {
    clearTimeout(stallTimer);
  }
}

async function downloadArchive() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const href = await resolveDownloadUrl();
      const existingBytes = fs.existsSync(PART_PATH) ? fs.statSync(PART_PATH).size : 0;
      log(
        `${existingBytes > 0 ? `resuming at ${existingBytes} bytes` : `downloading ${PUBLIC_URL}`} (attempt ${attempt}/${MAX_ATTEMPTS})`
      );
      await downloadOnce(href, PART_PATH, ARCHIVE.bytes);
      fs.rmSync(ARCHIVE_PATH, { force: true });
      fs.renameSync(PART_PATH, ARCHIVE_PATH);
      return;
    } catch (error) {
      log(`attempt ${attempt} failed: ${error.message}`);
      if (attempt === MAX_ATTEMPTS) throw error;
      await sleep(Math.min(2 ** attempt * 1_000, 15_000));
    }
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function extractModel(archivePath, stagingDir) {
  const archive = await unzipper.Open.file(archivePath);
  const entries = new Map(archive.files.map((entry) => [entry.path.replace(/\\/g, "/"), entry]));

  for (const file of MODEL_FILES) {
    const archivePathForFile = expectedArchiveEntry(file);
    const entry = entries.get(archivePathForFile);
    if (!entry || entry.type !== "File") {
      throw new Error(`archive is missing ${archivePathForFile}`);
    }
    if (entry.uncompressedSize !== file.bytes) {
      throw new Error(
        `${archivePathForFile} size mismatch: expected ${file.bytes}, got ${entry.uncompressedSize}`
      );
    }
    log(`extracting ${file.name}`);
    await pipeline(entry.stream(), fs.createWriteStream(path.join(stagingDir, file.name)));
  }

  fs.writeFileSync(
    path.join(stagingDir, MANIFEST_FILE),
    `${JSON.stringify(modelManifest(), null, 2)}\n`,
    "utf8"
  );
  assertModelDir(stagingDir, { requireManifest: true });
}

function installStagedModel(stagingDir) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const installedFiles = [...MODEL_FILES.map((file) => file.name), MANIFEST_FILE];
  for (const fileName of installedFiles) {
    const source = path.join(stagingDir, fileName);
    const finalDest = path.join(OUT_DIR, fileName);
    fs.rmSync(finalDest, { force: true });
    fs.renameSync(source, finalDest);
  }
  for (const entry of fs.readdirSync(OUT_DIR, { withFileTypes: true })) {
    if (!installedFiles.includes(entry.name)) {
      fs.rmSync(path.join(OUT_DIR, entry.name), { recursive: true, force: true });
    }
  }
  assertModelDir(OUT_DIR, { requireManifest: true });
}

async function main() {
  const force = process.argv.includes("--force");
  const verifyOnly = process.argv.includes("--verify-only");

  if (!force) {
    try {
      assertModelDir(OUT_DIR, { requireManifest: true });
      log(`model ${verifyOnly ? "verified" : "already ready"} in ${OUT_DIR}`);
      return;
    } catch (error) {
      if (verifyOnly) throw error;
    }
  } else if (verifyOnly) {
    throw new Error("--force and --verify-only cannot be used together");
  }

  await downloadArchive();
  const digest = await sha256File(ARCHIVE_PATH);
  if (digest !== ARCHIVE.sha256) {
    fs.rmSync(ARCHIVE_PATH, { force: true });
    throw new Error(`archive SHA-256 mismatch: expected ${ARCHIVE.sha256}, got ${digest}`);
  }
  log("archive SHA-256 verified");

  fs.mkdirSync(RESOURCES_DIR, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(RESOURCES_DIR, ".gigaam-model-staging-"));
  try {
    await extractModel(ARCHIVE_PATH, stagingDir);
    installStagedModel(stagingDir);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  fs.rmSync(ARCHIVE_PATH, { force: true });
  log(`model ready in ${OUT_DIR}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[gigaam-model] error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  downloadOnce,
  extractModel,
  installStagedModel,
  main,
  resolveDownloadUrl,
  sha256File,
};
