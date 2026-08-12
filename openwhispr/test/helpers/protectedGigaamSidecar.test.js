const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ProtectedGigaamSidecar,
  resolveProtectedGigaamConfig,
} = require("../../src/helpers/protectedGigaamSidecar");

test("protected GigaAM config is fail-closed when a release marker is present", (t) => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "type-protected-config-"));
  t.after(() => fs.rmSync(resources, { recursive: true, force: true }));
  const dir = path.join(resources, "protected-gigaam");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "required.json"), "{}\n");

  const missing = resolveProtectedGigaamConfig({
    resourcesPath: resources,
    env: {},
    helperPath: null,
  });
  assert.equal(missing.required, true);
  assert.equal(missing.available, false);

  const modelPath = path.join(dir, "gigaam-en-ru.memento-model");
  fs.writeFileSync(modelPath, "ciphertext fixture");
  const ready = resolveProtectedGigaamConfig({
    resourcesPath: resources,
    env: {},
    helperPath: process.execPath,
  });
  assert.equal(ready.required, true);
  assert.equal(ready.available, true);
  assert.equal(ready.modelPath, modelPath);
});

test("protected GigaAM sidecar frames PCM requests and serializes replies", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "type-protected-sidecar-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, "fixture.js");
  fs.writeFileSync(
    fixture,
    `
const ready = Buffer.from(JSON.stringify({type:"ready",releaseId:"r1",modelId:"m1"}));
const header = Buffer.alloc(4); header.writeUInt32LE(ready.length); process.stdout.write(header); process.stdout.write(ready);
let pending = Buffer.alloc(0); let expected = null;
process.stdin.on("data", chunk => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    if (expected === null) {
      if (pending.length < 4) return;
      expected = pending.readUInt32LE(0); pending = pending.subarray(4);
      if (expected === 0) process.exit(0);
    }
    if (pending.length < expected) return;
    const body = pending.subarray(0, expected); pending = pending.subarray(expected); expected = null;
    const reply = Buffer.from(JSON.stringify({type:"transcript",text:String(body.length / 4)}));
    const length = Buffer.alloc(4); length.writeUInt32LE(reply.length); process.stdout.write(length); process.stdout.write(reply);
  }
});
`,
    "utf8"
  );

  const sidecar = new ProtectedGigaamSidecar({
    helperPath: process.execPath,
    modelPath: "unused",
    helperArgs: [fixture],
  });
  t.after(() => sidecar.stop());
  const info = await sidecar.start();
  assert.deepEqual(info, { type: "ready", releaseId: "r1", modelId: "m1" });

  const first = sidecar.transcribe(new Float32Array(4).buffer);
  const second = sidecar.transcribe(new Float32Array(7).buffer);
  assert.deepEqual(await first, { text: "4" });
  assert.deepEqual(await second, { text: "7" });
});
