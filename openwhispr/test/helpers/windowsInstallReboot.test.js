const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  WINDOWS_INSTALL_REBOOT_MARKER,
  getWindowsInstallRebootMarkerPath,
  getWindowsInstallRebootState,
} = require("../../src/utils/windowsInstallReboot.cjs");

const execPath = path.join(
  "C:",
  "Users",
  "test",
  "AppData",
  "Local",
  "Programs",
  "Type",
  "Type.exe"
);
const markerPath = getWindowsInstallRebootMarkerPath(execPath);

test("Windows packaged app is blocked when installed during the current boot", () => {
  const state = getWindowsInstallRebootState({
    platform: "win32",
    isPackaged: true,
    execPath,
    nowMs: 2_000_000,
    uptimeSeconds: 1_000,
    fileSystem: {
      statSync(requestedPath) {
        assert.equal(requestedPath, markerPath);
        return { mtimeMs: 1_500_000 };
      },
      unlinkSync() {
        assert.fail("current-boot marker must not be removed");
      },
    },
  });

  assert.equal(state.required, true);
  assert.equal(state.reason, "installed-this-boot");
});

test("Windows packaged app starts and cleans the marker after a reboot", () => {
  let removedPath = null;
  const state = getWindowsInstallRebootState({
    platform: "win32",
    isPackaged: true,
    execPath,
    nowMs: 2_000_000,
    uptimeSeconds: 100,
    fileSystem: {
      statSync() {
        return { mtimeMs: 1_500_000 };
      },
      unlinkSync(requestedPath) {
        removedPath = requestedPath;
      },
    },
  });

  assert.equal(state.required, false);
  assert.equal(state.reason, "restarted");
  assert.equal(removedPath, markerPath);
});

test("reboot marker does not affect development or other platforms", () => {
  const inaccessibleFileSystem = {
    statSync() {
      assert.fail("marker must not be read");
    },
  };

  assert.equal(
    getWindowsInstallRebootState({
      platform: "darwin",
      isPackaged: true,
      fileSystem: inaccessibleFileSystem,
    }).required,
    false
  );
  assert.equal(
    getWindowsInstallRebootState({
      platform: "win32",
      isPackaged: false,
      fileSystem: inaccessibleFileSystem,
    }).required,
    false
  );
  assert.equal(path.basename(markerPath), WINDOWS_INSTALL_REBOOT_MARKER);
});
