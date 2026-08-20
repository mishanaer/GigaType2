#!/usr/bin/env bash
# Build a Linux .deb of Type with the GigaAM model wired in — offline, no
# first-run download. The app resolves the model from
# /opt/Type/resources/gigaam-model (linux.extraResources in
# electron-builder.json); nothing fetches it at runtime, so a .deb built without
# it installs an app that cannot transcribe. This script refuses to build so.
#
# Linux has no Neural Engine, so unlike the macOS arm64 build it ships the full
# 885 MB ONNX encoder. Expect a ~900 MB package.
#
# Runs on Linux natively, and cross-builds from macOS (see below).
#
# Usage:
#   scripts/build-linux-deb.sh                       # host arch
#   scripts/build-linux-deb.sh --arch arm64
#   scripts/build-linux-deb.sh --skip-deps           # don't re-fetch sidecars/models
#   scripts/build-linux-deb.sh --skip-model-download # error instead of fetching the model
#
# --- Cross-building from macOS ------------------------------------------------
# Two things have to be solved, and this script does both:
#
#  1. fpm (which electron-builder shells out to for deb) needs GNU ar — BSD ar
#     produces an archive dpkg rejects — plus dpkg-deb itself:
#         brew install binutils dpkg
#
#  2. Native node modules resolve to the HOST's binaries. better-sqlite3 and
#     @napi-rs/keyring would go into the package as Mach-O and the app would
#     crash on Linux. We fetch their Linux builds (better-sqlite3 via
#     prebuild-install from its GitHub releases, keyring via its published
#     platform package), swap them in for the duration of the build, and put the
#     host's back afterwards — including on failure, via an EXIT trap.
#     npmRebuild is disabled for the cross build: it cannot compile for Linux here.
#
# What a macOS-built package does NOT get: resources/bin/linux-* (fast-paste,
# key-listener, text-monitor, system-audio-helper) and a Linux `usocket`. The
# helpers are C, needing gcc plus X11/XTest/GLib/AT-SPI headers; usocket is
# node-gyp only. So push-to-talk, system-audio capture and the text monitor are
# absent, paste falls back to ydotool/xdotool, and — because usocket backs
# dbus-next — GNOME/KDE/Hyprland Wayland global shortcuts break on any session
# whose bus address uses `abstract=` (the `path=` form degrades gracefully).
# Good for a packaging smoke test; NOT for release.
#
# --- Release builds: run this same script on Linux -----------------------------
# In a container from the repo root (verified working on an Apple Silicon Mac):
#
#   docker run --rm --platform linux/amd64 \
#     -e DEB_MAINTAINER="Your Name <you@example.com>" \
#     -e http_proxy -e https_proxy -e HTTP_PROXY -e HTTPS_PROXY \
#     -v "$PWD":/project -w /project \
#     -v gigatype-node-modules:/project/node_modules \
#     -v gigatype-electron-cache:/root/.cache/electron \
#     -v gigatype-builder-cache:/root/.cache/electron-builder \
#     node:24-bookworm bash -lc '
#       apt-get update -qq &&
#       apt-get install -y -qq --no-install-recommends \
#         build-essential pkg-config fakeroot dpkg-dev git \
#         libx11-dev libxtst-dev libglib2.0-dev libatspi2.0-dev &&
#       npm ci --ignore-scripts &&
#       scripts/build-linux-deb.sh --skip-model-download'
#
# Three details there are load-bearing:
#
#   gigatype-node-modules:/project/node_modules — keeps the container's Linux
#     install in a volume. Without it npm ci overwrites the node_modules of the
#     macOS checkout you mounted, and your next mac build packages Linux binaries.
#
#   npm ci --ignore-scripts — skips ffmpeg-static's postinstall, which fetches a
#     binary this app does not ship (resources/bin/ffmpeg is what it uses) and
#     often cannot reach GitHub. electron-builder rebuilds the native modules
#     that matter against Electron's ABI during the build anyway.
#
#   --platform linux/amd64 — only needed on Apple Silicon, and runs emulated.
#     Drop it to build an arm64 package natively.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_OS="$(uname -s)"

