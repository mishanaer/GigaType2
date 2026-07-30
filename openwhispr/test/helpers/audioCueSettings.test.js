const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..", "..");

const readSource = (...segments) => fs.readFileSync(path.join(repoRoot, ...segments), "utf8");

test("dictation sounds are user-controllable from the interface stack", () => {
  const settingsStore = readSource("src", "stores", "settingsStore.ts");
  const settingsPage = readSource("src", "components", "SettingsPage.tsx");
  const settingsCells = readSource("src", "components", "settings", "WalletSettingsCells.tsx");
  const cuePlayer = readSource("src", "utils", "dictationCues.js");

  assert.match(
    settingsStore,
    /audioCuesEnabled:\s*readBoolean\("audioCuesEnabled", DEFAULT_AUDIO_CUES_ENABLED\)/
  );
  assert.match(settingsStore, /setAudioCuesEnabled:\s*createBooleanSetter\("audioCuesEnabled"\)/);
  assert.doesNotMatch(settingsStore, /FIXED_AUDIO_CUES_ENABLED/);

  assert.match(settingsPage, /audioCuesEnabled=\{audioCuesEnabled\}/);
  assert.match(settingsPage, /onAudioCuesEnabledChange=\{setAudioCuesEnabled\}/);
  assert.match(settingsCells, /<CellStack ariaLabel="Внешний вид и звуки">/);
  assert.match(settingsCells, /title="Звуки диктовки"/);
  assert.match(cuePlayer, /getSettings\(\)\.audioCuesEnabled/);
  assert.match(cuePlayer, /if \(!isEnabled\(\)\) return/);
});
