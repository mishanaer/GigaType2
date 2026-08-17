const path = require("path");
const { verifyMacAppIdentity } = require("./verify-macos-app-identity");

exports.default = async function verifyMacIdentityAfterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  verifyMacAppIdentity(appPath);
};
