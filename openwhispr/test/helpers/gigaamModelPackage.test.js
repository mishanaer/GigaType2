const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const afterPack = require("../../scripts/afterPack");
const {
  ARCHIVE,
  MANIFEST_FILE,
  MODEL_FILES,
  PUBLIC_DOWNLOAD_API,
  PUBLIC_RESOURCES_API,
  PUBLIC_URL,
  expectedArchiveEntry,
  modelManifest,
  publicApiUrl,
  validateModelDir,
} = require("../../scripts/lib/gigaam-model-package");
const { assertNames } = require("../../scripts/verify-gigaam-model");

function createSparseModelDir(modelDir) {
  fs.mkdirSync(modelDir, { recursive: true });
  for (const file of MODEL_FILES) {
    const filePath = path.join(modelDir, file.name);
    fs.writeFileSync(filePath, "");
    fs.truncateSync(filePath, file.bytes);
  }
  fs.writeFileSync(path.join(modelDir, MANIFEST_FILE), JSON.stringify(modelManifest()));
}

test("Yandex Disk API URLs keep the permanent public key", () => {
  for (const baseUrl of [PUBLIC_RESOURCES_API, PUBLIC_DOWNLOAD_API]) {
    const url = new URL(publicApiUrl(baseUrl));
    assert.equal(url.searchParams.get("public_key"), PUBLIC_URL);
  }
});

test("pinned package describes the selected fp32 archive entries", () => {
  assert.equal(ARCHIVE.name, "en_ru_onnx.zip");
  assert.equal(ARCHIVE.sha256.length, 64);
  assert.deepEqual(
    MODEL_FILES.map(expectedArchiveEntry),
    MODEL_FILES.map((file) => `en_ru_onnx/${file.name}`)
  );
  assert.equal(
    MODEL_FILES.some((file) => file.name.includes("int8")),
    false
  );
});

test("model directory validation checks sizes and pinned manifest", (t) => {
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigatype-model-package-"));
  t.after(() => fs.rmSync(modelDir, { recursive: true, force: true }));

  createSparseModelDir(modelDir);
  assert.deepEqual(validateModelDir(modelDir, { requireManifest: true }), []);

  fs.truncateSync(path.join(modelDir, MODEL_FILES[0].name), MODEL_FILES[0].bytes - 1);
  assert.match(validateModelDir(modelDir, { requireManifest: true })[0], /size mismatch/);
});

test("afterPack rejects an incomplete Windows wired model and accepts the pinned package", (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigatype-afterpack-win-"));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  const context = { electronPlatformName: "win32", appOutDir };

  assert.throws(
    () => afterPack._testing.validateBundledGigaamModel(context),
    /Invalid GigaAM model directory/
  );

  createSparseModelDir(path.join(appOutDir, "resources", "gigaam-model"));
  assert.doesNotThrow(() => afterPack._testing.validateBundledGigaamModel(context));
});

test("ONNX interface validation reports missing runtime names", () => {
  assert.doesNotThrow(() => assertNames("inputs", ["audio_signal", "length"], ["length"], "x"));
  assert.throws(
    () => assertNames("outputs", ["encoded"], ["encoded", "encoded_len"], "encoder.onnx"),
    /encoded_len/
  );
});
