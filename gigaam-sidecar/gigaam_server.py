import os
from contextlib import asynccontextmanager
import json
import logging
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import onnx_asr
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse

MODEL_NAME = os.getenv("GIGAAM_MODEL", "gigaam-v3-e2e-rnnt")
MODEL_PROVIDERS = ["CPUExecutionProvider"]
FFMPEG_BIN = os.getenv("FFMPEG_BIN") or shutil.which("ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN") or shutil.which("ffprobe")

logger = logging.getLogger("uvicorn.error")

_model: Any | None = None
_model_load_started = False
_model_lock = threading.Lock()
_model_state: dict[str, str | None] = {
    "status": "loading",
    "detail": "model load has not started",
}


def _set_model_state(status: str, detail: str | None = None) -> None:
    with _model_lock:
        _model_state["status"] = status
        _model_state["detail"] = detail


def _health_payload() -> dict[str, str]:
    with _model_lock:
        status = str(_model_state["status"])
        detail = _model_state.get("detail")

    payload = {"status": status, "model": MODEL_NAME}
    if detail:
        payload["detail"] = detail
    return payload


def _load_model_worker() -> None:
    global _model

    started = time.perf_counter()
    _set_model_state("loading", "model is loading")
    logger.info(
        "model load start model=%s providers=%s",
        MODEL_NAME,
        ",".join(MODEL_PROVIDERS),
    )

    try:
        loaded_model = onnx_asr.load_model(MODEL_NAME, providers=MODEL_PROVIDERS)
    except Exception as exc:
        detail = f"{type(exc).__name__}: {exc}"
        _set_model_state("error", detail)
        logger.exception("model load error model=%s detail=%s", MODEL_NAME, detail)
        return

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    with _model_lock:
        _model = loaded_model
        _model_state["status"] = "ok"
        _model_state["detail"] = None
    logger.info("model load ok model=%s duration_ms=%s", MODEL_NAME, elapsed_ms)


def _ensure_model_loading_started() -> None:
    global _model_load_started

    with _model_lock:
        if _model_load_started:
            return
        _model_load_started = True

    thread = threading.Thread(target=_load_model_worker, name="gigaam-model-loader", daemon=True)
    thread.start()


def _get_ready_model() -> Any:
    with _model_lock:
        if _model_state["status"] == "ok" and _model is not None:
            return _model
        status = str(_model_state["status"])
        detail = _model_state.get("detail")

    logger.info("transcription rejected model_status=%s detail=%s", status, detail)
    raise HTTPException(
        status_code=503,
        detail={
            "status": status,
            "model": MODEL_NAME,
            "detail": detail or "model is not ready",
        },
    )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info(
        "startup model=%s providers=%s ffmpeg=%s ffprobe=%s",
        MODEL_NAME,
        ",".join(MODEL_PROVIDERS),
        FFMPEG_BIN or "<not found>",
        FFPROBE_BIN or "<not found>",
    )
    _ensure_model_loading_started()
    yield


app = FastAPI(title="Local GigaAM ASR", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1):\d+$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


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


def _is_wav_16k_mono(path: Path) -> bool:
    """Check WAV header: PCM, 1 channel, 16000 Hz, 16-bit — no external deps."""
    try:
        with open(path, "rb") as f:
            h = f.read(44)
        if len(h) < 44:
            return False
        if h[0:4] != b"RIFF" or h[8:12] != b"WAVE" or h[12:16] != b"fmt ":
            return False
        audio_fmt = int.from_bytes(h[20:22], "little")
        channels = int.from_bytes(h[22:24], "little")
        sample_rate = int.from_bytes(h[24:28], "little")
        bits = int.from_bytes(h[34:36], "little")
        return audio_fmt == 1 and channels == 1 and sample_rate == 16000 and bits == 16
    except Exception:
        return False


def _to_wav_16k_mono(src: Path, dst: Path) -> None:
    # Fast path: already 16 kHz mono PCM WAV — copy directly, no ffmpeg needed
    if src.suffix.lower() == ".wav" and _is_wav_16k_mono(src):
        shutil.copy2(str(src), str(dst))
        return

    if FFMPEG_BIN is None:
        raise RuntimeError("ffmpeg is not configured; set FFMPEG_BIN or install ffmpeg for development")

    cmd = [
        FFMPEG_BIN,
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
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def _probe_audio(path: Path) -> dict[str, str | None]:
    if FFPROBE_BIN is None:
        return {"error": "ffprobe is not configured; set FFPROBE_BIN or install ffprobe for development"}

    cmd = [
        FFPROBE_BIN,
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
    try:
        completed = subprocess.run(cmd, check=True, capture_output=True, text=True)
        data = json.loads(completed.stdout or "{}")
    except Exception as exc:
        return {"error": f"ffprobe failed: {exc}"}

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
    return _health_payload()


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
    ready_model = _get_ready_model()
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"

    with tempfile.TemporaryDirectory(prefix="gigaam-asr-") as tmpdir:
        raw_path = Path(tmpdir) / f"input{suffix}"
        wav_path = Path(tmpdir) / "input.16k.mono.wav"

        raw_bytes = await file.read()
        raw_path.write_bytes(raw_bytes)
        logger.info(
            "transcription request filename=%s content_type=%s suffix=%s bytes=%s model=%s response_format=%s",
            file.filename,
            file.content_type,
            suffix,
            len(raw_bytes),
            model_name,
            response_format,
        )

        try:
            input_probe = _probe_audio(raw_path)
            _to_wav_16k_mono(raw_path, wav_path)
            output_probe = _probe_audio(wav_path)
            logger.info("audio input=%s normalized=%s", input_probe, output_probe)
            result = ready_model.recognize(str(wav_path))
            text = _normalize_result(result)
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr.strip() if exc.stderr else str(exc)
            logger.warning("audio conversion failed detail=%s", detail)
            raise HTTPException(
                status_code=400,
                detail=f"Audio conversion failed: {detail}",
            ) from exc
        except Exception as exc:
            logger.exception("transcription failed")
            raise HTTPException(
                status_code=500,
                detail=f"GigaAM transcription failed: {exc}",
            ) from exc

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    logger.info("transcription ok duration_ms=%s text_chars=%s", elapsed_ms, len(text))

    if response_format == "text":
        return PlainTextResponse(text)

    return {
        "text": text,
        "model": MODEL_NAME,
        "duration_ms": elapsed_ms,
    }
