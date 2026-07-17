#!/usr/bin/env node
/*
 * Download the fp32 GigaAM v3 RNN-T ONNX model into resources/gigaam-model/
 * so electron-builder can bundle it ("wired model" → the app transcribes
 * offline on first launch instead of pulling ~885 MB on first run).
 *
 * The file list and source mirror src/helpers/gigaamLocalAsr.js
 * (MODEL_FILES / HF_BASE). The HuggingFace repo is public, so no token is
 * needed. Files already present at the expected size are skipped, so re-runs
 * (and cache hits) are cheap.
 */
const fs = require("fs");
const path = require("path");
const { downloadFile } = require("./lib/download-utils");

const HF_BASE = "https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/main";
const MODEL_FILES = [
  { name: "v3_e2e_rnnt_encoder.onnx", bytes: 885_084_534 },
  { name: "v3_e2e_rnnt_decoder.onnx", bytes: 4_599_910 },
  { name: "v3_e2e_rnnt_joint.onnx", bytes: 2_712_896 },
  { name: "v3_e2e_rnnt_vocab.txt", bytes: 13_354 },
];
const OUT_DIR = path.join(__dirname, "..", "resources", "gigaam-model");

async function fetchOne(file) {
  const dest = path.join(OUT_DIR, file.name);
  if (fs.existsSync(dest) && fs.statSync(dest).size === file.bytes) {
    console.log(`✓ ${file.name} (cached)`);
    return;
  }
  const tmp = `${dest}.part`;
  const url = `${HF_BASE}/${file.name}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`↓ ${file.name} (attempt ${attempt}/3) ${url}`);
      await downloadFile(url, tmp);
      const size = fs.statSync(tmp).size;
      if (file.bytes && size !== file.bytes) {
        throw new Error(`size mismatch: expected ${file.bytes}, got ${size}`);
      }
      fs.renameSync(tmp, dest);
      console.log(`✓ ${file.name}`);
      return;
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      console.warn(`  ${file.name} failed: ${err.message}`);
      if (attempt === 3) throw err;
    }
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const file of MODEL_FILES) {
    await fetchOne(file);
  }
  console.log(`GigaAM model ready in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
