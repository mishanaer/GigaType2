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
