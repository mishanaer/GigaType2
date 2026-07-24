const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

const WindowsKeyManager = require("../../src/helpers/windowsKeyManager");

function createCaptureManager() {
  const manager = new WindowsKeyManager();
  const proc = new EventEmitter();
  proc.kill = () => {};

  manager.startProcess = (_args, identity) => {
    manager.process = proc;
    manager.currentKey = identity;
    manager.isReady = false;
    return proc;
  };

  return { manager, proc };
}

test("Windows hotkey capture resolves only after the native listener reports READY", async () => {
  const { manager } = createCaptureManager();
  const pending = manager.startCapture(100);

  let resolved = false;
  pending.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false);

  manager.handleOutputLine("READY", "__capture__");
  assert.deepEqual(await pending, { success: true });
});

test("Windows hotkey capture rejects an unrelated READY event", async () => {
  const { manager } = createCaptureManager();
  const pending = manager.startCapture(100);

  manager.handleOutputLine("READY", "F3");
  await Promise.resolve();
  assert.equal(manager.isReady, false);

  manager.handleOutputLine("READY", "__capture__");
  assert.deepEqual(await pending, { success: true });
});

test("Windows hotkey capture fails closed when READY times out", async () => {
  const { manager } = createCaptureManager();
  const result = await manager.startCapture(10);

  assert.deepEqual(result, { success: false, reason: "ready-timeout" });
  assert.equal(manager.process, null);
  assert.equal(manager.currentKey, null);
});
