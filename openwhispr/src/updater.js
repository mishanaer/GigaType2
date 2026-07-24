const fs = require("fs");
const path = require("path");
const { app, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
const { i18nMain } = require("./helpers/i18nMain");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

const SKIP_DURATION_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 3000;
const PERIODIC_INTERVAL_MS = 4 * 60 * 60 * 1000;
const SKIP_STATE_FILE = "updater-skip.json";

function envFlag(name) {
  return TRUE_VALUES.has(
    String(process.env[name] || "")
      .trim()
      .toLowerCase()
  );
}

// Auto-update is ON by default in production. It stays off in dev / unpackaged
// builds (there is nothing to update to), and can be force-disabled in the
// field via GIGATYPE_DISABLE_AUTO_UPDATES or force-enabled for QA on any build
// via GIGATYPE_FORCE_UPDATE_CHECKS.
function isUpdaterEnabled() {
  if (envFlag("GIGATYPE_FORCE_UPDATE_CHECKS")) return true;
  if (process.env.NODE_ENV === "development") return false;
  if (!app.isPackaged) return false;
  if (envFlag("GIGATYPE_DISABLE_AUTO_UPDATES")) return false;
  return true;
}

function compareVersions(a, b) {
  const split = (v) =>
    String(v)
      .split("-")[0]
      .split(".")
      .map((p) => parseInt(p, 10));
  const pa = split(a);
  const pb = split(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (Number.isNaN(va) || Number.isNaN(vb)) return 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

function fmtErr(e) {
  if (e == null) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

class UpdateManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.windowManager = null;

    this.enabled = isUpdaterEnabled();
    // Kept for the renderer's UpdateStatus shape (useUpdater.ts).
    this.startupUpdateChecksEnabled = this.enabled;

    this.updateAvailable = false;
    this.updateDownloaded = false;
    this.isDownloading = false;
    this.isInstalling = false;
    this.lastUpdateInfo = null;

    this._activeDownload = null;
    this._eventListeners = [];
    this._periodicTimer = null;
    this._startupTimer = null;
    this._prepareForInstall = null;

    this.setupAutoUpdater();
  }

  setWindows(mainWindow, controlPanelWindow) {
    this.mainWindow = mainWindow;
    this.controlPanelWindow = controlPanelWindow;
  }

  setWindowManager(windowManager) {
    this.windowManager = windowManager;
  }

  // main.js injects the teardown that must run before the installer replaces
  // the app: stop native listeners + shut down every sidecar (Qdrant, the ONNX
  // utility process, llama-server, GigaAM). On Windows those hold file locks
  // that break the NSIS in-place update; on macOS the ONNX/dylib mappings can
  // interfere with the .app swap. Mirrors GigaTool's killSidecar-before-install.
  setPrepareForInstall(fn) {
    this._prepareForInstall = fn;
  }

  setupAutoUpdater() {
    if (!this.enabled) return;

    // The update feed is baked into app-update.yml at build time from the
    // "generic" publish provider in electron-builder.json (SberCloud OBS:
    // .../function_descriptions/gigatype-electron/<channel>). Do NOT call
    // setFeedURL here — it would override the baked config. We only tune the
    // channel below; electron-updater reads the OBS URL from app-update.yml.

    // Base channel: "latest" (Windows → latest.yml, Linux → latest-linux.yml).
    this._primaryChannel = "latest";
    this._fallbackChannel = null;

    // Use an arch-specific update channel on macOS to prevent arm64/x64 from
    // downloading mismatched artifacts. Both builds publish to the same feed,
    // so without this they race on latest-mac.yml. Channel 'latest-arm64' makes
    // the updater fetch 'latest-arm64-mac.yml' (minted by scripts/publish.py /
    // release.yml) instead of the shared 'latest-mac.yml'.
    if (process.platform === "darwin") {
      let nativeArch = process.arch;

      // Detect Rosetta: an x64 build running on Apple Silicon reports
      // sysctl.proc_translated === "1". This self-heals users stuck on the x64
      // build from older releases by pointing them at the arm64 channel.
      if (process.arch === "x64") {
        try {
          const { execSync } = require("child_process");
          const translated = execSync("sysctl -n sysctl.proc_translated", {
            encoding: "utf8",
            timeout: 3000,
          }).trim();
          if (translated === "1") {
            console.log("🔄 Rosetta detected — switching update channel to arm64");
            nativeArch = "arm64";
          }
        } catch {
          // sysctl.proc_translated doesn't exist on real Intel Macs — ignore.
        }
      }

      this._primaryChannel = nativeArch === "arm64" ? "latest-arm64" : "latest-x64";
      // Fall back to the shared latest-mac.yml when the arch-specific manifest
      // isn't on the feed (older releases published only latest-mac.yml).
      // electron-updater then picks the artifact matching process.arch, so this
      // is safe — it never installs a mismatched build.
      this._fallbackChannel = "latest";
    }

    autoUpdater.channel = this._primaryChannel;

    // We drive download + install ourselves (background download, then a native
    // dialog), so disable both of electron-updater's automatic paths. In
    // particular autoInstallOnAppQuit MUST stay false: an install on quit would
    // bypass our sidecar teardown and hit the Windows file-lock problem.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = true;

    // Differential (blockmap) download is what keeps updates small: only the
    // changed blocks of the new artifact are fetched; unchanged blocks are
    // copied from the installed app. The bundled ~851 MB GigaAM model is a
    // fixed snapshot, so when it hasn't changed between versions its blocks are
    // reused and the download is effectively "app only". It falls back to a
    // full download when no local artifact exists to diff against (first update
    // after a fresh install). Enabled by default; set explicitly for clarity.
    autoUpdater.disableDifferentialDownload = false;

    autoUpdater.logger = console;

    this.setupEventHandlers();

    console.log("auto updater configured", {
      channel: autoUpdater.channel,
      allowDowngrade: autoUpdater.allowDowngrade,
      currentVersion: app.getVersion(),
    });
  }

  setupEventHandlers() {
    const handlers = {
      "checking-for-update": () => {
        this.notifyRenderers("checking-for-update");
      },
      "update-available": (info) => {
        this.updateAvailable = true;
        if (info) this.lastUpdateInfo = this._pickInfo(info);
        this.notifyRenderers("update-available", info);
      },
      "update-not-available": (info) => {
        this.updateAvailable = false;
        if (!this.updateDownloaded) {
          this.isDownloading = false;
          this.lastUpdateInfo = null;
        }
        this.notifyRenderers("update-not-available", info);
      },
      error: (err) => {
        // Log only. electron-updater fires this for routine conditions (feed
        // unreachable, a not-yet-published manifest 404, offline), and the
        // native-dialog flow already surfaces genuine failures via checkForUpdates
        // rejecting. Forwarding it to the renderer produced a scary toast on
        // every background check, so we no longer notify renderers here.
        console.error("❌ Auto-updater error:", err);
        this.isDownloading = false;
      },
      "download-progress": (progressObj) => {
        console.log(
          `📥 Download progress: ${progressObj.percent.toFixed(2)}% (${(progressObj.transferred / 1024 / 1024).toFixed(2)}MB / ${(progressObj.total / 1024 / 1024).toFixed(2)}MB)`
        );
        this.notifyRenderers("update-download-progress", progressObj);
      },
      "update-downloaded": (info) => {
        console.log("✅ Update downloaded successfully:", info?.version);
        this.updateDownloaded = true;
        this.isDownloading = false;
        if (info) this.lastUpdateInfo = this._pickInfo(info);
        this.notifyRenderers("update-downloaded", info);
      },
    };

    Object.entries(handlers).forEach(([event, handler]) => {
      autoUpdater.on(event, handler);
      this._eventListeners.push({ event, handler });
    });
  }

  _pickInfo(info) {
    return {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
      files: info.files,
    };
  }

  notifyRenderers(channel, data) {
    for (const win of [this.mainWindow, this.controlPanelWindow]) {
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send(channel, data);
      }
    }
  }

  // ---- Localized native dialogs -------------------------------------------

  t(key, params) {
    return i18nMain.t(`updater.${key}`, params);
  }

  async _promptInstall(version) {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: this.t("readyTitle"),
      message: this.t("readyTitle"),
      detail: this.t("readyPrompt", { version }),
      buttons: [this.t("install"), this.t("later")],
      defaultId: 0,
      cancelId: 1,
    });
    return response === 0;
  }

  // ---- Skip / defer state (persisted to userData) --------------------------

  _skipStatePath() {
    return path.join(app.getPath("userData"), SKIP_STATE_FILE);
  }

  _loadSkipState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._skipStatePath(), "utf8"));
      if (raw && typeof raw.version === "string" && typeof raw.until === "number") {
        return raw;
      }
    } catch {
      // No skip state (or unreadable) — treat as "not deferred".
    }
    return null;
  }

  _isSkipActive(version) {
    const skip = this._loadSkipState();
    return Boolean(skip && skip.version === version && Date.now() < skip.until);
  }

  _deferVersion(version) {
    try {
      fs.writeFileSync(
        this._skipStatePath(),
        JSON.stringify({ version, until: Date.now() + SKIP_DURATION_MS })
      );
    } catch {
      // Defer is a UX nicety, not load-bearing.
    }
  }

  _clearSkipState() {
    try {
      fs.rmSync(this._skipStatePath(), { force: true });
    } catch {
      // ignore
    }
  }

  // ---- Core flow -----------------------------------------------------------

  _checkOnChannel(channel) {
    autoUpdater.channel = channel;
    return autoUpdater.checkForUpdates();
  }

  // Returns the check result when a strictly newer version is available, or
  // null when already up to date. THROWS when the feed can't be reached — so
  // callers can tell "no update" apart from "check failed" (a swallowed error
  // used to be reported to the user as "you're up to date").
  async _checkOnce() {
    let result;
    try {
      result = await this._checkOnChannel(this._primaryChannel);
    } catch (primaryErr) {
      if (!this._fallbackChannel || this._fallbackChannel === this._primaryChannel) {
        throw primaryErr;
      }
      console.warn(
        `update check on '${this._primaryChannel}' failed (${fmtErr(primaryErr)}); ` +
          `retrying on '${this._fallbackChannel}'`
      );
      result = await this._checkOnChannel(this._fallbackChannel);
    }
    const version = result?.updateInfo?.version;
    if (!version) return null;
    if (compareVersions(app.getVersion(), version) >= 0) return null;
    return result;
  }

  // Downloads once; concurrent callers await the same promise.
  async _ensureDownloaded() {
    if (this.updateDownloaded) return;
    if (!this._activeDownload) {
      this.isDownloading = true;
      this._activeDownload = autoUpdater
        .downloadUpdate()
        .then(() => {
          this.updateDownloaded = true;
        })
        .finally(() => {
          this.isDownloading = false;
          this._activeDownload = null;
        });
    }
    await this._activeDownload;
  }

  async _installDownloaded() {
    if (this.isInstalling) return;
    this.isInstalling = true;
    console.log("🔄 Installing update and restarting...");

    // Let close-to-tray handlers fall through to a real quit.
    if (this.windowManager) this.windowManager.isQuitting = true;

    try {
      if (this._prepareForInstall) await this._prepareForInstall();
    } catch (e) {
      console.error("prepare-for-install failed (continuing):", fmtErr(e));
    }

    // isSilent on Windows: run the NSIS installer without its wizard since the
    // user already consented via the dialog. isForceRunAfter: relaunch after.
    const isSilent = process.platform === "win32";
    autoUpdater.quitAndInstall(isSilent, true);
  }

  // Startup + periodic flow: check → background download → prompt (unless the
  // user deferred this version within the last 24h).
  async runStartupUpdateCheck() {
    if (!this.enabled) return;
    let result;
    try {
      result = await this._checkOnce();
    } catch (e) {
      // Background check: stay silent (offline, feed unreachable, etc.).
      console.error("startup update check failed:", fmtErr(e));
      return;
    }
    if (!result) return;
    const version = result.updateInfo.version;

    try {
      await this._ensureDownloaded();
    } catch (e) {
      console.error("background update download failed:", fmtErr(e));
      return;
    }

    if (this._isSkipActive(version)) return;

    const shouldInstall = await this._promptInstall(version);
    if (!shouldInstall) {
      this._deferVersion(version);
      return;
    }
    this._clearSkipState();
    await this._safeInstall();
  }

  // Manual flow (menu / settings button): same as startup but ignores the
  // 24h defer and surfaces failures to the user when alertOnFail is set.
  async runManualUpdateCheck(alertOnFail) {
    if (!this.enabled) {
      if (alertOnFail) {
        await dialog.showMessageBox({
          type: "info",
          title: this.t("upToDateTitle"),
          message: this.t("upToDateMessage"),
        });
      }
      return;
    }

    let result;
    try {
      result = await this._checkOnce();
    } catch (e) {
      console.error("manual update check failed:", fmtErr(e));
      if (alertOnFail) {
        await dialog.showMessageBox({
          type: "error",
          title: this.t("checkFailedTitle"),
          message: this.t("checkFailedMessage"),
          detail: fmtErr(e),
        });
      }
      return;
    }
    if (!result) {
      if (alertOnFail) {
        await dialog.showMessageBox({
          type: "info",
          title: this.t("upToDateTitle"),
          message: this.t("upToDateMessage"),
        });
      }
      return;
    }
    const version = result.updateInfo.version;

    try {
      await this._ensureDownloaded();
    } catch (e) {
      console.error("manual update download failed:", fmtErr(e));
      if (alertOnFail) {
        await dialog.showMessageBox({
          type: "error",
          title: this.t("downloadFailedTitle"),
          message: this.t("downloadFailedMessage"),
          detail: fmtErr(e),
        });
      }
      return;
    }

    const shouldInstall = await this._promptInstall(version);
    if (!shouldInstall) {
      this._deferVersion(version);
      return;
    }
    this._clearSkipState();
    await this._safeInstall(alertOnFail);
  }

  async _safeInstall(alertOnFail) {
    try {
      await this._installDownloaded();
    } catch (e) {
      this.isInstalling = false;
      console.error("update install failed:", fmtErr(e));
      if (alertOnFail) {
        await dialog.showMessageBox({
          type: "error",
          title: this.t("installFailedTitle"),
          message: this.t("installFailedMessage"),
          detail: fmtErr(e),
        });
      }
    }
  }

  // Called from main.js on startup. Runs the flow shortly after launch, then
  // re-checks every 4h. Each run respects the 24h defer.
  checkForUpdatesOnStartup() {
    if (!this.enabled) {
      console.log(
        "Automatic update checks are disabled (dev/unpackaged or GIGATYPE_DISABLE_AUTO_UPDATES)."
      );
      return;
    }

    this._startupTimer = setTimeout(() => {
      this._startupTimer = null;
      console.log("🔄 Checking for updates on startup...");
      this.runStartupUpdateCheck().catch((err) => {
        console.error("Startup update check failed:", fmtErr(err));
      });
    }, STARTUP_DELAY_MS);

    this._periodicTimer = setInterval(() => {
      console.log("🔄 Periodic update check...");
      this.runStartupUpdateCheck().catch((err) => {
        console.error("Periodic update check failed:", fmtErr(err));
      });
    }, PERIODIC_INTERVAL_MS);
  }

  // ---- Back-compat IPC surface (preload.js / ipcHandlers.js) ---------------

  async checkForUpdates() {
    if (!this.enabled) {
      return { updateAvailable: false, message: "Update checks are disabled" };
    }
    try {
      const result = await this._checkOnce();
      if (result?.updateInfo?.version) {
        const info = result.updateInfo;
        return {
          updateAvailable: true,
          version: info.version,
          releaseDate: info.releaseDate,
          files: info.files,
          releaseNotes: info.releaseNotes,
        };
      }
      return { updateAvailable: false, message: "You are running the latest version" };
    } catch (e) {
      return { updateAvailable: false, message: fmtErr(e) };
    }
  }

  async downloadUpdate() {
    if (!this.enabled) {
      return { success: false, message: "Update downloads are disabled" };
    }
    if (this.updateDownloaded) {
      return { success: true, message: "Update already downloaded. Ready to install." };
    }
    if (this.isDownloading) {
      return { success: true, message: "Download already in progress" };
    }
    try {
      await this._ensureDownloaded();
      return { success: true, message: "Update download started" };
    } catch (error) {
      console.error("❌ Update download error:", fmtErr(error));
      throw error;
    }
  }

  async installUpdate() {
    if (!this.updateDownloaded) {
      return { success: false, message: "No update available to install" };
    }
    if (this.isInstalling) {
      return { success: false, message: "Update installation already in progress" };
    }
    try {
      await this._installDownloaded();
      return { success: true, message: "Update installation started" };
    } catch (error) {
      this.isInstalling = false;
      console.error("❌ Update installation error:", fmtErr(error));
      throw error;
    }
  }

  async getAppVersion() {
    return { version: app.getVersion() };
  }

  async getUpdateStatus() {
    return {
      updateAvailable: this.updateAvailable,
      updateDownloaded: this.updateDownloaded,
      isDevelopment: process.env.NODE_ENV === "development",
      startupUpdateChecksEnabled: this.startupUpdateChecksEnabled,
    };
  }

  async getUpdateInfo() {
    return this.lastUpdateInfo;
  }

  cleanup() {
    if (this._startupTimer) {
      clearTimeout(this._startupTimer);
      this._startupTimer = null;
    }
    if (this._periodicTimer) {
      clearInterval(this._periodicTimer);
      this._periodicTimer = null;
    }
    this._eventListeners.forEach(({ event, handler }) => {
      autoUpdater.removeListener(event, handler);
    });
    this._eventListeners = [];
  }
}

module.exports = UpdateManager;
