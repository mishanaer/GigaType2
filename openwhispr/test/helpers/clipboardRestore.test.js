const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const emptyImage = { isEmpty: () => true };

const fakeClipboard = {
  text: "",
  html: "",
  image: null,
  formats: ["text/plain"],
  writes: [],
  availableFormats() {
    return this.formats;
  },
  readText() {
    return this.text;
  },
  writeText(text) {
    this.text = text;
    this.html = "";
    this.image = null;
    this.formats = ["text/plain"];
    this.writes.push(["writeText", text]);
  },
  readHTML() {
    return this.html;
  },
  write(payload) {
    this.text = payload.text || "";
    this.html = payload.html || "";
    this.image = payload.image || null;
    this.formats = [];
    if (Object.hasOwn(payload, "text")) this.formats.push("text/plain");
    if (Object.hasOwn(payload, "html")) this.formats.push("text/html");
    if (Object.hasOwn(payload, "image")) this.formats.push("image/png");
    this.writes.push(["write", payload]);
  },
  readImage() {
    return this.image || emptyImage;
  },
  writeImage(image) {
    this.text = "";
    this.html = "";
    this.image = image;
    this.formats = image && !image.isEmpty() ? ["image/png"] : [];
    this.writes.push(["writeImage", image]);
  },
};

const clipboardModulePath = require.resolve("../../src/helpers/clipboard");
const originalLoad = Module._load;

function loadClipboardManager({ spawn } = {}) {
  delete require.cache[clipboardModulePath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        clipboard: fakeClipboard,
        systemPreferences: {
          isTrustedAccessibilityClient: () => true,
        },
      };
    }
    if (request === "child_process" && spawn) {
      return { ...childProcess, spawn };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/helpers/clipboard");
  } finally {
    Module._load = originalLoad;
  }
}

function createSuccessfulSpawn(calls) {
  return function successfulSpawn(command, args = []) {
    calls.push({ command, args });
    const pasteProcess = new EventEmitter();
    pasteProcess.stderr = new EventEmitter();
    pasteProcess.stdout = new EventEmitter();
    process.nextTick(() => pasteProcess.emit("close", 0));
    return pasteProcess;
  };
}

function resetClipboard({
  text = "",
  html = "",
  image = null,
  formats = ["text/plain"],
} = {}) {
  fakeClipboard.text = text;
  fakeClipboard.html = html;
  fakeClipboard.image = image;
  fakeClipboard.formats = formats;
  fakeClipboard.writes = [];
}

async function withPlatform(platform, callback) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...originalDescriptor, value: platform });
  try {
    return await callback();
  } finally {
    Object.defineProperty(process, "platform", originalDescriptor);
  }
}

const ClipboardManager = loadClipboardManager();

test("restore preserves rich text clipboard formats atomically", () => {
  resetClipboard({
    formats: ["text/html", "text/plain"],
    text: "plain before",
    html: "<b>html before</b>",
  });
  const manager = new ClipboardManager();

  const snapshot = manager._saveClipboard();
  fakeClipboard.writeText("dictated text");
  manager._restoreClipboard(snapshot);

  assert.deepEqual([...fakeClipboard.availableFormats()].sort(), ["text/html", "text/plain"]);
  assert.equal(fakeClipboard.text, "plain before");
  assert.equal(fakeClipboard.html, "<b>html before</b>");
  assert.equal(fakeClipboard.writes.at(-1)[0], "write");
});

test("guarded restore runs after a verified paste while clipboard is unchanged", async () => {
  resetClipboard({ text: "dictated text" });
  const manager = new ClipboardManager();

  await manager._restoreClipboardAfterDelay(
    { type: "text", data: "previous clipboard" },
    { delayMs: 0, expectedText: "dictated text" }
  );

  assert.equal(fakeClipboard.text, "previous clipboard");
});

test("restore is skipped when another clipboard write wins the race", async () => {
  resetClipboard({ text: "user copied something else" });
  const manager = new ClipboardManager();

  await manager._restoreClipboardAfterDelay(
    { type: "text", data: "previous clipboard" },
    { delayMs: 0, expectedText: "dictated text" }
  );

  assert.equal(fakeClipboard.text, "user copied something else");
});

test("macOS restores the previous clipboard only after a verified paste", async () => {
  await withPlatform("darwin", async () => {
    resetClipboard({ text: "previous clipboard" });
    const manager = new ClipboardManager();
    let pasteOriginal;
    let restoreCall;

    manager.resolveFastPasteBinary = () => "/tmp/openwhispr-fast-paste";
    manager.checkAccessibilityPermissions = async () => true;
    manager.pasteMacOS = async (originalClipboard) => {
      pasteOriginal = originalClipboard;
      return { restoreComplete: Promise.resolve() };
    };
    manager._restoreClipboardAfterDelay = async (originalClipboard, options) => {
      restoreCall = { originalClipboard, options };
      manager._restoreClipboard(originalClipboard);
    };

    const result = await manager.pasteText("dictated text", {
      restoreClipboard: true,
      allowClipboardFallback: true,
      verifyPaste: async () => ({ inserted: true, reason: "verified" }),
      verificationIntervalMs: 1,
      verificationTimeoutMs: 1,
    });

    assert.equal(pasteOriginal, null);
    assert.deepEqual(restoreCall, {
      originalClipboard: { type: "text", data: "previous clipboard" },
      options: { delayMs: 450, expectedText: "dictated text" },
    });
    assert.equal(fakeClipboard.text, "previous clipboard");
    assert.equal(result.inserted, true);
    assert.equal(result.verified, true);
    assert.equal(result.fallback, false);
  });
});

