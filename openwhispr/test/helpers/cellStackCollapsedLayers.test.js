const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const cellStackSource = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "..",
    "src",
    "vendor",
    "wallet_animations",
    "components",
    "CellStack",
    "index.jsx"
  ),
  "utf8"
);
const cellStackStyles = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "..",
    "src",
    "vendor",
    "wallet_animations",
    "components",
    "CellStack",
    "CellStack.module.scss"
  ),
  "utf8"
);
const cellStackMorphSource = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "..",
    "src",
    "vendor",
    "wallet_animations",
    "components",
    "CellStack",
    "Morph.jsx"
  ),
  "utf8"
);
const settingsSource = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "components", "settings", "WalletSettingsCells.tsx"),
  "utf8"
);

test("collapsed CellStack renders only the front card and one visible layer", () => {
  assert.match(cellStackSource, /const FADE_STEP = 0\.5/);
  assert.match(cellStackSource, /opacity:\s*depth >= 2 \? 0 : 1 - depth \* FADE_STEP/);
});

test("CellStack reuses the typography and grouped-card styling of the settings list", () => {
  assert.match(cellStackSource, /radius:\s*expanded \? 0/);
  assert.match(cellStackStyles, /\[data-expanded="true"\][\s\S]*gap:\s*0/);
  assert.match(cellStackStyles, /> \.card:last-child[\s\S]*--cell-separator-height:\s*0/);
  assert.match(
    cellStackStyles,
    /\[data-expanded="false"\][\s\S]*> \.card:not\(:first-child\)[\s\S]*position:\s*absolute/
  );
  assert.doesNotMatch(settingsSource, /title="Внешний вид и звуки"\s+bold/);
});

test("collapsed CellStack uses a downward chevron instead of a settings count", () => {
  assert.match(settingsSource, /ChevronDownIcon/);
  assert.doesNotMatch(settingsSource, /ChevronUpIcon/);
  assert.match(settingsSource, /CellStack\.Morph rotateEndOnExpand/);
  assert.match(settingsSource, /text-\[var\(--tg-theme-subtitle-text-color\)\] opacity-70/);
  assert.match(cellStackMorphSource, /rotate: expanded \? 180 : 0/);
  assert.match(cellStackMorphSource, /CHEVRON_DURATION_SCALE = 1\.5/);
  assert.match(cellStackMorphSource, /transition=\{rotateTransition\}/);
  assert.doesNotMatch(settingsSource, /["`]3 настройки["`]/);
  assert.doesNotMatch(settingsSource, /["`]2 настройки["`]/);
});

test("interface stack does not show secondary descriptions", () => {
  assert.doesNotMatch(settingsSource, /description=/);
});