skip_deps=0
skip_model_download=0
arch=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) arch="${2:-}"; [[ -n "$arch" ]] || { echo "--arch needs a value" >&2; exit 1; }; shift 2 ;;
    --skip-deps) skip_deps=1; shift ;;
    --skip-model-download) skip_model_download=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

case "$HOST_OS" in
  Linux|Darwin) ;;
  *) die "unsupported host OS: $HOST_OS (build on Linux, or cross-build from macOS)" ;;
esac

# ---------- target arch -------------------------------------------------------
host_arch="$(uname -m)"
case "$host_arch" in
  x86_64) host_arch="x64" ;;
  aarch64|arm64) host_arch="arm64" ;;
  *) die "unsupported host architecture: $host_arch" ;;
esac
# A Mac's own arch says nothing about the Linux target; default to x64 there.
[[ -n "$arch" ]] || { [[ "$HOST_OS" == "Darwin" ]] && arch="x64" || arch="$host_arch"; }
case "$arch" in x64|arm64) ;; *) die "--arch must be x64 or arm64 (got '$arch')" ;; esac
echo "==> Target: linux-$arch (host: $HOST_OS/$host_arch)"

# ---------- toolchain ---------------------------------------------------------
command -v node >/dev/null || die "node is not on PATH"
command -v npm  >/dev/null || die "npm is not on PATH"
# The repo pins Node 24 (.nvmrc) for lockfile/CI parity, but packaging itself
# runs fine on older majors — warn rather than block a local cross-build.
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" -lt 24 ]]; then
  echo "  note: .nvmrc pins Node 24; building with $(node -v)."
  echo "        Fine for packaging — but only regenerate package-lock.json under Node 24 (CLAUDE.md)."
fi

cross=0
if [[ "$HOST_OS" == "Darwin" ]]; then
  cross=1
  # fpm picks up whatever `ar` is first on PATH; BSD ar silently produces a deb
  # that dpkg cannot read, so GNU ar has to win.
  for prefix in /opt/homebrew/opt/binutils /usr/local/opt/binutils; do
    if [[ -x "$prefix/bin/ar" ]]; then
      export PATH="$prefix/bin:$PATH"
      break
    fi
  done
  ar_path="$(command -v ar || true)"
  if [[ -z "$ar_path" ]] || ! "$ar_path" --version 2>/dev/null | grep -qi "GNU ar"; then
    die "GNU ar not found (BSD ar produces a deb dpkg rejects). Run: brew install binutils"
  fi
  command -v dpkg-deb >/dev/null || die "dpkg-deb not found. Run: brew install dpkg"
  echo "==> Cross-building from macOS (GNU ar: $ar_path)"
else
  command -v fakeroot >/dev/null || echo "  note: 'fakeroot' not found — electron-builder's deb target usually needs it"
  command -v dpkg-deb >/dev/null || echo "  note: 'dpkg-deb' not found — the package builds but cannot be inspected"
fi

# ---------- sidecars and models ----------------------------------------------
# `npm run build:linux:deb` does NOT run prebuild:linux — npm fires a pre-hook
# only for the exact script name, and the hook hangs off `build:linux`. That is
# the usual reason a hand-rolled deb ships without llama-server, Qdrant,
# sherpa-onnx or the VAD model.
if [[ $skip_deps -eq 1 ]]; then
  echo "==> Skipping dependency fetch (--skip-deps)"
elif [[ $cross -eq 1 ]]; then
  echo "==> Fetching linux-$arch sidecars"
  ( cd "$REPO_ROOT"
    npm run download:llama-server -- --platform linux --arch "$arch"
    npm run download:sherpa-onnx  -- --platform linux --arch "$arch"
    npm run download:qdrant       -- --platform linux --arch "$arch"
    npm run download:speech-vad-model
    npm run download:diarization-models -- --output-dir resources/bin/diarization-models )
