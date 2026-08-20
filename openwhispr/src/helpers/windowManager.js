const { app, screen, BrowserWindow, shell, dialog, nativeTheme } = require("electron");
const debugLogger = require("./debugLogger");
const HotkeyManager = require("./hotkeyManager");
const { isGlobeLikeHotkey, isModifierOnlyHotkey } = HotkeyManager;
const DragManager = require("./dragManager");
const MenuManager = require("./menuManager");
const DevServerManager = require("./devServerManager");
const { i18nMain } = require("./i18nMain");
const { DEV_SERVER_PORT } = DevServerManager;
const { isAllowedAppNavigation, isSafeExternalUrl } = require("./securityPolicy");
const { calculateControlPanelBounds } = require("./controlPanelBounds");
const {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  NOTIFICATION_WINDOW_CONFIG,
  TRANSCRIPTION_PREVIEW_CONFIG,
  TRANSCRIPTION_PREVIEW_SIZE_LIMITS,
  WINDOW_SIZES,
  WindowPositionUtil,
  getControlPanelBackgroundColor,
} = require("./windowConfig");

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.notificationWindow = null;
    this._notificationTimeout = null;
    this.transcriptionPreviewWindow = null;
    this.notificationPrefs = {
      notificationsEnabled: false,
      notifyMeetingDetection: false,
      notifyCalendarReminders: false,
      notifyUpdates: false,
    };
    this.tray = null;
    this.hotkeyManager = new HotkeyManager();
    this.dragManager = new DragManager();
    this.isQuitting = false;
    this.loadErrorShown = false;
    this.macCompoundPushState = null;
    this.winPushState = null;
    this._cachedActivationMode = "push";
    this._isDictatingToggle = false;
    this._pendingMeetingNoteNavigation = null;
    this.showDockIcon = true;
    this._dockVisibilityPromise = Promise.resolve();
    this._mainWindowRaiseTimers = new Set();
    this._controlPanelResizeTimers = new Set();
    this._desiredControlPanelContentSize = null;
    this._dictationPanelShowGeneration = 0;
    this.ensureTrayHandler = null;

    app.on("before-quit", () => {
      this.isQuitting = true;
      this._clearControlPanelResizeTimers();
      this.hotkeyManager.unregisterAll();
    });

    for (const eventName of ["display-metrics-changed", "display-added", "display-removed"]) {
      screen.on(eventName, () => this.recoverControlPanelLayout());
    }
  }

  setEnsureTrayHandler(fn) {
    this.ensureTrayHandler = typeof fn === "function" ? fn : null;
  }

  setShowDockIcon(enabled) {
    this.showDockIcon = process.platform === "darwin" ? Boolean(enabled) : true;
    if (process.platform !== "darwin" || !app.dock) {
      return Promise.resolve(this.showDockIcon);
    }

    this._dockVisibilityPromise = this._dockVisibilityPromise
      .catch(() => {})
      .then(async () => {
        if (this.showDockIcon) {
          app.setActivationPolicy("regular");
          await app.dock.show();
        } else {
          // app.dock.hide() alone is unreliable while the activation policy is
          // still "regular": macOS re-adds the Dock icon the moment a window is
          // shown or focused, so the user's "hide" setting appears to do nothing.
          // Switching to "accessory" (agent app) makes the app truly dock-less;
          // the control panel / overlay windows still open and take focus.
          app.setActivationPolicy("accessory");
          app.dock.hide();
        }
        debugLogger.info("macOS Dock visibility changed", { visible: this.showDockIcon }, "window");
        return this.showDockIcon;
      });
    return this._dockVisibilityPromise;
  }

  ensureDockVisibility() {
    return this.setShowDockIcon(this.showDockIcon);
  }

  _alwaysOnTopOptions() {
    // Keep the current app activation policy stable. The Dock icon is controlled
    // explicitly with app.dock, and hiding it must not deactivate open windows.
    // The required macOS process-type transition is performed separately while
    // the capsule is hidden, so repeated raises do not blink the Dock.
    return { skipTransformProcessType: true };
  }

  _prepareMainWindowForMacWorkspaces() {
    if (process.platform !== "darwin" || !this.mainWindow || this.mainWindow.isDestroyed()) {
      return false;
    }

    // Electron needs one process-type transition to make visibleOnFullScreen
    // effective for a regular macOS app. Do it only while the capsule is hidden:
    // subsequent always-on-top refreshes can safely skip the transition and keep
    // the Dock/control panel stable.
    if (this.mainWindow.isVisible()) {
      return false;
    }

    WindowPositionUtil.setupAlwaysOnTop(this.mainWindow, {
      skipTransformProcessType: false,
    });
    return true;
  }

  async createMainWindow() {
    const cursorPos = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPos);
    const position = WindowPositionUtil.getMainWindowPosition(display);

    this.mainWindow = new BrowserWindow({
      ...MAIN_WINDOW_CONFIG,
      ...position,
    });

    this._prepareMainWindowForMacWorkspaces();
    this.setMainWindowInteractivity(false);
    this.registerMainWindowEvents();

    // Register load event handlers BEFORE loading to catch all events
    this.mainWindow.webContents.on(
      "did-fail-load",
      async (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        if (
          process.env.NODE_ENV === "development" &&
          validatedURL &&
          validatedURL.includes(`localhost:${DEV_SERVER_PORT}`)
        ) {
          setTimeout(async () => {
            const isReady = await DevServerManager.waitForDevServer();
            if (isReady) {
              this.mainWindow.reload();
            }
          }, 2000);
        } else {
          this.showLoadFailureDialog("Dictation panel", errorCode, errorDescription, validatedURL);
        }
      }
    );

    this.mainWindow.webContents.on("did-finish-load", () => {
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
      this.enforceMainWindowOnTop();
    });

    await this.loadMainWindow();
    await this.initializeHotkey();
    this.dragManager.setTargetWindow(this.mainWindow);
    MenuManager.setupMainMenu(() => this.openSettings());
  }

  setMainWindowInteractivity(shouldCapture) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    if (shouldCapture) {
      this.mainWindow.setIgnoreMouseEvents(false);
    } else if (process.platform === "win32") {
      // The orb has no controls. Do not leave an invisible or visible overlay
      // intercepting clicks; Windows does not need mouse-move forwarding here.
      this.mainWindow.setIgnoreMouseEvents(true);
    } else {
      this.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  setNotificationInteractivity(interactive) {
    if (!this.notificationWindow || this.notificationWindow.isDestroyed()) {
      return;
    }
    if (interactive) {
      this.notificationWindow.setIgnoreMouseEvents(false);
    } else {
      this.notificationWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  resizeMainWindow(sizeKey) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    const newSize = WINDOW_SIZES[sizeKey] || WINDOW_SIZES.BASE;
    const currentBounds = this.mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height / 2,
    });

    const bounds = WindowPositionUtil.getMainWindowPosition(display, newSize);
    this.mainWindow.setBounds(bounds);

    return { success: true, bounds };
  }

  resizeControlPanelToContent(height, width) {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) {
      return { success: false, message: "Control panel window not available" };
    }

    if (win.isMaximized() || win.isFullScreen()) {
      return { success: true, bounds: win.getBounds() };
    }

    const requestedHeight = Math.ceil(Number(height));
    const requestedWidth = width === undefined ? undefined : Math.ceil(Number(width));
    if (
      !Number.isFinite(requestedHeight) ||
      requestedHeight <= 0 ||
      (requestedWidth !== undefined && (!Number.isFinite(requestedWidth) || requestedWidth <= 0))
    ) {
      return { success: false, message: "Invalid content height" };
    }

    this._desiredControlPanelContentSize = {
      height: requestedHeight,
      width: requestedWidth,
    };

    const result = this._applyDesiredControlPanelSize();
    if (result.deferred) {
      this._scheduleControlPanelResizeRecovery();
    }
    return result;
  }

  _applyDesiredControlPanelSize() {
    const win = this.controlPanelWindow;
    const desired = this._desiredControlPanelContentSize;
    if (!win || win.isDestroyed() || !desired) {
      return { success: false, message: "Control panel window not available" };
    }

    const currentBounds = win.getBounds();
    const display = screen.getDisplayNearestPoint({
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height / 2,
    });
    const layout = calculateControlPanelBounds({
      currentBounds,
      display,
      requestedHeight: desired.height,
      requestedWidth: desired.width,
    });

    if (!layout) {
      debugLogger.warn(
        "Deferring control panel resize until display metrics are ready",
        { displayBounds: display?.bounds, workArea: display?.workArea, desired },
        "window"
      );
      return { success: false, deferred: true, bounds: currentBounds };
    }

    const { bounds: nextBounds, minWidth, minHeight } = layout;
    win.setMinimumSize(minWidth, minHeight);

    if (
      Math.abs(currentBounds.x - nextBounds.x) <= 1 &&
      Math.abs(currentBounds.y - nextBounds.y) <= 1 &&
      Math.abs(currentBounds.height - nextBounds.height) <= 1 &&
      Math.abs(currentBounds.width - nextBounds.width) <= 1
    ) {
      this._clearControlPanelResizeTimers();
      return { success: true, bounds: currentBounds };
    }

    win.setBounds(nextBounds);
    this._clearControlPanelResizeTimers();
    return { success: true, bounds: nextBounds };
  }

  _clearControlPanelResizeTimers() {
    for (const timer of this._controlPanelResizeTimers) {
      clearTimeout(timer);
    }
    this._controlPanelResizeTimers.clear();
  }

  _scheduleControlPanelResizeRecovery() {
    if (this._controlPanelResizeTimers.size > 0) return;

    for (const delayMs of [250, 1000, 3000]) {
      const timer = setTimeout(() => {
        this._controlPanelResizeTimers.delete(timer);
        this._applyDesiredControlPanelSize();
      }, delayMs);
      this._controlPanelResizeTimers.add(timer);
    }
  }

  recoverControlPanelLayout() {
    if (!this._desiredControlPanelContentSize) return;
    const result = this._applyDesiredControlPanelSize();
    if (result.deferred) {
      this._scheduleControlPanelResizeRecovery();
    }
  }

  async loadWindowContent(window, isControlPanel = false) {
    if (process.env.NODE_ENV === "development") {
      const appUrl = DevServerManager.getAppUrl(isControlPanel);
      await DevServerManager.waitForDevServer();
      await window.loadURL(appUrl);
    } else {
      const fileInfo = DevServerManager.getAppFilePath(isControlPanel);
      if (!fileInfo) {
        throw new Error("Failed to get app file path");
      }

      const fs = require("fs");
      if (!fs.existsSync(fileInfo.path)) {
        throw new Error(`HTML file not found: ${fileInfo.path}`);
      }

      await window.loadFile(fileInfo.path, { query: fileInfo.query });
    }
  }

  async loadMainWindow() {
    await this.loadWindowContent(this.mainWindow, false);
  }

  createHotkeyCallback() {
    let lastToggleTime = 0;
    const DEBOUNCE_MS = 150;

    return async () => {
      if (this.hotkeyManager.isInListeningMode()) {
        return;
      }

      const activationMode = this.getActivationMode();
      const currentHotkey = this.hotkeyManager.getCurrentHotkey?.();

      if (
        process.platform === "darwin" &&
        activationMode === "push" &&
        currentHotkey &&
        !isGlobeLikeHotkey(currentHotkey) &&
        currentHotkey.includes("+")
      ) {
        this.startMacCompoundPushToTalk(currentHotkey);
        return;
      }

      // Push mode: defer to native listener (globalShortcut can't detect key-up)
      if (
        (process.platform === "win32" || process.platform === "linux") &&
        activationMode === "push"
      ) {
        return;
      }

      const now = Date.now();
      if (now - lastToggleTime < DEBOUNCE_MS) {
        return;
      }
      lastToggleTime = now;

      // Capture target app PID before the window might steal focus
      if (this.textEditMonitor) this.textEditMonitor.captureTargetPid();

      this.sendToggleDictation();
    };
  }

  startMacCompoundPushToTalk(hotkey) {
    if (this.macCompoundPushState?.active) {
      return;
    }

    const requiredModifiers = this.getMacRequiredModifiers(hotkey);
    if (requiredModifiers.size === 0) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const MAX_PUSH_DURATION_MS = 300000; // 5 minutes max recording
    const downTime = Date.now();

    if (this.textEditMonitor) this.textEditMonitor.captureTargetPid();

    const safetyTimeoutId = setTimeout(() => {
      if (this.macCompoundPushState?.active) {
        debugLogger.warn("Compound PTT safety timeout", undefined, "ptt");
        this.forceStopMacCompoundPush("timeout");
      }
    }, MAX_PUSH_DURATION_MS);

    this.macCompoundPushState = {
      active: true,
      downTime,
      isRecording: false,
      hotkey,
      requiredModifiers,
      safetyTimeoutId,
    };

    setTimeout(() => {
      if (!this.macCompoundPushState || this.macCompoundPushState.downTime !== downTime) {
        return;
      }

      if (!this.macCompoundPushState.isRecording) {
        this.macCompoundPushState.isRecording = true;
        this.sendStartDictation();
      }
    }, MIN_HOLD_DURATION_MS);
  }

  handleMacPushModifierUp(modifier) {
    if (!this.macCompoundPushState?.active) {
      return;
    }

    if (!this.macCompoundPushState.requiredModifiers.has(modifier)) {
      return;
    }

    if (this.macCompoundPushState.safetyTimeoutId) {
      clearTimeout(this.macCompoundPushState.safetyTimeoutId);
    }

    const wasRecording = this.macCompoundPushState.isRecording;
    this.macCompoundPushState = null;

    if (wasRecording) {
      this.sendStopDictation();
    } else {
      this.hideDictationPanel();
    }
  }

  forceStopMacCompoundPush(reason = "manual") {
    if (!this.macCompoundPushState) {
      return;
    }

    if (this.macCompoundPushState.safetyTimeoutId) {
      clearTimeout(this.macCompoundPushState.safetyTimeoutId);
    }

    const wasRecording = this.macCompoundPushState.isRecording;
    this.macCompoundPushState = null;

    if (wasRecording) {
      this.sendStopDictation();
    }
    this.hideDictationPanel();

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("compound-ptt-force-stopped", { reason });
    }
  }

  getMacRequiredModifiers(hotkey) {
    const required = new Set();
    const parts = hotkey.split("+").map((part) => part.trim());

    for (const part of parts) {
      switch (part) {
        case "Command":
        case "Cmd":
        case "RightCommand":
        case "RightCmd":
        case "CommandOrControl":
        case "Super":
        case "Meta":
          required.add("command");
          break;
        case "Control":
        case "Ctrl":
        case "RightControl":
        case "RightCtrl":
          required.add("control");
          break;
        case "Alt":
        case "Option":
        case "RightAlt":
        case "RightOption":
          required.add("option");
          break;
        case "Shift":
        case "RightShift":
          required.add("shift");
          break;
        case "Fn":
          required.add("fn");
          break;
        default:
          break;
      }
    }

    return required;
  }

  handleMacModifierStateChanged(activeModifiers, hotkey) {
    if (!hotkey || !isModifierOnlyHotkey(hotkey)) {
      return;
    }

    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }

    const requiredModifiers = this.getMacRequiredModifiers(hotkey);
    if (requiredModifiers.size < 2) {
      return;
    }

    const active = new Set(activeModifiers);
    const isExactMatch =
      active.size === requiredModifiers.size &&
      [...requiredModifiers].every((modifier) => active.has(modifier));

    if (isExactMatch) {
      if (this.textEditMonitor) this.textEditMonitor.captureTargetPid();
      this.startMacCompoundPushToTalk(hotkey);
      return;
    }

    if (this.macCompoundPushState?.active && this.macCompoundPushState.hotkey === hotkey) {
      const wasRecording = this.macCompoundPushState.isRecording;
      if (this.macCompoundPushState.safetyTimeoutId) {
        clearTimeout(this.macCompoundPushState.safetyTimeoutId);
      }
      this.macCompoundPushState = null;

      if (wasRecording) {
        this.sendStopDictation();
      } else {
        this.hideDictationPanel();
      }
    }
  }

  startWindowsPushToTalk() {
    if (this.winPushState?.active) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const downTime = Date.now();

    this.winPushState = {
      active: true,
      downTime,
      isRecording: false,
    };

    setTimeout(() => {
      if (!this.winPushState || this.winPushState.downTime !== downTime) {
        return;
      }

      if (!this.winPushState.isRecording) {
        this.winPushState.isRecording = true;
        this.sendStartDictation();
      }
    }, MIN_HOLD_DURATION_MS);
  }

  handleWindowsPushKeyUp() {
    if (!this.winPushState?.active) {
      return;
    }

    const wasRecording = this.winPushState.isRecording;
    this.winPushState = null;

    if (wasRecording) {
      this.sendStopDictation();
    } else {
      this.hideDictationPanel();
    }
  }

  resetWindowsPushState() {
    if (!this.winPushState?.active) {
      return;
    }

    this.handleWindowsPushKeyUp();
  }

  sendToggleDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("toggle-dictation");
      this._isDictatingToggle = !this._isDictatingToggle;
      this.meetingDetectionEngine?.setUserRecording(this._isDictatingToggle);
    }
  }

  sendStartDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("start-dictation");
      this.meetingDetectionEngine?.setUserRecording(true);
    }
  }

  sendStopDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("stop-dictation");
      this._isDictatingToggle = false;
      this.meetingDetectionEngine?.setUserRecording(false);
    }
  }

  getActivationMode() {
    return this._cachedActivationMode;
  }

  setActivationModeCache(mode) {
    this._cachedActivationMode = mode === "tap" ? "tap" : "push";
  }

  setHotkeyListeningMode(enabled) {
    this.hotkeyManager.setListeningMode(enabled);
  }

  async initializeHotkey() {
    await this.hotkeyManager.initializeHotkey(this.mainWindow, this.createHotkeyCallback());
  }

  async updateHotkey(hotkey) {
    return await this.hotkeyManager.updateHotkey(hotkey, this.createHotkeyCallback());
  }

  isUsingGnomeHotkeys() {
    return this.hotkeyManager.isUsingGnome();
  }

  isUsingHyprlandHotkeys() {
    return this.hotkeyManager.isUsingHyprland();
  }

  isUsingKDEHotkeys() {
    return this.hotkeyManager.isUsingKDE();
  }

  isUsingNativeShortcutHotkeys() {
    return this.hotkeyManager.isUsingNativeShortcut();
  }

  async startWindowDrag() {
    return await this.dragManager.startWindowDrag();
  }

  async stopWindowDrag() {
    return await this.dragManager.stopWindowDrag();
  }

  openExternalUrl(url, showError = true) {
    if (!isSafeExternalUrl(url, { allowLocalHttp: process.env.NODE_ENV === "development" })) {
      debugLogger.warn("Blocked unsafe external URL", { url }, "security");
      return;
    }

    shell.openExternal(url).catch((error) => {
      if (showError) {
        dialog.showErrorBox(
          i18nMain.t("dialog.openLink.title"),
          i18nMain.t("dialog.openLink.message", { url, error: error.message })
        );
      }
    });
  }

  async createControlPanelWindow() {
    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      this.recoverControlPanelLayout();
      if (this.controlPanelWindow.isMinimized()) {
        this.controlPanelWindow.restore();
      }
      if (!this.controlPanelWindow.isVisible()) {
        this.controlPanelWindow.show();
      }
      this.controlPanelWindow.focus();
      return;
    }

    this.controlPanelWindow = new BrowserWindow({
      ...CONTROL_PANEL_CONFIG,
      backgroundColor: getControlPanelBackgroundColor(
        process.platform,
        nativeTheme.shouldUseDarkColors
      ),
    });

    this.controlPanelWindow.webContents.on("will-navigate", (event, url) => {
      const appUrl = DevServerManager.getAppUrl(true);
      const appFileInfo = DevServerManager.getAppFilePath(true);

      if (
        isAllowedAppNavigation(url, {
          appUrl,
          appFilePath: appFileInfo?.path,
          devServerPort: DEV_SERVER_PORT,
        })
      ) {
        return;
      }

      event.preventDefault();
      this.openExternalUrl(url);
    });

    this.controlPanelWindow.webContents.setWindowOpenHandler(({ url }) => {
      this.openExternalUrl(url);
      return { action: "deny" };
    });

    this.controlPanelWindow.webContents.on("did-create-window", (childWindow, details) => {
      childWindow.close();
      if (details.url && !details.url.startsWith("devtools://")) {
        this.openExternalUrl(details.url, false);
      }
    });

    const visibilityTimer = setTimeout(() => {
      if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
        return;
      }
      if (!this.controlPanelWindow.isVisible()) {
        this.controlPanelWindow.show();
        this.controlPanelWindow.focus();
      }
    }, 10000);

    const clearVisibilityTimer = () => {
      clearTimeout(visibilityTimer);
    };

    this.controlPanelWindow.once("ready-to-show", () => {
      clearVisibilityTimer();
      this.recoverControlPanelLayout();
      void this.ensureDockVisibility();
      this.controlPanelWindow.show();
      this.controlPanelWindow.focus();
    });

    this.controlPanelWindow.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        void this.hideControlPanelToTray();
      }
    });

    this.controlPanelWindow.on("closed", () => {
      clearVisibilityTimer();
      this._clearControlPanelResizeTimers();
      this.controlPanelWindow = null;
    });

    MenuManager.setupControlPanelMenu(this.controlPanelWindow, () => this.openSettings());

    this.controlPanelWindow.webContents.on("did-finish-load", () => {
      clearVisibilityTimer();
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    });

    this.controlPanelWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        clearVisibilityTimer();
        if (process.env.NODE_ENV !== "development") {
          this.showLoadFailureDialog("Control panel", errorCode, errorDescription, validatedURL);
        }
        if (!this.controlPanelWindow.isVisible()) {
          this.controlPanelWindow.show();
          this.controlPanelWindow.focus();
        }
      }
    );

    this.controlPanelWindow.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "crashed" || details.reason === "killed" || details.reason === "oom") {
        debugLogger.error(
          "Control panel renderer process gone",
          { reason: details.reason, exitCode: details.exitCode },
          "window"
        );
        setTimeout(() => this.loadControlPanel(), 1000);
      }
    });

    this.controlPanelWindow.on("show", () => {
      if (this.controlPanelWindow.webContents.isCrashed()) {
        debugLogger.error("Control panel crashed, reloading on show", undefined, "window");
        this.loadControlPanel();
      }
    });

    await this.loadControlPanel();
  }

  async loadControlPanel() {
    await this.loadWindowContent(this.controlPanelWindow, true);
  }

  async ensureTranscriptionPreviewWindow() {
    if (this.transcriptionPreviewWindow && !this.transcriptionPreviewWindow.isDestroyed()) {
      return;
    }

    this.transcriptionPreviewWindow = new BrowserWindow(TRANSCRIPTION_PREVIEW_CONFIG);

    this.transcriptionPreviewWindow.on("closed", () => {
      this.transcriptionPreviewWindow = null;
    });

    if (process.env.NODE_ENV === "development") {
      await DevServerManager.waitForDevServer();
      await this.transcriptionPreviewWindow.loadURL(
        `${DevServerManager.DEV_SERVER_URL}?transcription-preview=true`
      );
    } else {
      const fileInfo = DevServerManager.getAppFilePath(false);
      await this.transcriptionPreviewWindow.loadFile(fileInfo.path, {
        query: { ...fileInfo.query, "transcription-preview": "true" },
      });
    }
  }

  async showTranscriptionPreview(text) {
    await this.ensureTranscriptionPreviewWindow();

    if (!this.transcriptionPreviewWindow || this.transcriptionPreviewWindow.isDestroyed()) return;

    const mainBounds =
      this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow.getBounds() : null;

    if (mainBounds) {
      const display = screen.getDisplayNearestPoint({ x: mainBounds.x, y: mainBounds.y });
      const position = WindowPositionUtil.getTranscriptionPreviewPosition(display, mainBounds, {
        width: TRANSCRIPTION_PREVIEW_CONFIG.width,
        height: TRANSCRIPTION_PREVIEW_CONFIG.height,
      });
      this.transcriptionPreviewWindow.setBounds(position);
    }

    this.transcriptionPreviewWindow.webContents.send("preview-text", text);
    this.transcriptionPreviewWindow.showInactive();
    WindowPositionUtil.setupAlwaysOnTop(
      this.transcriptionPreviewWindow,
      this._alwaysOnTopOptions()
    );
  }

  appendTranscriptionPreview(text) {
    if (!this.transcriptionPreviewWindow || this.transcriptionPreviewWindow.isDestroyed()) return;
    this.transcriptionPreviewWindow.webContents.send("preview-append", text);
  }

  holdTranscriptionPreview(options = {}) {
    if (!this.transcriptionPreviewWindow || this.transcriptionPreviewWindow.isDestroyed()) return;
    this.transcriptionPreviewWindow.webContents.send("preview-hold", {
      showCleanup: !!options.showCleanup,
    });
  }

  completeTranscriptionPreview(text) {
    if (!this.transcriptionPreviewWindow || this.transcriptionPreviewWindow.isDestroyed()) return;
    this.transcriptionPreviewWindow.webContents.send("preview-result", { text });
    this.transcriptionPreviewWindow.showInactive();
    WindowPositionUtil.setupAlwaysOnTop(
      this.transcriptionPreviewWindow,
      this._alwaysOnTopOptions()
    );
  }

  hideTranscriptionPreview() {
    if (!this.transcriptionPreviewWindow || this.transcriptionPreviewWindow.isDestroyed()) return;

    this.transcriptionPreviewWindow.webContents.send("preview-hide");
    setTimeout(() => {
      if (this.transcriptionPreviewWindow && !this.transcriptionPreviewWindow.isDestroyed()) {
        this.transcriptionPreviewWindow.hide();
      }
    }, 200);
  }

  resizeTranscriptionPreview(width, height) {
    if (!this.transcriptionPreviewWindow || this.transcriptionPreviewWindow.isDestroyed()) {
      return { success: false, error: "Preview window not available" };
    }

    const targetWidth = Math.max(
      TRANSCRIPTION_PREVIEW_SIZE_LIMITS.minWidth,
      Math.min(Math.round(width), TRANSCRIPTION_PREVIEW_SIZE_LIMITS.maxWidth)
    );
    const targetHeight = Math.max(
      TRANSCRIPTION_PREVIEW_SIZE_LIMITS.minHeight,
      Math.min(Math.round(height), TRANSCRIPTION_PREVIEW_SIZE_LIMITS.maxHeight)
    );

    const anchorBounds =
      this.mainWindow && !this.mainWindow.isDestroyed()
        ? this.mainWindow.getBounds()
        : this.transcriptionPreviewWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: anchorBounds.x, y: anchorBounds.y });
    const bounds = WindowPositionUtil.getTranscriptionPreviewPosition(display, anchorBounds, {
      width: targetWidth,
      height: targetHeight,
    });

    const currentBounds = this.transcriptionPreviewWindow.getBounds();
    if (
      currentBounds.x === bounds.x &&
      currentBounds.y === bounds.y &&
      currentBounds.width === bounds.width &&
      currentBounds.height === bounds.height
    ) {
      return { success: true, bounds };
    }

    this.transcriptionPreviewWindow.setBounds(bounds);
    return { success: true, bounds };
  }

  _repositionToCursorDisplay(force = false, placement = "bottom") {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const cursorPos = screen.getCursorScreenPoint();
    const cursorDisplay = screen.getDisplayNearestPoint(cursorPos);

    const currentBounds = this.mainWindow.getBounds();
    const currentDisplay = screen.getDisplayNearestPoint({
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height / 2,
    });

    if (!force && currentDisplay.id === cursorDisplay.id) return;

    const newPos = WindowPositionUtil.getMainWindowPosition(
      cursorDisplay,
      {
        width: currentBounds.width,
        height: currentBounds.height,
      },
      { placement }
    );
    this.mainWindow.setBounds(newPos);
  }

  _repositionForWindowsStartSurface(showGeneration) {
    if (
      process.platform !== "win32" ||
      typeof this.textEditMonitor?.isWindowsStartSurfaceForeground !== "function"
    ) {
      return;
    }

    this.textEditMonitor
      .isWindowsStartSurfaceForeground()
      .then((isStartSurface) => {
        if (
          !isStartSurface ||
          showGeneration !== this._dictationPanelShowGeneration ||
          !this.mainWindow ||
          this.mainWindow.isDestroyed() ||
          !this.mainWindow.isVisible()
        ) {
          return;
        }

        // Start/Search owns the lower center of the display and remains above
        // ordinary topmost windows. Move the non-focusable capsule to the top
        // edge instead of competing with the shell's protected z-order.
        this._repositionToCursorDisplay(true, "top");
        this.raiseMainWindowWithoutFocus();
      })
      .catch((error) => {
        debugLogger.debug(
          "Unable to inspect Windows foreground surface",
          { error: error.message },
          "window"
        );
      });
  }

  showDictationPanel(options = {}) {
    const { focus = false } = options;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const showGeneration = ++this._dictationPanelShowGeneration;
      this._clearMainWindowRaiseTimers();
      const wasHidden = !this.mainWindow.isVisible() || this.mainWindow.isMinimized();

      if (wasHidden) {
        // Recompute even when Electron reports the same nearest display:
        // disconnects/scaling changes can leave the old bounds off-screen.
        this._repositionToCursorDisplay(true);
      }

      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      this.enforceMainWindowOnTop();
      if (!this.mainWindow.isVisible()) {
        if (typeof this.mainWindow.showInactive === "function") {
          this.mainWindow.showInactive();
        } else {
          this.mainWindow.show();
        }
      }
      if (focus) {
        this.mainWindow.focus();
      }
      this.raiseMainWindowWithoutFocus();
      this._repositionForWindowsStartSurface(showGeneration);

      // Explorer can reassert the Start menu's z-order just after the capsule
      // is shown. Re-raise during that short shell transition, without
      // activating the capsule or taking keyboard focus from the input.
      for (const delayMs of [0, 75, 250]) {
        const timer = setTimeout(() => {
          this._mainWindowRaiseTimers.delete(timer);
          this.raiseMainWindowWithoutFocus();
        }, delayMs);
        this._mainWindowRaiseTimers.add(timer);
      }
    }
  }

  async hideControlPanelToTray() {
    const controlPanelWindow = this.controlPanelWindow;
    if (!controlPanelWindow || controlPanelWindow.isDestroyed()) {
      return false;
    }

    // On Windows/Linux the tray is the only recovery path after the taskbar
    // window is hidden. Never leave a live background process unreachable if
    // the packaged icon is missing or Explorer discarded the tray object.
    if (process.platform !== "darwin") {
      let trayReady = false;
      try {
        trayReady = Boolean(await this.ensureTrayHandler?.());
      } catch (error) {
        debugLogger.error(
          "Failed to ensure tray before hiding control panel",
          { error: error?.message },
          "tray"
        );
      }

      if (!trayReady) {
        debugLogger.error(
          "Keeping control panel visible because tray is unavailable",
          undefined,
          "tray"
        );
        if (!controlPanelWindow.isDestroyed()) {
          controlPanelWindow.setSkipTaskbar(false);
          if (!controlPanelWindow.isVisible()) {
            controlPanelWindow.show();
          }
          controlPanelWindow.focus();
        }
        return false;
      }
    }

    if (!controlPanelWindow.isDestroyed()) {
      controlPanelWindow.hide();
      return true;
    }
    return false;
  }

  hideDictationPanel() {
    this._dictationPanelShowGeneration += 1;
    this._clearMainWindowRaiseTimers();
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.hide();
    }
  }

  recoverAfterSystemResume() {
    this.resetWindowsPushState();
    this.recoverControlPanelLayout();

    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    // A transparent always-on-top window can retain stale DWM/z-order state
    // across Windows sleep. Reset it while hidden; the renderer remains the
    // single owner of visibility and will show it only after recording starts.
    this.mainWindow.hide();
    this._prepareMainWindowForMacWorkspaces();
    this.mainWindow.setFocusable(false);
    this.setMainWindowInteractivity(false);
    this.enforceMainWindowOnTop();
    this._repositionToCursorDisplay(true);

    if (!this.mainWindow.webContents.isDestroyed()) {
      this.mainWindow.webContents.send("system-resumed");
    }
  }

  isDictationPanelVisible() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false;
    }

    if (this.mainWindow.isMinimized && this.mainWindow.isMinimized()) {
      return false;
    }

    return this.mainWindow.isVisible();
  }

  registerMainWindowEvents() {
    if (!this.mainWindow) {
      return;
    }

    this.mainWindow.once("ready-to-show", () => {
      this.enforceMainWindowOnTop();
    });

    this.mainWindow.on("show", () => {
      this.raiseMainWindowWithoutFocus();
    });

    this.mainWindow.on("focus", () => {
      this.enforceMainWindowOnTop();
    });

    this.mainWindow.on("closed", () => {
      this._clearMainWindowRaiseTimers();
      this.dragManager.cleanup();
      this.mainWindow = null;
    });

    this.mainWindow.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "crashed" || details.reason === "killed" || details.reason === "oom") {
        debugLogger.error(
          "Dictation overlay renderer process gone",
          { reason: details.reason, exitCode: details.exitCode },
          "window"
        );
        setTimeout(() => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.reload();
          }
        }, 500);
      }
    });
  }

  enforceMainWindowOnTop() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      WindowPositionUtil.setupAlwaysOnTop(this.mainWindow, this._alwaysOnTopOptions());
    }
  }

  raiseMainWindowWithoutFocus() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    this.enforceMainWindowOnTop();
    if (
      process.platform === "win32" &&
      this.mainWindow.isVisible() &&
      typeof this.mainWindow.moveTop === "function"
    ) {
      try {
        this.mainWindow.moveTop();
      } catch (error) {
        debugLogger.debug("Unable to raise dictation capsule", { error: error.message }, "window");
      }
    }
  }

  _clearMainWindowRaiseTimers() {
    for (const timer of this._mainWindowRaiseTimers) {
      clearTimeout(timer);
    }
    this._mainWindowRaiseTimers.clear();
  }

  async showMeetingNotification(promptData) {
    if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
      this.notificationWindow.close();
      this.notificationWindow = null;
    }
    if (this._notificationTimeout) {
      clearTimeout(this._notificationTimeout);
      this._notificationTimeout = null;
    }

    const display = screen.getPrimaryDisplay();
    const position = WindowPositionUtil.getNotificationPosition(display);

    this.notificationWindow = new BrowserWindow({
      ...NOTIFICATION_WINDOW_CONFIG,
      ...position,
    });

    if (process.platform === "darwin") {
      this.notificationWindow.setIgnoreMouseEvents(true, { forward: true });
    }

    WindowPositionUtil.setupAlwaysOnTop(this.notificationWindow, this._alwaysOnTopOptions());

    this._pendingNotificationData = promptData;

    if (process.env.NODE_ENV === "development") {
      await DevServerManager.waitForDevServer();
      await this.notificationWindow.loadURL(
        `${DevServerManager.DEV_SERVER_URL}?meeting-notification=true`
      );
    } else {
      const fileInfo = DevServerManager.getAppFilePath(false);
      await this.notificationWindow.loadFile(fileInfo.path, {
        query: { ...fileInfo.query, "meeting-notification": "true" },
      });
    }

    this._notificationReadyFallback = setTimeout(() => {
      this._notificationReadyFallback = null;
      if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
        debugLogger.warn(
          "Notification renderer did not signal ready, force-showing",
          {},
          "meeting"
        );
        this.notificationWindow.webContents.send("meeting-notification-data", promptData);
        this.notificationWindow.showInactive();
      }
    }, 3000);

    this._notificationTimeout = setTimeout(() => {
      if (this.meetingDetectionEngine) {
        this.meetingDetectionEngine.handleNotificationTimeout();
      }
      this.dismissMeetingNotification();
    }, 30000);

    this.notificationWindow.on("closed", () => {
      this.notificationWindow = null;
      if (this._notificationTimeout) {
        clearTimeout(this._notificationTimeout);
        this._notificationTimeout = null;
      }
    });
  }

  showNotificationWindow() {
    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }
    if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
      this.notificationWindow.showInactive();
    }
  }

  dismissMeetingNotification() {
    this._pendingNotificationData = null;
    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }
    if (this._notificationTimeout) {
      clearTimeout(this._notificationTimeout);
      this._notificationTimeout = null;
    }
    if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
      this.notificationWindow.close();
    }
    this.notificationWindow = null;
  }

  sendToControlPanel(channel, data) {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", () => {
        if (!win.isDestroyed()) win.webContents.send(channel, data);
      });
    } else {
      win.webContents.send(channel, data);
    }
  }

  async queueMeetingNoteNavigation(payload) {
    this._pendingMeetingNoteNavigation = payload;
    await this.createControlPanelWindow();
    this.sendToControlPanel("meeting-note-navigation-pending");
  }

  consumePendingMeetingNoteNavigation() {
    const payload = this._pendingMeetingNoteNavigation;
    this._pendingMeetingNoteNavigation = null;
    return payload;
  }

  snapControlPanelToMeetingMode() {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    this._preMeetingBounds = win.getBounds();
    const display = screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const width = Math.round(workArea.width / 3);
    win.setBounds({
      x: workArea.x + workArea.width - width,
      y: workArea.y,
      width,
      height: workArea.height,
    });
    win.focus();
  }

  restoreControlPanelFromMeetingMode() {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    if (this._preMeetingBounds) {
      win.setBounds(this._preMeetingBounds);
      this._preMeetingBounds = null;
    } else {
      const { width, height } = CONTROL_PANEL_CONFIG;
      win.setSize(width, height);
      win.center();
    }
  }

  refreshLocalizedUi() {
    MenuManager.setupMainMenu(() => this.openSettings());

    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      MenuManager.setupControlPanelMenu(this.controlPanelWindow, () => this.openSettings());
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
    }
  }

  async openSettings() {
    await this.createControlPanelWindow();
    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      this.controlPanelWindow.webContents.send("show-settings");
    }
  }

  showLoadFailureDialog(windowName, errorCode, errorDescription, validatedURL) {
    if (this.loadErrorShown) {
      return;
    }
    this.loadErrorShown = true;
    const detailLines = [
      i18nMain.t("dialog.loadFailure.detail.window", { windowName }),
      i18nMain.t("dialog.loadFailure.detail.error", { errorCode, errorDescription }),
      validatedURL ? i18nMain.t("dialog.loadFailure.detail.url", { url: validatedURL }) : null,
      i18nMain.t("dialog.loadFailure.detail.hint"),
    ].filter(Boolean);
    dialog.showMessageBox({
      type: "error",
      title: i18nMain.t("dialog.loadFailure.title"),
      message: i18nMain.t("dialog.loadFailure.message"),
      detail: detailLines.join("\n"),
    });
  }
}

module.exports = WindowManager;
