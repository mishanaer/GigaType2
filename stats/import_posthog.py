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
from uuid import UUID

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


def hogql_datetime(value: datetime) -> str:
    """Render an API-sourced UTC timestamp as a fixed-precision HogQL literal."""
    return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")


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


def fetch_page(
    base_url: str,
    project_id: str,
    api_key: str,
    since: datetime,
    until: datetime,
    limit: int,
    after: tuple[datetime, str] | None = None,
) -> tuple[list[dict], tuple[datetime, str] | None, int]:
    event_names = ", ".join("'" + name + "'" for name in EVENTS)
    cursor_clause = ""
    if after is not None:
        after_timestamp, after_uuid = after
        # UUID comes from PostHog itself. Canonicalizing it both validates the
        # cursor and prevents an API response from becoming query syntax.
        cursor_uuid = str(UUID(after_uuid))
        cursor_timestamp = hogql_datetime(after_timestamp)
        cursor_clause = (
            "AND ("
            f"timestamp > toDateTime64('{cursor_timestamp}', 6, 'UTC') "
            "OR ("
            f"timestamp = toDateTime64('{cursor_timestamp}', 6, 'UTC') "
            f"AND uuid > toUUID('{cursor_uuid}')"
            ")) "
        )
    query = (
        "SELECT uuid, timestamp, event, distinct_id, properties "
        "FROM events "
        f"WHERE event IN ({event_names}) "
        f"AND timestamp >= toDateTime64('{hogql_datetime(since)}', 6, 'UTC') "
        f"AND timestamp < toDateTime64('{hogql_datetime(until)}', 6, 'UTC') "
        f"{cursor_clause}"
        f"ORDER BY timestamp, uuid LIMIT {limit}"
    )
    payload = posthog_query(base_url, project_id, api_key, query)
    results = payload.get("results") or []
    rows = []
    for result in results:
        if not isinstance(result, (list, tuple)) or len(result) < 5:
            continue
        source_id, timestamp, name, distinct_id, raw_properties = result[:5]
        event_timestamp = iso_datetime(str(timestamp))
        properties = sanitize_properties(raw_properties)
        rows.append(
            {
                "ts": event_timestamp.timestamp(),
                "device_id": properties.get("install_id") or distinct_id or "",
                "name": name,
                "properties": properties,
                "event_id": properties.get("event_id") or source_id or "",
            }
        )
    if not results:
        return rows, None, 0
    last_result = results[-1]
    if not isinstance(last_result, (list, tuple)) or len(last_result) < 2:
        raise ValueError("PostHog page has no usable keyset cursor")
    last_uuid, last_timestamp = last_result[:2]
    cursor = (iso_datetime(str(last_timestamp)), str(UUID(str(last_uuid))))
    return rows, cursor, len(results)


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

    fetched = inserted = 0
    cursor = None
    try:
        while True:
            rows, next_cursor, result_count = fetch_page(
                base_url, project_id, api_key, since, until, page_size, cursor
            )
            fetched += len(rows)
            if database is not None:
                received_at = datetime.now(timezone.utc).timestamp()
                inserted += insert_events(database, [
                    {
                        **row,
                        "received_at": received_at,
                        "ingest_source": "posthog",
                    }
                    for row in rows
                ])
            if result_count < page_size:
                break
            if next_cursor is None or next_cursor == cursor:
                raise ValueError("PostHog pagination cursor did not advance")
            cursor = next_cursor
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
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
