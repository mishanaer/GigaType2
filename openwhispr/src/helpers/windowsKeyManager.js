/**
 * WindowsKeyManager - Handles key up/down detection for Push-to-Talk on Windows
 *
 * Uses a native Windows keyboard hook to detect when specific keys are
 * pressed and released, enabling Push-to-Talk functionality.
 */

const { spawn } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");
const debugLogger = require("./debugLogger");

class WindowsKeyManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.isSupported = process.platform === "win32";
    this.hasReportedError = false;
    this.currentKey = null;
    this.isReady = false;
  }

  handleOutputLine(line, key) {
    if (line === "READY") {
      debugLogger.debug("[WindowsKeyManager] Listener ready", { key });
      this.isReady = true;
      this.emit("ready");
      return;
    }

    if (line === "KEY_DOWN") {
      debugLogger.debug("[WindowsKeyManager] KEY_DOWN detected", { key });
      this.emit("key-down", key);
      return;
    }

    if (line === "KEY_UP") {
      debugLogger.debug("[WindowsKeyManager] KEY_UP detected", { key });
      this.emit("key-up", key);
      return;
    }

    if (line === "CAPTURE_CANCEL") {
      debugLogger.debug("[WindowsKeyManager] Native hotkey capture cancelled");
      this.emit("capture-cancel");
      return;
    }

    if (line.startsWith("CAPTURE ")) {
      const hotkey = line.slice("CAPTURE ".length).trim();
      if (hotkey) {
        debugLogger.debug("[WindowsKeyManager] Native hotkey captured", { hotkey });
        this.emit("capture", hotkey);
      }
      return;
    }

    debugLogger.debug("[WindowsKeyManager] Unknown output", { line });
  }

  /**
   * Start listening for the specified key
   * @param {string} key - The key to listen for (e.g., "`", "F8", "F11", "CommandOrControl+F11")
   */
  start(key = "`") {
    this.startProcess([key], key);
  }

  /**
   * Capture one Windows shortcut through the low-level hook. The native
   * process suppresses the captured keystrokes so Win+letter shortcuts do not
   * escape to the shell while the settings field is armed.
   */
  startCapture() {
    this.startProcess(["--capture"], "__capture__");
  }

  restart(key = this.currentKey) {
    if (!key || key === "__capture__") {
      return;
    }
    this.stop();
    this.start(key);
  }

  startProcess(args, identity) {
    if (!this.isSupported) {
      return;
    }

    // If already running with the same key, do nothing
    if (this.process && this.currentKey === identity) {
      return;
    }

    // Stop any existing listener
    this.stop();

    const listenerPath = this.resolveListenerBinary();
    if (!listenerPath) {
      // Binary not found - this is OK, Push-to-Talk will use fallback mode
      this.emit("unavailable", new Error("Windows key listener binary not found"));
      return;
    }

    this.hasReportedError = false;
    this.isReady = false;
    this.currentKey = identity;

    debugLogger.debug("[WindowsKeyManager] Starting key listener", {
      key: identity,
      args,
      binaryPath: listenerPath,
    });

    try {
      this.process = spawn(listenerPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      debugLogger.error("[WindowsKeyManager] Failed to spawn process", { error: error.message });
      this.reportError(error);
      return;
    }

    let lineBuffer = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        this.handleOutputLine(line, identity);
      }
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (data) => {
      const message = data.toString().trim();
      if (message.length > 0) {
        // Native binary logs to stderr for info messages, don't treat as error
        debugLogger.debug("[WindowsKeyManager] Native stderr", { message });
      }
    });

    const proc = this.process;

    proc.on("error", (error) => {
      if (this.process === proc) this.process = null;
      this.reportError(error, proc);
    });

    proc.on("exit", (code, signal) => {
      const trailingLine = lineBuffer.trim();
      if (trailingLine) {
        this.handleOutputLine(trailingLine, identity);
        lineBuffer = "";
      }

      if (this.process === proc) {
        this.process = null;
        this.isReady = false;
      }
      // stop() kills the child asynchronously; its exit event (code null,
      // SIGTERM) arrives later and must not be treated as a failure —
      // reportError would kill this.process, which by then can already be a
      // freshly started listener for the NEW hotkey (the exact race that made
      // hotkeys dead after changing them until an app restart).
      if (proc.__intentionallyStopped) {
        return;
      }
      if (code !== 0) {
        this.reportError(
          new Error(
            `Windows key listener exited with code ${code ?? "null"} signal ${signal ?? "null"}`
          ),
          proc
        );
      }
    });
  }

  /**
   * Stop the key listener
   */
  stop() {
    if (this.process) {
      debugLogger.debug("[WindowsKeyManager] Stopping key listener");
      try {
        // Flag checked in the exit handler so this deliberate kill is not
        // reported as an error (see the race note there).
        this.process.__intentionallyStopped = true;
        this.process.kill();
      } catch {
        // Ignore kill errors
      }
      this.process = null;
    }
    this.isReady = false;
    this.currentKey = null;
  }

  /**
   * Check if the listener is available and ready
   */
  isAvailable() {
    return this.resolveListenerBinary() !== null;
  }

  /**
   * Report an error (only once per session to avoid log spam)
   */
  reportError(error, failedProc = null) {
    if (this.hasReportedError) {
      return;
    }
    this.hasReportedError = true;

    // Only tear down the live listener if IT is the process that failed. A
    // stale error from an already-replaced process must never kill the
    // current listener.
    if (this.process && (failedProc === null || this.process === failedProc)) {
      try {
        this.process.kill();
      } catch {
        // Ignore
      } finally {
        this.process = null;
      }
    }

    debugLogger.warn("[WindowsKeyManager] Error occurred", { error: error.message });
    this.emit("error", error);
  }

  /**
   * Find the listener binary in various possible locations
   */
  resolveListenerBinary() {
    const binaryName = "windows-key-listener.exe";
    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", binaryName),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryName),
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "resources", binaryName),
        path.join(process.resourcesPath, "resources", "bin", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName),
      ].forEach((candidate) => candidates.add(candidate));
    }

    const candidatePaths = [...candidates];

    for (const candidate of candidatePaths) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}

module.exports = WindowsKeyManager;
