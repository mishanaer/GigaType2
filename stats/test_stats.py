from __future__ import annotations

import asyncio
import json
import math
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_TEMP = tempfile.TemporaryDirectory()
os.environ["STATS_DB"] = str(Path(_TEMP.name) / "events.db")

import import_posthog  # noqa: E402
import server  # noqa: E402
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
        server._db.execute("DELETE FROM events")
        server._db.commit()

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
        })

    def test_summary_exposes_only_applicable_canonical_overview_metrics(self):
        self.seed()
        with patch("server.time.time", return_value=NOW):
            response = server.summary(7)
        overview = json.loads(response.body)["overview"]

        self.assertEqual(set(overview), {"ever_used", "dau", "wau", "mau"})
        self.assertNotIn("sessions_per_dau", overview)
        self.assertNotIn("tools_per_dau", overview)

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
        rows = list(server._db.execute("SELECT ts, properties FROM events ORDER BY event_id"))
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(math.isfinite(row[0]) and row[0] <= time.time() + 2 for row in rows))
        self.assertEqual(json.loads(rows[0][1]), {})


if __name__ == "__main__":
    unittest.main()
