const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const afterPack = require("../../scripts/afterPack");
const GigaamLocalAsrManager = require("../../src/helpers/gigaamLocalAsr");

test("arm64 packaging keeps a custom ONNX encoder only when requested", () => {
  const { shouldKeepGigaamOnnxEncoder } = afterPack._testing;

  assert.equal(shouldKeepGigaamOnnxEncoder("arm64", {}), false);
  assert.equal(shouldKeepGigaamOnnxEncoder("arm64", { GIGAAM_MAC_ENCODER: "onnx" }), true);
  assert.equal(shouldKeepGigaamOnnxEncoder("x64", {}), true);
});

test("packaged ASR detects the bundled ONNX encoder fallback", (t) => {
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigatype-onnx-"));
  t.after(() => fs.rmSync(resourcesDir, { recursive: true, force: true }));

  const modelDir = path.join(resourcesDir, "gigaam-model");
  const encoderPath = path.join(modelDir, "v3_e2e_rnnt_encoder.onnx");
  fs.mkdirSync(modelDir, { recursive: true });

  assert.equal(GigaamLocalAsrManager._testing.findBundledOnnxEncoder(resourcesDir), null);

  fs.writeFileSync(encoderPath, "test model placeholder");
  assert.equal(GigaamLocalAsrManager._testing.findBundledOnnxEncoder(resourcesDir), encoderPath);
});
