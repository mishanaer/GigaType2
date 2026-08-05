#!/usr/bin/env node
const os = require("os");
const path = require("path");
const ort = require("onnxruntime-node");
const { MODEL_FILES, assertModelDir } = require("./lib/gigaam-model-package");

const MODEL_DIR = path.join(__dirname, "..", "resources", "gigaam-model");
const intraOpNumThreads = Math.min(4, Math.max(2, Math.floor((os.cpus()?.length || 4) / 2)));
const SESSION_OPTIONS = { intraOpNumThreads, executionMode: "sequential" };

const EXPECTED_IO = {
  "v3_e2e_rnnt_encoder.onnx": {
    inputs: ["audio_signal", "length"],
    outputs: ["encoded", "encoded_len"],
  },
  "v3_e2e_rnnt_decoder.onnx": {
    inputs: ["x", "h.1", "c.1"],
    outputs: ["dec", "h", "c"],
  },
  "v3_e2e_rnnt_joint.onnx": {
    inputs: ["enc", "dec"],
    outputs: ["joint"],
  },
};

function assertNames(kind, actual, expected, fileName) {
  const missing = expected.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    throw new Error(`${fileName} is missing ${kind}: ${missing.join(", ")}`);
  }
}

async function verifySession(fileName, expected) {
  const filePath = path.join(MODEL_DIR, fileName);
  console.log(`[gigaam-model] loading ${fileName}`);
  const session = await ort.InferenceSession.create(filePath, SESSION_OPTIONS);
  try {
    assertNames("inputs", session.inputNames, expected.inputs, fileName);
    assertNames("outputs", session.outputNames, expected.outputs, fileName);
  } finally {
    await session.release();
  }
}

async function main() {
  assertModelDir(MODEL_DIR, { requireManifest: true });

  for (const file of MODEL_FILES) {
    const expected = EXPECTED_IO[file.name];
    if (expected) await verifySession(file.name, expected);
  }

  console.log("[gigaam-model] ONNX sessions and runtime input/output names verified");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[gigaam-model] verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { EXPECTED_IO, assertNames, main };
