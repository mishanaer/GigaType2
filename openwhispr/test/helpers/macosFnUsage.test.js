const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  APPLE_FN_USAGE_TYPE,
  getMacosDefaultHotkey,
  isFnUsageAvailable,
  parseAppleFnUsageType,
  readAppleFnUsageType,
} = require("../../src/helpers/macosFnUsage");

const repoRoot = path.join(__dirname, "..", "..");

test("parses known AppleFnUsageType values", () => {
  assert.equal(parseAppleFnUsageType("0\n"), APPLE_FN_USAGE_TYPE.DO_NOTHING);
  assert.equal(parseAppleFnUsageType("1"), APPLE_FN_USAGE_TYPE.CHANGE_INPUT_SOURCE);
  assert.equal(parseAppleFnUsageType("2"), APPLE_FN_USAGE_TYPE.SHOW_EMOJI_AND_SYMBOLS);
  assert.equal(parseAppleFnUsageType("3"), APPLE_FN_USAGE_TYPE.START_DICTATION);
});

test("treats missing and unknown AppleFnUsageType values as unknown", () => {
  assert.equal(parseAppleFnUsageType(""), null);
  assert.equal(parseAppleFnUsageType("dictation"), null);
  assert.equal(parseAppleFnUsageType("4"), null);
});

test("reads AppleFnUsageType from the macOS defaults domain", () => {
  const calls = [];
  const usageType = readAppleFnUsageType({
    platform: "darwin",
    spawnSyncFn: (...args) => {
      calls.push(args);
      return { status: 0, stdout: "3\n" };
    },
  });

  assert.equal(usageType, APPLE_FN_USAGE_TYPE.START_DICTATION);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/defaults");
  assert.deepEqual(calls[0][1], ["read", "com.apple.HIToolbox", "AppleFnUsageType"]);
});

test("returns unknown when defaults cannot be read", () => {
  assert.equal(
    readAppleFnUsageType({
      platform: "darwin",
      spawnSyncFn: () => ({ status: 1, stdout: "" }),
    }),
    null
  );
  assert.equal(
    readAppleFnUsageType({
      platform: "darwin",
      spawnSyncFn: () => {
        throw new Error("unavailable");
      },
    }),
    null
  );
});

test("does not inspect macOS preferences on other platforms", () => {
  let called = false;
  const usageType = readAppleFnUsageType({
    platform: "win32",
    spawnSyncFn: () => {
      called = true;
      return { status: 0, stdout: "0" };
    },
  });

  assert.equal(usageType, null);
  assert.equal(called, false);
});

test("uses Fn only when macOS assigns no system action", () => {
  assert.equal(isFnUsageAvailable(APPLE_FN_USAGE_TYPE.DO_NOTHING), true);
  assert.equal(isFnUsageAvailable(APPLE_FN_USAGE_TYPE.CHANGE_INPUT_SOURCE), false);
  assert.equal(isFnUsageAvailable(APPLE_FN_USAGE_TYPE.SHOW_EMOJI_AND_SYMBOLS), false);
  assert.equal(isFnUsageAvailable(APPLE_FN_USAGE_TYPE.START_DICTATION), false);
  assert.equal(isFnUsageAvailable(null), false);

  assert.equal(getMacosDefaultHotkey(APPLE_FN_USAGE_TYPE.DO_NOTHING), "GLOBE");
  assert.equal(getMacosDefaultHotkey(APPLE_FN_USAGE_TYPE.START_DICTATION), "RightOption");
  assert.equal(getMacosDefaultHotkey(null), "RightOption");
});

test("manual Fn rejection returns before the selected hotkey is saved", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "src/components/settings/WalletSettingsCells.tsx"),
    "utf8"
  );
  const handlerStart = source.indexOf("const handleHotkeyChange");
  const availabilityCheck = source.indexOf("await checkFnAvailability()", handlerStart);
  const invalidCall = source.indexOf("handleHotkeyInvalid();", availabilityCheck);
  const earlyReturn = source.indexOf("return;", invalidCall);
  const saveCall = source.indexOf("await onHotkeyChange(newHotkey);", handlerStart);

  assert.ok(handlerStart >= 0);
  assert.ok(availabilityCheck > handlerStart);
  assert.ok(invalidCall > availabilityCheck);
  assert.ok(earlyReturn > invalidCall);
  assert.ok(saveCall > earlyReturn);
});

test("onboarding applies the backend-resolved default when no preference exists", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/components/OnboardingFlow.tsx"), "utf8");
  const persistedPreferenceCheck = source.indexOf('if (backendKey && backendKey.trim() !== "")');
  const defaultLookup = source.indexOf("getEffectiveDefaultHotkey", persistedPreferenceCheck);
  const defaultRegistration = source.indexOf("registerHotkey(defaultHotkey)", defaultLookup);

  assert.ok(persistedPreferenceCheck >= 0);
  assert.ok(defaultLookup > persistedPreferenceCheck);
  assert.ok(defaultRegistration > defaultLookup);
});
