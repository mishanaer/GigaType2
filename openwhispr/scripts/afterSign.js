// electron-builder afterSign hook
//
// Notarizes the signed macOS .app with Apple's notary service (notarytool via
// @electron/notarize). Runs after the app is code-signed but before the DMG is
// assembled, so the DMG ships a notarized (and later stapled) app.
//
// Notarization is skipped gracefully — without failing the build — when:
//   - the platform is not macOS,
//   - the build is intentionally unsigned (CSC_IDENTITY_AUTO_DISCOVERY=false),
//   - no notarization credentials are present in the environment.
//
// Provide credentials via either:
//   App Store Connect API key (recommended):
//     APPLE_API_KEY    = path to the AuthKey_XXXX.p8 file
//     APPLE_API_KEY_ID = the key ID
//     APPLE_API_ISSUER = the issuer UUID
//   or Apple ID + app-specific password:
//     APPLE_ID                     = your Apple ID email
//     APPLE_APP_SPECIFIC_PASSWORD  = an app-specific password
//     APPLE_TEAM_ID                = the Developer Team ID (e.g. LTS79DWRGJ)

const path = require("path");
const { notarize } = require("@electron/notarize");

exports.default = async function notarizeMac(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  if (electronPlatformName !== "darwin") return;

  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") {
    console.log("  afterSign: unsigned build (CSC_IDENTITY_AUTO_DISCOVERY=false) — skipping notarization");
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const apiKey = process.env.APPLE_API_KEY;
  const apiKeyId = process.env.APPLE_API_KEY_ID;
  const apiIssuer = process.env.APPLE_API_ISSUER;
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  let options;
  if (apiKey && apiKeyId && apiIssuer) {
    options = {
      appPath,
      appleApiKey: apiKey,
      appleApiKeyId: apiKeyId,
      appleApiIssuer: apiIssuer,
    };
  } else if (appleId && appleIdPassword && teamId) {
    options = { appPath, appleId, appleIdPassword, teamId };
  } else {
    console.warn(
      "  afterSign: notarization credentials not set — skipping notarization.\n" +
        "            Set APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or\n" +
        "            APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, then rebuild."
    );
    return;
  }

  console.log(`  afterSign: notarizing ${appName}.app (this can take several minutes)…`);
  await notarize(options);
  console.log("  afterSign: notarization complete");
};
