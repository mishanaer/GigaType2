const fs = require("fs");
const os = require("os");
const path = require("path");

const WINDOWS_INSTALL_REBOOT_MARKER = ".type-install-reboot-required";

function getWindowsInstallRebootMarkerPath(execPath = process.execPath) {
  return path.join(path.dirname(execPath), WINDOWS_INSTALL_REBOOT_MARKER);
}

function getWindowsInstallRebootState({
  platform = process.platform,
  isPackaged = false,
  execPath = process.execPath,
  nowMs = Date.now(),
  uptimeSeconds = os.uptime(),
  fileSystem = fs,
} = {}) {
  const markerPath = getWindowsInstallRebootMarkerPath(execPath);

  if (platform !== "win32" || !isPackaged) {
    return { required: false, markerPath };
  }

  let markerStat;
  try {
    markerStat = fileSystem.statSync(markerPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { required: false, markerPath };
    }

    // Fail closed: an unreadable installer marker must not let the native
    // helpers start in the same boot session.
    return { required: true, markerPath, reason: "marker-unreadable" };
  }

  const bootStartedAtMs = nowMs - Math.max(0, uptimeSeconds) * 1000;
  if (markerStat.mtimeMs >= bootStartedAtMs) {
    return { required: true, markerPath, reason: "installed-this-boot" };
  }

  // The marker predates the current Windows boot, so the required restart
  // happened. Cleanup is best-effort because per-machine installs may not let
  // a standard user remove files from the installation directory.
  try {
    fileSystem.unlinkSync(markerPath);
  } catch {
    // A stale marker is harmless: its timestamp remains older than this boot.
  }

  return { required: false, markerPath, reason: "restarted" };
}

module.exports = {
  WINDOWS_INSTALL_REBOOT_MARKER,
  getWindowsInstallRebootMarkerPath,
  getWindowsInstallRebootState,
};
