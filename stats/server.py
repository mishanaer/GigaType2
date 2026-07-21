#!/usr/bin/env python3
"""Stats-модуль GigaType для хаба Traction (контракт: specs/stats-hub.md §4
в репо GigaTool; гайд — traction/ONBOARDING.md там же).

Контракт:
  GET  /            — дашборд (относительные URL: живём за strip_prefix /p/gigatype)
  GET  /health      — liveness + версия деплоя
  GET  /summary     — стандартное ядро (?days=N) + витринные metrics[] GigaType
  POST /events      — ingest со своим токеном
Своё:
  GET  /timeseries  — дневные корзины для графиков дашборда (?days=N)

Схема событий (внутреннее дело модуля; device_id — в конверте батча):
  dictation — исход диктовки: ok (bool), outcome, words, chars, duration_s,
              provider (gigaam_local|...), model, app_version, platform
              (WPM модуль считает сам из words/duration_s)
  app_open  — запуск приложения: first (bool), app_version, platform
  error     — ошибка приложения: context, code, app_version, platform

Запуск: STATS_PORT=9902 python3 server.py
Env:    STATS_PORT (default 9902), STATS_DB (default ./data/events.db),
        STATS_INGEST_TOKEN (пусто = ingest без токена, только для dev!)
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import statistics
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("STATS_PORT", "9902"))
DB_PATH = Path(os.environ.get("STATS_DB", HERE / "data" / "events.db"))
INGEST_TOKEN = os.environ.get("STATS_INGEST_TOKEN", "")
VERSION_FILE = HERE / "VERSION"
VERSION = VERSION_FILE.read_text().strip() if VERSION_FILE.exists() else "dev"

app = FastAPI()

DB_PATH.parent.mkdir(parents=True, exist_ok=True)
_db = sqlite3.connect(DB_PATH, check_same_thread=False)
_db.execute("PRAGMA journal_mode=WAL")
_db.execute(
    "CREATE TABLE IF NOT EXISTS events ("
    " ts REAL NOT NULL, device_id TEXT, name TEXT NOT NULL, properties TEXT)"
)
_db.execute("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)")
_db.commit()


@app.get("/health")
def health() -> dict:
    return {"ok": True, "version": VERSION}


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
    now = time.time()
    rows = []
    for ev in events:
        if not isinstance(ev, dict) or not ev.get("name"):
            continue
        try:
            ts = float(ev.get("ts") or now)
        except (TypeError, ValueError):
            continue
        # Мусорный ts (inf/NaN от json.loads, далёкое будущее) не должен ни
        # ронять fromtimestamp в выборках, ни вечно сидеть в каждом окне.
        if not math.isfinite(ts) or not (0.0 < ts < now + 86400.0):
            ts = now
        props = ev.get("properties")
        props_json = json.dumps(props) if isinstance(props, dict) else "{}"
        if len(props_json) > 4000:  # не режем сериализацию посреди токена
            props_json = "{}"
        rows.append((ts, str(ev.get("device_id") or device or ""),
                     str(ev["name"])[:120], props_json))
    _db.executemany("INSERT INTO events VALUES (?,?,?,?)", rows)
    _db.commit()
    return JSONResponse({"ok": True, "ingested": len(rows)})


def _window(days: float) -> tuple[float, float]:
    window_days = max(0.04, min(float(days), 365.0))
    return window_days, time.time() - window_days * 86400.0


def _dictations(since: float) -> list[dict]:
    """Свойства диктовок окна; битые/не-dict properties — пропускаем, не роняем."""
    out = []
    for (props,) in _db.execute(
        "SELECT properties FROM events WHERE ts > ? AND name = 'dictation'", (since,)
    ):
        try:
            parsed = json.loads(props or "{}")
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            out.append(parsed)
    return out


def _num(v) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v) if math.isfinite(v) else None


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
    window_days, since = _window(days)
    installs = _db.execute(
        "SELECT COUNT(DISTINCT device_id) FROM events WHERE device_id != ''"
    ).fetchone()[0]
    dau = _db.execute(
        "SELECT COUNT(DISTINCT device_id) FROM events WHERE ts > ? AND device_id != ''",
        (since,),
    ).fetchone()[0]
    events = _db.execute("SELECT COUNT(*) FROM events WHERE ts > ?", (since,)).fetchone()[0]
    errors = _db.execute(
        "SELECT COUNT(*) FROM events WHERE ts > ? AND name = 'error'", (since,)
    ).fetchone()[0]

    dicts = _dictations(since)
    ok = [d for d in dicts if d.get("ok") is True]
    # Попытка = событие с булевым ok (маркер исхода диктовки; события с
    # обнулёнными properties не искажают долю). Отмена — не неудача.
    attempts = [
        d for d in dicts
        if isinstance(d.get("ok"), bool) and d.get("outcome") != "cancelled"
    ]
    words = sum(w for d in ok if (w := _num(d.get("words"))) is not None)
    # WPM пересчитываем сами из words/duration_s (клиентскому wpm не доверяем),
    # отсекая мусорные замеры короче секунды.
    wpms = [
        w / (dur / 60.0)
        for d in ok
        if (w := _num(d.get("words"))) is not None
        and (dur := _num(d.get("duration_s"))) is not None
        and dur >= 1.0 and w > 0
    ]
    median_wpm = statistics.median(wpms) if wpms else None
    success_rate = len(ok) / len(attempts) if attempts else None

    win = "24h" if abs(window_days - 1.0) < 1e-9 else f"{window_days:g}d"
    payload = {
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window_days": window_days,
        "installs": installs,
        "dau": dau,
        "events": events,
        "errors": errors,
        "metrics": [
            {"label": f"Dictations {win}", "value": _fmt_int(len(ok))},
            {"label": "Median WPM",
             "value": f"{median_wpm:.0f}" if median_wpm is not None else "—"},
            {"label": f"Words typed {win}", "value": _fmt_int(words)},
            # «Accuracy» продукт пока не меряет (нет ground truth у диктовки);
            # показываем долю успешных диктовок среди неотменённых попыток —
            # только по исходам самих диктовок, посторонние error не влияют.
            {"label": "Success rate",
             "value": f"{success_rate * 100:.1f}%" if success_rate is not None else "—",
             "good": success_rate == 1.0 if success_rate is not None else None},
        ],
    }
    # no-store обязателен: закэшированный 200 маскирует мёртвый модуль.
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


@app.get("/timeseries")
def timeseries(days: float = 7.0) -> JSONResponse:
    """Дневные корзины для графиков дашборда (UTC-сутки, пустые дни — нулями:
    провал активности на графике должен выглядеть провалом, а не сжатием)."""
    window_days, since = _window(days)
    buckets: dict[str, dict] = {}
    for ts, device, name, props in _db.execute(
        "SELECT ts, device_id, name, properties FROM events WHERE ts > ?", (since,)
    ):
        day = datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")
        b = buckets.setdefault(
            day, {"day": day, "dictations": 0, "words": 0, "errors": 0, "devices": set()}
        )
        if device:
            b["devices"].add(device)
        if name == "dictation":
            try:
                p = json.loads(props or "{}")
            except json.JSONDecodeError:
                p = {}
            if isinstance(p, dict) and p.get("ok") is True:
                b["dictations"] += 1
                b["words"] += int(_num(p.get("words")) or 0)
        elif name == "error":
            b["errors"] += 1
    start = datetime.fromtimestamp(since, timezone.utc).date()
    end = datetime.now(timezone.utc).date()
    if buckets:  # допуск клок-скью до суток: корзина может лечь «на завтра»
        end = max(end, date.fromisoformat(max(buckets)))
    series = []
    day = start
    while day <= end:
        b = buckets.get(
            day.isoformat(),
            {"day": day.isoformat(), "dictations": 0, "words": 0, "errors": 0,
             "devices": set()},
        )
        series.append({**b, "devices": len(b["devices"])})
        day += timedelta(days=1)
    return JSONResponse(
        {"window_days": window_days, "series": series},
        headers={"Cache-Control": "no-store"},
    )


@app.get("/")
def dashboard() -> FileResponse:
    return FileResponse(HERE / "index.html")


if __name__ == "__main__":
    if not INGEST_TOKEN:
        print("WARNING: STATS_INGEST_TOKEN пуст — ingest открыт без токена. "
              "Это допустимо ТОЛЬКО в dev.", flush=True)
    # Только loopback: наружу модуль ходит через Caddy (контракт §4).
    uvicorn.run(app, host="127.0.0.1", port=PORT)
