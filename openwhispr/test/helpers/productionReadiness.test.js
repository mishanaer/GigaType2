const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("control panel keeps Electron web security enabled", () => {
  const {
    CONTROL_PANEL_CONFIG,
    getControlPanelBackgroundColor,
  } = require("../../src/helpers/windowConfig");

  assert.equal(CONTROL_PANEL_CONFIG.webPreferences.nodeIntegration, false);
  assert.equal(CONTROL_PANEL_CONFIG.webPreferences.contextIsolation, true);
  assert.equal(CONTROL_PANEL_CONFIG.webPreferences.sandbox, true);
  assert.equal(CONTROL_PANEL_CONFIG.webPreferences.webSecurity, true);
  assert.equal(getControlPanelBackgroundColor("win32", false), "#f5f5f5");
  assert.equal(getControlPanelBackgroundColor("win32", true), "#f5f5f5");
  assert.equal(getControlPanelBackgroundColor("linux", false), "#f5f5f5");
  assert.equal(getControlPanelBackgroundColor("linux", true), "#262626");
  assert.equal(getControlPanelBackgroundColor("darwin", true), "#00000000");
});

test("renderer entrypoint declares Type branding and CSP", () => {
  const html = read("src/index.html");

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /<title>Type<\/title>/);
});

test("bundled app metadata uses Type as the visible product name", () => {
  const builderConfig = JSON.parse(read("electron-builder.json"));
  const englishLocale = JSON.parse(read("src/locales/en/translation.json"));

  assert.equal(builderConfig.productName, "Type");
  assert.equal(builderConfig.protocols.name, "Type Protocol");
  assert.equal(englishLocale.menu.appLabel, "Type");
  assert.equal(englishLocale.auth.welcomeTitle, "Welcome to Type");
});

test("macOS release artifacts use one signed notarization pipeline", () => {
  const builderConfig = JSON.parse(read("electron-builder.json"));
  const protectedEntitlements = read("resources/mac/entitlements.protected-helper.plist");
  const releaseWorkflow = read(".github/workflows/release.yml");

  assert.equal(builderConfig.appId, "ai.gigatype.app");
  assert.equal(builderConfig.mac.hardenedRuntime, true);
  assert.equal(builderConfig.mac.notarize, true);
  assert.equal(builderConfig.dmg.sign, true);
  assert.equal(builderConfig.afterSign, "scripts/verifyMacIdentityAfterSign.js");
  assert.match(protectedEntitlements, /SBHVKH5UUY\.ai\.gigatype\.app/);
  assert.match(releaseWorkflow, /verify-macos-app-identity\.js/);
});

test("local-only transcription provider surface does not advertise OpenAI", () => {
  const providersStore = read("src/stores/streamingProvidersStore.ts");
  const modelRegistry = read("src/models/ModelRegistry.ts");

  assert.match(providersStore, /id:\s*"gigaam"/);
  assert.match(providersStore, /gigaam-v3-e2e-rnnt/);
  assert.match(modelRegistry, /gigaam-v3-e2e-rnnt/);
  assert.doesNotMatch(providersStore, /gpt-4o-mini-transcribe/);
  assert.doesNotMatch(modelRegistry, /gpt-4o-mini-transcribe/);
  assert.doesNotMatch(providersStore, /id:\s*"openai"/);
});

test("reasoning selector does not expose cloud provider tabs", () => {
  const selector = read("src/components/ReasoningModelSelector.tsx");
  const editor = read("src/components/settings/InferenceConfigEditor.tsx");

  assert.doesNotMatch(selector, /selectedCloudProvider/);
  assert.doesNotMatch(selector, /CloudModelPicker/);
  assert.doesNotMatch(editor, /id:\s*"providers"/);
});
