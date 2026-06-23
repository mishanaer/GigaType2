const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const testRoot = path.join(root, "test");

function collectTests(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTests(fullPath));
    } else if (/\.test\.js$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

const tests = collectTests(testRoot);
if (tests.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: root,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
