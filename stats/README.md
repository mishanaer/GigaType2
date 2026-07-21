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
`dictation` (words, chars, duration_s, provider, model, lang), `app_open`,
`error`. Конверт батча несёт `device_id` (= install_id телеметрии).
Витрина карточки «Обзора»: Dictations, Median WPM, Words typed, Success rate.

Прод: `/srv/stats/gigatype/`, юнит `stats-gigatype` (порт 9902), токен в
systemd drop-in. `VERSION` штампуется деплоем и отдаётся в `/health`.
Как подключать/деплоить — `traction/ONBOARDING.md` в репо GigaTool.
