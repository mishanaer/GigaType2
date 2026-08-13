const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const repoRoot = path.join(__dirname, "..", "..");

function loadTsModule(relPath, requireStub = () => ({})) {
  const filePath = path.join(repoRoot, relPath);
  const source = ts.transpileModule(fs.readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) { ${source}\n})`,
    { filename: filePath }
  );
  wrapper(module.exports, requireStub, module, filePath, path.dirname(filePath));
  return module.exports;
}

// t() stub that echoes the key (plus params when present) so assertions can
// check which translation was chosen and with which interpolation values.
const t = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);

test("windows denied status wins over every error name, including NotFoundError", () => {
  const { describeMicAccessError } = loadTsModule("src/utils/recordingErrors.ts");
  for (const name of ["NotFoundError", "NotAllowedError", "NotReadableError", "AbortError"]) {
    const result = describeMicAccessError(
      { name, winMicAccessStatus: "denied" },
      t,
      "win32"
    );
    assert.match(result, /windowsDesktopAppsBlocked/, `name=${name}`);
  }
});

test("windows busy text for NotReadableError when status is granted", () => {
  const { describeMicAccessError } = loadTsModule("src/utils/recordingErrors.ts");
  const result = describeMicAccessError(
    { name: "NotReadableError", winMicAccessStatus: "granted" },
    t,
    "win32"
  );
  assert.match(result, /windowsMicBusyOrBlocked/);
});

test("stale configured device surfaces deviceUnavailable even when the retry failed differently", () => {
  const { describeMicAccessError, getMicAccessErrorTitle } = loadTsModule(
    "src/utils/recordingErrors.ts"
  );
  const failure = { name: "NotReadableError", originalDeviceErrorName: "OverconstrainedError" };
  assert.match(describeMicAccessError(failure, t, "darwin"), /deviceUnavailable/);
  assert.match(getMicAccessErrorTitle(failure, t), /micUnavailable/);
});

test("non-windows platforms keep the generic couldNotStart text", () => {
  const { describeMicAccessError } = loadTsModule("src/utils/recordingErrors.ts");
  const result = describeMicAccessError({ name: "NotReadableError" }, t, "darwin");
  assert.match(result, /couldNotStart/);
});

test("titles map per error name", () => {
  const { getMicAccessErrorTitle } = loadTsModule("src/utils/recordingErrors.ts");
  assert.match(getMicAccessErrorTitle({ name: "NotAllowedError" }, t), /micAccessDenied/);
  assert.match(getMicAccessErrorTitle({ winMicAccessStatus: "denied" }, t), /micAccessDenied/);
  assert.match(getMicAccessErrorTitle({ name: "NotFoundError" }, t), /micNotFound/);
  assert.match(getMicAccessErrorTitle({ name: "NotReadableError" }, t), /micInUse/);
  assert.match(getMicAccessErrorTitle({ name: "WeirdError" }, t), /recordingError/);
});

test("getExactAudioDeviceId reads exact and plain string deviceIds only", () => {
  const { getExactAudioDeviceId } = loadTsModule("src/utils/audioDeviceUtils.ts");
  assert.equal(getExactAudioDeviceId({ audio: { deviceId: { exact: "abc" } } }), "abc");
  assert.equal(getExactAudioDeviceId({ audio: { deviceId: "abc" } }), "abc");
  assert.equal(getExactAudioDeviceId({ audio: true }), null);
  assert.equal(getExactAudioDeviceId({ audio: {} }), null);
  assert.equal(getExactAudioDeviceId({}), null);
});

test("fallback helper retries with default device and reports the failed id", async () => {
  const { getUserMediaWithDefaultDeviceFallback } = loadTsModule("src/utils/audioDeviceUtils.ts");
  const calls = [];
  const stream = { id: "fallback-stream" };
  const err = Object.assign(new Error("busy"), { name: "NotReadableError" });
  global.navigator = {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        calls.push(constraints);
        if (calls.length === 1) throw err;
        return stream;
      },
    },
  };
  try {
    let fallbackInfo = null;
    const result = await getUserMediaWithDefaultDeviceFallback(
      { audio: { deviceId: { exact: "dead" }, echoCancellation: false } },
      { echoCancellation: false },
      { onFallback: (info) => (fallbackInfo = info) }
    );
    assert.equal(result.stream, stream);
    assert.equal(result.usedFallback, true);
    assert.equal(result.failedDeviceId, "dead");
    assert.equal(result.originalError, err);
    assert.deepEqual(fallbackInfo, { failedDeviceId: "dead", error: err });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].audio.deviceId, undefined);
  } finally {
    delete global.navigator;
  }
});

test("fallback helper rethrows non-device errors and errors without an exact device", async () => {
  const { getUserMediaWithDefaultDeviceFallback } = loadTsModule("src/utils/audioDeviceUtils.ts");
  const err = Object.assign(new Error("nope"), { name: "NotAllowedError" });
  let calls = 0;
  global.navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        calls += 1;
        throw err;
      },
    },
  };
  try {
    await assert.rejects(
      () =>
        getUserMediaWithDefaultDeviceFallback({ audio: { deviceId: { exact: "x" } } }, {}, {}),
      /nope/
    );
    assert.equal(calls, 1, "permission errors must not trigger a retry");

    calls = 0;
    err.name = "NotReadableError";
    await assert.rejects(
      () => getUserMediaWithDefaultDeviceFallback({ audio: true }, {}, {}),
      /nope/
    );
    assert.equal(calls, 1, "no exact device means no retry");
  } finally {
    delete global.navigator;
  }
});

test("fallback helper attaches originalDeviceErrorName when the retry also fails", async () => {
  const { getUserMediaWithDefaultDeviceFallback } = loadTsModule("src/utils/audioDeviceUtils.ts");
  const first = Object.assign(new Error("gone"), { name: "OverconstrainedError" });
  const second = Object.assign(new Error("busy"), { name: "NotReadableError" });
  let calls = 0;
  global.navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        calls += 1;
        throw calls === 1 ? first : second;
      },
    },
  };
  try {
    await assert.rejects(
      () =>
        getUserMediaWithDefaultDeviceFallback({ audio: { deviceId: { exact: "x" } } }, {}, {}),
      (thrown) => {
        assert.equal(thrown, second);
        assert.equal(thrown.originalDeviceErrorName, "OverconstrainedError");
        return true;
      }
    );
  } finally {
    delete global.navigator;
  }
});

test("fallback helper honors shouldCancel between attempts", async () => {
  const { getUserMediaWithDefaultDeviceFallback } = loadTsModule("src/utils/audioDeviceUtils.ts");
  const err = Object.assign(new Error("busy"), { name: "NotReadableError" });
  let calls = 0;
  global.navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        calls += 1;
        throw err;
      },
    },
  };
  try {
    const result = await getUserMediaWithDefaultDeviceFallback(
      { audio: { deviceId: { exact: "x" } } },
      {},
      { shouldCancel: () => true }
    );
    assert.equal(result.stream, null);
    assert.equal(result.usedFallback, false);
    assert.equal(calls, 1, "cancel must prevent the retry getUserMedia");
  } finally {
    delete global.navigator;
  }
});
