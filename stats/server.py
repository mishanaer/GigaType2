#!/usr/bin/env python3
"""Stats-модуль GigaType для хаба Traction (контракт: specs/stats-hub.md §4
в репо GigaTool; гайд — traction/ONBOARDING.md там же).

Контракт:
  GET  /            — дашборд (относительные URL: живём за strip_prefix /p/gigatype)
  GET  /health      — liveness + версия деплоя
  GET  /summary     — стандартное ядро (?days=N) + витринные metrics[] GigaType
  POST /events      — ingest со своим токеном
Своё:
  GET  /product     — value, funnel, retention, quality, release health (?days=N)
  GET  /timeseries  — дневные корзины для графиков дашборда (?days=N)

Схема событий (внутреннее дело модуля; device_id — в конверте батча):
  first_app_opened, app_opened, requirements_ready, model_ready,
  dictation_finished (любой outcome), типизированные error-события.
  Старые dictation/app_open/error поддерживаются как legacy-совместимость.

Запуск: STATS_PORT=9902 python3 server.py
Env:    STATS_PORT (default 9902), STATS_DB (default ./data/events.db),
        STATS_INGEST_TOKEN (пусто = ingest без токена, только для dev!),
        STATS_CACHE_TTL (default 90), STATS_REFRESH_TICK (default 15)
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import sqlite3
import threading
import time
import traceback
from collections import Counter, defaultdict, deque
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

from storage import connect, insert_events
from materialized import FactEvent, MaterializedStats

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("STATS_PORT", "9902"))
DB_PATH = Path(os.environ.get("STATS_DB", HERE / "data" / "events.db"))
METRICS_DB_PATH = Path(
    os.environ.get("STATS_METRICS_DB", DB_PATH.with_name("metrics.db"))
)
INGEST_TOKEN = os.environ.get("STATS_INGEST_TOKEN", "")
VERSION_FILE = HERE / "VERSION"
VERSION = VERSION_FILE.read_text().strip() if VERSION_FILE.exists() else "dev"
STATS_LOGIC_REVISION = f"{VERSION}:human-activity-v2"
REPORTING_TZ = ZoneInfo("Europe/Moscow")
SUMMARY_BATCH_CAPABILITY = "summary_batch_v1"
PERIOD_SNAPSHOT_CAPABILITY = "period_snapshot_v1"


@contextlib.asynccontextmanager
async def _lifespan(_app: FastAPI):
    _start_refresher()
    yield


app = FastAPI(lifespan=_lifespan)

_db = connect(DB_PATH, check_same_thread=False)
_db_lock = threading.RLock()
_materialized = MaterializedStats(METRICS_DB_PATH)
_materialized_ready = threading.Event()

# Ответы считаются НЕ в запросе. Хаб опрашивает /health + /summary?days=1/7/30
# раз в минуту с таймаутом 5 с, обсерверному прокси на /product отведено 15 с,
# а полный пересчёт продуктового пейлоада растёт вместе с историей (13.08.2026:
# 167k событий → холодные 6–11 с, все три окна в таймауте, карточка Тайпа
# замёрзла на пятичасовом снапшоте). Поэтому запрос всегда отдаёт последнее
# посчитанное значение, а пересчитывает фоновый поток. Цена — данные отстают не
# больше чем на CACHE_TTL_SECONDS; для витрины это незаметно, для таймаутов
# критично.
CACHE_TTL_SECONDS = float(os.environ.get("STATS_CACHE_TTL", "90"))
REFRESH_TICK_SECONDS = float(os.environ.get("STATS_REFRESH_TICK", "15"))
# Страховка на случай, если фоновый поток умер: настолько протухшее значение
# запрос пересчитывает сам, пусть и ценой таймаута у одного поллинга.
CACHE_HARD_LIMIT_SECONDS = 10 * CACHE_TTL_SECONDS
WARM_WINDOWS = (1.0, 3.0, 7.0, 30.0)
_cache: dict[str, tuple[float, object]] = {}
_cache_lock = threading.Lock()
_refresh_jobs: dict[str, tuple[object, float]] = {}
# Модуль живёт на общей с соседями квоте CPU: тяжёлые пересчёты идут по одному.
# RLock, а не Lock: сборка summary внутри себя строит снапшот событий и product.
_build_lock = threading.RLock()
_refresher: threading.Thread | None = None
SESSION_GAP_SECONDS = 5 * 60


def _cached(key: str, builder, ttl: float = CACHE_TTL_SECONDS):
    """Отдать последнее значение сразу, обновление оставить фону."""
    with _cache_lock:
        _refresh_jobs[key] = (builder, ttl)
        entry = _cache.get(key)
    if entry is not None and time.monotonic() - entry[0] < CACHE_HARD_LIMIT_SECONDS:
        return entry[1]
    return _build(key, builder)


def _build(key: str, builder):
    with _build_lock:
        with _cache_lock:
            entry = _cache.get(key)
        # Пока мы стояли в очереди, значение мог посчитать сосед по локу.
        if entry is not None and time.monotonic() - entry[0] < REFRESH_TICK_SECONDS:
            return entry[1]
        value = builder()
        with _cache_lock:
            _cache[key] = (time.monotonic(), value)
        return value


# Порядок обхода: сначала то, на чём стоят остальные ключи. Иначе summary
# пересобирается на ещё не обновлённом product и витрина отстаёт на два TTL.
_REFRESH_ORDER = ("events", "retention", "product:", "summary:", "timeseries:")


def _refresh_rank(key: str) -> int:
    for rank, prefix in enumerate(_REFRESH_ORDER):
        if key == prefix or key.startswith(prefix):
            return rank
    return len(_REFRESH_ORDER)


def _refresh_due() -> None:
    with _cache_lock:
        jobs = sorted(_refresh_jobs.items(), key=lambda job: _refresh_rank(job[0]))
        ages = {key: entry[0] for key, entry in _cache.items()}
    now = time.monotonic()
    for key, (builder, ttl) in jobs:
        stamp = ages.get(key)
        if stamp is not None and now - stamp < ttl:
            continue
        try:
            _build(key, builder)
        except Exception:  # noqa: BLE001 — один битый ключ не роняет прогрев
            traceback.print_exc()


def _warm() -> None:
    """Warm only the lightweight hub contract.

    Product and timeseries payloads are intentionally lazy.  Both decode
    product-specific event properties and their cost grows with the selected
    history; eagerly building every window made a restart compete with the
    materialized catch-up for the unit's memory limit.
    """
    for days in WARM_WINDOWS:
        summary(days)


def _refresh_loop() -> None:
    try:
        _ensure_materialized()
        _warm()
    except Exception:  # noqa: BLE001
        traceback.print_exc()
    while True:
        time.sleep(REFRESH_TICK_SECONDS)
        try:
            if _materialized_ready.is_set() and _materialized.telemetry()["dirty_dates"]:
                _materialized.refresh(code_revision=STATS_LOGIC_REVISION)
            _refresh_due()
        except Exception:  # noqa: BLE001
            traceback.print_exc()


def _start_refresher() -> None:
    global _refresher
    if _refresher is not None and _refresher.is_alive():
        return
    _refresher = threading.Thread(
        target=_refresh_loop, name="stats-refresher", daemon=True
    )
    _refresher.start()


def _ensure_materialized() -> None:
    """Backfill a new logic revision, otherwise resume the existing journal.

    Raw ingest may advance while the service is restarting.  A row-count
    mismatch therefore means "catch up", not "delete and rebuild".  Replaying
    the source is idempotent because ``stats_processed_events.event_id`` is the
    deduplication key, and batching keeps memory bounded.
    """
    try:
        with _db_lock:
            raw_count, raw_watermark = _db.execute(
                "SELECT COUNT(*),MAX(ts) FROM events"
            ).fetchone()
        telemetry = _materialized.telemetry()
        derived_count = int(telemetry.get("processed_events") or 0)
        derived = telemetry.get("source_watermark")
        last_revision = (telemetry.get("last_run") or {}).get("code_revision")
        derived_ts = datetime.fromisoformat(derived).timestamp() if derived else None
        if last_revision != STATS_LOGIC_REVISION:
            _materialized.rebuild(
                _materialized_events(),
                error_names=frozenset(ERROR_EVENTS),
                code_revision=STATS_LOGIC_REVISION,
            )
        elif int(raw_count) != derived_count or (
            raw_watermark is not None and
            (derived_ts is None or derived_ts + 1 <= float(raw_watermark))
        ):
            batch: list[FactEvent] = []
            for fact in _materialized_events(_iter_unmaterialized_events()):
                batch.append(fact)
                if len(batch) >= 5000:
                    _materialized.record_events(
                        batch, error_names=frozenset(ERROR_EVENTS)
                    )
                    batch.clear()
            if batch:
                _materialized.record_events(
                    batch, error_names=frozenset(ERROR_EVENTS)
                )
            _materialized.refresh(
                kind="catchup", code_revision=STATS_LOGIC_REVISION
            )
        elif derived is None:
            _materialized.refresh(
                kind="bootstrap", code_revision=STATS_LOGIC_REVISION
            )
        _materialized_ready.set()
    except Exception:  # noqa: BLE001 — legacy summary remains available
        traceback.print_exc()


def _reset_caches() -> None:
    with _cache_lock:
        _cache.clear()
        _refresh_jobs.clear()


RATE_WINDOW_SECONDS = 60.0
RATE_LIMIT_PER_IP = 600
RATE_LIMIT_PER_DEVICE = 12
_rate_buckets: dict[str, deque[float]] = {}
_rate_lock = threading.Lock()

ERROR_EVENTS = {
    "error",
    "error_occurred",
    "main_process_error",
    "renderer_process_gone",
    "app_crashed",
}

# Canonical product activity requires a person to use Type. ``app_opened`` is
# deliberately excluded: packaged builds enable hidden OS login startup, so a
# launch event alone proves that the process ran, not that the person used it.
HUMAN_EVENT_NAMES: tuple[str, ...] = (
    "first_app_opened", "dictation", "dictation_finished",
)
APP_RUNNING_EVENT_NAMES = frozenset((*HUMAN_EVENT_NAMES, "app_open", "app_opened"))

COMMON_INGEST_PROPERTIES = {
    "event_id",
    "contract_version",
    "app_version",
    "app_channel",
    "platform",
    "platform_name",
    "arch",
}
# Shared by dictation_output_attempted / _succeeded (identical payload).
_DICTATION_OUTPUT_PROPERTIES = {
    "session_id",
    "activation_mode",
    "trigger",
    "provider",
    "model",
    "audio_duration_ms",
    "raw_transcript_chars",
    "raw_transcript_words",
    "final_output_chars",
    "final_output_words",
    "output_method",
    "output_status",
    "output_latency_ms",
    "total_latency_ms",
    "transcription_latency_ms",
    "success",
    "status",
    "output_attempted",
}
DIRECT_EVENT_PROPERTIES = {
    "first_app_opened": set(),
    "app_opened": set(),
    "requirements_ready": {
        "microphone_ready",
        "macos_accessibility_ready",
        "windows_paste_tool_ready",
        "linux_paste_tool_ready",
    },
    "model_ready": {"source", "model", "provider"},
    "model_download": {"source", "model", "status", "bytes", "duration_ms", "error_code"},
    "onboarding_step": {"step"},
    "onboarding_completed": {"agent_named", "language"},
    # Permission funnel (mirror of the client mapper). Was emitted but dropped.
    "permission_result": {"permission", "status", "os_status", "trigger"},
    "requirement_status_changed": {
        "requirement",
        "ready",
        "permission_type",
        "microphone_ready",
        "macos_accessibility_ready",
        "windows_paste_tool_ready",
        "linux_paste_tool_ready",
    },
    "all_required_permissions_granted": {
        "permission_type",
        "microphone_ready",
        "macos_accessibility_ready",
        "windows_paste_tool_ready",
        "linux_paste_tool_ready",
    },
    # Dictation sub-funnel (started → audio → transcribed → output).
    "dictation_started": {"session_id", "activation_mode", "trigger"},
    "dictation_audio_captured": {
        "session_id",
        "activation_mode",
        "trigger",
        "audio_duration_ms",
        "status",
    },
    "dictation_transcribed": {
        "session_id",
        "activation_mode",
        "trigger",
        "provider",
        "model",
        "audio_duration_ms",
        "raw_transcript_chars",
        "raw_transcript_words",
        "transcription_latency_ms",
        "total_latency_ms",
        "status",
        "transcribed",
        "error_code",
    },
    "dictation_output_attempted": _DICTATION_OUTPUT_PROPERTIES,
    "dictation_output_succeeded": _DICTATION_OUTPUT_PROPERTIES,
    "dictation_finished": {
        "session_id",
        "activation_mode",
        "trigger",
        "provider",
        "model",
        "audio_duration_ms",
        "raw_transcript_chars",
        "raw_transcript_words",
        "final_output_chars",
        "final_output_words",
        "output_method",
        "output_status",
        "success",
        "outcome",
        "total_latency_ms",
        "transcription_latency_ms",
        "output_latency_ms",
        "error_area",
        "error_code",
        "reason",
    },
    "error_occurred": {"session_id", "error_area", "error_code", "reason"},
    "main_process_error": {"error_area", "error_code", "reason"},
    "renderer_process_gone": {"error_area", "error_code", "reason", "exit_code"},
    "app_crashed": {"error_area", "error_code", "reason", "exit_code"},
}


@app.get("/health")
def health() -> dict:
    capabilities = [SUMMARY_BATCH_CAPABILITY]
    if _materialized_ready.is_set():
        capabilities.append(PERIOD_SNAPSHOT_CAPABILITY)
    return {
        "ok": True,
        "version": VERSION,
        "ingest_enabled": True,
        "ingest_authenticated": bool(INGEST_TOKEN),
        "contract_version": 2,
        "capabilities": capabilities,
        "stats": _materialized.telemetry(),
    }


def _safe_direct_properties(event_name: str, raw) -> dict:
    if not isinstance(raw, dict):
        return {}
    allowed = COMMON_INGEST_PROPERTIES | DIRECT_EVENT_PROPERTIES[event_name]
    result = {}
    for key, value in raw.items():
        if key not in allowed or value is None:
            continue
        if isinstance(value, bool):
            result[key] = value
        elif isinstance(value, (int, float)) and math.isfinite(value):
            result[key] = value
        elif isinstance(value, str):
            result[key] = value[:500]
    return result


def _within_rate_limit(scope: str, value: str, limit: int) -> bool:
    """Bound receiver abuse without persisting raw IP/device identifiers."""
    digest = hashlib.sha256(f"{scope}:{value}".encode()).hexdigest()
    now = time.monotonic()
    cutoff = now - RATE_WINDOW_SECONDS
    with _rate_lock:
        if len(_rate_buckets) > 10_000:
            for key in list(_rate_buckets):
                bucket = _rate_buckets[key]
                while bucket and bucket[0] <= cutoff:
                    bucket.popleft()
                if not bucket:
                    _rate_buckets.pop(key, None)
        bucket = _rate_buckets.setdefault(digest, deque())
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= limit:
            return False
        bucket.append(now)
        return True


@app.post("/events")
async def ingest(request: Request) -> JSONResponse:
    if INGEST_TOKEN and request.headers.get("x-ingest-token") != INGEST_TOKEN:
        return JSONResponse({"error": "bad token"}, status_code=401)
    try:
        body = json.loads(await request.body())
    except json.JSONDecodeError as e:
        return JSONResponse({"error": f"bad json: {e}"}, status_code=400)
    events = body.get("events", [body]) if isinstance(body, dict) else body
    if not isinstance(events, list) or len(events) > 500:
        return JSONResponse({"error": "expected ≤500 events"}, status_code=400)
    device = body.get("device_id") if isinstance(body, dict) else None
    client = getattr(request, "client", None)
    client_host = getattr(client, "host", "unknown")
    if not _within_rate_limit("ip", str(client_host), RATE_LIMIT_PER_IP):
        return JSONResponse({"error": "rate limit"}, status_code=429)
    if isinstance(device, str) and device and not _within_rate_limit(
        "device", device, RATE_LIMIT_PER_DEVICE
    ):
        return JSONResponse({"error": "rate limit"}, status_code=429)
    now = time.time()
    headers = getattr(request, "headers", {})
    ingest_source = (
        "posthog"
        if headers.get("x-stats-source", "").strip().lower() == "posthog"
        else "direct"
    )
    rows = []
    rejected = 0
    for ev in events:
        if not isinstance(ev, dict) or ev.get("name") not in DIRECT_EVENT_PROPERTIES:
            rejected += 1
            continue
        event_name = ev["name"]
        event_device = ev.get("device_id") or device
        properties = _safe_direct_properties(event_name, ev.get("properties"))
        event_id = ev.get("event_id") or properties.get("event_id")
        if not isinstance(event_device, str) or not event_device.strip():
            rejected += 1
            continue
        if not isinstance(event_id, str) or not event_id.strip():
            rejected += 1
            continue
        try:
            timestamp = float(ev.get("ts") or now)
        except (TypeError, ValueError):
            rejected += 1
            continue
        # NaN/inf or a far-future timestamp must not poison every time window.
        if not math.isfinite(timestamp) or not (0 < timestamp < now + 86400):
            timestamp = now
        properties["event_id"] = event_id
        rows.append(
            {
                "ts": timestamp,
                "device_id": event_device,
                "name": event_name,
                "properties": properties,
                "event_id": event_id,
                "received_at": now,
                "ingest_source": ingest_source,
            }
        )
    with _db_lock:
        inserted = insert_events(_db, rows)
    if rows and _materialized_ready.is_set():
        _materialized.record_events(
            [
                FactEvent(
                    row["ts"], row.get("device_id") or "", row["name"],
                    row.get("event_id") or "", True,
                    _is_human_activity(row), _is_human_activity(row),
                )
                for row in rows
            ],
            error_names=frozenset(ERROR_EVENTS),
        )
    # Инвалидации здесь намеренно нет. Пока она была, каждая пачка событий
    # обнуляла кэши, а при нынешнем потоке (DAU ~800) это значит «кэша нет
    # вообще»: любой опрос хаба считал витрину с нуля и ловил таймаут.
    # Свежесть даёт фоновый пересчёт раз в CACHE_TTL_SECONDS.
    return JSONResponse(
        {
            "ok": True,
            "accepted": len(rows),
            "ingested": inserted,
            "duplicates": len(rows) - inserted,
            "rejected": rejected,
        }
    )


def _window(days: float, now: float | None = None) -> tuple[float, float]:
    """Return N Moscow calendar dates, including the current date.

    ``days=1`` starts at 00:00 MSK today instead of an arbitrary trailing
    24-hour boundary. Larger windows start at 00:00 MSK N-1 dates ago.
    """
    window_days = max(1, min(int(math.ceil(float(days))), 365))
    current = datetime.fromtimestamp(time.time() if now is None else now, REPORTING_TZ)
    start_date = current.date() - timedelta(days=window_days - 1)
    start = datetime.combine(start_date, datetime.min.time(), REPORTING_TZ)
    return float(window_days), start.timestamp()


def _overview_period_starts(now: float) -> dict[str, float]:
    """Canonical Traction periods in the shared Europe/Moscow timezone."""
    current = datetime.fromtimestamp(now, REPORTING_TZ)
    day_start = current.replace(hour=0, minute=0, second=0, microsecond=0)
    return {
        "dau": day_start.timestamp(),
        # Traction fleet decision 2026-08-17: WAU is rolling too — the
        # last 7 Moscow dates. Week-to-date collapsed onto DAU every
        # Monday morning, exactly like month-to-date MAU before 01.08.
        "wau": (day_start - timedelta(days=6)).timestamp(),
        "mau": (day_start - timedelta(days=29)).timestamp(),
    }


def _num(v) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v) if math.isfinite(v) else None


def _query_events(since: float | None = None, until: float | None = None) -> list[dict]:
    clauses, params = [], []
    if since is not None:
        clauses.append("ts >= ?")
        params.append(since)
    if until is not None:
        clauses.append("ts <= ?")
        params.append(until)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    with _db_lock:
        rows = list(
            _db.execute(
                "SELECT ts, device_id, name, properties, event_id, "
                "received_at, ingest_source FROM events"
                + where
                + " ORDER BY ts",
                params,
            )
        )
    events = []
    for ts, device, name, raw_properties, event_id, received_at, ingest_source in rows:
        try:
            properties = json.loads(raw_properties or "{}")
        except json.JSONDecodeError:
            properties = {}
        events.append(
            {
                "ts": float(ts),
                "device_id": device or "",
                "name": name,
                "properties": properties if isinstance(properties, dict) else {},
                "event_id": event_id or "",
                "received_at": float(received_at or 0),
                "ingest_source": ingest_source or "unknown",
            }
        )
    return events


def _iter_events(since: float | None = None, until: float | None = None,
                 batch: int = 5000):
    """Stream events in rowid order without materializing the window.

    Keyset pagination keeps each locked read short (ingest is not starved) and
    bounds memory to one batch; callers must not rely on ts ordering.
    """
    last_rowid = 0
    while True:
        clauses, params = ["rowid > ?"], [last_rowid]
        if since is not None:
            clauses.append("ts >= ?")
            params.append(since)
        if until is not None:
            clauses.append("ts <= ?")
            params.append(until)
        params.append(batch)
        with _db_lock:
            rows = list(_db.execute(
                "SELECT rowid, ts, device_id, name, properties, event_id, "
                "received_at, ingest_source "
                "FROM events WHERE " + " AND ".join(clauses)
                + " ORDER BY rowid LIMIT ?",
                params,
            ))
        if not rows:
            return
        for (
            rowid, ts, device, name, raw_properties, event_id,
            received_at, ingest_source,
        ) in rows:
            last_rowid = rowid
            try:
                properties = json.loads(raw_properties or "{}")
            except json.JSONDecodeError:
                properties = {}
            yield {
                "ts": float(ts),
                "device_id": device or "",
                "name": name,
                "properties": properties if isinstance(properties, dict) else {},
                "event_id": event_id or "",
                "received_at": float(received_at or 0),
                "ingest_source": ingest_source or "unknown",
            }


def _iter_unmaterialized_events(batch: int = 5000):
    """Stream only raw rows absent from the durable processed-event journal."""
    last_rowid = 0
    while True:
        # Close the attached read transaction before yielding a page.  Keeping
        # it open while MaterializedStats writes would pin the metrics WAL and
        # turn a small catch-up into gigabytes of checkpoint I/O.
        connection = sqlite3.connect(
            f"file:{DB_PATH}?mode=ro", uri=True, timeout=30
        )
        try:
            connection.execute(
                "ATTACH DATABASE ? AS materialized",
                (f"file:{METRICS_DB_PATH}?mode=ro",),
            )
            rows = connection.execute(
                "SELECT e.rowid,e.ts,e.device_id,e.name,e.properties,e.event_id,"
                "e.received_at,e.ingest_source FROM events AS e "
                "WHERE e.rowid>? AND NOT EXISTS (SELECT 1 FROM "
                "materialized.stats_processed_events AS p "
                "WHERE p.event_id=e.event_id) ORDER BY e.rowid LIMIT ?",
                (last_rowid, batch),
            ).fetchall()
        finally:
            connection.close()
        if not rows:
            return
        for (
            rowid, ts, device, name, raw_properties, event_id,
            received_at, ingest_source,
        ) in rows:
            last_rowid = rowid
            try:
                properties = json.loads(raw_properties or "{}")
            except json.JSONDecodeError:
                properties = {}
            yield {
                "ts": float(ts),
                "device_id": device or "",
                "name": name,
                "properties": properties if isinstance(properties, dict) else {},
                "event_id": event_id or "",
                "received_at": float(received_at or 0),
                "ingest_source": ingest_source or "unknown",
            }


def _read_events(since: float | None = None, until: float | None = None) -> list[dict]:
    """Read events, sharing one parsed all-history snapshot across 1/7/30.

    Windowed reads stay uncached at this level (их кэширует вызывающий).
    Product calculations filter the immutable list in memory and may lag new
    ingest by at most CACHE_TTL_SECONDS.
    """
    if since is not None or until is None:
        return _query_events(since, until)
    return _cached("events", lambda: _query_events(until=until))


def _dictation_record(event: dict) -> dict | None:
    properties = event["properties"]
    if event["name"] == "dictation":
        duration_s = _num(properties.get("duration_s"))
        outcome = str(properties.get("outcome") or "succeeded")
        has_denominator = isinstance(properties.get("ok"), bool)
        eligible = outcome not in {"cancelled", "too_short"} and (
            duration_s is None or duration_s >= 1
        )
        return {
            **event,
            "legacy": True,
            "denominator_ready": has_denominator,
            "legacy_success_only": not has_denominator,
            "duration_ms": duration_s * 1000 if duration_s is not None else None,
            "eligible": eligible,
            "success": eligible and (properties.get("ok") if has_denominator else True),
            "words": _num(properties.get("words")) or 0,
            "chars": _num(properties.get("chars")) or 0,
            "latency_ms": None,
            "outcome": outcome,
        }
    if event["name"] != "dictation_finished":
        return None
    duration_ms = _num(properties.get("audio_duration_ms"))
    outcome = str(properties.get("outcome") or "unknown")
    eligible = outcome != "too_short" and (duration_ms is None or duration_ms >= 1000)
    success = eligible and outcome == "succeeded"
    return {
        **event,
        "legacy": False,
        "denominator_ready": True,
        "legacy_success_only": False,
        "duration_ms": duration_ms,
        "eligible": eligible,
        "success": success,
        "words": (
            _num(properties.get("final_output_words"))
            if _num(properties.get("final_output_words")) is not None
            else _num(properties.get("raw_transcript_words")) or 0
        ),
        "chars": (
            _num(properties.get("final_output_chars"))
            if _num(properties.get("final_output_chars")) is not None
            else _num(properties.get("raw_transcript_chars")) or 0
        ),
        "latency_ms": _num(properties.get("total_latency_ms")),
        "outcome": outcome,
    }


def _dedupe_legacy_dictations(records: list[dict]) -> list[dict]:
    """Hide old success-only Traction rows when a PostHog canonical copy exists.

    The first deployed mapper had no event_id or session_id. A narrow
    device/time/word match prevents a historical backfill from double counting
    those rows while leaving the raw database reversible.
    """
    canonical = defaultdict(list)
    for record in records:
        if not record["legacy"]:
            canonical[record["device_id"]].append(record)
    output = []
    for record in records:
        if record["legacy"] and any(
            candidate["success"]
            and abs(candidate["ts"] - record["ts"]) <= 10
            and int(candidate["words"]) == int(record["words"])
            for candidate in canonical.get(record["device_id"], [])
        ):
            continue
        output.append(record)
    return output


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _day(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, REPORTING_TZ).strftime("%Y-%m-%d")


def _is_first_open(event: dict) -> bool:
    return event["name"] == "first_app_opened" or (
        event["name"] == "app_open" and event["properties"].get("first") is True
    )


def _is_human_activity(event: dict) -> bool:
    return _is_first_open(event) or event["name"] in {
        "dictation", "dictation_finished",
    }


def _is_app_running_activity(event: dict) -> bool:
    return _is_human_activity(event) or event["name"] in {
        "app_open", "app_opened",
    }


def _materialized_events(events=None):
    for event in _iter_events() if events is None else events:
        active = _is_human_activity(event)
        yield FactEvent(
            event["ts"], event["device_id"], event["name"], event["event_id"],
            True, active, active,
        )


def _event_version(event: dict) -> str:
    return str(event["properties"].get("app_version") or "unknown")


def _retention(successes: list[dict], since: float, now: float, days: int) -> dict:
    by_device = defaultdict(list)
    for record in successes:
        if record["device_id"]:
            by_device[record["device_id"]].append(record["ts"])
    matured, returned = 0, 0
    for timestamps in by_device.values():
        first = min(timestamps)
        if first < since or first > now - days * 86400:
            continue
        matured += 1
        first_day = _day(first)
        if any(first < ts <= first + days * 86400 and _day(ts) != first_day for ts in timestamps):
            returned += 1
    return {
        "days": days,
        "cohort": matured,
        "returned": returned,
        "rate": returned / matured if matured else None,
    }


def _compute_product_payload(days: float, now: float) -> dict:
    window_days, since = _window(days, now)
    all_events = _read_events(until=now)
    window_events = [event for event in all_events if event["ts"] >= since]
    records = _dedupe_legacy_dictations(
        [record for event in all_events if (record := _dictation_record(event)) is not None]
    )
    window_records = [record for record in records if record["ts"] >= since]
    successes = [record for record in records if record["success"]]
    window_successes = [record for record in window_records if record["success"]]
    human_events = [event for event in all_events if _is_human_activity(event)]
    window_human_events = [event for event in human_events if event["ts"] >= since]
    seen_devices = {event["device_id"] for event in all_events if event["device_id"]}
    all_devices = {event["device_id"] for event in human_events if event["device_id"]}
    overview_starts = _overview_period_starts(now)
    active_by_period = {
        period: {
            event["device_id"]
            for event in human_events
            if event["device_id"] and event["ts"] >= period_start
        }
        for period, period_start in overview_starts.items()
    }
    app_running_by_period = {
        period: {
            event["device_id"]
            for event in all_events
            if event["device_id"]
            and event["ts"] >= period_start
            and _is_app_running_activity(event)
        }
        for period, period_start in overview_starts.items()
    }
    dau = len(active_by_period["dau"])
    successful_dictations_today = sum(
        record["ts"] >= overview_starts["dau"] for record in successes
    )
    # Fleet decision (Tsevdn, 07.08.2026): a session ends after 5 minutes of
    # user inactivity — the same timeout across every product. Tools stay
    # defined as successful dictations, so the two cards now diverge.
    day_events = sorted(
        (event["device_id"], event["ts"])
        for event in human_events
        if event["device_id"] and event["ts"] >= overview_starts["dau"]
    )
    sessions_today = 0
    previous_device, previous_ts = None, 0.0
    for device, ts in day_events:
        if device != previous_device or ts - previous_ts > SESSION_GAP_SECONDS:
            sessions_today += 1
        previous_device, previous_ts = device, ts
    sessions_per_dau = sessions_today / dau if dau else None
    tools_per_dau = successful_dictations_today / dau if dau else None
    quality_eligible = [
        record for record in window_records if record["denominator_ready"] and record["eligible"]
    ]
    quality_successes = [record for record in quality_eligible if record["success"]]
    active_devices = {
        event["device_id"] for event in window_human_events if event["device_id"]
    }
    app_running_devices = {
        event["device_id"] for event in window_events
        if event["device_id"] and _is_app_running_activity(event)
    }
    active_dictators = {record["device_id"] for record in window_successes if record["device_id"]}
    success_days = defaultdict(set)
    for record in window_successes:
        if record["device_id"]:
            success_days[record["device_id"]].add(_day(record["ts"]))

    first_opens = {}
    for event in all_events:
        if event["device_id"] and _is_first_open(event):
            first_opens.setdefault(event["device_id"], event["ts"])
    cohort = {
        device: first for device, first in first_opens.items() if since <= first <= now
    }
    event_times = defaultdict(lambda: defaultdict(list))
    for event in all_events:
        if event["device_id"]:
            event_times[event["device_id"]][event["name"]].append(event["ts"])
    success_times = defaultdict(list)
    for record in successes:
        if record["device_id"]:
            success_times[record["device_id"]].append(record["ts"])

    def reached(device: str, names: tuple[str, ...]) -> bool:
        first = cohort[device]
        return any(ts >= first for name in names for ts in event_times[device].get(name, []))

    mature_activation = {
        device: first for device, first in cohort.items() if first <= now - 7 * 86400
    }
    activated = sum(
        any(first <= ts <= first + 7 * 86400 for ts in success_times[device])
        for device, first in mature_activation.items()
    )

    errors = [event for event in window_events if event["name"] in ERROR_EVENTS]
    signatures = Counter(
        f"{event['properties'].get('error_area') or event['properties'].get('context') or event['name']}:"
        f"{event['properties'].get('error_code') or event['properties'].get('code') or 'UNKNOWN'}"
        for event in errors
    )
    known_outputs = [
        record for record in quality_successes if record["properties"].get("output_status")
    ]
    latencies = [record["latency_ms"] for record in window_successes if record["latency_ms"] is not None]

    versions = defaultdict(lambda: {"devices": set(), "attempts": 0, "successes": 0, "errors": 0})
    for event in window_events:
        if event["device_id"]:
            versions[_event_version(event)]["devices"].add(event["device_id"])
        if event["name"] in ERROR_EVENTS:
            versions[_event_version(event)]["errors"] += 1
    for record in quality_eligible:
        row = versions[_event_version(record)]
        row["attempts"] += 1
        row["successes"] += int(record["success"])
    release_health = [
        {
            "version": version,
            "devices": len(row["devices"]),
            "attempts": row["attempts"],
            "success_rate": row["successes"] / row["attempts"] if row["attempts"] else None,
            "errors": row["errors"],
        }
        for version, row in sorted(versions.items(), key=lambda item: len(item[1]["devices"]), reverse=True)
    ]

    # Permission funnel: how many prompts resolved which way (mic / accessibility).
    permission_results = Counter(
        (event["properties"].get("permission"), event["properties"].get("status"))
        for event in window_events
        if event["name"] == "permission_result"
        and event["properties"].get("permission")
        and event["properties"].get("status")
    )
    # Dictation sub-funnel: stage counts expose where dictations drop off.
    dictation_stages = ("dictation_started", "dictation_audio_captured",
                        "dictation_transcribed", "dictation_output_succeeded")
    dictation_stage_counts = Counter(
        event["name"] for event in window_events if event["name"] in dictation_stages
    )

    canonical_finishes = [record for record in window_records if not record["legacy"]]
    return {
        "updated_at": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"),
        "window_days": window_days,
        "installs": len(all_devices),
        "telemetry_seen_devices": len(seen_devices),
        "overview": {
            "ever_used": len(all_devices),
            "dau": dau,
            "wau": len(active_by_period["wau"]),
            "mau": len(active_by_period["mau"]),
            "sessions_per_dau": sessions_per_dau,
            "tools_per_dau": tools_per_dau,
        },
        "app_running_overview": {
            period: len(devices) for period, devices in app_running_by_period.items()
        },
        "startup_only_today": len(
            app_running_by_period["dau"] - active_by_period["dau"]
        ),
        "active_devices": len(active_devices),
        "app_running_devices": len(app_running_devices),
        "startup_only_devices": len(app_running_devices - active_devices),
        "active_dictators": len(active_dictators),
        "repeat_dictators": sum(len(days_used) >= 2 for days_used in success_days.values()),
        "successful_dictations": len(window_successes),
        "words_delivered": int(sum(record["words"] for record in window_successes)),
        "audio_hours": sum((record["duration_ms"] or 0) for record in window_successes) / 3_600_000,
        "dictations_per_active_dictator": (
            len(window_successes) / len(active_dictators) if active_dictators else None
        ),
        "funnel": {
            "cohort": len(cohort),
            "first_opened": len(cohort),
            "permission_asked": sum(
                reached(device, ("permission_result", "requirement_status_changed"))
                for device in cohort
            ),
            "permissions_granted": sum(
                reached(device, ("all_required_permissions_granted",)) for device in cohort
            ),
            "requirements_ready": sum(reached(device, ("requirements_ready",)) for device in cohort),
            "model_ready": sum(reached(device, ("model_ready",)) for device in cohort),
            "first_success": sum(any(ts >= first for ts in success_times[device]) for device, first in cohort.items()),
            "activation_7d": activated / len(mature_activation) if mature_activation else None,
            "activation_7d_cohort": len(mature_activation),
        },
        # Prompt outcomes (mic / accessibility) — the "Запрошенные permissions"
        # view: how many were asked and how many granted vs denied.
        "permission_results": [
            {"permission": perm, "status": status, "count": count}
            for (perm, status), count in permission_results.most_common()
        ],
        # Where dictations drop off between start and delivered output.
        "dictation_funnel": {
            "started": dictation_stage_counts["dictation_started"],
            "audio_captured": dictation_stage_counts["dictation_audio_captured"],
            "transcribed": dictation_stage_counts["dictation_transcribed"],
            "output_succeeded": dictation_stage_counts["dictation_output_succeeded"],
        },
        "retention": {
            f"d{period}": _retention(successes, since, now, period) for period in (1, 7, 30)
        },
        "quality": {
            "eligible_finishes": len(quality_eligible),
            "success_rate": len(quality_successes) / len(quality_eligible) if quality_eligible else None,
            "latency_p50_ms": _percentile(latencies, 0.5),
            "latency_p90_ms": _percentile(latencies, 0.9),
            "latency_sample": len(latencies),
            "clipboard_fallback_rate": (
                sum(record["properties"].get("output_status") == "clipboard_fallback" for record in known_outputs)
                / len(known_outputs)
                if known_outputs
                else None
            ),
        },
        "errors": {
            "count": len(errors),
            "affected_devices": len({event["device_id"] for event in errors if event["device_id"]}),
            "top_signatures": [
                {"signature": signature, "count": count} for signature, count in signatures.most_common(8)
            ],
        },
        "release_health": release_health[:12],
        "coverage": {
            "canonical_finishes": len(canonical_finishes),
            "legacy_success_only": sum(record["legacy_success_only"] for record in window_records),
            "duration": (
                sum(record["duration_ms"] is not None for record in canonical_finishes) / len(canonical_finishes)
                if canonical_finishes
                else None
            ),
            "latency": (
                sum(record["latency_ms"] is not None for record in canonical_finishes) / len(canonical_finishes)
                if canonical_finishes
                else None
            ),
            "event_id": (
                sum(bool(event["event_id"]) for event in window_events) / len(window_events)
                if window_events
                else None
            ),
            "ingest_sources": dict(Counter(
                event.get("ingest_source") or "unknown" for event in window_events
            )),
            "latest_received_at": max(
                (event.get("received_at") or 0 for event in window_events),
                default=0,
            ) or None,
        },
    }


def _product_payload(days: float, now: float | None = None) -> dict:
    """Return product metrics, caching only real-time dashboard reads.

    Explicit ``now`` values bypass the cache so tests and historical
    calculations remain deterministic.
    """
    window_days, _ = _window(days, now)
    if now is not None:
        return _compute_product_payload(window_days, now)
    return _cached(
        f"product:{window_days:g}",
        lambda: _compute_product_payload(window_days, time.time()),
    )


def _fmt_int(n: float) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 10_000:
        return f"{n / 1000:.0f}k"
    if n >= 1000:
        return f"{n / 1000:.1f}k"
    return str(int(n))


@app.get("/summary")
def summary(days: float = 1.0) -> JSONResponse:
    """Ядро (installs/dau/events/errors) сравнимо между проектами и уходит в
    «Сводную»; metrics[] — витрина GigaType на карточке «Обзора»."""
    window_days, _ = _window(days)
    payload = _cached(f"summary:{window_days:g}", lambda: _compute_summary(days))
    # no-store обязателен: закэшированный 200 маскирует мёртвый модуль.
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


@app.get("/summary-batch")
def summary_batch(days: str = "1,3,7,30") -> JSONResponse:
    try:
        windows = sorted({
            float(max(1, min(math.ceil(float(item.strip())), 365)))
            for item in days.split(",") if item.strip()
        })
    except ValueError:
        return JSONResponse(
            {"error": "days must be comma-separated numbers"}, status_code=400
        )
    if not windows or len(windows) > 10:
        return JSONResponse({"error": "expected 1 to 10 windows"}, status_code=400)
    summaries = {
        f"{window:g}": _cached(
            f"summary:{window:g}", lambda window=window: _compute_summary(window)
        )
        for window in windows
    }
    return JSONResponse(
        {
            "schema_version": 1,
            "updated_at": max(item["updated_at"] for item in summaries.values()),
            "summaries": summaries,
        },
        headers={"Cache-Control": "no-store"},
    )


@app.get("/period-snapshot")
def period_snapshot() -> JSONResponse:
    if not _materialized_ready.is_set():
        return JSONResponse({"error": "materialized backfill is not ready"}, status_code=503)
    return JSONResponse(
        _materialized.snapshot(), headers={"Cache-Control": "no-store"}
    )


@app.get("/stats-telemetry")
def stats_telemetry() -> JSONResponse:
    return JSONResponse(
        {"schema_version": 1, "ready": _materialized_ready.is_set(),
         **_materialized.telemetry()},
        headers={"Cache-Control": "no-store"},
    )


def _compute_summary_legacy(days: float) -> dict:
    product = _product_payload(days)
    window_days = product["window_days"]
    product_now = datetime.fromisoformat(product["updated_at"]).timestamp()
    _, since = _window(window_days, product_now)
    with _db_lock:
        events = _db.execute(
            "SELECT COUNT(*) FROM events WHERE ts >= ? AND ts <= ?",
            (since, product_now),
        ).fetchone()[0]
    win = "today MSK" if window_days == 1 else f"{window_days:g} Moscow dates"
    rate = product["quality"]["success_rate"]
    # Один снимок retention на запрос: compute_retention() вычитывает таблицу
    # целиком, и второй проход по ней добавляет /summary секунды — ровно те,
    # на которых поллер хаба ловит таймаут и красит модуль в degraded.
    retention: dict = {}
    try:
        retention = compute_retention()
    except Exception:  # noqa: BLE001 — карточки деградируют, ядро выживает
        pass
    return {
        "updated_at": product["updated_at"],
        "window_days": window_days,
        "installs": product["installs"],
        "dau": product["active_devices"],
        "events": events,
        "errors": product["errors"]["count"],
        "overview": product["overview"],
        "metrics": [
            {"label": f"Active dictators {win}", "value": _fmt_int(product["active_dictators"])},
            {"label": f"Successful dictations {win}", "value": _fmt_int(product["successful_dictations"])},
            {"label": f"Words delivered {win}", "value": _fmt_int(product["words_delivered"])},
            {
                "label": "Sessions / DAU today MSK",
                "value": (
                    f"{product['overview']['sessions_per_dau']:.2f}"
                    if product["overview"]["sessions_per_dau"] is not None
                    else "—"
                ),
            },
            {"label": "Eligible success rate", "value": f"{rate * 100:.1f}%" if rate is not None else "—"},
        ] + _retention_cards(retention) + _canonical_cards(product_now, retention),
    }


def _compute_summary(days: float) -> dict:
    telemetry = _materialized.telemetry()
    last_revision = (telemetry.get("last_run") or {}).get("code_revision")
    if last_revision == STATS_LOGIC_REVISION:
        return _compute_materialized_summary(days)

    # Compatibility fallback for a first boot and deterministic unit tests.
    # Production reaches this path only until the background materializer has
    # published its first complete snapshot.
    return _compute_summary_legacy(days)


def _compute_materialized_summary(days: float) -> dict:
    """Build the fleet summary without decoding the full raw event history."""
    window_days, _ = _window(days)
    period_id = {
        1.0: "today",
        3.0: "last_3_dates",
        7.0: "last_7_dates",
        30.0: "last_30_dates",
    }.get(window_days)
    if period_id is None:
        # Materialized v1 publishes the fleet's standard periods only.
        return _compute_summary_legacy(days)

    snapshot = _materialized.snapshot()
    period = snapshot["periods"][period_id]
    overview = dict(snapshot["overview"])
    now = time.time()
    current = datetime.fromtimestamp(now, REPORTING_TZ)
    day_start = current.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    activity_times: dict[str, list[float]] = defaultdict(list)
    records: list[dict] = []
    for event in _iter_events(since=day_start, until=now):
        actor = event["device_id"]
        if actor and _is_human_activity(event):
            activity_times[actor].append(event["ts"])
        record = _dictation_record(event)
        if record is not None:
            records.append(record)
    successful_dictations = sum(
        record["success"] for record in _dedupe_legacy_dictations(records)
    )
    sessions = sum(
        1 + sum(
            current_ts - previous_ts > SESSION_GAP_SECONDS
            for previous_ts, current_ts in zip(
                sorted(timestamps), sorted(timestamps)[1:]
            )
        )
        for timestamps in activity_times.values() if timestamps
    )
    dau = int(overview.get("dau") or 0)
    overview["sessions_per_dau"] = sessions / dau if dau else None
    overview["tools_per_dau"] = successful_dictations / dau if dau else None
    return {
        "updated_at": snapshot["computed_at"],
        "window_days": window_days,
        "installs": int(snapshot["periods"]["all_time"]["installs"]),
        "dau": int(period["active_actors"]),
        "events": int(period["events"]),
        "errors": int(period["errors"]),
        "overview": overview,
        "metrics": [
            {
                "label": "Sessions / DAU today MSK",
                "value": (
                    f"{overview['sessions_per_dau']:.2f}"
                    if overview["sessions_per_dau"] is not None else "—"
                ),
            },
            {
                "label": "Tools / DAU today MSK",
                "value": (
                    f"{overview['tools_per_dau']:.2f}"
                    if overview["tools_per_dau"] is not None else "—"
                ),
            },
        ],
    }


@app.get("/product")
def product(days: float = 7.0) -> JSONResponse:
    return JSONResponse(_product_payload(days), headers={"Cache-Control": "no-store"})


@app.get("/timeseries")
def timeseries(days: float = 7.0) -> JSONResponse:
    """Дневные корзины для графиков дашборда (московские даты)."""
    window_days, _ = _window(days)
    payload = _cached(f"timeseries:{window_days:g}", lambda: _compute_timeseries(days))
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


def _compute_timeseries(days: float) -> dict:
    now = time.time()
    window_days, since = _window(days, now)
    # Stream the window instead of materializing every event dict: a 90-day
    # read of the full history used to stack a second full copy on top of the
    # product snapshot and OOM the unit (2026-08-07).
    slim_keys = ("ts", "device_id", "legacy", "denominator_ready", "eligible",
                 "success", "words", "latency_ms")
    records: list[dict] = []
    buckets: dict[str, dict] = {}
    for event in _iter_events(since=since):
        day = _day(event["ts"])
        b = buckets.setdefault(
            day,
            {
                "day": day,
                "dictations": 0,
                "attempts": 0,
                "canonical_successes": 0,
                "words": 0,
                "errors": 0,
                "devices": set(),
                "app_running_devices": set(),
                "dictators": set(),
                "latencies": [],
                "activity_times": defaultdict(list),
            },
        )
        if event["device_id"] and _is_human_activity(event):
            b["devices"].add(event["device_id"])
            b["activity_times"][event["device_id"]].append(event["ts"])
        if event["device_id"] and _is_app_running_activity(event):
            b["app_running_devices"].add(event["device_id"])
        if event["name"] in ERROR_EVENTS:
            b["errors"] += 1
        record = _dictation_record(event)
        if record is not None:
            records.append({key: record[key] for key in slim_keys})
    records = _dedupe_legacy_dictations(records)
    for record in records:
        b = buckets[_day(record["ts"])]
        if record["denominator_ready"] and record["eligible"]:
            b["attempts"] += 1
            b["canonical_successes"] += int(record["success"])
        if record["success"]:
            b["dictations"] += 1
            b["words"] += int(record["words"])
            if record["device_id"]:
                b["dictators"].add(record["device_id"])
            if record["latency_ms"] is not None:
                b["latencies"].append(record["latency_ms"])
    # Zero-fill calendar gaps: inactivity must look like a drop, not a visually
    # compressed series. One future day is tolerated by the ingest clock clamp.
    start_day = datetime.fromtimestamp(since, REPORTING_TZ).date()
    end_day = datetime.fromtimestamp(now, REPORTING_TZ).date()
    if buckets:
        end_day = max(end_day, date.fromisoformat(max(buckets)))
    series = []
    current_day = start_day
    while current_day <= end_day:
        day_key = current_day.isoformat()
        bucket = buckets.get(
            day_key,
            {
                "day": day_key,
                "dictations": 0,
                "attempts": 0,
                "canonical_successes": 0,
                "words": 0,
                "errors": 0,
                "devices": set(),
                "app_running_devices": set(),
                "dictators": set(),
                "latencies": [],
                "activity_times": defaultdict(list),
            },
        )
        sessions = sum(
            1 + sum(
                current - previous > SESSION_GAP_SECONDS
                for previous, current in zip(
                    sorted(timestamps), sorted(timestamps)[1:]
                )
            )
            for timestamps in bucket["activity_times"].values()
            if timestamps
        )
        series.append(
            {
                "day": day_key,
                "dictations": bucket["dictations"],
                "attempts": bucket["attempts"],
                "words": bucket["words"],
                "errors": bucket["errors"],
                "devices": len(bucket["devices"]),
                "app_running": len(bucket["app_running_devices"]),
                "dictators": len(bucket["dictators"]),
                "success_rate": (
                    bucket["canonical_successes"] / bucket["attempts"]
                    if bucket["attempts"]
                    else None
                ),
                "latency_p50_ms": _percentile(bucket["latencies"], 0.5),
                "sessions_per_dau": (
                    sessions / len(bucket["devices"])
                    if bucket["devices"]
                    else None
                ),
            }
        )
        current_day += timedelta(days=1)
    return {"window_days": window_days, "series": series}


def compute_retention(now: float | None = None) -> dict:
    """Кэшированная обёртка: явный ``now`` считает честно (тесты, история)."""
    if now is not None:
        return _compute_retention(now)
    return _cached("retention", lambda: _compute_retention(time.time()))


def _compute_retention(now: float | None = None) -> dict:
    """Fleet retention standard (RETENTION_ROLLOUT.md).

    Two complementary views, both per canonical actor (until a product has
    auth, user_id = device_id per the 02.08 pass-through decision):

    - rolling d1/d7/d30 — share of a cohort that returned at least once
      within N days of first use; mature cohorts only, last 90 days,
      size-weighted (MultiTool reference);
    - weekly cohort table — cohort = Moscow ISO week of first appearance,
      distinct returners per week offset (concierge reference).

    Activity = a product-declared human event on a Moscow date; background
    startup and readiness telemetry do not create cohorts or returns.
    """
    now = now or time.time()
    rows = _db.execute(
        "SELECT device_id, ts, name, properties FROM events WHERE device_id != ''",
    ).fetchall()
    to_day = lambda ts: datetime.fromtimestamp(ts, REPORTING_TZ).date().toordinal()
    active_days: dict[str, set[int]] = {}
    for actor, ts, name, raw_properties in rows:
        try:
            properties = json.loads(raw_properties or "{}")
        except json.JSONDecodeError:
            properties = {}
        if not _is_human_activity({"name": name, "properties": properties}):
            continue
        active_days.setdefault(actor, set()).add(to_day(ts))
    today = to_day(now)
    first = {actor: min(days) for actor, days in active_days.items()}

    horizons = (1, 7, 30)
    num = {n: 0 for n in horizons}
    den = {n: 0 for n in horizons}
    for actor, days in active_days.items():
        cohort = first[actor]
        if cohort < today - 90:
            continue
        for n in horizons:
            if cohort + n <= today:  # only cohorts mature enough
                den[n] += 1
                if any(cohort < d <= cohort + n for d in days):
                    num[n] += 1
    rolling = {
        f"d{n}": (num[n] / den[n]) if den[n] else None for n in horizons
    }

    monday = lambda ordinal: ordinal - date.fromordinal(ordinal).weekday()
    this_week = monday(today)
    weeks: dict[str, dict[str, int]] = {}
    sizes: dict[str, int] = {}
    for actor, days in active_days.items():
        cohort_week = monday(first[actor])
        if cohort_week < this_week - 12 * 7:
            continue
        key = date.fromordinal(cohort_week).isoformat()
        sizes[key] = sizes.get(key, 0) + 1
        for offset in {(monday(d) - cohort_week) // 7 for d in days}:
            bucket = weeks.setdefault(key, {})
            bucket[str(offset)] = bucket.get(str(offset), 0) + 1
    return {
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "actors": len(active_days),
        "rolling": rolling,
        "weekly_cohorts": {"sizes": sizes, "weeks": weeks},
    }


def _retention_cards(retention: dict | None = None) -> list[dict]:
    try:
        rolling = (retention or compute_retention())["rolling"]
        return [
            {"label": f"Retention {h.upper()} · rolling, 90d cohorts",
             "value": f"{rolling[h] * 100:.0f}%"}
            for h in ("d1", "d7") if rolling.get(h) is not None
        ]
    except Exception:  # noqa: BLE001 — cards degrade, the core survives
        return []


# «Сессия = использование продукта = активность человека, а сколько агент
# работает в фоне — без разницы» (Артём/Цев, 02.08). Каждый модуль
# перечисляет СВОИ человеческие события: маски вида «в имени есть tool»
# отваливаются молча — у AIWA вызов модели зовётся ai_call, у Тайпа
# model_ready, — а тихо завышенные сессии хуже отсутствующих. Пустой
# список = карточек сессий у модуля нет, и это честнее выдумки.
#
# У Тайпа человеческое действие — диктовка; плюс самый первый
# запуск после установки. app_opened сюда НЕ входит: startApp() в
# openwhispr/main.js зовёт ensureAutoStartEnabledByDefault(), которая на
# упакованных сборках ставит openAtLogin + openAsHidden по умолчанию, так
# что событие прилетает на каждый вход в систему, даже когда приложение
# молча стартует в фоне и человек его не видел. requirements_ready и
# model_ready — сигналы готовности, error_occurred и renderer_process_gone
# — аварии; всё это машинное.
# Машинные события перечисляются так же явно, а не как «всё остальное»:
# дополнение к человеческому списку засасывает нейтральное (обновления,
# версии, технические маркеры) и выдаёт его за работу агента. Пустой
# список = карточки Agent runtime у модуля нет.
#
# У Тайпа он пустой. Агентский чат в продукте есть (src/components/agent,
# свой слот хоткея в main.js), но он не инструментирован: ни одного вызова
# трекера в agent/chat/notes, и в ALLOWED_EVENTS телеметрии нет ни одного
# агентского имени. Считать нечего — Тайп меряет диктовки, а не агента.
# Появится инструментация — список надо будет пополнить.
MACHINE_EVENT_NAMES: tuple[str, ...] = ()
# Разрыв, после которого следующее человеческое событие открывает новую
# сессию (веб-стандарт 30 минут; Цева 02.08 — «сессия это когда человек
# касается ноута», интервалы между user msg). Имя своё: раньше эта строка
# звалась SESSION_GAP_SECONDS и молча перетирала 5-минутный флотский тайм-аут
# из шапки модуля, так что overview.sessions_per_dau считался по 30 минутам
# вопреки решению от 07.08 и карточке в реестре хаба.
HUMAN_SESSION_GAP_SECONDS = 30 * 60


def _canonical_cards(now: float, retention: dict | None = None) -> list[dict]:
    """Черновик канона «6 показателей» (Артём/Цева 02.08; ПН решает состав).

    Сессии считаются двумя способами намеренно — в ПН выбирается один:
    - «gap» — интервалы между human-событиями с разрывом 30 минут (фрейм
      Цевы: сессия = когда человек касается ноута);
    - «hourly» — прокси Артёма: уникальные пары (актор, час). Дешевле и
      детерминированнее, но длинный разговор дробится по границам часа.
    Обе смотрят только на HUMAN_EVENT_NAMES, поэтому фоновый автостарт и
    техника не надувают сессии; машинное время идёт в Agent runtime по
    своему списку MACHINE_EVENT_NAMES, а объём продуктовой работы уже
    меряют карточки диктовок.
    Плюс Stickiness DAU/MAU (rolling) и Return rate W+1/W+2 из недельных
    когорт. Всё деградирует молча, ядро summary неприкосновенно.
    """
    cards: list[dict] = []
    try:
        current = datetime.fromtimestamp(now, REPORTING_TZ)
        day_start = current.replace(hour=0, minute=0, second=0, microsecond=0)
        since = (day_start - timedelta(days=29)).timestamp()
        window = " FROM events WHERE ts >= ? AND device_id != ''"
        human = (" AND name IN (" + ",".join("?" * len(HUMAN_EVENT_NAMES)) + ")"
                 if HUMAN_EVENT_NAMES else "")
        names = list(HUMAN_EVENT_NAMES)
        if names:
            with _db_lock:
                # Сессия начинается, когда предыдущее человеческое событие
                # того же актора старше SESSION_GAP_SECONDS (или его вовсе
                # не было).
                gap_sessions = _db.execute(
                    "SELECT COUNT(*) FROM (SELECT ts - LAG(ts) OVER"
                    " (PARTITION BY device_id ORDER BY ts) AS delta"
                    + window + human + ") WHERE delta IS NULL OR delta > ?",
                    (since, *names, HUMAN_SESSION_GAP_SECONDS),
                ).fetchone()[0]
                hours = _db.execute(
                    "SELECT COUNT(DISTINCT device_id || ':' || CAST(ts / 3600 AS INT))"
                    + window + human,
                    (since, *names),
                ).fetchone()[0]
            cards.append({
                "label": "Sessions / day · human, 30-min gap · 30 Moscow dates",
                "value": f"{gap_sessions / 30:.1f}",
            })
            cards.append({
                "label": "Sessions / day · human hourly proxy · 30 Moscow dates",
                "value": f"{hours / 30:.1f}",
            })
        if MACHINE_EVENT_NAMES:
            machine = list(MACHINE_EVENT_NAMES)
            with _db_lock:
                agent_hours = _db.execute(
                    "SELECT COUNT(DISTINCT device_id || ':' || CAST(ts / 3600 AS INT))"
                    + window + " AND name IN ("
                    + ",".join("?" * len(machine)) + ")",
                    (since, *machine),
                ).fetchone()[0]
            if agent_hours:
                cards.append({
                    "label": "Agent runtime · machine actor-hours / day",
                    "value": f"{agent_hours / 30:.1f}",
                })
        with _db_lock:
            dau, mau = _db.execute(
                "SELECT COUNT(DISTINCT CASE WHEN ts >= ? THEN device_id END),"
                " COUNT(DISTINCT device_id)" + window,
                (day_start.timestamp(), since),
            ).fetchone()
        if mau:
            cards.append({"label": "Stickiness · DAU/MAU rolling",
                          "value": f"{dau / mau * 100:.0f}%"})
    except Exception:  # noqa: BLE001
        pass
    try:
        cohorts = (retention or compute_retention(now))["weekly_cohorts"]
        sizes, weeks = cohorts.get("sizes") or {}, cohorts.get("weeks") or {}
        if sizes:
            current = datetime.fromtimestamp(now, REPORTING_TZ)
            week_start = (current.date()
                          - timedelta(days=current.weekday())).toordinal()
            for offset in (1, 2):
                den = num = 0
                for key, size in sizes.items():
                    # Зрелость: неделя W+offset когорты полностью прожита,
                    # т.е. закончилась до начала текущей недели.
                    cohort = date.fromisoformat(key).toordinal()
                    if cohort + offset * 7 + 7 <= week_start:
                        den += size
                        num += (weeks.get(key) or {}).get(str(offset), 0)
                if den:
                    cards.append({
                        "label": f"Return rate W+{offset} · weekly cohorts",
                        "value": f"{num / den * 100:.0f}%",
                    })
    except Exception:  # noqa: BLE001
        pass
    return cards


@app.get("/retention")
def retention() -> JSONResponse:
    return JSONResponse(compute_retention(),
                        headers={"Cache-Control": "no-store"})


@app.get("/")
def dashboard() -> FileResponse:
    return FileResponse(HERE / "index.html")


if __name__ == "__main__":
    if not INGEST_TOKEN:
        print(
            "WARNING: STATS_INGEST_TOKEN пуст — ingest открыт без токена. "
            "Это допустимо ТОЛЬКО в dev.",
            flush=True,
        )
    # Только loopback: наружу модуль ходит через Caddy (контракт §4).
    # Analytics never needs durable source IPs; disable per-request access logs.
    uvicorn.run(app, host="127.0.0.1", port=PORT, access_log=False)
