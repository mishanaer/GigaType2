#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

if (!new Set(["darwin", "win32"]).has(process.platform)) process.exit(0);

const root = path.resolve(__dirname, "..");
const crate = path.join(root, "native", "protected-gigaam");
const outputDir = path.join(root, "resources", "bin");
const arch = process.env.TARGET_ARCH || process.arch;
const triples = {
  darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
  win32: { arm64: "aarch64-pc-windows-msvc", x64: "x86_64-pc-windows-msvc" },
};
const target = triples[process.platform]?.[arch];
if (!target) {
  console.error(`[protected-gigaam] unsupported build target ${process.platform}/${arch}`);
  process.exit(1);
}

if (process.env.TYPE_PROTECTED_GIGAAM_REQUIRED === "1") {
  for (const name of ["TYPE_REGISTRATION_KEY", "TYPE_MODEL_MANIFEST_PUBLIC_KEY"]) {
    if (!process.env[name]?.trim()) {
      console.error(`[protected-gigaam] ${name} is required for a protected release build`);
      process.exit(1);
    }
  }
}

const result = spawnSync("cargo", ["build", "--release", "--locked", "--target", target], {
  cwd: crate,
  stdio: "inherit",
  env: process.env,
});
if (result.status !== 0) process.exit(result.status ?? 1);

const extension = process.platform === "win32" ? ".exe" : "";
const source = path.join(crate, "target", target, "release", `type-protected-gigaam${extension}`);
const destination = path.join(outputDir, `type-protected-gigaam${extension}`);
fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(source, destination);
fs.chmodSync(destination, 0o755);
console.log(`[protected-gigaam] built ${destination} for ${target}`);
