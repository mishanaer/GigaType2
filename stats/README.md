# stats — модуль статистики GigaType для хаба Traction

Модуль по контракту Traction (репо GigaTool, `specs/stats-hub.md` §4):
`/health`, `/summary` (ядро + витрина GigaType), `POST /events` с токеном,
`/timeseries` для графиков, `/` — дашборд с относительными URL.
SQLite, только loopback; в проде живёт за `https://stats.multitool.works/p/gigatype/`.

```bash
python3 -m venv .venv && .venv/bin/pip install fastapi uvicorn
STATS_PORT=9902 .venv/bin/python server.py    # http://127.0.0.1:9902
```

События шлёт приложение (main-процесс, `openwhispr/src/helpers/tractionAnalytics.js`):
`first_app_opened`, `app_opened`, `requirements_ready`, `model_ready`, все
`dictation_finished` и типизированные ошибки. Конверт несёт `device_id`
(= install_id телеметрии), а событие — общий с PostHog `event_id`.

Метрики и знаменатели зафиксированы в [`PRODUCT_METRICS.md`](PRODUCT_METRICS.md).
`GET /product?days=N` отдаёт value, funnel, retention, quality, release health
и coverage; `/summary` сохраняет общий контракт Traction, `/timeseries` — UTC
ряды для дашборда.

## История без нового релиза

Уже выпущенные клиенты отправляют полную privacy-safe воронку в PostHog.
Идемпотентный importer переносит только явный allowlist полей и дедуплицирует
данные с direct ingest по `event_id`:

```bash
export POSTHOG_PERSONAL_API_KEY=phx_...  # query:read, только на сервере
export POSTHOG_PROJECT_ID=12345
export STATS_DB=/srv/stats/gigatype/data/events.db
.venv/bin/python import_posthog.py --since 2026-07-01T00:00:00Z
```

Для регулярного догона можно запускать перекрывающееся окно: повторный импорт
безопасен (`event_id` уникален). Секреты не добавлять в репозиторий и не
передавать в браузер.

Важно: `eu.posthog.com` отвечает текущему серверу в Yandex Cloud (RU)
`403 PostHog is not available in your region`. Поэтому personal key нельзя
считать рабочей серверной конфигурацией на i167. Разовый backfill запускается
на доверенной машине вне этой блокировки в отдельную SQLite-базу, после чего
на сервер переносится только результат allowlist-проекции. Для переходного
регулярного догона нужен runner/relay вне RU; после выпуска direct Traction
delivery он удаляется, а PostHog key отзывается.

Архитектура хранения, оценка объёма и план миграции:
[`STORAGE_ARCHITECTURE.md`](STORAGE_ARCHITECTURE.md).

## Проверка

```bash
.venv/bin/python -m unittest -v test_stats.py
```

Прод: `/srv/stats/gigatype/`, юнит `stats-gigatype` (порт 9902), токен в
systemd drop-in. `VERSION` штампуется деплоем и отдаётся в `/health`.
Как подключать/деплоить — `traction/ONBOARDING.md` в репо GigaTool.
