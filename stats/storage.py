"""SQLite storage shared by the stats service and historical importers."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Iterable


def connect(path: str | Path, *, check_same_thread: bool = True) -> sqlite3.Connection:
    db_path = Path(path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    database = sqlite3.connect(db_path, check_same_thread=check_same_thread)
    database.execute("PRAGMA journal_mode=WAL")
    database.execute("PRAGMA busy_timeout=5000")
    init_db(database)
    return database


def init_db(database: sqlite3.Connection) -> None:
    database.execute(
        "CREATE TABLE IF NOT EXISTS events ("
        " ts REAL NOT NULL, device_id TEXT, name TEXT NOT NULL, properties TEXT,"
        " event_id TEXT NOT NULL DEFAULT '', received_at REAL NOT NULL DEFAULT 0,"
        " ingest_source TEXT NOT NULL DEFAULT 'unknown')"
    )
    columns = {row[1] for row in database.execute("PRAGMA table_info(events)")}
    if "event_id" not in columns:
        database.execute("ALTER TABLE events ADD COLUMN event_id TEXT NOT NULL DEFAULT ''")
    if "received_at" not in columns:
        database.execute(
            "ALTER TABLE events ADD COLUMN received_at REAL NOT NULL DEFAULT 0"
        )
    if "ingest_source" not in columns:
        database.execute(
            "ALTER TABLE events ADD COLUMN ingest_source TEXT NOT NULL DEFAULT 'unknown'"
        )
    database.execute("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)")
    database.execute("CREATE INDEX IF NOT EXISTS idx_events_name ON events(name)")
    database.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id "
        "ON events(event_id) WHERE event_id != ''"
    )
    database.commit()


def insert_events(database: sqlite3.Connection, rows: Iterable[dict]) -> int:
    def properties_json(value) -> str:
        if not isinstance(value, dict):
            return "{}"
        try:
            encoded = json.dumps(value, separators=(",", ":"), allow_nan=False)
        except (TypeError, ValueError):
            return "{}"
        # Dropping oversized properties is safer than cutting JSON mid-token.
        return encoded if len(encoded) <= 8000 else "{}"

    before = database.total_changes
    database.executemany(
        "INSERT OR IGNORE INTO events "
        "(ts, device_id, name, properties, event_id, received_at, ingest_source) "
        "VALUES (?,?,?,?,?,?,?)",
        (
            (
                float(row["ts"]),
                str(row.get("device_id") or "")[:200],
                str(row["name"])[:120],
                properties_json(row.get("properties")),
                str(row.get("event_id") or "")[:200],
                float(row.get("received_at") or time.time()),
                str(row.get("ingest_source") or "unknown")[:40],
            )
            for row in rows
        ),
    )
    database.commit()
    return database.total_changes - before
