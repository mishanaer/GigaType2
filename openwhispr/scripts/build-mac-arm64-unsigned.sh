#!/usr/bin/env bash
# Build an UNSIGNED, un-notarized macOS arm64 Type.app + DMG with the GigaAM
# model wired in (offline, no first-run download): the CoreML encoder that runs
# on the Neural Engine plus the ONNX RNN-T decoder/joint.
#
# This is the signing-free counterpart of build-mac-arm64-signed.sh — same
# arm64 wired-model artifact, but with code signing and Apple notarization
# turned off. No Apple ID, no .p12, no keychain, no network to the notary
# service. Handy for local smoke tests, CI dry-runs, or handing a colleague a
# build they will run with `xattr -dr com.apple.quarantine Type.app` (Gatekeeper
# WILL block an unsigned download otherwise — that is expected here).
#
# Usage:
#   scripts/build-mac-arm64-unsigned.sh                     # build (assumes resources/bin already arm64)
#   scripts/build-mac-arm64-unsigned.sh --recompile-natives # rebuild Swift/native helpers as arm64 first
#   scripts/build-mac-arm64-unsigned.sh --skip-model-download # error (don't auto-fetch) if model files missing
#
# --- How "unsigned" is expressed --------------------------------------------
#   CSC_IDENTITY_AUTO_DISCOVERY=false tells electron-builder to skip code
#   signing, and scripts/afterSign.js short-circuits (skips notarization) on
#   that same flag. Every CSC_*/APPLE_* var is unset first so a stray value in
#   the environment can't quietly re-enable signing.
#
# --- What this does NOT do vs. the signed script -----------------------------
#   No codesign, no notarytool submit, no stapler staple, no spctl assessment
#   (an unsigned app is 'rejected' by Gatekeeper by definition — checking it
#   would only ever fail). It still preflights the wired model and the arm64
#   native binaries, builds the renderer, and runs electron-builder.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

recompile_natives=0
skip_model_download=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --recompile-natives) recompile_natives=1; shift ;;
    --skip-model-download) skip_model_download=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ---------- force unsigned ----------------------------------------------------
# Drop anything that could steer electron-builder toward a real identity, then
# explicitly disable auto-discovery. afterSign.js reads this same flag and skips
# notarization when it is "false".
unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME \
      APPLE_ID APPLE_PASSWORD APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID \
      APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
export CSC_IDENTITY_AUTO_DISCOVERY=false

# ---------- preflight: wired GigaAM model -------------------------------------
# The whole point of this build is that the model ships inside the app.
# electron-builder's mac.extraResources copies resources/gigaam-model/ and
# resources/gigaam-ane/ into Contents/Resources/, and gigaamLocalAsr.js resolves
# them there so a fresh install transcribes offline with no first-run download.
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
    if [[ ! -f "$MODEL_DIR/$f" ]]; then
      echo "error: model download did not produce $MODEL_DIR/$f" >&2
      exit 1
    fi
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
  if [[ ! -f "$ANE_MODEL/model.mil" ]]; then
    echo "error: download did not produce $ANE_MODEL" >&2
    exit 1
  fi
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
  [[ -f "$f" ]] || { echo "error: missing native binary: $f (run --recompile-natives)" >&2; exit 1; }
  archs="$(lipo -archs "$f" 2>/dev/null || true)"
  if [[ "$archs" != *arm64* ]]; then
    echo "error: $b is '$archs' — not arm64. Rerun with --recompile-natives." >&2
    exit 1
  fi
done

# ---------- build -------------------------------------------------------------
echo "==> Building UNSIGNED arm64 Type.app + DMG (wired GigaAM model)"
date

( cd "$REPO_ROOT" && npm run build:renderer )
( cd "$REPO_ROOT" && ./node_modules/.bin/electron-builder --mac --arm64 )

# ---------- report ------------------------------------------------------------
DIST="$REPO_ROOT/dist"
DMG="$(ls -t "$DIST"/*-arm64.dmg 2>/dev/null | head -1)"
APP="$(ls -dt "$DIST"/mac-arm64/*.app 2>/dev/null | head -1)"

echo
echo "==> Artifacts:"
ls -lh "$DIST"/*-arm64.dmg "$DIST"/*-arm64-mac.zip 2>/dev/null || true
[[ -n "$DMG" && -f "$DMG" ]] && shasum -a 256 "$DMG"
echo
echo "Done (UNSIGNED — no notarization). To run locally without a Gatekeeper prompt:"
[[ -n "$APP" ]] && echo "  xattr -dr com.apple.quarantine \"$APP\""
