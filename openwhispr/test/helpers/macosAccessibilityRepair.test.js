const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CURRENT_BUNDLE_ID,
  LEGACY_BUNDLE_IDS,
  REPAIR_MARKER,
  repairLegacyAccessibilityIfNeeded,
} = require("../../src/helpers/macosAccessibilityRepair");

function createFakeFs(markerExists = false) {
  const writes = [];
  return {
    writes,
    existsSync(filePath) {
      return markerExists && filePath.endsWith(REPAIR_MARKER);
    },
    writeFileSync(...args) {
      writes.push(args);
    },
  };
}

test("repairs current and legacy Type TCC records once for returning packaged users", async () => {
  const calls = [];
  const fakeFs = createFakeFs();
  const result = await repairLegacyAccessibilityIfNeeded({
    platform: "darwin",
    isPackaged: true,
    isTrusted: false,
    hasExistingUserData: true,
    userDataPath: "/tmp/type-test-user-data",
    fsImpl: fakeFs,
    execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options });
      callback(null, "Successfully reset Accessibility approval status", "");
    },
  });

  assert.equal(result.attempted, true);
  assert.deepEqual(
    calls.map(({ args }) => args),
    [...LEGACY_BUNDLE_IDS, CURRENT_BUNDLE_ID].map((bundleId) => [
      "reset",
      "Accessibility",
      bundleId,
    ])
  );
  assert.equal(fakeFs.writes.length, 1);
  assert.equal(fakeFs.writes[0][2].mode, 0o600);
});

test("does not reset TCC for fresh, trusted, development, or already-repaired apps", async () => {
  const scenarios = [
    { platform: "win32", isPackaged: true, isTrusted: false, hasExistingUserData: true },
    { platform: "darwin", isPackaged: false, isTrusted: false, hasExistingUserData: true },
    { platform: "darwin", isPackaged: true, isTrusted: true, hasExistingUserData: true },
    { platform: "darwin", isPackaged: true, isTrusted: false, hasExistingUserData: false },
  ];

  for (const scenario of scenarios) {
    const result = await repairLegacyAccessibilityIfNeeded({
      ...scenario,
      userDataPath: "/tmp/type-test-user-data",
      fsImpl: createFakeFs(),
      execFileImpl() {
        assert.fail("tccutil must not run");
      },
    });
    assert.equal(result.attempted, false);
  }

  const alreadyRepaired = await repairLegacyAccessibilityIfNeeded({
    platform: "darwin",
    isPackaged: true,
    isTrusted: false,
    hasExistingUserData: true,
    userDataPath: "/tmp/type-test-user-data",
    fsImpl: createFakeFs(true),
    execFileImpl() {
      assert.fail("tccutil must not run twice");
    },
  });
  assert.equal(alreadyRepaired.reason, "already-attempted");
});
