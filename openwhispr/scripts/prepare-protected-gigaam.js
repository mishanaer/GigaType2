#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const targetDir = path.join(root, "resources", "protected-gigaam");
const targetModel = path.join(targetDir, "gigaam-en-ru.memento-model");
const source = process.env.TYPE_PROTECTED_GIGAAM_MODEL_SOURCE;
const extension = process.platform === "win32" ? ".exe" : "";
const helper = path.join(root, "resources", "bin", `type-protected-gigaam${extension}`);

function fail(message) {
  console.error(`[protected-gigaam] ${message}`);
  process.exit(1);
}

if (!process.env.TYPE_REGISTRATION_KEY?.trim()) fail("TYPE_REGISTRATION_KEY is missing");
if (!process.env.TYPE_MODEL_MANIFEST_PUBLIC_KEY?.trim()) {
  fail("TYPE_MODEL_MANIFEST_PUBLIC_KEY is missing");
}
if (source) {
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) fail(`model source does not exist: ${resolved}`);
  fs.mkdirSync(targetDir, { recursive: true });
  if (resolved !== targetModel) fs.copyFileSync(resolved, targetModel);
}
if (!fs.existsSync(targetModel)) {
  fail(`place the encrypted model at ${targetModel} or set TYPE_PROTECTED_GIGAAM_MODEL_SOURCE`);
}
if (!fs.existsSync(helper)) fail(`native loader is missing: ${helper}`);

const fd = fs.openSync(targetModel, "r");
const magic = Buffer.alloc(8);
fs.readSync(fd, magic, 0, magic.length, 0);
fs.closeSync(fd);
if (!magic.equals(Buffer.from("MMODEL01"))) fail("model is not a Memento protected container");

const inspected = spawnSync(helper, ["--inspect", "--model", targetModel], {
  cwd: root,
  encoding: "utf8",
  env: process.env,
});
if (inspected.status !== 0) {
  fail(`container verification failed: ${(inspected.stderr || inspected.stdout).trim()}`);
}
let metadata;
try {
  metadata = JSON.parse(inspected.stdout);
} catch (error) {
  fail(`native loader returned invalid metadata: ${error.message}`);
}
if (metadata.modelId !== "gigaam-v3-e2e-rnnt-en-ru") {
  fail(`unexpected protected model id: ${metadata.modelId}`);
}
fs.writeFileSync(
  path.join(targetDir, "required.json"),
  `${JSON.stringify({ schema: 1, ...metadata }, null, 2)}\n`,
  { mode: 0o644 }
);
console.log(
  `[protected-gigaam] verified ${metadata.releaseId} (${Math.round(metadata.containerBytes / 1024 / 1024)} MB)`
);
