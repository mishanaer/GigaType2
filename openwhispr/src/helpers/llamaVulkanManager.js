const fs = require("fs");
const { promises: fsPromises } = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const VULKAN_ASSETS = {
  "win32-x64": {
    assetPattern: /^llama-.*-bin-win-vulkan-x64\.zip$/,
    binaryName: "llama-server.exe",
    outputName: "llama-server-vulkan.exe",
    libPattern: /\.dll$/i,
  },
  "linux-x64": {
    assetPattern: /^llama-.*-bin-ubuntu-vulkan-x64\.tar\.gz$/,
    binaryName: "llama-server",
    outputName: "llama-server-vulkan",
    libPattern: /\.so(\.\d+)*$/,
  },
};

class LlamaVulkanManager {
  constructor() {
    this._binDir = null;
  }

  get binDir() {
    if (!this._binDir) {
      this._binDir = path.join(app.getPath("userData"), "bin");
    }
    return this._binDir;
  }

  _getConfig() {
    return VULKAN_ASSETS[`${process.platform}-${process.arch}`] || null;
  }

  isSupported() {
    return this._getConfig() !== null;
  }

  getBinaryPath() {
    const config = this._getConfig();
    if (!config) return null;
    const p = path.join(this.binDir, config.outputName);
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
    return null;
  }

  isDownloaded() {
    return this.getBinaryPath() !== null;
  }

  getStatus() {
    return {
      supported: this.isSupported(),
      downloaded: this.isDownloaded(),
    };
  }

  async deleteBinary() {
    const config = this._getConfig();
    if (!config) return { success: true };

    let deletedCount = 0;
    try {
      const entries = await fsPromises.readdir(this.binDir);
      for (const entry of entries) {
        if (entry === config.outputName || config.libPattern.test(entry)) {
          await fsPromises.unlink(path.join(this.binDir, entry)).catch(() => {});
          deletedCount++;
        }
      }
    } catch {}

    debugLogger.info("Vulkan llama-server deleted", { deletedCount });
    return { success: true, deletedCount };
  }
}

module.exports = LlamaVulkanManager;
