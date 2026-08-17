# GigaType product metrics

This document is the metric contract for the Traction dashboard. It separates
product outcomes from diagnostics and records which data can be recovered from
already released clients.

## Decisions the dashboard should support

1. Are more installations getting value from dictation?
2. Do people return to dictate again?
3. Where does the first-value funnel break?
4. Did a release make dictation slower or less reliable?

Raw event volume is a data-quality diagnostic, not a product KPI.

## Recommended KPI set

| Role | Metric | Definition | Main caveat |
|---|---|---|---|
| Primary | Active dictators (7d / 30d) | Distinct `install_id` with at least one eligible successful dictation in the window | One installation is the current user proxy |
| Primary | 7-day activation | Mature first-open cohorts that complete an eligible successful dictation within 7 days | Exclude cohorts without a full 7-day observation window |
| Driver | Successful dictations | Eligible `dictation_finished` events with `outcome=succeeded` | Do not infer success from a generic error count |
| Driver | Sessions / DAU | Successful dictations on the current Moscow date / distinct active installations on that same date | An installation that opens the app but does not dictate remains in the DAU denominator |
| Driver | Tools / DAU | Same value as Sessions / DAU: one successful eligible dictation is one product-defined tool use | Traction deliberately shows both canonical cards |
| Driver | Final words delivered | Sum of `final_output_words` for successful dictations | Raw words are a fallback only and coverage must be shown |
| Driver | Repeat dictators | Active dictators with successful dictation on at least two Moscow dates in the window | A simple early repeat signal, not long-term retention |
| Outcome | D1 / D7 / D30 dictation retention | First-success cohorts with another successful dictation on a later date within N days | Only mature cohorts enter each denominator |
| Guardrail | Eligible-session success rate | Successful eligible finishes / all eligible finishes | Requires all finishes, not only successful ones |
| Guardrail | End-to-end latency p50 / p90 | Percentiles of `total_latency_ms` on successful sessions | Report sample size and field coverage |
| Guardrail | Output fallback / failure | Clipboard fallback among known successful outputs; output failures among eligible finishes | Older clients can have missing output status |
| Diagnostic | Affected devices and top error signatures | Distinct devices with errors; `error_area:error_code` counts | An error event is not a session denominator |
| Diagnostic | Release health | Active devices, eligible sessions, success rate and errors by app version | Small samples must remain visible |

`Accuracy` is intentionally absent. There is no ground truth or privacy-safe
correction signal today. Words-per-minute is useful as a behaviour/throughput
diagnostic, but not as recognition quality.

## First-value funnel

The canonical funnel is:

`first_app_opened -> requirements_ready -> model_ready -> first eligible successful dictation`

`settings_screen_viewed` is not a required activation step: a user can receive
value without visiting settings. Funnel steps are distinct installations from
the same first-open cohort, never raw event counts.

## Eligibility and identity

- A successful dictation has `outcome=succeeded` and audio duration of at least
  one second. Missing duration is retained as legacy-compatible success and is
  called out in coverage.
- `too_short` sessions are excluded from the success-rate denominator. Other
  completed outcomes are eligible attempts.
- `install_id` is the identity. PostHog `distinct_id` is only a fallback during
  historical import.
- `Europe/Moscow` is the reporting timezone for daily activity and cohorts.
  DAU is the distinct active installation count from 00:00 MSK on the current
  date, never a trailing 24-hour window. WAU is the rolling last 7 Moscow
  dates including today (fleet decision of 2026-08-17: week-to-date collapsed
  onto DAU every Monday). MAU is the rolling
  last 30 Moscow dates including today (fleet decision of 2026-08-01: a
  calendar month-to-date cliffed to daily values every 1st and read as broken
  data). Product seven- and 30-date views likewise include today plus the
  previous 6 or 29 Moscow calendar dates.
- `event_id` is the cross-source deduplication key. The same telemetry event may
  arrive from a PostHog backfill and direct Traction ingest.
- `Sessions / DAU` always uses the current Moscow date for both numerator and
  denominator, independently of the selected 1/7/30-date product view.
- `Tools / DAU` is a fleet-wide canonical field, and its per-project meaning is
  owned by the hub registry, not by this module: `tools_definition` of project
  `gigatype` in `projects.json` fixes it as successful eligible dictations per
  DAU, i.e. deliberately the same number as `Sessions / DAU`, with both cards
  rendered. The equality is the decision, not a placeholder — do not drop the
  field to remove a duplicate-looking card. The hub also charts `Engagement
  dynamics` from `tools_per_dau` alone, so dropping it blanks that chart and
  cuts the stored series, which starts on 2026-07-30 for Type.

## Availability

### Available without shipping a new client

Released clients already send the necessary privacy-safe events to PostHog:
first/app opens, readiness, model readiness, all dictation outcomes, final word
counts, latency, output status, errors, platform and app version. A server-side
PostHog import can therefore backfill activation, value, retention, quality and
release-health history without reinstalling or updating the app.

The importer requires a PostHog personal API key with query-read access and the
project id. Those secrets stay on the stats host.

### Requires the next client release

- Direct Traction delivery of readiness, model readiness and every
  `dictation_finished` outcome.
- The shared `event_id` in direct ingest, so live data and PostHog history merge
  idempotently.
- Contract/coverage version stamping for an honest mixed-client rollout.

### Deliberately deferred client instrumentation

Edit-distance, undo and target-application signals could approximate acceptance
or quality, but they increase privacy and implementation risk. Add them only
after a concrete product decision, a privacy review and an explicit retention
policy; never send dictated or edited text.
