// electron-builder afterAllArtifactBuild hook
//
// Previously this recompressed the macOS DMG to ULMO (LZMA) to shave a little
// size. That is DISABLED: an ULMO (UDIF/lzma) disk image cannot be assessed by
// Gatekeeper's open path — `spctl -a -t open` reports "no usable signature"
// even when the DMG is notarized and stapled — so users who download a
// quarantined ULMO DMG hit a Gatekeeper block. On this app's payload ULMO also
// saved <1 MB over the UDZO image, so the trade is entirely negative for a
// signed + notarized build.
//
// The DMG now ships as UDZO (zlib) via electron-builder's dmg.format, which is
// the format meetily ships and which passes `spctl -a -t open`. Leave the
// artifacts untouched.

exports.default = async function (buildResult) {
  return buildResult.artifactPaths;
};
