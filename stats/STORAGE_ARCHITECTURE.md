# GigaType / Memento telemetry storage

Статус: принято для текущего масштаба. Замеры: 2026-07-23 UTC.

## Решение

Не разворачивать PostHog, ClickHouse или общий live-event database на текущем
сервере. Сохранять контракт Traction: у каждого продукта свой процесс и свой
SQLite/WAL, а хаб читает только стабильные `/summary` и `/series`. Общими
должны быть схема конверта, правила privacy/quality и холодный архив, но не
рабочий SQLite-файл и не lock-domain.

Это сохраняет главную гарантию Traction: сбой, тяжёлый запрос или миграция
одного продукта не останавливает остальные вкладки.

## Фактический масштаб

| Product | Rows | DB size | Last 7d events/day |
|---|---:|---:|---:|
| MultiTool | 181,349 | 78.7 MiB | 8,323 |
| AIWA | 27,372 | 12.6 MiB | 1,301 |
| GigaType allowlisted PostHog backfill | 45,792 | 31.3 MiB | 3,366 |
| Memento | 0 | 0.03 MiB | 0 |

При текущей физической плотности SQLite это около 2.3 GiB нового hot storage
в год для трёх живых потоков. Даже три копии (live + local backup + object
archive) дают порядок 7 GiB/год, поэтому отдельный аналитический кластер сейчас
не окупает операционную сложность.

В PostHog-проекте GigaType было 194k событий и примерно 433 MB логического JSON
properties. Храним не этот сырой payload, а только 45.8k продуктово значимых
событий и явный allowlist properties. Получившаяся база — 32.8 MB. `$ip`,
dictated text и добавленная PostHog метаинформация не переносятся.

## Общий конверт

Каждый продукт нормализует событие в одну модель:

- `event_id` — обязательный idempotency key;
- `occurred_at` и серверный `received_at`;
- `anonymous_actor_id` (install/device, не человек);
- опциональный `session_id`;
- `event_name`, `schema_version`, `app_version`, `platform`, `channel`;
- `source` (`direct`, `posthog_backfill`, `import`);
- allowlisted product-specific `properties`.

В live SQLite поле `product` не нужно: граница продукта задаётся модулем и
файлом БД. В общем Parquet-архиве `product` обязательно.

Нельзя принимать текст диктовки/встречи, prompt/response, пути, заголовки,
сырой error message, email, IP или client-generated произвольный JSON.

## Потоки данных

### GigaType

1. История PostHog уже перенесена через read-only `query:read` key и
   keyset-pagination `(timestamp, uuid)`.
2. PostHog блокирует запросы с текущего Yandex Cloud RU IP. До нового релиза
   переходный sync должен выполняться вне RU и передавать на i167 только
   allowlisted события через HTTPS.
3. Следующий подписанный релиз отправляет события напрямую в
   `/p/gigatype/events`; после достаточного rollout PostHog delivery
   выключается, bridge удаляется, personal key отзывается.

### Memento

Истории для backfill нет. Не строить переходный PostHog-контур: следующий
клиентский релиз сразу отправляет consent-gated allowlisted события в свой
Traction-модуль. Memento остаётся в отдельной БД и использует тот же envelope,
dedupe и coverage contract.

## Переходный bridge

Предпочтительный вариант — scheduled GitHub Actions runner или минимальный
EU relay без собственной БД:

1. read-only PostHog key ограничен одним проектом и `query:read`;
2. отдельный write-only ingest token ограничен одним Traction-модулем;
3. runner читает только окно с overlap, применяет allowlist до отправки;
4. сервер дедуплицирует по `event_id`;
5. runner не сохраняет raw export как artifact и не пишет payload в logs;
6. алерт срабатывает на lag, 4xx/5xx, rejected rows и отсутствие cursor advance.

GitHub-hosted runner проще временного VM, но требует защищённых repository
secrets и review любых изменений workflow. Если это неприемлемо, использовать
маленький EU relay с тем же stateless-кодом. Webhook подходит только для новых
событий и не заменяет проверяемый historical backfill.

## Backup и аналитика

- Hot path: per-product SQLite в WAL mode.
- Ежедневно: SQLite online backup, шифрованный private bucket в Yandex Object
  Storage, отдельный prefix на продукт.
- Ежемесячно или после 1 GiB: Parquet/Zstd по `product/year/month`; агрегаты
  можно читать DuckDB без постоянно работающего сервиса.
- Traction никогда не читает SQLite другого продукта и не строит dashboard
  запросом к cold archive.
- Event-level retention: начать с 13 месяцев; суточные агрегаты хранить дольше.
  Менять срок только после определения юридической/продуктовой потребности.

## Когда мигрировать с SQLite

Переходить на PostgreSQL не по числу продуктов, а при измеряемом ограничении:

- одна продуктовая БД выросла примерно до 5 GiB или нескольких миллионов строк
  и dashboard P95 перестал укладываться в 1 секунду;
- появился второй независимый writer и устойчивый `SQLITE_BUSY`;
- backup/checkpoint не укладывается в операционное окно;
- запросам постоянно нужны cross-product raw joins, а summary/Parquet уже
  недостаточны.

Тогда меняется storage adapter конкретного модуля или выделяется PostgreSQL,
но публичный Traction contract остаётся прежним. ClickHouse/PostHog следует
рассматривать только при масштабе на порядки выше или при явной потребности в
их продуктовой UI/feature set.
