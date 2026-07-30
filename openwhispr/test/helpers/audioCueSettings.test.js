const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..", "..");

const readSource = (...segments) => fs.readFileSync(path.join(repoRoot, ...segments), "utf8");

// These are source-level guards: the renderer has no DOM test harness, so they check the
// wiring that carries the toggle to the capsule window rather than the rendered result.
test("dictation sounds are a user setting rather than a fixed constant", () => {
  const settingsStore = readSource("src", "stores", "settingsStore.ts");

  assert.match(settingsStore, /audioCuesEnabled:\s*readBoolean\("audioCuesEnabled"/);
  assert.match(settingsStore, /setAudioCuesEnabled:\s*createBooleanSetter\("audioCuesEnabled"\)/);

  // Launch-time enforcement must not clobber the user's choice.
  const enforceBehavior = settingsStore.match(
    /function enforceFixedBehaviorSettings\(\)[\s\S]*?\n\}/
  );
  assert.ok(enforceBehavior, "enforceFixedBehaviorSettings should still exist");
  assert.doesNotMatch(enforceBehavior[0], /audioCuesEnabled/);

  // Without this entry the storage-event bridge won't sync the toggle across windows.
  const booleanSettings = settingsStore.match(/const BOOLEAN_SETTINGS = new Set\(\[[\s\S]*?\]\)/);
  assert.ok(booleanSettings, "BOOLEAN_SETTINGS should still exist");
  assert.match(booleanSettings[0], /"audioCuesEnabled"/);
});

test("the dictation sounds switch is wired from the store to the cue player", () => {
  const settingsPage = readSource("src", "components", "SettingsPage.tsx");
  const settingsCells = readSource("src", "components", "settings", "WalletSettingsCells.tsx");
  const cuePlayer = readSource("src", "utils", "dictationCues.js");

  assert.match(settingsPage, /audioCuesEnabled=\{audioCuesEnabled\}/);
  assert.match(settingsPage, /onAudioCuesEnabledChange=\{setAudioCuesEnabled\}/);
  assert.match(settingsCells, /Звуки диктовки/);
  assert.match(cuePlayer, /getSettings\(\)\.audioCuesEnabled/);
  assert.match(cuePlayer, /if \(!isEnabled\(\)\) return/);
});
