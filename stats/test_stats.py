from __future__ import annotations

import asyncio
import json
import math
import os
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

_TEMP = tempfile.TemporaryDirectory()
os.environ["STATS_DB"] = str(Path(_TEMP.name) / "events.db")

import import_posthog  # noqa: E402
import server  # noqa: E402
import sync_posthog  # noqa: E402
from storage import insert_events  # noqa: E402


NOW = 2_000_000_000.0
DAY = 86400.0


def event(days_ago, device, name, event_id, **properties):
    return {
        "ts": NOW - days_ago * DAY,
        "device_id": device,
        "name": name,
        "event_id": event_id,
        "properties": {"event_id": event_id, "app_version": "2.0", **properties},
    }


class ProductMetricsTest(unittest.TestCase):
    def setUp(self):
        server._reset_caches()
        server._db.execute("DELETE FROM events")
        server._db.commit()
        server._rate_buckets.clear()

    def seed(self):
        rows = [
            event(20, "a", "first_app_opened", "a-open"),
            event(19.9, "a", "requirements_ready", "a-ready"),
            event(19.8, "a", "model_ready", "a-model"),
            event(15, "a", "dictation_finished", "a-one", outcome="succeeded", audio_duration_ms=5000, final_output_words=10, total_latency_ms=1000, output_status="inserted_verified"),
            event(14.1, "a", "dictation_finished", "a-two", outcome="succeeded", audio_duration_ms=6000, final_output_words=20, total_latency_ms=2000, output_status="clipboard_fallback"),
            event(20, "b", "first_app_opened", "b-open"),
            event(18, "b", "dictation_finished", "b-fail", outcome="transcription_failed", audio_duration_ms=4000, total_latency_ms=700),
            event(17, "b", "dictation_finished", "b-short", outcome="too_short", audio_duration_ms=300),
            event(3, "c", "first_app_opened", "c-open"),
            event(2, "c", "dictation_finished", "c-one", outcome="succeeded", audio_duration_ms=3000, final_output_words=5, total_latency_ms=500, output_status="inserted_verified"),
        ]
        self.assertEqual(insert_events(server._db, rows), len(rows))

    def test_product_metrics_use_session_denominators_and_mature_cohorts(self):
        self.seed()
        product = server._product_payload(30, NOW)

        self.assertEqual(product["active_dictators"], 2)
        self.assertEqual(product["repeat_dictators"], 1)
        self.assertEqual(product["successful_dictations"], 3)
        self.assertEqual(product["words_delivered"], 35)
        self.assertEqual(product["quality"]["eligible_finishes"], 4)
        self.assertAlmostEqual(product["quality"]["success_rate"], 0.75)
        self.assertEqual(product["quality"]["latency_p50_ms"], 1000)
        self.assertEqual(product["funnel"]["activation_7d_cohort"], 2)
        self.assertAlmostEqual(product["funnel"]["activation_7d"], 0.5)
        self.assertEqual(product["retention"]["d1"]["cohort"], 2)
        self.assertAlmostEqual(product["retention"]["d1"]["rate"], 0.5)
        self.assertEqual(product["overview"], {
            "ever_used": 3,
            "dau": 0,
            "wau": 1,
            "mau": 3,
            "sessions_per_dau": None,
            "tools_per_dau": None,
        })

    def test_summary_batch_matches_cached_single_windows(self):
        self.seed()
        self.assertIn("summary_batch_v1", server.health()["capabilities"])
        batch = json.loads(server.summary_batch("1,3,7,30").body)
        self.assertEqual(set(batch["summaries"]), {"1", "3", "7", "30"})
        for days in (1, 3, 7, 30):
            single = json.loads(server.summary(days).body)
            candidate = batch["summaries"][str(days)]
            for key in (
                "window_days", "installs", "dau", "events", "errors", "overview",
            ):
                self.assertEqual(candidate[key], single[key])

    def test_materialized_period_snapshot_and_duplicate_replay(self):
        self.seed()
        server._materialized.rebuild(
            server.sqlite_events(server.DB_PATH),
            error_names=frozenset(server.ERROR_EVENTS),
            code_revision="test",
        )
        server._materialized_ready.set()
        snapshot = json.loads(server.period_snapshot().body)
        self.assertEqual(
            set(snapshot["periods"]),
            {"today", "yesterday", "last_3_dates", "last_7_dates",
             "last_30_dates", "all_time"},
        )
        before = snapshot["periods"]["all_time"]["events"]
        row = {
            "ts": server.time.time(), "device_id": "dup",
            "name": "app_opened", "event_id": "duplicate-id",
        }
        self.assertEqual(server._materialized.record_events([
            (row["ts"], row["device_id"], row["name"], row["event_id"]),
        ]), 1)
        self.assertEqual(server._materialized.record_events([
            (row["ts"], row["device_id"], row["name"], row["event_id"]),
        ]), 0)
        server._materialized.refresh(now=server.time.time())
        self.assertEqual(
            server._materialized.snapshot()["periods"]["all_time"]["events"],
            before + 1,
        )

    def test_overview_uses_moscow_day_and_rolling_7_and_30_dates(self):
        calendar_now = datetime(2026, 7, 8, 12, 0, tzinfo=timezone.utc).timestamp()
        rows = [
            {
                # 00:01 MSK on the current date.
                "ts": datetime(2026, 7, 7, 21, 1, tzinfo=timezone.utc).timestamp(),
                "device_id": "current-day",
                "name": "app_opened",
                "event_id": "current-day",
                "properties": {},
            },
            {
                "ts": datetime(2026, 7, 8, 7, 0, tzinfo=timezone.utc).timestamp(),
                "device_id": "current-day",
                "name": "dictation_finished",
                "event_id": "current-day-session-1",
                "properties": {
                    "outcome": "succeeded",
                    "audio_duration_ms": 2000,
                },
            },
            {
                "ts": datetime(2026, 7, 8, 8, 0, tzinfo=timezone.utc).timestamp(),
                "device_id": "current-day",
                "name": "dictation_finished",
                "event_id": "current-day-session-2",
                "properties": {
                    "outcome": "succeeded",
                    "audio_duration_ms": 3000,
                },
            },
            {
                # Monday of the current ISO week — inside the rolling week.
                "ts": datetime(2026, 7, 6, 8, 0, tzinfo=timezone.utc).timestamp(),
                "device_id": "current-week",
                "name": "app_opened",
                "event_id": "current-week",
                "properties": {},
            },
            {
                # Sunday of the previous ISO week. WAU is rolling since
                # 2026-08-17, so this one counts too.
                "ts": datetime(2026, 7, 5, 8, 0, tzinfo=timezone.utc).timestamp(),
                "device_id": "previous-week",
                "name": "app_opened",
                "event_id": "previous-week",
                "properties": {},
            },
            {
                # 23:59 MSK on the last date of the previous calendar month.
                # MAU is rolling since 2026-08-01, so this one counts.
                "ts": datetime(2026, 6, 30, 20, 59, tzinfo=timezone.utc).timestamp(),
                "device_id": "previous-month",
                "name": "app_opened",
                "event_id": "previous-month",
                "properties": {},
            },
            {
                # 00:00 MSK on 2026-06-09 — the 30th and oldest date of the
                # rolling window, whose start bound is inclusive.
                "ts": datetime(2026, 6, 8, 21, 0, tzinfo=timezone.utc).timestamp(),
                "device_id": "window-oldest-date",
                "name": "app_opened",
                "event_id": "window-oldest-date",
                "properties": {},
            },
            {
                # 23:59 MSK on 2026-06-08 — one minute before the window.
                "ts": datetime(2026, 6, 8, 20, 59, tzinfo=timezone.utc).timestamp(),
                "device_id": "before-window",
                "name": "app_opened",
                "event_id": "before-window",
                "properties": {},
            },
        ]
        self.assertEqual(insert_events(server._db, rows), 8)

        product = server._product_payload(1, calendar_now)

        self.assertEqual(product["active_devices"], 1)
        self.assertEqual(product["overview"]["dau"], 1)
        # Rolling last 7 Moscow dates (2026-07-02..2026-07-08).
        self.assertEqual(product["overview"]["wau"], 3)
        # Rolling last 30 Moscow dates (2026-06-09..2026-07-08): everyone
        # except the device whose only event predates the window.
        self.assertEqual(product["overview"]["mau"], 5)
        self.assertEqual(product["overview"]["ever_used"], 6)
        # Сессии Тайпа с 07.08.2026 считаются отдельно от диктовок: три события
        # устройства current-day разнесены на часы, значит три сессии, а не две
        # диктовки. Ряд /timeseries живёт по старому дневному прокси
        # (диктовки / устройства) и остаётся на 2.0 — расхождение осознанное.
        self.assertEqual(product["overview"]["sessions_per_dau"], 3.0)

        with patch("server.time.time", return_value=calendar_now):
            series = json.loads(server.timeseries(1).body)["series"]
        self.assertEqual(series[-1]["sessions_per_dau"], 2.0)

    def test_overview_sessions_split_on_the_five_minute_fleet_gap(self):
        now = datetime(2026, 7, 8, 12, 0, tzinfo=timezone.utc).timestamp()
        day_start = datetime(2026, 7, 7, 21, 0, tzinfo=timezone.utc).timestamp()
        rows = [
            {
                "ts": day_start + offset,
                "device_id": "gap",
                "name": "app_opened",
                "event_id": f"gap-{index}",
                "properties": {},
            }
            # 0 и +4 мин — одна сессия, +10 мин — вторая: граница ровно та,
            # что записана в SESSION_GAP_SECONDS (флотские 5 минут).
            for index, offset in enumerate((0, 4 * 60, 10 * 60))
        ]
        self.assertEqual(insert_events(server._db, rows), 3)

        product = server._product_payload(1, now)

        self.assertEqual(server.SESSION_GAP_SECONDS, 5 * 60)
        self.assertEqual(product["overview"]["sessions_per_dau"], 2.0)

    def test_summary_exposes_only_applicable_canonical_overview_metrics(self):
        self.seed()
        with patch("server.time.time", return_value=NOW):
            response = server.summary(7)
        overview = json.loads(response.body)["overview"]

        self.assertEqual(
            set(overview),
            {
                "ever_used", "dau", "wau", "mau",
                "sessions_per_dau", "tools_per_dau",
            },
        )
        # Равенство намеренное, а не совпадение: для Тайпа одна завершённая
        # диктовка — и сессия, и продуктовое действие (tools_definition
        # проекта gigatype в реестре хаба projects.json).
        self.assertEqual(
            overview["tools_per_dau"],
            overview["sessions_per_dau"],
        )

    def test_realtime_product_cache_serializes_fills_and_reuses_payload(self):
        calls = []
        entered = threading.Event()
        release = threading.Event()

        def fake_compute(days, now):
            calls.append(days)
            entered.set()
            release.wait(timeout=2)
            return {"window_days": days, "updated_at": str(now)}

        results = []
        with patch.object(server, "_compute_product_payload", side_effect=fake_compute):
            workers = [
                threading.Thread(target=lambda: results.append(server._product_payload(7)))
                for _ in range(3)
            ]
            for worker in workers:
                worker.start()
            self.assertTrue(entered.wait(timeout=1))
            release.set()
            for worker in workers:
                worker.join(timeout=2)

            self.assertEqual(calls, [7.0])
            self.assertEqual(len(results), 3)
            self.assertIs(results[0], results[1])
            self.assertIs(results[1], results[2])

            server._product_payload(7, NOW)
            self.assertEqual(calls, [7.0, 7.0])

    def test_summary_answers_from_cache_and_recomputes_in_background(self):
        self.seed()
        calls = []

        def fake_compute(days):
            calls.append(days)
            return {"window_days": days, "metrics": [], "calls": len(calls)}

        with patch.object(server, "_compute_summary", side_effect=fake_compute):
            first = json.loads(server.summary(1).body)
            second = json.loads(server.summary(1).body)
            self.assertEqual(calls, [1.0])
            self.assertEqual(second["calls"], first["calls"])

            # Протухшее значение всё равно уходит в ответ мгновенно — за счёт
            # этого поллер хаба укладывается в свои 5 секунд, — а пересчёт
            # делает фоновый тик.
            with server._cache_lock:
                stamp, value = server._cache["summary:1"]
                server._cache["summary:1"] = (
                    stamp - server.CACHE_TTL_SECONDS - 1, value
                )
            stale = json.loads(server.summary(1).body)
            self.assertEqual(calls, [1.0])
            self.assertEqual(stale["calls"], first["calls"])

            server._refresh_due()
            self.assertEqual(calls, [1.0, 1.0])
            self.assertEqual(json.loads(server.summary(1).body)["calls"], 2)

    def test_ingest_keeps_the_warm_cache(self):
        class FakeRequest:
            headers: dict[str, str] = {}
            client = None

            async def body(self):
                return json.dumps({
                    "device_id": "fresh",
                    "events": [{
                        "name": "app_opened",
                        "ts": time.time(),
                        "event_id": "fresh-open",
                    }],
                }).encode()

        self.seed()
        calls = []
        with patch.object(
            server, "_compute_summary",
            side_effect=lambda days: calls.append(days) or {"window_days": days},
        ):
            server.summary(1)
            # Сброс кэша на каждой пачке событий означал бы «кэша нет»: при
            # DAU в сотни устройств ingest идёт непрерывно (инцидент 13.08).
            self.assertEqual(
                json.loads(asyncio.run(server.ingest(FakeRequest())).body)["ingested"],
                1,
            )
            server.summary(1)
            self.assertEqual(calls, [1.0])

    def test_product_windows_share_one_parsed_event_snapshot(self):
        snapshot = [{"ts": NOW, "device_id": "a", "name": "app_opened"}]
        with patch.object(server, "_query_events", return_value=snapshot) as query:
            first = server._read_events(until=NOW)
            second = server._read_events(until=NOW + 1)
        self.assertIs(first, second)
        query.assert_called_once_with(until=NOW)

    def test_event_id_and_legacy_overlap_are_deduplicated(self):
        canonical = event(1, "a", "dictation_finished", "same", outcome="succeeded", audio_duration_ms=5000, final_output_words=10)
        self.assertEqual(insert_events(server._db, [canonical]), 1)
        self.assertEqual(insert_events(server._db, [canonical]), 0)
        self.assertEqual(
            insert_events(
                server._db,
                [{"ts": canonical["ts"] + 1, "device_id": "a", "name": "dictation", "properties": {"words": 10, "duration_s": 5}}],
            ),
            1,
        )
        self.assertEqual(server._product_payload(7, NOW)["successful_dictations"], 1)

    def test_posthog_projection_drops_unapproved_properties(self):
        self.assertEqual(
            import_posthog.sanitize_properties(
                {"event_id": "one", "final_output_words": 12, "$ip": "hidden", "dictated_text": "secret"}
            ),
            {"event_id": "one", "final_output_words": 12},
        )

    def test_posthog_import_uses_keyset_pagination(self):
        captured_queries = []
        timestamp = "2026-07-23T10:20:30.123456Z"
        first_uuid = "019f2206-38cd-7000-8000-da5486ba6669"
        second_uuid = "019f2206-38cd-7000-8000-da5486ba6670"

        def fake_query(_base_url, _project_id, _api_key, query):
            captured_queries.append(query)
            return {
                "results": [
                    [first_uuid, timestamp, "app_opened", "device", {"install_id": "device"}],
                    [second_uuid, timestamp, "dictation_finished", "device", {"outcome": "succeeded"}],
                ]
            }

        original = import_posthog.posthog_query
        import_posthog.posthog_query = fake_query
        try:
            rows, cursor, result_count = import_posthog.fetch_page(
                "https://eu.posthog.com",
                "214255",
                "secret",
                import_posthog.iso_datetime("2026-07-01T00:00:00Z"),
                import_posthog.iso_datetime("2026-08-01T00:00:00Z"),
                2,
            )
            self.assertEqual(result_count, 2)
            self.assertEqual(len(rows), 2)
            self.assertEqual(cursor[1], second_uuid)
            self.assertNotIn("OFFSET", captured_queries[0])

            import_posthog.fetch_page(
                "https://eu.posthog.com",
                "214255",
                "secret",
                import_posthog.iso_datetime("2026-07-01T00:00:00Z"),
                import_posthog.iso_datetime("2026-08-01T00:00:00Z"),
                2,
                cursor,
            )
            self.assertIn("timestamp > toDateTime64", captured_queries[1])
            self.assertIn(f"uuid > toUUID('{second_uuid}')", captured_queries[1])
            self.assertNotIn("OFFSET", captured_queries[1])
        finally:
            import_posthog.posthog_query = original

    def test_posthog_bridge_requires_full_receiver_acceptance(self):
        class FakeResponse:
            def __init__(self, payload):
                self.payload = payload

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(self.payload).encode()

        rows = [{"name": "app_opened", "event_id": "one", "device_id": "device"}]
        with patch(
            "sync_posthog.urllib.request.urlopen",
            return_value=FakeResponse(
                {"ok": True, "accepted": 1, "ingested": 0, "duplicates": 1, "rejected": 0}
            ),
        ):
            result = sync_posthog.send_batch("https://example.invalid/events", "key", rows)
        self.assertEqual(result["duplicates"], 1)

        with patch(
            "sync_posthog.urllib.request.urlopen",
            return_value=FakeResponse(
                {"ok": True, "accepted": 0, "ingested": 0, "duplicates": 0, "rejected": 1}
            ),
        ):
            with self.assertRaises(ValueError):
                sync_posthog.send_batch("https://example.invalid/events", "key", rows)

    def test_ingest_clamps_poison_timestamps_and_keeps_json_valid(self):
        class FakeRequest:
            async def body(self):
                return json.dumps(
                    {
                        "device_id": "clock-skew",
                        "events": [
                            {"ts": math.inf, "name": "app_opened", "event_id": "clock-one", "properties": {"large": "x" * 9000}},
                            {"ts": time.time() + 10 * DAY, "name": "app_opened", "event_id": "clock-two"},
                            {"ts": "not-a-number", "name": "app_opened", "event_id": "clock-bad"},
                        ],
                    }
                ).encode()

        response = asyncio.run(server.ingest(FakeRequest()))
        payload = json.loads(response.body)
        self.assertEqual(payload["ingested"], 2)
        self.assertEqual(payload["accepted"], 2)
        self.assertEqual(payload["rejected"], 1)
        rows = list(server._db.execute("SELECT ts, properties FROM events ORDER BY event_id"))
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(math.isfinite(row[0]) and row[0] <= time.time() + 2 for row in rows))
        self.assertEqual(json.loads(rows[0][1]), {"event_id": "clock-one"})

    def test_ingest_enforces_server_side_event_and_property_allowlists(self):
        class FakeRequest:
            async def body(self):
                return json.dumps(
                    {
                        "device_id": "device",
                        "events": [
                            {
                                "name": "dictation_finished",
                                "event_id": "allowed",
                                "properties": {
                                    "outcome": "succeeded",
                                    "final_output_words": 12,
                                    "dictated_text": "must never be stored",
                                    "$ip": "must never be stored",
                                    "model": {"nested": "not a scalar"},
                                },
                            },
                            {"name": "arbitrary_event", "event_id": "blocked"},
                            {"name": "app_opened"},
                        ],
                    }
                ).encode()

        payload = json.loads(asyncio.run(server.ingest(FakeRequest())).body)
        self.assertEqual(payload, {
            "ok": True,
            "accepted": 1,
            "ingested": 1,
            "duplicates": 0,
            "rejected": 2,
        })
        properties = json.loads(
            server._db.execute(
                "SELECT properties FROM events WHERE event_id = 'allowed'"
            ).fetchone()[0]
        )
        self.assertEqual(
            properties,
            {"outcome": "succeeded", "final_output_words": 12, "event_id": "allowed"},
        )

    def test_receiver_rate_limit_uses_hashed_ephemeral_buckets(self):
        for _ in range(3):
            self.assertTrue(server._within_rate_limit("device", "private-id", 3))
        self.assertFalse(server._within_rate_limit("device", "private-id", 3))
        self.assertNotIn("private-id", server._rate_buckets)


if __name__ == "__main__":
    unittest.main()
