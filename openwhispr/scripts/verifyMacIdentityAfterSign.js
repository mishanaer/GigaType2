const path = require("path");
const { verifyMacAppIdentity } = require("./verify-macos-app-identity");

exports.default = async function verifyMacIdentityAfterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  // Deliberately unsigned builds (npm run pack, local smoke tests) get an
  // ad-hoc signature with no TeamIdentifier. Gating them on the release team
  // would fail every such build at the very end, so only note it.
  const unsigned = process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false";

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const results = verifyMacAppIdentity(appPath, { allowUnsigned: unsigned });
  for (const result of results) {
    if (result.unsigned) {
      console.log(`  afterSign: ${result.appPath} is unsigned (CSC_IDENTITY_AUTO_DISCOVERY=false)`);
    }
  }
};
