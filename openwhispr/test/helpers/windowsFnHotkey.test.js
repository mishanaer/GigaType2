const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const repoRoot = path.join(__dirname, "..", "..");

function loadCommonJsModule(filePath, requireStub, transform = (source) => source) {
  const source = transform(fs.readFileSync(filePath, "utf8"));
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) { ${source}\n})`,
    { filename: filePath }
  );
  wrapper(module.exports, requireStub, module, filePath, path.dirname(filePath));
  return module.exports;
}

function loadHotkeyValidator() {
  const filePath = path.join(repoRoot, "src", "utils", "hotkeyValidator.ts");
  return loadCommonJsModule(
    filePath,
    (request) => {
      if (request === "./hotkeys") {
        return {
          formatHotkeyLabelForPlatform: (hotkey) => hotkey,
          isGlobeLikeHotkey: (hotkey) => hotkey === "Fn" || hotkey === "GLOBE",
          isMouseButtonHotkey: (hotkey) => /^MouseButton[45]$/i.test(hotkey || ""),
        };
      }
      throw new Error(`Unexpected validator dependency: ${request}`);
    },
    (source) =>
      ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText
  );
}

function loadHotkeyManager(globalShortcut) {
  const filePath = path.join(repoRoot, "src", "helpers", "hotkeyManager.js");
  const nullLogger = new Proxy({}, { get: () => () => {} });
  class NativeShortcutStub {
    static isGnome() {
      return false;
    }
    static isWayland() {
      return false;
    }
    static isHyprland() {
      return false;
    }
    static isHyprctlAvailable() {
      return false;
    }
    static isKDE() {
      return false;
    }
  }

  return loadCommonJsModule(filePath, (request) => {
    if (request === "events") return require("node:events");
    if (request === "electron") {
      return { globalShortcut, BrowserWindow: { getAllWindows: () => [] } };
    }
    if (request === "./debugLogger") return nullLogger;
    if (
      request === "./gnomeShortcut" ||
      request === "./hyprlandShortcut" ||
      request === "./kdeShortcut"
    ) {
      return NativeShortcutStub;
    }
    if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
    if (request === "./macosFnUsage") {
      return {
        getMacosDefaultHotkey: () => "GLOBE",
        isFnUsageAvailable: () => true,
        readAppleFnUsageType: () => null,
      };
    }
    throw new Error(`Unexpected hotkey manager dependency: ${request}`);
  });
}

test("Windows and Linux validators reject Fn in every shortcut position", () => {
  const { validateHotkey } = loadHotkeyValidator();

  for (const platform of ["win32", "linux"]) {
    for (const hotkey of ["Fn", "Fn+F8", "Control+Fn+K", " fn + F8 ", "Globe+F9"]) {
      const result = validateHotkey(hotkey, platform);
      assert.equal(result.valid, false, `${platform}: ${hotkey}`);
      assert.equal(result.errorCode, "INVALID_GLOBE", `${platform}: ${hotkey}`);
    }
  }

  assert.equal(validateHotkey("F8", "win32").valid, true);
  assert.equal(validateHotkey("Control+F8", "win32").valid, true);
  assert.equal(validateHotkey("Fn+F8", "darwin").valid, true);
});

test("Windows reserved Win combinations are rejected before registration", () => {
  const { validateHotkey } = loadHotkeyValidator();

  for (const hotkey of ["Super+L", "Super+Space", "Super+A"]) {
    const result = validateHotkey(hotkey, "win32");
    assert.equal(result.valid, false, hotkey);
    assert.equal(result.errorCode, "RESERVED", hotkey);
  }
});

test("Windows and Linux backends reject Fn before touching active registrations", async () => {
  const calls = [];
  const globalShortcut = {
    isRegistered: () => false,
    register: (...args) => {
      calls.push(["register", ...args]);
      return true;
    },
    unregister: (...args) => calls.push(["unregister", ...args]),
    unregisterAll: () => calls.push(["unregisterAll"]),
  };
  const HotkeyManager = loadHotkeyManager(globalShortcut);
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    for (const platform of ["win32", "linux"]) {
      Object.defineProperty(process, "platform", { configurable: true, value: platform });
      const manager = new HotkeyManager();
      const previousHotkey = manager.getCurrentHotkey();
      const result = manager.setupShortcuts("Fn+F8", () => {});

      assert.equal(result.success, false, platform);
      assert.equal(result.reason, "unsupported_fn_key", platform);
      assert.equal(manager.getCurrentHotkey(), previousHotkey, platform);
      assert.deepEqual(calls, [], platform);

      const slotResult = await manager.registerSlot("agent", "Fn+F8", () => {});
      assert.equal(slotResult.success, false, platform);
      assert.equal(slotResult.reason, "unsupported_fn_key", platform);
      assert.deepEqual(calls, [], platform);
    }
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

test("registration failures are wired to the settings capsule shake", () => {
  const settingsSource = fs.readFileSync(
    path.join(repoRoot, "src", "components", "settings", "WalletSettingsCells.tsx"),
    "utf8"
  );

  const registration = settingsSource.indexOf(
    "const registered = await onHotkeyChange(newHotkey);"
  );
  const failureCheck = settingsSource.indexOf("if (registered === false)", registration);
  const shake = settingsSource.indexOf("handleHotkeyInvalid();", failureCheck);

  assert.ok(registration >= 0, "registration result should be retained");
  assert.ok(failureCheck > registration, "failed registration should be checked");
  assert.ok(shake > failureCheck, "failed registration should shake the capsule");

  const inputSource = fs.readFileSync(
    path.join(repoRoot, "src", "components", "ui", "HotkeyInput.tsx"),
    "utf8"
  );
  assert.match(inputSource, /finalizeCapture\(e\.key \|\| code \|\| "Unsupported"\)/);
  assert.match(inputSource, /registered = await onChange\(hotkey\)/);
  assert.match(
    inputSource,
    /if \(registered === false\)[\s\S]*lastCapturedHotkeyRef\.current = null/
  );
});

test("native Windows listener rejects Fn instead of falling back to the bare key", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "resources", "windows-key-listener.c"),
    "utf8"
  );

  assert.match(source, /g_hasUnsupportedFnToken = TRUE/);
  assert.match(source, /if \(g_hasUnsupportedFnToken\)/);
});

test("Windows native capture handles Win, Caps Lock and Escape without shell fallthrough", () => {
  const nativeSource = fs.readFileSync(
    path.join(repoRoot, "resources", "windows-key-listener.c"),
    "utf8"
  );
  const managerSource = fs.readFileSync(
    path.join(repoRoot, "src", "helpers", "windowsKeyManager.js"),
    "utf8"
  );
  const inputSource = fs.readFileSync(
    path.join(repoRoot, "src", "components", "ui", "HotkeyInput.tsx"),
    "utf8"
  );

  assert.match(nativeSource, /--capture/);
  assert.match(nativeSource, /CAPTURE_CANCEL/);
  assert.match(nativeSource, /EmitCapturedHotkey\("CapsLock"/);
  assert.match(nativeSource, /QueueCapturedHotkey/);
  assert.match(nativeSource, /TryEmitPendingCapture/);
  assert.match(nativeSource, /g_captureBaseDown/);
  assert.match(nativeSource, /return 1;[\s\S]*Suppress captured keys/);
  assert.match(managerSource, /async startCapture\(/);
  assert.match(managerSource, /this\.emit\("capture", hotkey\)/);
  assert.match(inputSource, /if \(code === "Escape"\)[\s\S]*cancelCapture\(\)/);
  assert.match(inputSource, /onWindowsHotkeyCaptured/);
});

test("Windows settings explain that hardware Fn is not observable", () => {
  const settingsSource = fs.readFileSync(
    path.join(repoRoot, "src", "components", "settings", "WalletSettingsCells.tsx"),
    "utf8"
  );

  assert.match(settingsSource, /Fn недоступна/);
});

test("Caps Lock hotkeys use the native Windows backend and remain valid", () => {
  const { validateHotkey } = loadHotkeyValidator();
  assert.equal(validateHotkey("CapsLock", "win32").valid, true);
  assert.equal(validateHotkey("CapsLock+A", "win32").valid, true);
  assert.equal(validateHotkey("Super+CapsLock+A", "win32").valid, true);

  const calls = [];
  const globalShortcut = {
    isRegistered: () => false,
    register: (...args) => {
      calls.push(["register", ...args]);
      return true;
    },
    unregister: (...args) => calls.push(["unregister", ...args]),
    unregisterAll: () => calls.push(["unregisterAll"]),
  };
  const HotkeyManager = loadHotkeyManager(globalShortcut);
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const manager = new HotkeyManager();
    const result = manager.setupShortcuts("CapsLock+A", () => {});
    assert.equal(result.success, true);
    assert.equal(manager.getCurrentHotkey(), "CapsLock+A");
    assert.equal(
      calls.some(([name]) => name === "register"),
      false
    );
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

test("native Linux listener rejects Fn instead of falling back to the bare key", () => {
  const source = fs.readFileSync(path.join(repoRoot, "resources", "linux-key-listener.c"), "utf8");
  const managerSource = fs.readFileSync(
    path.join(repoRoot, "src", "helpers", "linuxKeyManager.js"),
    "utf8"
  );

  assert.match(source, /has_unsupported_fn_token = 1/);
  assert.match(source, /if \(has_unsupported_fn_token\)/);
  assert.match(managerSource, /if \(hasFnOrGlobeToken\(key\)\)/);
});
