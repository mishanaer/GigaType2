#!/usr/bin/env python3
"""Idempotently backfill privacy-safe GigaType events from PostHog into Traction.

Required env: POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID.
Optional env: POSTHOG_BASE_URL (default EU cloud), STATS_DB.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from storage import connect, insert_events

EVENTS = (
    "first_app_opened",
    "app_opened",
    "requirements_ready",
    "model_ready",
    "dictation_finished",
    "error_occurred",
    "main_process_error",
    "renderer_process_gone",
    "app_crashed",
)

# Explicit projection: PostHog-added metadata and any future free-form property
# do not cross into the Traction database by accident.
SAFE_PROPERTIES = {
    "event_id",
    "install_id",
    "app_version",
    "app_channel",
    "platform",
    "platform_name",
    "arch",
    "session_id",
    "source",
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
    "microphone_ready",
    "macos_accessibility_ready",
    "windows_paste_tool_ready",
    "linux_paste_tool_ready",
}


def iso_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def posthog_query(base_url: str, project_id: str, api_key: str, query: str) -> dict:
    url = f"{base_url.rstrip('/')}/api/projects/{urllib.parse.quote(project_id, safe='')}/query/"
    request = urllib.request.Request(
        url,
        data=json.dumps({"query": {"kind": "HogQLQuery", "query": query}}).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def sanitize_properties(raw) -> dict:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    if not isinstance(raw, dict):
        return {}
    return {key: value for key, value in raw.items() if key in SAFE_PROPERTIES}


def fetch_page(base_url: str, project_id: str, api_key: str, since: datetime, until: datetime, limit: int, offset: int) -> list[dict]:
    event_names = ", ".join("'" + name + "'" for name in EVENTS)
    query = (
        "SELECT uuid, toUnixTimestamp(timestamp), event, distinct_id, properties "
        "FROM events "
        f"WHERE event IN ({event_names}) "
        f"AND timestamp >= toDateTime('{since.strftime('%Y-%m-%d %H:%M:%S')}') "
        f"AND timestamp < toDateTime('{until.strftime('%Y-%m-%d %H:%M:%S')}') "
        f"ORDER BY timestamp, uuid LIMIT {limit} OFFSET {offset}"
    )
    payload = posthog_query(base_url, project_id, api_key, query)
    rows = []
    for result in payload.get("results") or []:
        if not isinstance(result, (list, tuple)) or len(result) < 5:
            continue
        source_id, timestamp, name, distinct_id, raw_properties = result[:5]
        properties = sanitize_properties(raw_properties)
        rows.append(
            {
                "ts": timestamp,
                "device_id": properties.get("install_id") or distinct_id or "",
                "name": name,
                "properties": properties,
                "event_id": properties.get("event_id") or source_id or "",
            }
        )
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", help="UTC ISO timestamp; default: 30 days ago")
    parser.add_argument("--until", help="UTC ISO timestamp; default: now")
    parser.add_argument("--page-size", type=int, default=5000)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    api_key = os.environ.get("POSTHOG_PERSONAL_API_KEY", "")
    project_id = os.environ.get("POSTHOG_PROJECT_ID", "")
    if not api_key or not project_id:
        parser.error("POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID are required")

    now = datetime.now(timezone.utc)
    since = iso_datetime(args.since) if args.since else now - timedelta(days=30)
    until = iso_datetime(args.until) if args.until else now
    if since >= until:
        parser.error("--since must be earlier than --until")
    page_size = max(1, min(args.page_size, 10000))
    base_url = os.environ.get("POSTHOG_BASE_URL", "https://eu.posthog.com")
    db_path = Path(os.environ.get("STATS_DB", Path(__file__).parent / "data" / "events.db"))
    database = None if args.dry_run else connect(db_path)

    fetched = inserted = offset = 0
    try:
        while True:
            rows = fetch_page(base_url, project_id, api_key, since, until, page_size, offset)
            fetched += len(rows)
            if database is not None:
                inserted += insert_events(database, rows)
            if len(rows) < page_size:
                break
            offset += len(rows)
    except (urllib.error.URLError, TimeoutError) as error:
        print(f"PostHog import failed: {error}", file=sys.stderr)
        return 1
    finally:
        if database is not None:
            database.close()

    action = "would inspect" if args.dry_run else "inserted"
    print(f"PostHog: fetched {fetched}; {action} {fetched if args.dry_run else inserted}; window {since.isoformat()}..{until.isoformat()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