else
  echo "==> Fetching sidecars and compiling native helpers (npm run prebuild:linux)"
  ( cd "$REPO_ROOT" && npm run prebuild:linux )
fi

# ---------- wired GigaAM model ------------------------------------------------
MODEL_DIR="$REPO_ROOT/resources/gigaam-model"
MODEL_FILES=(v3_e2e_rnnt_encoder.onnx v3_e2e_rnnt_decoder.onnx v3_e2e_rnnt_joint.onnx v3_e2e_rnnt_vocab.txt)
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

# A truncated encoder (interrupted download, git-lfs pointer) passes an
# existence check and then fails at load time with an opaque ONNX error.
if [[ "$HOST_OS" == "Darwin" ]]; then
  encoder_bytes="$(stat -f %z "$MODEL_DIR/v3_e2e_rnnt_encoder.onnx")"
else
  encoder_bytes="$(stat -c %s "$MODEL_DIR/v3_e2e_rnnt_encoder.onnx")"
fi
[[ "$encoder_bytes" -ge 800000000 ]] \
  || die "v3_e2e_rnnt_encoder.onnx is only $((encoder_bytes / 1000 / 1000)) MB — expected ~885 MB. Re-fetch it."
echo "==> Wired model OK ($((encoder_bytes / 1000 / 1000)) MB encoder + decoder/joint/vocab)"

# ---------- native node modules for the target --------------------------------
# Only needed when cross-building: on Linux, npm/electron-builder already have
# the right binaries.
STAGE="$REPO_ROOT/dist/.linux-native"
BS3_DIR="$REPO_ROOT/node_modules/better-sqlite3"
BS3_NODE="$BS3_DIR/build/Release/better_sqlite3.node"
BS3_BACKUP="$STAGE/better_sqlite3.node.host"
KEYRING_PKG=""

restore_host_natives() {
  if [[ -f "$BS3_BACKUP" ]]; then
    mv -f "$BS3_BACKUP" "$BS3_NODE"
    echo "==> Restored the host better-sqlite3 binary"
  fi
  # A Linux .node left in node_modules would be packaged into the next macOS
  # build, where it cannot be code-signed and breaks notarization.
  if [[ -n "$KEYRING_PKG" && -d "$KEYRING_PKG" ]]; then
    rm -rf "$KEYRING_PKG"
    echo "==> Removed the temporary Linux keyring package"
  fi
}

