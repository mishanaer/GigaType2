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
        STATS_INGEST_TOKEN (пусто = ingest без токена, только для dev!)
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import threading
import time
from collections import Counter, defaultdict, deque
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

from storage import connect, insert_events

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("STATS_PORT", "9902"))
DB_PATH = Path(os.environ.get("STATS_DB", HERE / "data" / "events.db"))
INGEST_TOKEN = os.environ.get("STATS_INGEST_TOKEN", "")
VERSION_FILE = HERE / "VERSION"
VERSION = VERSION_FILE.read_text().strip() if VERSION_FILE.exists() else "dev"
REPORTING_TZ = ZoneInfo("Europe/Moscow")

app = FastAPI()

_db = connect(DB_PATH, check_same_thread=False)
_db_lock = threading.RLock()

# Traction asks for the 1/7/30 day summaries concurrently. Product aggregation
# includes legacy/canonical dedupe, cohorts and quality metrics, so three copies
# competing under the module CPU quota can all miss the hub's 5-second timeout.
# Serialize cache fills and keep each window across one poll interval.
PRODUCT_CACHE_TTL_SECONDS = 90.0
_product_cache: dict[float, tuple[float, dict]] = {}
_product_cache_lock = threading.Lock()
EVENT_SNAPSHOT_TTL_SECONDS = 90.0
_event_snapshot: tuple[float, float, list[dict]] | None = None
_event_snapshot_lock = threading.Lock()
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

COMMON_INGEST_PROPERTIES = {
    "event_id",
    "contract_version",
    "app_version",
    "app_channel",
    "platform",
    "platform_name",
    "arch",
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
    return {
        "ok": True,
        "version": VERSION,
        "ingest_enabled": True,
        "ingest_authenticated": bool(INGEST_TOKEN),
        "contract_version": 2,
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
            }
        )
    with _db_lock:
        inserted = insert_events(_db, rows)
    if inserted:
        global _event_snapshot
        with _event_snapshot_lock:
            _event_snapshot = None
        with _product_cache_lock:
            _product_cache.clear()
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
        "wau": (day_start - timedelta(days=day_start.weekday())).timestamp(),
        "mau": day_start.replace(day=1).timestamp(),
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
                "SELECT ts, device_id, name, properties, event_id FROM events"
                + where
                + " ORDER BY ts",
                params,
            )
        )
    events = []
    for ts, device, name, raw_properties, event_id in rows:
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
            }
        )
    return events


def _read_events(since: float | None = None, until: float | None = None) -> list[dict]:
    """Read events, sharing one parsed all-history snapshot across 1/7/30.

    Windowed timeseries reads stay uncached. Product calculations filter the
    immutable list in memory and may lag new ingest by at most the explicit
    snapshot TTL.
    """
    if since is not None or until is None:
        return _query_events(since, until)

    global _event_snapshot
    with _event_snapshot_lock:
        monotonic_now = time.monotonic()
        if (
            _event_snapshot is not None
            and monotonic_now - _event_snapshot[0] < EVENT_SNAPSHOT_TTL_SECONDS
        ):
            return _event_snapshot[2]
        events = _query_events(until=until)
        _event_snapshot = (time.monotonic(), until, events)
        return events


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
    all_devices = {event["device_id"] for event in all_events if event["device_id"]}
    overview_starts = _overview_period_starts(now)
    active_by_period = {
        period: {
            event["device_id"]
            for event in all_events
            if event["device_id"] and event["ts"] >= period_start
        }
        for period, period_start in overview_starts.items()
    }
    dau = len(active_by_period["dau"])
    successful_dictations_today = sum(
        record["ts"] >= overview_starts["dau"] for record in successes
    )
    sessions_per_dau = successful_dictations_today / dau if dau else None
    quality_eligible = [
        record for record in window_records if record["denominator_ready"] and record["eligible"]
    ]
    quality_successes = [record for record in quality_eligible if record["success"]]
    active_devices = {event["device_id"] for event in window_events if event["device_id"]}
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

    canonical_finishes = [record for record in window_records if not record["legacy"]]
    return {
        "updated_at": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"),
        "window_days": window_days,
        "installs": len(all_devices),
        "overview": {
            "ever_used": len(all_devices),
            "dau": dau,
            "wau": len(active_by_period["wau"]),
            "mau": len(active_by_period["mau"]),
            "sessions_per_dau": sessions_per_dau,
        },
        "active_devices": len(active_devices),
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
            "requirements_ready": sum(reached(device, ("requirements_ready",)) for device in cohort),
            "model_ready": sum(reached(device, ("model_ready",)) for device in cohort),
            "first_success": sum(any(ts >= first for ts in success_times[device]) for device, first in cohort.items()),
            "activation_7d": activated / len(mature_activation) if mature_activation else None,
            "activation_7d_cohort": len(mature_activation),
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

    with _product_cache_lock:
        monotonic_now = time.monotonic()
        cached = _product_cache.get(window_days)
        if cached and monotonic_now - cached[0] < PRODUCT_CACHE_TTL_SECONDS:
            return cached[1]
        payload = _compute_product_payload(window_days, time.time())
        _product_cache[window_days] = (time.monotonic(), payload)
        return payload


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
    payload = {
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
        ] + _retention_cards(),
    }
    # no-store обязателен: закэшированный 200 маскирует мёртвый модуль.
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


