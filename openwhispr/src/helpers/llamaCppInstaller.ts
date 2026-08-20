import { spawn } from "child_process";
import { app } from "electron";
import path from "path";
import fs from "fs";
import { promises as fsPromises } from "fs";

class LlamaCppInstaller {
  private installDir: string;
  private binPath: string | null = null;
  private platform: string;
  private arch: string;

  constructor() {
    this.installDir = path.join(app.getPath("userData"), "llama-cpp");
    this.platform = process.platform;
    this.arch = process.arch;
  }

  async ensureInstallDir(): Promise<void> {
    await fsPromises.mkdir(this.installDir, { recursive: true });
  }

  getBinaryName(): string {
    return this.platform === "win32" ? "llama-cli.exe" : "llama-cli";
  }

  getInstalledBinaryPath(): string {
    return path.join(this.installDir, this.getBinaryName());
  }

  async isInstalled(): Promise<boolean> {
    try {
      const binaryPath = this.getInstalledBinaryPath();
      await fsPromises.access(binaryPath, fs.constants.X_OK);
      this.binPath = binaryPath;
      return true;
    } catch {
      return false;
    }
  }

  async checkSystemInstallation(): Promise<boolean> {
    return new Promise((resolve) => {
      const checkCommand = this.platform === "win32" ? "where" : "which";
      spawn(checkCommand, ["llama-cli"])
        .on("close", (code) => {
          resolve(code === 0);
        })
        .on("error", () => {
          resolve(false);
        });
    });
  }

  async getVersion(): Promise<string | null> {
    if (!(await this.isInstalled())) {
      return null;
    }

    return new Promise((resolve) => {
      const proc = spawn(this.binPath!, ["--version"]);
      let output = "";

      proc.stdout.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", () => {
        const match = output.match(/version:\s*([^\s]+)/i);
        resolve(match ? match[1] : "unknown");
      });

      proc.on("error", () => {
        resolve(null);
      });
    });
  }

  async uninstall(): Promise<{ success: boolean; error?: string }> {
    try {
      await fsPromises.rm(this.installDir, { recursive: true, force: true });
      this.binPath = null;
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || "Uninstall failed",
      };
    }
  }
}

export default new LlamaCppInstaller();