test("macOS keeps dictated text when the paste cannot be verified", async () => {
  await withPlatform("darwin", async () => {
    resetClipboard({ text: "previous clipboard" });
    const manager = new ClipboardManager();
    let restoreCalled = false;

    manager.resolveFastPasteBinary = () => "/tmp/openwhispr-fast-paste";
    manager.checkAccessibilityPermissions = async () => true;
    manager.pasteMacOS = async (originalClipboard) => {
      assert.equal(originalClipboard, null);
      return { restoreComplete: Promise.resolve() };
    };
    manager._restoreClipboardAfterDelay = async () => {
      restoreCalled = true;
    };

    const result = await manager.pasteText("dictated text", {
      restoreClipboard: true,
      allowClipboardFallback: true,
      verifyPaste: async () => ({
        inserted: false,
        retryable: false,
        reason: "unreadable-after-paste",
      }),
      verificationIntervalMs: 1,
      verificationTimeoutMs: 1,
    });

    assert.equal(restoreCalled, false);
    assert.equal(fakeClipboard.text, "dictated text");
    assert.equal(result.inserted, false);
    assert.equal(result.verified, false);
    assert.equal(result.fallback, true);
    assert.equal(result.reason, "unreadable-after-paste");
  });
});

test("macOS keeps dictated text when paste verification is unavailable", async () => {
  await withPlatform("darwin", async () => {
    resetClipboard({ text: "previous clipboard" });
    const manager = new ClipboardManager();

    manager.resolveFastPasteBinary = () => "/tmp/openwhispr-fast-paste";
    manager.checkAccessibilityPermissions = async () => true;
    manager.pasteMacOS = async (originalClipboard) => {
      assert.equal(originalClipboard, null);
      return { restoreComplete: Promise.resolve() };
    };

    const result = await manager.pasteText("dictated text", {
      restoreClipboard: true,
      allowClipboardFallback: true,
    });

    assert.equal(fakeClipboard.text, "dictated text");
    assert.equal(result.inserted, false);
    assert.equal(result.verified, false);
    assert.equal(result.fallback, true);
    assert.equal(result.reason, "verification-unavailable");
  });
});

test("macOS rewrites dictated text to the clipboard when paste fails", async () => {
  await withPlatform("darwin", async () => {
    resetClipboard({ text: "previous clipboard" });
    const manager = new ClipboardManager();
    let pasteAttempts = 0;

    manager.resolveFastPasteBinary = () => "/tmp/openwhispr-fast-paste";
    manager.checkAccessibilityPermissions = async () => true;
    manager.pasteMacOS = async () => {
      pasteAttempts += 1;
      fakeClipboard.writeText("clipboard changed during paste");
      throw new Error("paste failed");
    };

    await assert.rejects(
      manager.pasteText("dictated text", {
        restoreClipboard: true,
        allowClipboardFallback: true,
      }),
      /paste failed/
    );

    assert.equal(pasteAttempts, 2);
    assert.equal(fakeClipboard.text, "dictated text");
  });
});

test("pasteText waits for prior clipboard restoration before starting the next paste", async () => {
  const manager = new ClipboardManager();
  const events = [];
  let releaseFirstRestore;

  manager._pasteText = async (text) => {
    events.push(`start:${text}`);
    events.push(`end:${text}`);
    if (text === "first") {
      return {
        restoreComplete: new Promise((resolve) => {
          releaseFirstRestore = resolve;
        }),
      };
    }
    return { restoreComplete: Promise.resolve() };
  };

  await manager.pasteText("first");
  const secondPaste = manager.pasteText("second");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(events, ["start:first", "end:first"]);

  releaseFirstRestore();
  await secondPaste;
  assert.deepEqual(events, ["start:first", "end:first", "start:second", "end:second"]);
});

test("pasteMacOS returns a restore gate with expected pasted text", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  const originalClipboard = { type: "text", data: "previous clipboard" };
  let restoreCall;

  manager.resolveFastPasteBinary = () => "/tmp/openwhispr-fast-paste";
  manager._restoreClipboardAfterDelay = (original, options) => {
    restoreCall = { original, options };
    return Promise.resolve();
  };

  const result = await manager.pasteMacOS(originalClipboard, {
    expectedClipboardText: "dictated text",
    fromStreaming: true,
  });
  await result.restoreComplete;

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "/tmp/openwhispr-fast-paste");
  assert.equal(restoreCall.original, originalClipboard);
  assert.deepEqual(restoreCall.options, {
    delayMs: 450,
    expectedText: "dictated text",
  });
});

test("pasteMacOSWithOsascript fallback returns a restore gate with expected pasted text", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  const originalClipboard = { type: "text", data: "previous clipboard" };
  let restoreCall;

  manager._restoreClipboardAfterDelay = (original, options) => {
    restoreCall = { original, options };
    return Promise.resolve();
  };

  const result = await manager.pasteMacOSWithOsascript(originalClipboard, {
    expectedClipboardText: "dictated text",
  });
  await result.restoreComplete;

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "osascript");
  assert.deepEqual(spawnCalls[0].args, [
    "-e",
    'tell application "System Events" to key code 9 using command down',
  ]);
  assert.equal(restoreCall.original, originalClipboard);
  assert.deepEqual(restoreCall.options, {
    delayMs: 450,
    expectedText: "dictated text",
  });
});
