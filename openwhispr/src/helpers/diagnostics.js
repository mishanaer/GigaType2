const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");
const { app, shell } = require("electron");
const debugLogger = require("./debugLogger");

const SIDECAR_PORT_RANGE = { start: 8765, end: 8775 };
const PORT_PROBE_TIMEOUT_MS = 500;

function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/health", method: "GET", timeout: PORT_PROBE_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ port, listening: true, status: res.statusCode, body: body.slice(0, 300) }));
      }
    );
    req.on("error", () => resolve({ port, listening: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ port, listening: true, status: "timeout" });
    });
    req.end();
  });
}

function listSidecarProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      execFile("pgrep", ["-fl", "gigatype-sidecar"], (err, stdout) =>
        resolve(err ? [] : stdout.trim().split("\n").filter(Boolean))
      );
      return;
    }
    execFile(
      "tasklist",
      ["/FI", "IMAGENAME eq gigatype-sidecar-win-x64.exe", "/FO", "CSV", "/NH"],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        const rows = stdout
          .trim()
          .split("\n")
          .filter((line) => line.includes("gigatype-sidecar"));
        resolve(rows);
      }
    );
  });
}

/**
 * Collects a single self-contained diagnostic snapshot of the dictation
 * pipeline (hotkey state → key listener → recording state → sidecar → paste
 * tool) and writes it to the logs directory. Returns the report path.
 *
 * Every section is best-effort: a failure in one collector must not lose the
 * rest of the report.
 */
async function saveDiagnosticsReport({
  windowManager,
  windowsKeyManager,
  gigaamSidecarManager,
  clipboardManager,
} = {}) {
  const report = { generatedAt: new Date().toISOString() };

  const section = (name, fn) => {
    try {
      report[name] = fn();
    } catch (error) {
      report[name] = { error: error?.message };
    }
  };

  section("app", () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    userDataPath: app.getPath("userData"),
    resourcesPath: process.resourcesPath || null,
  }));

  section("hotkey", () => {
    const hotkeyManager = windowManager?.hotkeyManager;
    return {
      currentHotkey: hotkeyManager?.getCurrentHotkey?.() ?? null,
      envDictationKey: process.env.DICTATION_KEY || null,
      inListeningMode: hotkeyManager?.isInListeningMode?.() ?? null,
      slots: hotkeyManager?.slots ? Array.from(hotkeyManager.slots.entries()) : null,
    };
  });

  section("windowsKeyListener", () => windowsKeyManager?.getState?.() ?? null);

  section("recordingState", () => ({
    winPushState: windowManager?.winPushState ?? null,
    isDictatingToggle: windowManager?._isDictatingToggle ?? null,
    dictationPanelVisible: windowManager?.isDictationPanelVisible?.() ?? null,
  }));

  section("gigaamSidecar", () => gigaamSidecarManager?.getStatus?.() ?? null);

  section("pasteTool", () => clipboardManager?.getNircmdStatus?.() ?? null);

  try {
    report.sidecarPorts = [];
    for (let port = SIDECAR_PORT_RANGE.start; port <= SIDECAR_PORT_RANGE.end; port++) {
      report.sidecarPorts.push(await probeHealth(port));
    }
  } catch (error) {
    report.sidecarPorts = { error: error?.message };
  }

  try {
    report.sidecarProcesses = await listSidecarProcesses();
  } catch (error) {
    report.sidecarProcesses = { error: error?.message };
  }

  const logsDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const fileName = `diagnostics-${report.generatedAt.replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(logsDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), "utf8");

  debugLogger.info("Diagnostics report saved", { filePath });
  shell.showItemInFolder(filePath);
  return filePath;
}

module.exports = { saveDiagnosticsReport };
