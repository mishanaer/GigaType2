#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_DIR="$ROOT_DIR/gigaam-sidecar"
OPENWHISPR_DIR="$ROOT_DIR/openwhispr"
BUILD_ROOT="$ROOT_DIR/.build/gigaam-sidecar-macos-arm64"
VENV_DIR="$BUILD_ROOT/.venv"
WORK_DIR="$BUILD_ROOT/work"
SPEC_DIR="$BUILD_ROOT/spec"
OUTPUT_DIR="$OPENWHISPR_DIR/resources/bin"
OUTPUT_BIN="$OUTPUT_DIR/gigatype-sidecar-darwin-arm64"
DEFAULT_PYTHON_BIN="$SIDECAR_DIR/.venv/bin/python"
if [[ -x "$DEFAULT_PYTHON_BIN" ]]; then
  PYTHON_BIN="${PYTHON_BIN:-$DEFAULT_PYTHON_BIN}"
else
  PYTHON_BIN="${PYTHON_BIN:-python3}"
fi
NODE_BIN="${NODE_BIN:-node}"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This script builds only on macOS arm64." >&2
  exit 1
fi

PYTHON_VERSION_OK="$("$PYTHON_BIN" -c 'import sys; print(int(sys.version_info >= (3, 10)))')"
if [[ "$PYTHON_VERSION_OK" != "1" ]]; then
  echo "Python >=3.10 is required. Set PYTHON_BIN to a newer interpreter." >&2
  "$PYTHON_BIN" --version >&2
  exit 1
fi

rm -rf "$BUILD_ROOT"
mkdir -p "$VENV_DIR" "$WORK_DIR" "$SPEC_DIR" "$OUTPUT_DIR"

"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip wheel setuptools
"$VENV_DIR/bin/python" -m pip install -r "$SIDECAR_DIR/requirements.txt" pyinstaller

"$VENV_DIR/bin/python" -m PyInstaller \
  --clean \
  --onefile \
  --name gigatype-sidecar-darwin-arm64 \
  --copy-metadata onnx-asr \
  --collect-data onnx_asr \
  --distpath "$OUTPUT_DIR" \
  --workpath "$WORK_DIR" \
  --specpath "$SPEC_DIR" \
  "$SIDECAR_DIR/gigatype_sidecar_entry.py"

chmod +x "$OUTPUT_BIN"

# Binary sources:
# - ffmpeg: npm dependency "ffmpeg-static" from openwhispr/package.json.
# - ffprobe: npm dependency "@ffprobe-installer/ffprobe" from openwhispr/package.json.
# Keep their upstream license notices when preparing wider distribution.
FFMPEG_SRC="$(cd "$OPENWHISPR_DIR" && "$NODE_BIN" -e 'process.stdout.write(require("ffmpeg-static"))')"
FFPROBE_SRC="$(cd "$OPENWHISPR_DIR" && "$NODE_BIN" -e 'process.stdout.write(require("@ffprobe-installer/ffprobe").path)')"

cp "$FFMPEG_SRC" "$OUTPUT_DIR/ffmpeg"
cp "$FFPROBE_SRC" "$OUTPUT_DIR/ffprobe"
chmod +x "$OUTPUT_DIR/ffmpeg" "$OUTPUT_DIR/ffprobe"

echo "Built $OUTPUT_BIN"
echo "Bundled $OUTPUT_DIR/ffmpeg"
echo "Bundled $OUTPUT_DIR/ffprobe"