@app.get("/product")
def product(days: float = 7.0) -> JSONResponse:
    return JSONResponse(_product_payload(days), headers={"Cache-Control": "no-store"})


@app.get("/timeseries")
def timeseries(days: float = 7.0) -> JSONResponse:
    """Дневные корзины для графиков дашборда (московские даты)."""
    now = time.time()
    window_days, since = _window(days, now)
    events = _read_events(since=since)
    records = _dedupe_legacy_dictations(
        [record for event in events if (record := _dictation_record(event)) is not None]
    )
    buckets: dict[str, dict] = {}
    for event in events:
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
                "dictators": set(),
                "latencies": [],
            },
        )
        if event["device_id"]:
            b["devices"].add(event["device_id"])
        if event["name"] in ERROR_EVENTS:
            b["errors"] += 1
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
                "dictators": set(),
                "latencies": [],
            },
        )
        series.append(
            {
                "day": day_key,
                "dictations": bucket["dictations"],
                "attempts": bucket["attempts"],
                "words": bucket["words"],
                "errors": bucket["errors"],
                "devices": len(bucket["devices"]),
                "dictators": len(bucket["dictators"]),
                "success_rate": (
                    bucket["canonical_successes"] / bucket["attempts"]
                    if bucket["attempts"]
                    else None
                ),
                "latency_p50_ms": _percentile(bucket["latencies"], 0.5),
                "sessions_per_dau": (
                    bucket["dictations"] / len(bucket["devices"])
                    if bucket["devices"]
                    else None
                ),
            }
        )
        current_day += timedelta(days=1)
    return JSONResponse(
        {"window_days": window_days, "series": series},
        headers={"Cache-Control": "no-store"},
    )


def compute_retention(now: float | None = None) -> dict:
    """Fleet retention standard (RETENTION_ROLLOUT.md).

    Two complementary views, both per canonical actor (until a product has
    auth, user_id = device_id per the 02.08 pass-through decision):

    - rolling d1/d7/d30 — share of a cohort that returned at least once
      within N days of first use; mature cohorts only, last 90 days,
      size-weighted (MultiTool reference);
    - weekly cohort table — cohort = Moscow ISO week of first appearance,
      distinct returners per week offset (concierge reference).

    Activity = any event on a Moscow date. Cohorts start at the first event
    ever recorded, so young modules simply show short tables.
    """
    now = now or time.time()
    rows = _db.execute(
        "SELECT device_id, ts FROM events WHERE device_id != ''",
    ).fetchall()
    to_day = lambda ts: datetime.fromtimestamp(ts, REPORTING_TZ).date().toordinal()
    active_days: dict[str, set[int]] = {}
    for actor, ts in rows:
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


def _retention_cards() -> list[dict]:
    try:
        rolling = compute_retention()["rolling"]
        return [
            {"label": f"Retention {h.upper()} · rolling, 90d cohorts",
             "value": f"{rolling[h] * 100:.0f}%"}
            for h in ("d1", "d7") if rolling.get(h) is not None
        ]
    except Exception:  # noqa: BLE001 — cards degrade, the core survives
        return []


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
