# GigaAM Sidecar

Local OpenAI-compatible ASR endpoint for GigaType MVP.

The server forces ONNX Runtime `CPUExecutionProvider`. On this macOS setup,
the default CoreML provider loads but fails during GigaAM RNN-T inference.
It also enables CORS for local `localhost` / `127.0.0.1` dev origins, because
GigaType's Electron renderer calls the endpoint from Vite.

## Setup

```bash
cd /Users/misha/Documents/GigaType2.0/gigaam-sidecar
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
python -m pip install -r requirements.txt
```

FFmpeg must be available in `PATH`:

```bash
ffmpeg -version
```

## Run

```bash
cd /Users/misha/Documents/GigaType2.0/gigaam-sidecar
source .venv/bin/activate
uvicorn gigaam_server:app --host 127.0.0.1 --port 8765
```

## Check

```bash
curl http://127.0.0.1:8765/health
```

GigaType Custom Endpoint settings:

- Base URL: `http://127.0.0.1:8765/v1`
- Model: `gigaam-v3-e2e-rnnt`
- API key: `local`
- Language: `ru`

Keep AI cleanup disabled for the first ASR test.

### Windows dev setup

Same steps, with the Windows venv layout:

```powershell
cd path\to\GigaType2\gigaam-sidecar
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -U pip
python -m pip install -r requirements.txt
uvicorn gigaam_server:app --host 127.0.0.1 --port 8765
```

`ffmpeg.exe` / `ffprobe.exe` must be on `PATH` for dev, or set the `FFMPEG_BIN`
/ `FFPROBE_BIN` environment variables to their full paths.

## Building the standalone executable

The Electron app bundles a PyInstaller onefile binary in
`openwhispr/resources/bin/` and starts it via `gigaamSidecarManager.js`. Build
it per host platform before running `electron-builder`:

- **macOS (arm64):** `scripts/build-gigaam-sidecar-macos-arm64.sh`
- **Windows (x64):** `scripts/build-gigaam-sidecar-windows-x64.ps1`
  (or `npm run build:gigaam-sidecar:win` from `openwhispr/`)

Each script creates an isolated venv, runs PyInstaller against the matching
`gigatype-sidecar-<platform>.spec`, and copies `ffmpeg`/`ffprobe` next to the
sidecar binary. Run `npm install` in `openwhispr/` first so the `ffmpeg-static`
and `@ffprobe-installer/ffprobe` binaries can be resolved.
