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
  const clipboardSource = fs.readFileSync(path.join(repoRoot, "src/helpers/clipboard.js"), "utf8");
  const mediaSource = fs.readFileSync(path.join(repoRoot, "src/helpers/mediaPlayer.js"), "utf8");

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

test("hiding the macOS Dock icon keeps open windows active", () => {
  const windowManagerSource = fs.readFileSync(
    path.join(repoRoot, "src/helpers/windowManager.js"),
    "utf8"
  );
  const setShowDockIconSource = windowManagerSource.match(
    /setShowDockIcon\(enabled\) \{[\s\S]*?\n {2}\}/
  )?.[0];

  assert.ok(setShowDockIconSource);
  assert.match(setShowDockIconSource, /app\.dock\.hide\(\)/);
  assert.doesNotMatch(setShowDockIconSource, /setActivationPolicy\("accessory"\)/);
  assert.match(
    windowManagerSource,
    /_alwaysOnTopOptions\(\) \{[\s\S]*?skipTransformProcessType: true/
  );
  assert.match(
    windowManagerSource,
    /_prepareMainWindowForMacWorkspaces\(\)[\s\S]*?skipTransformProcessType: false/
  );
  assert.match(
    windowManagerSource,
    /this\._prepareMainWindowForMacWorkspaces\(\);[\s\S]*?this\.setMainWindowInteractivity\(false\)/
  );
  assert.match(
    windowManagerSource,
    /recoverAfterSystemResume\(\)[\s\S]*?this\.mainWindow\.hide\(\);[\s\S]*?this\._prepareMainWindowForMacWorkspaces\(\)/
  );
});

test("packaged Windows close-to-tray always has a recoverable tray icon", () => {
  const mainSource = fs.readFileSync(path.join(repoRoot, "main.js"), "utf8");
  const builderConfig = fs.readFileSync(path.join(repoRoot, "electron-builder.json"), "utf8");
  const traySource = fs.readFileSync(path.join(repoRoot, "src/helpers/tray.js"), "utf8");
  const windowManagerSource = fs.readFileSync(
    path.join(repoRoot, "src/helpers/windowManager.js"),
    "utf8"
  );

  assert.doesNotMatch(builderConfig, /"!icon\.ico"/);
  assert.match(traySource, /isTrayReady\(\)/);
  assert.match(traySource, /async ensureTray\(\)/);
  assert.match(traySource, /process\.resourcesPath, "src", "assets", "icon\.png"/);
  assert.match(mainSource, /setEnsureTrayHandler\(\(\) => trayManager\.ensureTray\(\)\)/);
  assert.match(windowManagerSource, /trayReady = Boolean\(await this\.ensureTrayHandler\?\.\(\)\)/);
  assert.match(windowManagerSource, /Keeping control panel visible because tray is unavailable/);
});

test("Windows installer requires a reboot and blocks same-boot app startup", () => {
  const builderConfig = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "electron-builder.json"), "utf8")
  );
  const nsisSource = fs.readFileSync(
    path.join(repoRoot, "resources/nsis/cleanup-models.nsh"),
    "utf8"
  );
  const mainSource = fs.readFileSync(path.join(repoRoot, "main.js"), "utf8");

  assert.equal(builderConfig.nsis.runAfterFinish, false);
  assert.match(nsisSource, /!macro customInstall/);
  assert.match(nsisSource, /\\.type-install-reboot-required/);
  assert.match(nsisSource, /SetRebootFlag true/);
  assert.match(nsisSource, /SetErrorLevel 3010/);
  assert.match(mainSource, /getWindowsInstallRebootState/);
  assert.match(mainSource, /startup\.installReboot\.message/);
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

test("capsule visibility has one renderer owner and Windows resume restores the overlay hook", () => {
  const appSource = fs.readFileSync(path.join(repoRoot, "src/App.jsx"), "utf8");
  const windowManagerSource = fs.readFileSync(
    path.join(repoRoot, "src/helpers/windowManager.js"),
    "utf8"
  );
  const mainSource = fs.readFileSync(path.join(repoRoot, "main.js"), "utf8");

  assert.match(appSource, /if \(isCapsuleVisible && !hideCapsule\)[\s\S]*showDictationPanel/);
  assert.match(appSource, /else \{[\s\S]*hideDictationPanel/);
  assert.match(windowManagerSource, /recoverAfterSystemResume\(\)/);
  assert.match(windowManagerSource, /this\.mainWindow\.setFocusable\(false\)/);
  assert.match(windowManagerSource, /this\.setMainWindowInteractivity\(false\)/);
  assert.match(mainSource, /const recoverWindowsAfterResume[\s\S]*recoverAfterSystemResume/);
  assert.match(mainSource, /powerMonitor\.on\("resume"[\s\S]*recoverWindowsAfterResume/);
  assert.match(mainSource, /powerMonitor\.on\("unlock-screen", recoverWindowsAfterResume\)/);
  assert.match(mainSource, /windowsKeyManager\.restart\(currentHotkey\)/);
});

test("Windows capture waits for the native hook and the capsule recovers above shell surfaces", () => {
  const ipcSource = fs.readFileSync(path.join(repoRoot, "src/helpers/ipcHandlers.js"), "utf8");
  const hotkeyInputSource = fs.readFileSync(
    path.join(repoRoot, "src/components/ui/HotkeyInput.tsx"),
    "utf8"
  );
  const windowConfigSource = fs.readFileSync(
    path.join(repoRoot, "src/helpers/windowConfig.js"),
    "utf8"
  );
  const windowManagerSource = fs.readFileSync(
    path.join(repoRoot, "src/helpers/windowManager.js"),
    "utf8"
  );
  const textMonitorSource = fs.readFileSync(
    path.join(repoRoot, "src/helpers/textEditMonitor.js"),
    "utf8"
  );
  const windowsTextMonitorSource = fs.readFileSync(
    path.join(repoRoot, "resources/windows-text-monitor.c"),
    "utf8"
  );

  assert.match(ipcSource, /await this\.windowsKeyManager\.startCapture\(\)/);
  assert.match(hotkeyInputSource, /result\?\.nativeReady === false/);
  assert.match(hotkeyInputSource, /captureReadyRef\.current/);
  assert.match(windowConfigSource, /win32[\s\S]*setAlwaysOnTop\(true, "screen-saver"\)/);
  assert.match(windowManagerSource, /raiseMainWindowWithoutFocus\(\)/);
  assert.match(windowManagerSource, /this\.mainWindow\.moveTop\(\)/);
  assert.match(windowManagerSource, /for \(const delayMs of \[0, 75, 250\]\)/);
  assert.match(windowManagerSource, /_repositionForWindowsStartSurface/);
  assert.match(windowManagerSource, /_repositionToCursorDisplay\(true, "top"\)/);
  assert.match(textMonitorSource, /isWindowsStartSurfaceForeground/);
  assert.match(windowsTextMonitorSource, /--foreground-start-surface/);
  assert.match(windowsTextMonitorSource, /StartMenuExperienceHost\.exe/);
  assert.match(windowsTextMonitorSource, /SearchHost\.exe/);
});
