const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateControlPanelBounds,
  getUsableDisplayArea,
} = require("../../src/helpers/controlPanelBounds");

const currentBounds = { x: 710, y: 220, width: 500, height: 560 };

test("falls back to physical display bounds while Windows workArea is not ready", () => {
  const display = {
    workArea: { x: 0, y: 0, width: 320, height: 200 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  };

  assert.deepEqual(getUsableDisplayArea(display, 500), display.bounds);
  assert.deepEqual(
    calculateControlPanelBounds({
      currentBounds,
      display,
      requestedHeight: 620,
      requestedWidth: 500,
    }).bounds,
    { x: 710, y: 190, width: 500, height: 620 }
  );
});

test("defers resize instead of clipping fixed-width content on invalid startup metrics", () => {
  const result = calculateControlPanelBounds({
    currentBounds,
    display: {
      workArea: { x: 0, y: 0, width: 0, height: 0 },
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    },
    requestedHeight: 620,
    requestedWidth: 500,
  });

  assert.equal(result, null);
});

test("keeps the 500px renderer width and clamps only height on a real display", () => {
  const result = calculateControlPanelBounds({
    currentBounds,
    display: {
      workArea: { x: 0, y: 24, width: 1280, height: 720 },
      bounds: { x: 0, y: 0, width: 1280, height: 768 },
    },
    requestedHeight: 900,
    requestedWidth: 500,
  });

  assert.equal(result.minWidth, 500);
  assert.deepEqual(result.bounds, { x: 710, y: 72, width: 500, height: 672 });
});
