const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const GigaamLocalAsrManager = require("../../src/helpers/gigaamLocalAsr");
const {
  BUILT_IN_GIGAAM_API_BASE,
  isBuiltInGigaamEndpoint,
} = require("../../src/utils/gigaamTranscription.cjs");

const repoRoot = path.join(__dirname, "..", "..");

test("built-in GigaAM defaults to Electron IPC instead of a TCP listener", async () => {
  const manager = new GigaamLocalAsrManager();

  assert.equal(manager.httpBridgeEnabled, false);
  assert.equal(manager.port, null);
  assert.equal(manager.getApiBaseUrl(), BUILT_IN_GIGAAM_API_BASE);
  assert.equal(isBuiltInGigaamEndpoint(`${BUILT_IN_GIGAAM_API_BASE}/audio/transcriptions`), true);
  await assert.rejects(manager.transcribeAudioBuffer(Buffer.alloc(44)), /model not ready/i);
});

test("Windows package and runtime no longer depend on NirCmd", () => {
  const packageJson = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
  const builderConfig = fs.readFileSync(path.join(repoRoot, "electron-builder.json"), "utf8");
  const clipboardSource = fs.readFileSync(
    path.join(repoRoot, "src/helpers/clipboard.js"),
    "utf8"
  );
  const mediaSource = fs.readFileSync(
    path.join(repoRoot, "src/helpers/mediaPlayer.js"),
    "utf8"
  );

  for (const source of [packageJson, builderConfig, clipboardSource, mediaSource]) {
    assert.doesNotMatch(source, /nircmd/i);
  }
  assert.equal(fs.existsSync(path.join(repoRoot, "scripts/download-nircmd.js")), false);
});

test("Windows inbound bridges are opt-in and macOS keeps a menu bar recovery path", () => {
  const mainSource = fs.readFileSync(path.join(repoRoot, "main.js"), "utf8");
  const environmentSource = fs.readFileSync(
    path.join(repoRoot, "src/helpers/environment.js"),
    "utf8"
  );
  const settingsSource = fs.readFileSync(
    path.join(repoRoot, "src/components/settings/WalletSettingsCells.tsx"),
    "utf8"
  );

  assert.match(mainSource, /process\.env\.TYPE_CLI_BRIDGE === "1"/);
  assert.match(mainSource, /await trayManager\.createTray\(\)/);
  assert.match(environmentSource, /"SHOW_DOCK_ICON"/);
  assert.match(settingsSource, /Показывать иконку в Dock/);
});

test("capsule has a visible fallback and bounded renderer retries", () => {
  const componentSource = fs.readFileSync(
    path.join(repoRoot, "src/components/GolosCapsule.tsx"),
    "utf8"
  );
  const cssSource = fs.readFileSync(path.join(repoRoot, "src/index.css"), "utf8");

  assert.match(componentSource, /retryCountRef\.current >= 2/);
  assert.match(componentSource, /data-renderer-fallback/);
  assert.match(cssSource, /golos-capsule-fallback-pulse/);
  assert.doesNotMatch(cssSource, /data-fallback="true"\]\)\s*\{\s*opacity:\s*0/);
});
