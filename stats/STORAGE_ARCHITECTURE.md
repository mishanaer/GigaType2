# GigaType / Memento telemetry storage

Статус: принято для текущего масштаба. Замеры: 2026-07-23 UTC.

## Решение

Не разворачивать PostHog, ClickHouse, общий live-event database или общий
event-архив на текущем сервере. Сохранять контракт Traction: у каждого продукта
свой процесс, свой SQLite/WAL и свой backup lifecycle, а хаб читает только
стабильные `/summary` и `/series`. Общими остаются только формат API и правила
privacy/quality — не файл данных, bucket/prefix или lock-domain.

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

## Контракт конверта

Каждый продукт использует одинаковый минимальный API-конверт, но хранит его
в собственной схеме:

- `event_id` — обязательный idempotency key;
- `ts` — время события с серверным clamp некорректных часов;
- `device_id` — анонимный install/device, не человек;
- `name`, `contract_version`, `app_version`, `platform`, `channel`;
- опциональные `session_id` и `source`;
- allowlisted product-specific `properties`.

Поле `product` в live SQLite не нужно: граница продукта задаётся модулем и
файлом БД.

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
- Сейчас: SQLite online backup на текущий диск, отдельно для каждого продукта,
  30 скользящих ежедневных снимков; это защищает от ошибки приложения, но не
  от потери VM или диска.
- Опционально: одна weekly-копия каждого продукта в отдельный private bucket
  Yandex Object Storage. Это disaster-recovery слой, а не общее хранилище логов.
- Если одной базе понадобится дешёвый долгий event-retention, только её старые
  партиции можно переводить в собственный Parquet/Zstd-архив и читать DuckDB.
- Traction никогда не читает SQLite другого продукта и не строит dashboard
  запросом к backup/cold archive.
- Event-level retention: начать с 13 месяцев; суточные агрегаты хранить дольше.
  Менять срок только после определения юридической/продуктовой потребности.

## Диск или Yandex Object Storage

На сервере сейчас свободно 101.8 GiB. Проверенный online-backup всех Traction
SQLite после импорта GigaType занимает 19.0 MiB в gzip; 30 текущих ежедневных
копий при неизменном размере — около 0.56 GiB. Поэтому для ёмкости Object
Storage сейчас не нужен: рабочие базы и локальные backups остаются на диске.

Object Storage имеет смысл только как защита от потери VM/диска. На
2026-07-23 STANDARD стоит 2.376 ₽ за GiB-месяц с НДС, первый 1 GiB, первые
10,000 записей и 100,000 чтений в месяц бесплатны:
https://yandex.cloud/ru/docs/storage/pricing

- текущий объём backups: 0 ₽/месяц;
- если зеркалировать все 30 ежедневных копий и текущий поток/сжатие сохранятся,
  через год получится около 10.8 GiB, то есть примерно 23 ₽/месяц;
- если держать off-host только 5 недельных копий, прогноз через год —
  около 1.8 GiB, то есть примерно 2 ₽/месяц.

Это оценки capacity planning, а не счёт: они линейно продолжают текущие
2.3 GiB raw growth/year и текущий коэффициент gzip. Решение на сейчас —
оставить 30 daily на диске; когда потребуется disaster recovery, добавить по
5 weekly off-host копий отдельно для каждого продукта.

## Когда мигрировать с SQLite

Переходить на PostgreSQL не по числу продуктов, а при измеряемом ограничении:

- одна продуктовая БД выросла примерно до 5 GiB или нескольких миллионов строк
  и dashboard P95 перестал укладываться в 1 секунду;
- появился второй независимый writer и устойчивый `SQLITE_BUSY`;
- backup/checkpoint не укладывается в операционное окно;
- продукту постоянно нужны запросы, которым summary и его собственный архив
  уже недостаточны.

Тогда меняется storage adapter конкретного модуля или выделяется PostgreSQL,
но публичный Traction contract остаётся прежним. ClickHouse/PostHog следует
рассматривать только при масштабе на порядки выше или при явной потребности в
их продуктовой UI/feature set.
