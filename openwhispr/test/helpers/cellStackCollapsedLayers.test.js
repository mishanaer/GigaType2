const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..", "..");

const readSource = (...segments) => fs.readFileSync(path.join(repoRoot, ...segments), "utf8");

const cellStackDir = ["src", "vendor", "wallet_animations", "components", "CellStack"];
const cellStackSource = readSource(...cellStackDir, "index.jsx");
const cellStackStyles = readSource(...cellStackDir, "CellStack.module.scss");
const cellStackMorphSource = readSource(...cellStackDir, "Morph.jsx");
const settingsSource = readSource("src", "components", "settings", "WalletSettingsCells.tsx");

// Source-level guards only — there is no DOM test harness for the renderer, so these assert
// the contracts the collapsed stack relies on, not exact markup, styling or tuning constants.
test("collapsed CellStack layers are hidden from assistive tech and pointer input", () => {
  assert.match(cellStackSource, /aria-hidden=\{behind && !expanded\}/);
  assert.match(cellStackSource, /inert=\{behind && !expanded/);
  assert.match(
    cellStackStyles,
    /\[data-expanded="false"\][\s\S]*> \.card:not\(:first-child\)[\s\S]*pointer-events:\s*none/
  );
  // Layers deeper than the first peeking card are fully faded out.
  assert.match(cellStackSource, /opacity:\s*depth >= 2 \? 0/);
});

test("the CellStack header is operable by keyboard", () => {
  assert.match(cellStackSource, /role=\{isTrigger/);
  assert.match(cellStackSource, /aria-expanded=\{isTrigger/);
  assert.match(cellStackSource, /tabIndex=\{isTrigger/);
  assert.match(cellStackSource, /event\.key !== "Enter" && event\.key !== " "/);
  assert.match(cellStackStyles, /:focus-visible/);
});

test("expanding the stack merges the cards into a single grouped card", () => {
  assert.match(cellStackStyles, /\[data-expanded="true"\][\s\S]*gap:\s*0/);
  assert.match(cellStackStyles, /> \.card:last-child[\s\S]*--cell-separator-height:\s*0/);
  assert.match(cellStackSource, /radius:\s*expanded \? 0/);
});

test("the collapsed header shows a chevron that rotates once expanded", () => {
  assert.match(settingsSource, /ChevronDownIcon/);
  assert.doesNotMatch(settingsSource, /ChevronUpIcon/);
  assert.match(settingsSource, /CellStack\.Morph rotateEndOnExpand/);
  assert.match(cellStackMorphSource, /rotate: expanded \? 180 : 0/);
});
