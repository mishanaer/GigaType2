const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const {
  isAllowedAppNavigation,
  isAllowedIpcSenderUrl,
  isSafeExternalUrl,
} = require("../../src/helpers/securityPolicy");

test("external URLs allow only browser-safe protocols", () => {
  assert.equal(isSafeExternalUrl("https://example.com/path"), true);
  assert.equal(isSafeExternalUrl("mailto:support@example.com"), true);
  assert.equal(isSafeExternalUrl("http://localhost:11434", { allowLocalHttp: true }), true);

  assert.equal(isSafeExternalUrl("http://example.com"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("file:///etc/passwd"), false);
  assert.equal(isSafeExternalUrl("devtools://devtools/bundled/inspector.html"), false);
  assert.equal(isSafeExternalUrl(""), false);
});

test("app navigation is limited to the loaded app URL or bundled index", () => {
  const appPath = path.join("/Applications", "Type.app", "Contents", "Resources", "app.asar");
  const appFilePath = path.join(appPath, "src", "dist", "index.html");
  const appFileUrl = pathToFileURL(appFilePath).toString();

  assert.equal(
    isAllowedAppNavigation("http://localhost:5183/?panel=true", {
      appUrl: "http://localhost:5183/?panel=true",
      devServerPort: 5183,
    }),
    true
  );
  assert.equal(
    isAllowedAppNavigation("http://localhost:5183/other", {
      appUrl: "http://localhost:5183/?panel=true",
      devServerPort: 5183,
    }),
    false
  );
  assert.equal(isAllowedAppNavigation(`${appFileUrl}?panel=true`, { appFilePath }), true);
  assert.equal(isAllowedAppNavigation("file:///etc/passwd", { appFilePath }), false);
  assert.equal(isAllowedAppNavigation("devtools://devtools/bundled/inspector.html"), true);
});

test("IPC sender URLs are limited to the app renderer", () => {
  const appPath = path.join("/Applications", "Type.app", "Contents", "Resources", "app.asar");
  const appFileUrl = pathToFileURL(path.join(appPath, "src", "dist", "index.html")).toString();

  assert.equal(
    isAllowedIpcSenderUrl("http://localhost:5183/?panel=true", {
      appPath,
      devServerPort: 5183,
    }),
    true
  );
  assert.equal(
    isAllowedIpcSenderUrl(`${appFileUrl}?panel=true`, {
      appPath,
      devServerPort: 5183,
    }),
    true
  );
  assert.equal(
    isAllowedIpcSenderUrl("https://example.com", {
      appPath,
      devServerPort: 5183,
    }),
    false
  );
  assert.equal(
    isAllowedIpcSenderUrl("file:///tmp/index.html", {
      appPath,
      devServerPort: 5183,
    }),
    false
  );
});
