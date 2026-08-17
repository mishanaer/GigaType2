const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXPECTED_BUNDLE_ID,
  EXPECTED_TEAM_ID,
  parseCodesignDetails,
  verifyBundle,
} = require("../../scripts/verify-macos-app-identity");

test("parses the stable bundle and team identity from codesign output", () => {
  assert.deepEqual(
    parseCodesignDetails(
      `Executable=/Applications/Type.app/Contents/MacOS/Type\nIdentifier=${EXPECTED_BUNDLE_ID}\nTeamIdentifier=${EXPECTED_TEAM_ID}\n`
    ),
    {
      Executable: "/Applications/Type.app/Contents/MacOS/Type",
      Identifier: EXPECTED_BUNDLE_ID,
      TeamIdentifier: EXPECTED_TEAM_ID,
    }
  );
});

test("release identity verification rejects a different signing team", () => {
  const fakeExec = (_command, args) => {
    if (args[0] === "-extract") return `${EXPECTED_BUNDLE_ID}\n`;
    throw new Error("unexpected executable");
  };
  const fakeSpawn = () => ({
    status: 0,
    stdout: "",
    stderr: `Identifier=${EXPECTED_BUNDLE_ID}\nTeamIdentifier=WRONGTEAM1\n`,
  });

  assert.throws(
    () =>
      verifyBundle("/tmp/Type.app", {
        execFileSyncImpl: fakeExec,
        spawnSyncImpl: fakeSpawn,
      }),
    /WRONGTEAM1.*SBHVKH5UUY/
  );
});

test("release identity verification rejects a legacy bundle id", () => {
  const fakeExec = (_command, args) => {
    if (args[0] === "-extract") return "com.gizmolabs.openwhispr\n";
    throw new Error("codesign should not run after a bundle-id mismatch");
  };

  assert.throws(
    () => verifyBundle("/tmp/Type.app", { execFileSyncImpl: fakeExec }),
    /com\.gizmolabs\.openwhispr.*ai\.gigatype\.app/
  );
});
