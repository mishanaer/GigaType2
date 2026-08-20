#!/usr/bin/env bash
# Build a SIGNED (and, by default, notarized) macOS arm64 Type.app + DMG with
# the GigaAM model wired in — offline, no first-run download: the CoreML encoder
# that runs on the Neural Engine plus the ONNX RNN-T decoder/joint.
#
# Usage:
#   scripts/build-mac-arm64-signed.sh                       # sign + notarize + staple
#   scripts/build-mac-arm64-signed.sh --skip-notarize       # sign only (runs locally, Gatekeeper warns elsewhere)
#   scripts/build-mac-arm64-signed.sh --recompile-natives   # rebuild Swift/native helpers as arm64 first
#   scripts/build-mac-arm64-signed.sh --skip-model-download  # error (don't auto-fetch) if model files missing
#
# --- Environment you must set before running ---------------------------------
#
# Signing identity — pick ONE:
#   (a) already in your login keychain (what `security find-identity -v -p
#       codesigning` lists). Nothing to set; optionally pin which one with
#         CSC_NAME='Developer ID Application: Name (TEAMID)'   # or its SHA-1
#   (b) a .p12 to import:
#         CSC_LINK=/path/to/DeveloperID.p12   # or a base64 blob of it
#         CSC_KEY_PASSWORD=…
#
# Team:
#   APPLE_TEAM_ID=XXXXXXXXXX   # inferred from the keychain identity if unset
#
# Notarization (skip with --skip-notarize) — pick ONE:
#   (a) App Store Connect API key (recommended, no 2FA dance):
#         APPLE_API_KEY=/path/to/AuthKey_XXXX.p8
#         APPLE_API_KEY_ID=XXXXXXXXXX
#         APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#   (b) Apple ID + app-specific password:
#         APPLE_ID=you@example.com
#         APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop
#
# --- Why the old unsigned script failed here ---------------------------------
# It exported CSC_IDENTITY_AUTO_DISCOVERY=false, so electron-builder ad-hoc
# signed the app (identityName=-), and the afterSign hook
# (scripts/verifyMacIdentityAfterSign.js) then rejected it with
# "TeamIdentifier not set != SBHVKH5UUY". This script does the opposite: it
# refuses to start unless a real identity is available, so you never burn a
# full build discovering it was ad-hoc signed at the very end.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The team the repo expects to ship under (scripts/verify-macos-app-identity.js).
REPO_TEAM_ID="SBHVKH5UUY"

recompile_natives=0
skip_model_download=0
skip_notarize=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --recompile-natives) recompile_natives=1; shift ;;
    --skip-model-download) skip_model_download=1; shift ;;
    --skip-notarize) skip_notarize=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

# ---------- preflight: signing identity ---------------------------------------
# A stale CSC_IDENTITY_AUTO_DISCOVERY=false (e.g. exported by an earlier
# unsigned build in the same shell) silently downgrades this to an ad-hoc
# signature, which only surfaces as a failure minutes later in afterSign.
if [[ "${CSC_IDENTITY_AUTO_DISCOVERY:-}" == "false" ]]; then
  echo "==> CSC_IDENTITY_AUTO_DISCOVERY=false is set — unsetting it for a signed build"
  unset CSC_IDENTITY_AUTO_DISCOVERY
fi

