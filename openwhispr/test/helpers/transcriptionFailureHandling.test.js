const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("transcription failures retain model context outside the try block", () => {
  const source = read("src/helpers/audioManager.js");
  const processAudioStart = source.indexOf("async processAudio(");
  const modelDeclaration = source.indexOf(
    "const activeModel = this.getTranscriptionModel();",
    processAudioStart
  );
  const tryBlock = source.indexOf("try {", processAudioStart);

  assert.ok(processAudioStart >= 0);
  assert.ok(modelDeclaration > processAudioStart);
  assert.ok(modelDeclaration < tryBlock);
});

test("transcription failures are silent in the UI", () => {
  const manager = read("src/helpers/audioManager.js");
  const hook = read("src/hooks/useAudioRecording.js");

  assert.match(manager, /title: "Transcription Error",[\s\S]*?silent: true,/);
  assert.match(hook, /if \(!error\?\.silent\) \{\s*notify\(\{/);
});
