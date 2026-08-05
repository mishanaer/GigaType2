const fs = require("fs");
const path = require("path");

const PUBLIC_URL = "https://disk.yandex.ru/d/Ty5v8ZWVvLbEjw";
const PUBLIC_RESOURCES_API = "https://cloud-api.yandex.net/v1/disk/public/resources";
const PUBLIC_DOWNLOAD_API = `${PUBLIC_RESOURCES_API}/download`;

const ARCHIVE = Object.freeze({
  name: "en_ru_onnx.zip",
  bytes: 986_603_383,
  sha256: "086fe4f30126954f8db29318fa24d0cc1ce6320493379e37534cc938ba2909df",
  rootDir: "en_ru_onnx",
});

const MODEL_FILES = Object.freeze([
  Object.freeze({ name: "v3_e2e_rnnt_encoder.onnx", bytes: 885_093_303 }),
  Object.freeze({ name: "v3_e2e_rnnt_decoder.onnx", bytes: 4_599_970 }),
  Object.freeze({ name: "v3_e2e_rnnt_joint.onnx", bytes: 2_712_926 }),
  Object.freeze({ name: "v3_e2e_rnnt_vocab.txt", bytes: 13_354 }),
]);

const MANIFEST_FILE = "model-manifest.json";
const MODEL_REVISION = `yadisk-en-ru-${ARCHIVE.sha256.slice(0, 12)}`;

function publicApiUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set("public_key", PUBLIC_URL);
  return url.href;
}

function expectedArchiveEntry(file) {
  return `${ARCHIVE.rootDir}/${file.name}`;
}

function modelManifest() {
  return {
    revision: MODEL_REVISION,
    source: PUBLIC_URL,
    archive: {
      name: ARCHIVE.name,
      bytes: ARCHIVE.bytes,
      sha256: ARCHIVE.sha256,
    },
    files: MODEL_FILES.map(({ name, bytes }) => ({ name, bytes })),
  };
}

function validateModelDir(modelDir, options = {}) {
  const { requireManifest = false, files = MODEL_FILES } = options;
  const errors = [];

  for (const file of files) {
    const filePath = path.join(modelDir, file.name);
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      errors.push(`missing ${file.name}`);
      continue;
    }
    if (!stats.isFile()) {
      errors.push(`${file.name} is not a file`);
    } else if (stats.size !== file.bytes) {
      errors.push(`${file.name} size mismatch: expected ${file.bytes}, got ${stats.size}`);
    }
  }

  if (requireManifest) {
    const manifestPath = path.join(modelDir, MANIFEST_FILE);
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.revision !== MODEL_REVISION) {
        errors.push(
          `${MANIFEST_FILE} revision mismatch: expected ${MODEL_REVISION}, got ${manifest.revision || "<missing>"}`
        );
      }
      if (manifest.archive?.sha256 !== ARCHIVE.sha256) {
        errors.push(`${MANIFEST_FILE} archive SHA-256 mismatch`);
      }
    } catch (error) {
      errors.push(`invalid ${MANIFEST_FILE}: ${error.message}`);
    }
  }

  return errors;
}

function assertModelDir(modelDir, options = {}) {
  const errors = validateModelDir(modelDir, options);
  if (errors.length > 0) {
    throw new Error(`Invalid GigaAM model directory ${modelDir}: ${errors.join("; ")}`);
  }
}

module.exports = {
  ARCHIVE,
  MANIFEST_FILE,
  MODEL_FILES,
  MODEL_REVISION,
  PUBLIC_DOWNLOAD_API,
  PUBLIC_RESOURCES_API,
  PUBLIC_URL,
  assertModelDir,
  expectedArchiveEntry,
  modelManifest,
  publicApiUrl,
  validateModelDir,
};
