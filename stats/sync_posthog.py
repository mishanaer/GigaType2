#!/usr/bin/env python3
"""Bridge recent allowlisted PostHog events into the GigaType receiver.

This is transitional infrastructure for already released clients. Run it on a
trusted runner outside the PostHog regional block; it keeps no event database
and sends only the projection produced by import_posthog.fetch_page().
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from import_posthog import fetch_page


def send_batch(url: str, token: str, rows: list[dict]) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps({"events": rows}, separators=(",", ":")).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Ingest-Token": token,
            "User-Agent": "gigatype-posthog-bridge/1",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise ValueError("Traction receiver returned an invalid response")
    rejected = payload.get("rejected", 0)
    accepted = payload.get("accepted", len(rows))
    if rejected or accepted != len(rows):
        raise ValueError(
            f"Traction receiver accepted {accepted}/{len(rows)} and rejected {rejected}"
        )
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since-hours", type=float, default=36)
    parser.add_argument("--settle-minutes", type=float, default=5)
    parser.add_argument("--page-size", type=int, default=5000)
    parser.add_argument("--batch-size", type=int, default=400)
    args = parser.parse_args()

    api_key = os.environ.get("POSTHOG_PERSONAL_API_KEY", "")
    project_id = os.environ.get("POSTHOG_PROJECT_ID", "")
    ingest_url = os.environ.get("TRACTION_INGEST_URL", "")
    ingest_token = os.environ.get("TRACTION_INGEST_TOKEN", "")
    if not all((api_key, project_id, ingest_url, ingest_token)):
        parser.error(
            "POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID, "
            "TRACTION_INGEST_URL and TRACTION_INGEST_TOKEN are required"
        )

    until = datetime.now(timezone.utc) - timedelta(
        minutes=max(0, args.settle_minutes)
    )
    since = until - timedelta(hours=max(1, args.since_hours))
    page_size = max(1, min(args.page_size, 10000))
    batch_size = max(1, min(args.batch_size, 500))
    base_url = os.environ.get("POSTHOG_BASE_URL", "https://eu.posthog.com")

    fetched = inserted = duplicates = 0
    cursor = None
    try:
        while True:
            rows, next_cursor, result_count = fetch_page(
                base_url, project_id, api_key, since, until, page_size, cursor
            )
            fetched += len(rows)
            for offset in range(0, len(rows), batch_size):
                batch = rows[offset : offset + batch_size]
                last_error = None
                for attempt in range(3):
                    try:
                        result = send_batch(ingest_url, ingest_token, batch)
                        inserted += int(result.get("ingested", 0))
                        duplicates += int(result.get("duplicates", 0))
                        last_error = None
                        break
                    except (urllib.error.URLError, TimeoutError) as error:
                        last_error = error
                        if attempt < 2:
                            time.sleep(2**attempt)
                if last_error is not None:
                    raise last_error
            if result_count < page_size:
                break
            if next_cursor is None or next_cursor == cursor:
                raise ValueError("PostHog pagination cursor did not advance")
            cursor = next_cursor
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        print(f"PostHog bridge failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1

    print(
        "PostHog bridge:"
        f" fetched={fetched} inserted={inserted} duplicates={duplicates}"
        f" window={since.isoformat()}..{until.isoformat()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