if [[ $cross -eq 1 ]]; then
  trap restore_host_natives EXIT
  mkdir -p "$STAGE"
  electron_version="$(node -p "require('$REPO_ROOT/node_modules/electron/package.json').version")"

  echo "==> Fetching linux-$arch better-sqlite3 for Electron $electron_version"
  # prebuild-install reads ./package.json and writes ./build/Release, so it has
  # to run inside a copy of the module dir rather than against the real one.
  rm -rf "$STAGE/better-sqlite3" && mkdir -p "$STAGE/better-sqlite3"
  cp "$BS3_DIR/package.json" "$STAGE/better-sqlite3/"
  ( cd "$STAGE/better-sqlite3" && node "$REPO_ROOT/node_modules/.bin/prebuild-install" \
      --runtime electron --target "$electron_version" --arch "$arch" --platform linux \
      --download --force ) \
    || die "no better-sqlite3 prebuild for electron $electron_version / linux-$arch"
  staged_bs3="$STAGE/better-sqlite3/build/Release/better_sqlite3.node"
  [[ -f "$staged_bs3" ]] || die "prebuild-install produced no better_sqlite3.node"
  file "$staged_bs3" | grep -q ELF || die "fetched better_sqlite3.node is not an ELF binary"

  cp "$BS3_NODE" "$BS3_BACKUP"
  cp "$staged_bs3" "$BS3_NODE"
  echo "    swapped in (host copy saved for restore)"

  echo "==> Fetching the linux-$arch @napi-rs/keyring platform package"
  keyring_name="@napi-rs/keyring-linux-${arch}-gnu"
  keyring_version="$(node -p "require('$REPO_ROOT/node_modules/@napi-rs/keyring/package.json').version")"
  KEYRING_PKG="$REPO_ROOT/node_modules/@napi-rs/keyring-linux-${arch}-gnu"
  if [[ -d "$KEYRING_PKG" ]]; then
    echo "    already present — leaving it in place"
    KEYRING_PKG=""   # not ours to delete
  else
    rm -rf "$STAGE/keyring" && mkdir -p "$STAGE/keyring"
    ( cd "$STAGE/keyring" && npm pack "${keyring_name}@${keyring_version}" >/dev/null ) \
      || die "could not fetch ${keyring_name}@${keyring_version}"
    tarball="$(ls "$STAGE/keyring"/*.tgz | head -1)"
    mkdir -p "$KEYRING_PKG"
    tar xzf "$tarball" -C "$KEYRING_PKG" --strip-components=1
    ls "$KEYRING_PKG"/*.node >/dev/null 2>&1 || die "${keyring_name} contains no .node binary"
    echo "    installed into node_modules (removed again after the build)"
  fi
fi

# ---------- Linux native helpers ----------------------------------------------
BIN="$REPO_ROOT/resources/bin"
missing_helpers=()
for b in linux-fast-paste linux-text-monitor linux-system-audio-helper "linux-key-listener-$arch"; do
  [[ -e "$BIN/$b" ]] || missing_helpers+=("$b")
done
if [[ ${#missing_helpers[@]} -gt 0 ]]; then
  if [[ $cross -eq 1 ]]; then
    echo "  note: not built on macOS — ${missing_helpers[*]}"
    echo "        paste falls back to xdotool/ydotool/wtype; push-to-talk falls back to tap mode."
  else
    die "missing native helpers: ${missing_helpers[*]} (drop --skip-deps, or run 'npm run compile:native')"
  fi
fi

# ---------- build -------------------------------------------------------------
echo "==> Building Type .deb for linux-$arch (wired GigaAM model)"
date

builder_args=(--linux deb --"$arch")
# electron-builder cannot rebuild native modules for Linux while running on
# macOS — we already staged the right binaries above.
[[ $cross -eq 1 ]] && builder_args+=(-c.npmRebuild=false)

# fpm refuses to build a deb without a maintainer, and package.json's author has
# no email. Take it from the local git identity so no address is committed to
# the repo; override with DEB_MAINTAINER for a release build.
maintainer="${DEB_MAINTAINER:-}"
if [[ -z "$maintainer" ]]; then
  git_name="$(git -C "$REPO_ROOT" config user.name 2>/dev/null || true)"
  git_mail="$(git -C "$REPO_ROOT" config user.email 2>/dev/null || true)"
  [[ -n "$git_name" && -n "$git_mail" ]] && maintainer="$git_name <$git_mail>"
fi
[[ -n "$maintainer" ]] || die "deb needs a maintainer: export DEB_MAINTAINER='Name <email>'"
echo "    maintainer: $maintainer"
builder_args+=(-c.deb.maintainer="$maintainer")

( cd "$REPO_ROOT" && npm run build:renderer )
( cd "$REPO_ROOT" && ./node_modules/.bin/electron-builder "${builder_args[@]}" )

# ---------- verify ------------------------------------------------------------
DIST="$REPO_ROOT/dist"
# electron-builder names deb artifacts with the Debian arch, not electron's.
case "$arch" in x64) deb_arch="amd64" ;; *) deb_arch="$arch" ;; esac
DEB="$(ls -t "$DIST"/*"$deb_arch".deb 2>/dev/null | head -1)"
[[ -n "$DEB" && -f "$DEB" ]] || die "no .deb produced under $DIST"

if command -v dpkg-deb >/dev/null; then
  echo
  echo "==> Package metadata"
  dpkg-deb --info "$DEB" | sed -n '/^ Package:/,/^ Description:/p'

  echo "==> Verifying package contents"
  contents="$(dpkg-deb --contents "$DEB")"
  for f in "${MODEL_FILES[@]}"; do
    grep -q "resources/gigaam-model/$f\$" <<<"$contents" \
      || die "$f is not in the package — check linux.extraResources in electron-builder.json"
  done
  echo "    all 4 GigaAM model files present"

  # A native module that failed to rebuild is simply absent rather than wrong,
  # which the ELF sweep below cannot catch — assert the load-bearing ones exist.
  for required in better_sqlite3.node onnxruntime_binding.node; do
    grep -q "/$required\$" <<<"$contents" \
      || die "$required is missing from the package — the native rebuild did not run"
  done
  echo "    better-sqlite3 and onnxruntime native modules present"

  # The whole point of the native-module swap: catch a Mach-O that slipped through.
  #
  # Two are tolerated on a macOS cross-build:
  #   usocket  — node-gyp only, no published prebuilds. It backs dbus-next, which
  #              gnomeShortcut.js/kdeShortcut.js already load inside try/catch, so
  #              GNOME/KDE Wayland global hotkeys fall back to X11/globalShortcut.
  #   @napi-rs/keyring-{darwin,win32}-* — the loader picks the platform package at
  #              runtime, so the foreign ones are inert weight.
  cross_tolerated=("usocket/build/Release/uwrap.node" "@napi-rs/keyring-darwin" "@napi-rs/keyring-win32")

  extract="$DIST/.deb-check"
  rm -rf "$extract" && mkdir -p "$extract"
  dpkg-deb --extract "$DEB" "$extract"
  bad=0
  while IFS= read -r node_bin; do
    file "$node_bin" | grep -q ELF && continue
    rel="${node_bin#"$extract"/}"
    tolerated=0
    for pat in "${cross_tolerated[@]}"; do
      [[ "$node_bin" == *"$pat"* ]] && tolerated=1
    done
    if [[ $cross -eq 1 && $tolerated -eq 1 ]]; then
      echo "  note: $rel is $(file -b "$node_bin" | cut -d, -f1) — cannot cross-build"
    else
      echo "error: $rel is not a Linux binary: $(file -b "$node_bin")" >&2
      bad=1
    fi
  done < <(find "$extract" -name "*.node" 2>/dev/null)
  [[ $bad -eq 0 ]] || { rm -rf "$extract"; die "the package contains non-Linux native modules"; }
  echo "    bundled .node binaries are Linux ELF (bar the tolerated ones noted above)"

  # afterPack's wrapLinuxBinary renames the real ELF to <name>-app and drops a
  # bash wrapper in its place (forces XWayland, reads a user flags file). Without
  # it the overlay mispositions itself on Wayland.
  wrapper="$(find "$extract"/opt/*/ -maxdepth 1 -name "*-app" 2>/dev/null | head -1)"
  if [[ -n "$wrapper" && -f "${wrapper%-app}" ]]; then
    echo "    launcher wrapper in place ($(basename "${wrapper%-app}"))"
  else
    echo "  note: afterPack's launcher wrapper is missing — Wayland overlay positioning may be off"
  fi
  rm -rf "$extract"
fi

# ---------- report ------------------------------------------------------------
echo
echo "==> Artifact:"
ls -lh "$DEB"
if command -v sha256sum >/dev/null; then sha256sum "$DEB"; else shasum -a 256 "$DEB"; fi
echo
echo "Install with:"
echo "  sudo apt install \"$(basename "$DEB")\"    # resolves ydotool and the recommends"
echo "  # or: sudo dpkg -i <deb> && sudo apt-get -f install"
if [[ $cross -eq 1 ]]; then
  echo
  echo "NOTE: cross-built on macOS, so resources/bin/linux-* helpers are absent."
  echo "      Fine for testing; build a release on a Linux host."
fi
