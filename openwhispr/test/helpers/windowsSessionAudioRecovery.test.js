const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const repoRoot = path.join(__dirname, "..", "..");

function loadAudioManager(settings = { preferBuiltInMic: true, selectedMicDeviceId: "" }) {
  const filePath = path.join(repoRoot, "src/helpers/audioManager.js");
  const source = ts.transpileModule(fs.readFileSync(filePath, "utf8"), {
    compilerOptions: {
      allowJs: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const module = { exports: {} };
  const requireStub = (request) => {
    if (request.endsWith("/logger")) return logger;
    if (request.endsWith("/audioDeviceUtils")) {
      return {
        isBuiltInMicrophone: (label) => label.toLowerCase().includes("built-in"),
        getUserMediaWithDefaultDeviceFallback: async () => {
          throw new Error("unused");
        },
      };
    }
    if (request.endsWith("/settingsStore")) {
      return { getSettings: () => ({ ...settings }) };
    }
    if (request.endsWith("/SyncService.js")) return { syncService: {} };
    if (request.endsWith("/localSpeechGate")) {
      return {
        createLocalSpeechGateState: () => ({}),
        getLocalSpeechGateDecision: () => ({}),
        recordLocalSpeechWindow() {},
      };
    }
    return new Proxy(
      {},
      {
        get: () => () => "",
      }
    );
  };
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) { ${source}\n})`,
    { filename: filePath }
  );
  wrapper(module.exports, requireStub, module, filePath, path.dirname(filePath));
  return module.exports.default;
}

async function withNavigator(mock, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: mock,
    configurable: true,
    writable: true,
  });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
}

test("session reset releases capture resources and invalidates the endpoint cache", () => {
  const AudioManager = loadAudioManager();
  const manager = new AudioManager();
  let stopped = 0;
  let disconnected = 0;
  let contextClosed = 0;
  let stateChange = null;

  manager.isRecording = true;
  manager.cachedMicDeviceId = "stale-endpoint";
  manager._failedMicDeviceIds.add("failed-endpoint");
  manager._micStream = { getTracks: () => [{ stop: () => stopped++ }] };
  manager._scriptProcessor = { disconnect: () => disconnected++ };
  manager._recordSource = { disconnect: () => disconnected++ };
  manager._recordCtx = { close: () => (contextClosed++, Promise.resolve()) };
  manager._silenceCtx = { close: () => (contextClosed++, Promise.resolve()) };
  manager.streamingAudioContext = {
    state: "running",
    close: () => (contextClosed++, Promise.resolve()),
  };
  manager.onStateChange = (state) => {
    stateChange = state;
  };

  const result = manager.resetInputAfterSessionChange({ phase: "inactive", settleMs: 0 });

  assert.deepEqual(result, { hadActiveCapture: true });
  assert.equal(stopped, 1);
  assert.equal(disconnected, 2);
  assert.equal(contextClosed, 3);
  assert.equal(manager.cachedMicDeviceId, null);
  assert.equal(manager._failedMicDeviceIds.size, 0);
  assert.equal(manager.isRecording, false);
  assert.equal(manager._forceSystemDefaultMicOnce, true);
  assert.deepEqual(stateChange, {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
  });
});

test("first capture after session recovery bypasses stale device ids once", async () => {
  const AudioManager = loadAudioManager();
  const manager = new AudioManager();
  let enumerations = 0;

  manager.cachedMicDeviceId = "stale-endpoint";
  manager.resetInputAfterSessionChange({ phase: "active", settleMs: 0 });

  await withNavigator(
    {
      mediaDevices: {
        enumerateDevices: async () => {
          enumerations++;
          return [{ kind: "audioinput", deviceId: "fresh-endpoint", label: "Built-in Mic" }];
        },
      },
    },
    async () => {
      assert.deepEqual(await manager.getAudioConstraints(), {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
      });
      assert.equal(enumerations, 0);

      const second = await manager.getAudioConstraints();
      assert.equal(enumerations, 1);
      assert.deepEqual(second.audio.deviceId, { exact: "fresh-endpoint" });
    }
  );
});

test("session recovery keeps an explicitly selected microphone", async () => {
  const AudioManager = loadAudioManager({
    preferBuiltInMic: false,
    selectedMicDeviceId: "usb-mic",
  });
  const manager = new AudioManager();

  manager.cachedMicDeviceId = "stale-endpoint";
  manager.resetInputAfterSessionChange({ phase: "active", settleMs: 0 });

  await withNavigator(
    {
      mediaDevices: {
        enumerateDevices: async () => {
          throw new Error("should not enumerate for an explicit selection");
        },
      },
    },
    async () => {
      const constraints = await manager.getAudioConstraints();
      assert.deepEqual(constraints.audio.deviceId, { exact: "usb-mic" });

      const second = await manager.getAudioConstraints();
      assert.deepEqual(second.audio.deviceId, { exact: "usb-mic" });
    }
  );
});

test("renderer subscribes audio recovery to session and device change events", () => {
  const hookSource = fs.readFileSync(path.join(repoRoot, "src/hooks/useAudioRecording.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(repoRoot, "preload.js"), "utf8");

  assert.match(hookSource, /onSystemSessionInactive[\s\S]*resetWindowsSessionAudio\("inactive"\)/);
  assert.match(hookSource, /onSystemResumed[\s\S]*resetWindowsSessionAudio\("active"\)/);
  assert.match(hookSource, /addEventListener\?\.\("devicechange"/);
  assert.match(hookSource, /removeEventListener\?\.\("devicechange"/);
  assert.match(preloadSource, /"system-session-inactive"/);
});
