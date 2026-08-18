# stats — модуль статистики GigaType для хаба Traction

Модуль по контракту Traction (репо GigaTool, `specs/stats-hub.md` §4):
`/health`, `/summary` (ядро + витрина GigaType), `POST /events` с project key,
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
Receiver повторно проверяет event/property allowlist, требует `event_id`,
отбрасывает PII/free-form payload и дедуплицирует запись. Вшитый в desktop
project key — барьер от случайного трафика, а не секрет от владельца клиента;
периметр ограничивает тело запроса, а receiver — частоту по непостоянным хэшам
IP/device без записи исходных идентификаторов.

У каждой записи два времени: `ts` — клиентское время события (сохраняется для
продуктовой хронологии), `received_at` — серверное время приёма (для контроля
задержки доставки и проблем часов клиента). `ingest_source` отдельно отмечает
`direct`, `posthog` или старые строки `unknown`; источник доставки не меняет
семантику метрики.

Канонический DAU/WAU/MAU считает только человеческую активность
(`first_app_opened`, `dictation`, `dictation_finished`). `app_opened` может
приходить от автозапуска ОС, поэтому он показан отдельно как **App running
DAU**, а разница с каноническим DAU — как **startup-only**. Так подробная
страница сохраняет оба ответа, но фоновый старт не раздувает общий DAU флота.

Метрики и знаменатели зафиксированы в [`PRODUCT_METRICS.md`](PRODUCT_METRICS.md).
`GET /product?days=N` отдаёт value, funnel, retention, quality, release health
и coverage; `/summary` сохраняет общий контракт Traction, `/timeseries` — ряды
по московским датам для дашборда. Дневные окна календарные: `days=1`
начинается в 00:00 MSK,
а не ровно 24 часа назад.

## Ответы отдаются из кэша, считаются в фоне

Хаб опрашивает `/health` и `/summary?days=1/7/30` раз в минуту с таймаутом
**5 секунд**, обсерверному прокси на `/product` отведено 15 — а полный
пересчёт растёт вместе с историей и 13.08.2026 перевалил за таймаут на всех
окнах сразу (карточка Тайпа замёрзла на пятичасовом снапшоте, дашборд
опустел). Поэтому запрос никогда не считает: он отдаёт последнее посчитанное
значение, а пересчитывает фоновый поток (`stats-refresher`), стартующий из
lifespan и прогревающий 1/7/30 сразу при запуске.

- `STATS_CACHE_TTL` (90 с) — как часто фон пересчитывает ключ; на столько же
  максимум отстают числа.
- `STATS_REFRESH_TICK` (15 с) — период обхода ключей. Обход идёт по
  зависимостям: `events` → `retention` → `product:*` → `summary:*` →
  `timeseries:*`.
- Ingest **не** сбрасывает кэш: при DAU в сотни устройств события идут
  непрерывно, и инвалидация по записи означала бы «кэша нет вообще» — ровно
  это и уронило витрину.
- Если фоновый поток умер, значение старше `10 × TTL` пересчитает сам запрос.

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
на сервер переносится только результат allowlist-проекции. Переходный
регулярный догон выполняет `.github/workflows/sync-posthog-stats.yml`:
GitHub-hosted runner каждые 6 часов читает перекрывающееся 36-часовое окно и
сразу отправляет allowlisted батчи в receiver, не сохраняя raw export или
artifact. После достаточного rollout direct Traction delivery workflow
удаляется, а PostHog personal key отзывается.

То есть PostHog здесь не является источником расчёта и не нужен новым
клиентам: это временный транспортный мост для уже установленных версий, которые
ещё не умеют отправлять события напрямую в Traction. Дедупликация по
`event_id` не позволяет мосту и direct ingest посчитать одно событие дважды.

Архитектура хранения, оценка объёма и план миграции:
[`STORAGE_ARCHITECTURE.md`](STORAGE_ARCHITECTURE.md).

## Проверка

```bash
.venv/bin/python -m unittest -v test_stats.py
```

Прод: `/srv/stats/gigatype/`, юнит `stats-gigatype` (порт 9902), токен в
systemd drop-in. `VERSION` штампуется деплоем и отдаётся в `/health`.
Как подключать/деплоить — `traction/ONBOARDING.md` в репо GigaTool.