identity_line=""
if [[ -n "${CSC_LINK:-}" ]]; then
  # A .p12 path (base64 blobs are also accepted by electron-builder and are not
  # a file, so only validate when it looks like a path).
  if [[ "$CSC_LINK" == /* || "$CSC_LINK" == ./* ]] && [[ ! -f "$CSC_LINK" ]]; then
    die "CSC_LINK points at a file that does not exist: $CSC_LINK"
  fi
  [[ -n "${CSC_KEY_PASSWORD:-}" ]] || die "CSC_LINK is set but CSC_KEY_PASSWORD is not."
  echo "==> Signing identity: importing from CSC_LINK"
else
  identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  if [[ -n "${CSC_NAME:-}" ]]; then
    identity_line="$(grep -F "$CSC_NAME" <<<"$identities" | head -1 || true)"
    [[ -n "$identity_line" ]] || die "CSC_NAME='$CSC_NAME' matches no codesigning identity in the keychain."
  else
    identity_line="$(grep -F "Developer ID Application" <<<"$identities" | head -1 || true)"
  fi
  if [[ -z "$identity_line" ]]; then
    echo "error: no 'Developer ID Application' identity found in the keychain and CSC_LINK is unset." >&2
    echo "       Available codesigning identities:" >&2
    echo "${identities:-  (none)}" >&2
    echo "       Set CSC_LINK + CSC_KEY_PASSWORD, or import the certificate into your login keychain." >&2
    exit 1
  fi
  echo "==> Signing identity: $(sed 's/.*"\(.*\)"/\1/' <<<"$identity_line")"
fi

# ---------- preflight: team id ------------------------------------------------
# The afterSign hook verifies the signed app's TeamIdentifier. Default it to
# whatever the certificate we are about to use belongs to, so signing with a
# different team is an explicit, visible choice rather than a late failure.
cert_team=""
if [[ -n "$identity_line" ]]; then
  cert_team="$(sed -n 's/.*(\([A-Z0-9][A-Z0-9]*\))".*/\1/p' <<<"$identity_line")"
fi

if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
  [[ -n "$cert_team" ]] || die "APPLE_TEAM_ID is not set and could not be inferred. Export it and retry."
  export APPLE_TEAM_ID="$cert_team"
  echo "==> APPLE_TEAM_ID not set — inferred '$APPLE_TEAM_ID' from the identity"
elif [[ -n "$cert_team" && "$cert_team" != "$APPLE_TEAM_ID" ]]; then
  # Signing would use the certificate's team, notarization the declared one, and
  # the afterSign check would fail at the end with a confusing mismatch.
  die "APPLE_TEAM_ID='$APPLE_TEAM_ID' but the signing certificate belongs to team '$cert_team'.
       Fix APPLE_TEAM_ID, or pin the right certificate with CSC_NAME / CSC_LINK."
fi

# scripts/verify-macos-app-identity.js gates on this. Keep the repo default
# unless the operator is deliberately signing under another team.
export TYPE_EXPECTED_TEAM_ID="$APPLE_TEAM_ID"
if [[ "$APPLE_TEAM_ID" != "$REPO_TEAM_ID" ]]; then
  echo
  echo "WARNING: signing under team '$APPLE_TEAM_ID', not the release team '$REPO_TEAM_ID'."
  echo "         The build will be verified against '$APPLE_TEAM_ID'. Such a build must not"
  echo "         be published: TCC matches on bundle id + code requirement, so a copy signed"
  echo "         by another team collides with real installs of ai.gigatype.app."
  echo
fi

# ---------- preflight: notarization credentials -------------------------------
# electron-builder.json sets mac.notarize=true, and its built-in notarization
# reads these from the environment. Without them it prints "notarize options
# were unable to be generated" and silently ships an un-notarized app — check
# up front instead.
notarize_args=()
if [[ $skip_notarize -eq 1 ]]; then
  echo "==> Notarization: SKIPPED (--skip-notarize)"
  notarize_args=(-c.mac.notarize=false)
elif [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
  [[ -f "$APPLE_API_KEY" ]] || die "APPLE_API_KEY does not point at a file: $APPLE_API_KEY"
  echo "==> Notarization: App Store Connect API key ($APPLE_API_KEY_ID)"
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  echo "==> Notarization: Apple ID $APPLE_ID (team $APPLE_TEAM_ID)"
else
  echo "error: notarization credentials are not set." >&2
  echo "       Set APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or" >&2
  echo "       APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD (+ APPLE_TEAM_ID)," >&2
  echo "       or rerun with --skip-notarize to build a signed-but-unnotarized app." >&2
  exit 1
fi

# ---------- preflight: wired GigaAM model -------------------------------------
# The whole point of this build is that the model ships inside the app.
# electron-builder's mac.extraResources copies resources/gigaam-model/ and
# resources/gigaam-ane/ into Contents/Resources/, and gigaamLocalAsr.js resolves
# them there so a fresh install transcribes offline.
#
# arm64 runs the encoder on the Neural Engine (CoreML .mlmodelc), so only the
# 7 MB RNN-T decoder/joint/vocab are needed from the ONNX set — afterPack drops
# the 885 MB ONNX encoder from this build even when it is present locally.
MODEL_DIR="$REPO_ROOT/resources/gigaam-model"
MODEL_FILES=(v3_e2e_rnnt_decoder.onnx v3_e2e_rnnt_joint.onnx v3_e2e_rnnt_vocab.txt)
missing_model=0
for f in "${MODEL_FILES[@]}"; do
  [[ -f "$MODEL_DIR/$f" ]] || missing_model=1
done
if [[ $missing_model -eq 1 ]]; then
  if [[ $skip_model_download -eq 1 ]]; then
    echo "error: wired GigaAM model files missing under $MODEL_DIR" >&2
    echo "       run 'npm run download:gigaam-model' (or drop --skip-model-download)." >&2
    exit 1
  fi
  echo "==> Wired model missing — fetching it (npm run download:gigaam-model)"
  ( cd "$REPO_ROOT" && npm run download:gigaam-model )
  for f in "${MODEL_FILES[@]}"; do
    [[ -f "$MODEL_DIR/$f" ]] || die "model download did not produce $MODEL_DIR/$f"
  done
fi

# ---------- preflight: CoreML/ANE encoder -------------------------------------
# arm64 has no ONNX-encoder fallback: if the CoreML model or its helper is
# missing the app cannot transcribe locally at all, so fail here rather than
# shipping a broken build (afterPack repeats this check).
ANE_MODEL="$REPO_ROOT/resources/gigaam-ane/encoder-ane.mlmodelc"
if [[ ! -f "$ANE_MODEL/model.mil" ]]; then
  if [[ $skip_model_download -eq 1 ]]; then
    echo "error: CoreML/ANE encoder missing at $ANE_MODEL" >&2
    echo "       run 'npm run download:gigaam-ane' (or drop --skip-model-download)." >&2
    exit 1
  fi
  echo "==> CoreML/ANE encoder missing — fetching it (npm run download:gigaam-ane)"
  ( cd "$REPO_ROOT" && npm run download:gigaam-ane )
  [[ -f "$ANE_MODEL/model.mil" ]] || die "download did not produce $ANE_MODEL"
fi

# ---------- preflight: arm64 native binaries ----------------------------------
# The classic arch pitfall: single-arch x86_64 helpers left over from a prior
# x64 build get packaged into the arm64 app and throw "… binary is x86_64 but
# this Mac requires arm64" at runtime (afterPack only thins fat *dylibs*;
# single-arch macos-* binaries pass through untouched). Every macOS Mach-O in
# resources/bin must at least CONTAIN arm64 (universal is fine — afterPack thins
# it). Rerun with --recompile-natives if this trips.
if [[ $recompile_natives -eq 1 ]]; then
  echo "==> Recompiling native helpers as arm64 (TARGET_ARCH=arm64 npm run compile:native)"
  ( cd "$REPO_ROOT" && TARGET_ARCH=arm64 npm run compile:native )
fi

for b in ffmpeg macos-audio-tap macos-globe-listener macos-fast-paste \
         macos-mic-listener macos-text-monitor macos-media-remote \
         macos-gigaam-encoder; do
  f="$REPO_ROOT/resources/bin/$b"
  [[ -f "$f" ]] || die "missing native binary: $f (run --recompile-natives)"
  archs="$(lipo -archs "$f" 2>/dev/null || true)"
  if [[ "$archs" != *arm64* ]]; then
    die "$b is '$archs' — not arm64. Rerun with --recompile-natives."
  fi
done

# ---------- build -------------------------------------------------------------
echo "==> Building SIGNED arm64 Type.app + DMG (wired GigaAM model)"
[[ $skip_notarize -eq 1 ]] || echo "    notarization runs inside electron-builder and can take several minutes"
date

( cd "$REPO_ROOT" && npm run build:renderer )
# ${arr[@]+…} guard: macOS ships bash 3.2, where expanding an empty array
# as "${arr[@]}" is an "unbound variable" error under `set -u`.
( cd "$REPO_ROOT" && ./node_modules/.bin/electron-builder --mac --arm64 ${notarize_args[@]+"${notarize_args[@]}"} )

# ---------- verify ------------------------------------------------------------
DIST="$REPO_ROOT/dist"
APP="$(ls -dt "$DIST"/mac-arm64/*.app 2>/dev/null | head -1)"
DMG="$(ls -t "$DIST"/*-arm64.dmg 2>/dev/null | head -1)"
[[ -n "$APP" && -d "$APP" ]] || die "no .app produced under $DIST/mac-arm64"

echo
echo "==> Verifying signature"
codesign --verify --deep --strict --verbose=2 "$APP"
node "$REPO_ROOT/scripts/verify-macos-app-identity.js" "$APP"

if [[ $skip_notarize -eq 1 ]]; then
  echo "==> Gatekeeper: not assessed (build is signed but not notarized)"
else
  echo "==> Checking the notarization ticket"
  # electron-builder staples the app; the DMG is stapled separately when it is
  # notarized. A missing ticket here means notarization silently did not run.
  xcrun stapler validate "$APP" || die "no stapled notarization ticket on $APP"
  if [[ -n "$DMG" && -f "$DMG" ]]; then
    xcrun stapler validate "$DMG" || echo "  note: DMG is not stapled (the .app inside it is)"
  fi
  echo "==> Gatekeeper assessment"
  spctl --assess --type exec --verbose=4 "$APP"
fi

# ---------- report ------------------------------------------------------------
echo
echo "==> Artifacts:"
ls -lh "$DIST"/*-arm64.dmg "$DIST"/*-arm64-mac.zip 2>/dev/null || true
if [[ -n "$DMG" && -f "$DMG" ]]; then shasum -a 256 "$DMG"; fi
echo
if [[ $skip_notarize -eq 1 ]]; then
  echo "Done (SIGNED, NOT notarized). It runs on this Mac; Gatekeeper will warn on download."
else
  echo "Done (SIGNED + notarized + stapled)."
fi
