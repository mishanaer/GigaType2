// electron-builder afterAllArtifactBuild hook
//
// Recompress the macOS DMG with ULMO (LZMA). electron-builder's dmg.format
// only accepts up to UDBZ/ULFO, but hdiutil's LZMA format is ~10% smaller on
// this app's payload. ULMO images require macOS 10.15+ to mount, which is
// below the app's minimum supported macOS.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

exports.default = async function (buildResult) {
  if (process.platform !== "darwin") return buildResult.artifactPaths;

  const artifacts = [];
  for (const artifact of buildResult.artifactPaths) {
    if (!artifact.endsWith(".dmg")) {
      artifacts.push(artifact);
      continue;
    }

    const tmpPath = artifact.replace(/\.dmg$/, ".ulmo.dmg");
    try {
      execFileSync(
        "hdiutil",
        ["convert", artifact, "-format", "ULMO", "-o", tmpPath, "-quiet"],
        { stdio: ["ignore", "inherit", "inherit"] }
      );
      const before = fs.statSync(artifact).size;
      const after = fs.statSync(tmpPath).size;
      if (after < before) {
        fs.renameSync(tmpPath, artifact);
        console.log(
          `  afterAllArtifactBuild: recompressed ${path.basename(artifact)} to ULMO ` +
            `(${(before / 1024 / 1024).toFixed(1)} MB -> ${(after / 1024 / 1024).toFixed(1)} MB)`
        );
      } else {
        fs.rmSync(tmpPath, { force: true });
      }
    } catch (error) {
      fs.rmSync(tmpPath, { force: true });
      console.warn(`  afterAllArtifactBuild: ULMO conversion skipped: ${error.message}`);
    }
    artifacts.push(artifact);
  }
  return artifacts;
};
