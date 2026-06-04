import os
import json
import logging
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import onnx_asr
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse

MODEL_NAME = os.getenv("GIGAAM_MODEL", "gigaam-v3-e2e-rnnt")

app = FastAPI(title="Local GigaAM ASR", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1):\d+$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)
logger = logging.getLogger("uvicorn.error")

# Load the model once at process startup. The first launch can download model
# files into the Hugging Face cache and may take several minutes.
model = onnx_asr.load_model(MODEL_NAME, providers=["CPUExecutionProvider"])


def _normalize_result(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result.strip()
    if isinstance(result, dict):
        value = result.get("text") or result.get("transcription") or ""
        return str(value).strip()
    if hasattr(result, "text"):
        return str(result.text).strip()
    return str(result).strip()


def _to_wav_16k_mono(src: Path, dst: Path) -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is not available in PATH")

    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        str(dst),
    ]
    subprocess.run(cmd, check=True)


def _probe_audio(path: Path) -> dict[str, str | None]:
    if shutil.which("ffprobe") is None:
        return {"error": "ffprobe is not available in PATH"}

    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "format=format_name,duration:stream=codec_name,sample_rate,channels",
        "-of",
        "json",
        str(path),
    ]
    completed = subprocess.run(cmd, check=True, capture_output=True, text=True)
    data = json.loads(completed.stdout or "{}")
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format") or {}
    return {
        "format": fmt.get("format_name"),
        "codec": stream.get("codec_name"),
        "sample_rate": stream.get("sample_rate"),
        "channels": str(stream.get("channels")) if stream.get("channels") is not None else None,
        "duration": fmt.get("duration"),
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL_NAME}


@app.get("/v1/models")
def list_models() -> dict[str, list[dict[str, str]]]:
    return {"data": [{"id": MODEL_NAME, "object": "model"}]}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_name: str = Form(MODEL_NAME, alias="model"),
    response_format: str = Form("json"),
    language: str | None = Form(None),
    prompt: str | None = Form(None),
    temperature: float | None = Form(None),
):
    """
    Minimal OpenAI-compatible audio transcription endpoint.

    Extra form fields are accepted so OpenAI-compatible clients do not get 422.
    language, prompt, temperature and model_name are accepted but not used.
    """
    _ = (model_name, language, prompt, temperature)
    started = time.perf_counter()
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"

    with tempfile.TemporaryDirectory(prefix="gigaam-asr-") as tmpdir:
        raw_path = Path(tmpdir) / f"input{suffix}"
        wav_path = Path(tmpdir) / "input.16k.mono.wav"

        raw_bytes = await file.read()
        raw_path.write_bytes(raw_bytes)
        logger.info(
            "transcription request filename=%s content_type=%s suffix=%s bytes=%s",
            file.filename,
            file.content_type,
            suffix,
            len(raw_bytes),
        )

        try:
            input_probe = _probe_audio(raw_path)
            _to_wav_16k_mono(raw_path, wav_path)
            output_probe = _probe_audio(wav_path)
            logger.info("audio input=%s normalized=%s", input_probe, output_probe)
            result = model.recognize(str(wav_path))
            text = _normalize_result(result)
        except subprocess.CalledProcessError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Audio conversion failed: {exc}",
            ) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"GigaAM transcription failed: {exc}",
            ) from exc

    elapsed_ms = int((time.perf_counter() - started) * 1000)

    if response_format == "text":
        return PlainTextResponse(text)

    return {
        "text": text,
        "model": MODEL_NAME,
        "duration_ms": elapsed_ms,
    }
