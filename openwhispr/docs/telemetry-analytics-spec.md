# ТЗ: аналитика, ошибки и дашборд Type

## Цель

Собирать анонимную продуктовую аналитику, чтобы видеть:

- total users
- successful dictation sessions
- activation funnel
- DAU / WAU / MAU
- weekly / monthly retention
- ошибки и crash events
- качество и скорость диктовки

## Провайдер

MVP: PostHog Cloud EU.

Установка:

```bash
npx -y @posthog/wizard@latest --region eu
```

Настройки PostHog:

- выключить autocapture
- выключить session replay
- выключить IP capture
- dev-события не отправлять
- отправлять события только через наш `TelemetryService`

PostHog Cloud EU подходит для MVP. Если понадобится хранить данные строго в РФ, нужен self-host на нашем сервере.

Runtime env/config:

```bash
GIGATYPE_POSTHOG_API_KEY=...
GIGATYPE_POSTHOG_HOST=https://eu.i.posthog.com
GIGATYPE_TELEMETRY_ENABLED=true
```

В production telemetry включена по умолчанию, если задан `GIGATYPE_POSTHOG_API_KEY`.
В development telemetry выключена по умолчанию и включается только через `GIGATYPE_TELEMETRY_ENABLED=true`.

## Платформы

MVP можно внедрять на macOS, но схема событий должна сразу поддерживать будущие Windows и Linux сборки.

Во всех событиях должны быть поля:

```ts
{
  platform: "darwin" | "win32" | "linux",
  platform_name: "macOS" | "Windows" | "Linux",
  os_version: string,
  os_version_major: string,
  arch: "arm64" | "x64" | "arm" | "ia32" | "unknown",
  app_version: string,
  app_channel: "production" | "development" | "unknown"
}
```

Для Linux дополнительно, если доступно без лишних permission:

```ts
{
  linux_distro?: string,
  linux_desktop_session?: "wayland" | "x11" | "unknown",
  package_format?: "appimage" | "deb" | "rpm" | "tar" | "snap" | "flatpak" | "unknown"
}
```

Эти поля нужны, чтобы видеть распределение пользователей, успешных диктовок и ошибок по платформам.

## Privacy

Никогда не отправляем:

- текст диктовки
- аудио
- clipboard content
- raw API response
- raw LLM request / response
- prompt
- email
- Google tokens
- user file paths
- полный URL с query params
- raw stack trace

Можно отправлять:

- app version
- platform
- platform name
- OS version
- arch
- provider / model
- audio duration
- recognized chars count
- recognized words count
- latency
- typed sanitized errors

## Идентификаторы

### anonymous_user_id

Стабильный anonymous UUID пользователя.

- для MVP не хранить analytics id в OS credential store / Keychain, чтобы не показывать системные prompts и не блокировать первый запуск
- хранить в encrypted local file через Electron `safeStorage`
- генерировать один раз
- сохранять между обновлениями и обычными перезапусками
- после полного удаления app data пользователь может стать новым пользователем в аналитике; для MVP это приемлемо
- если encrypted fallback недоступен, хранить plain UUID в local config как последний fallback
- Keychain можно рассмотреть позже только асинхронно после старта приложения и с timeout, если retention между reinstall станет критичным

### install_id

ID конкретной установки.

- хранить в local app config
- генерировать UUIDv4 при первом запуске
- после переустановки может измениться

Пользователь для MVP = одна установка с одним `install_id`.

## Dev Mode

В dev-сборках telemetry выключена по умолчанию.

Включение только явно:

```bash
GIGATYPE_TELEMETRY_ENABLED=true
```

## Activation Funnel

Основная воронка:

```txt
first_app_opened
→ requirements_ready
→ model_ready
→ settings_screen_viewed
→ dictation_output_succeeded
```

Дополнительные события:

```txt
permission_granted
requirement_status_changed
all_required_permissions_granted
model_download_started
model_download_succeeded
model_download_failed
settings_screen_viewed
```

`requirements_ready` = все требования для первой диктовки выполнены.

Состав требований зависит от платформы:

```ts
{
  microphone_ready: boolean,
  macos_accessibility_ready?: boolean,
  windows_paste_tool_ready?: boolean,
  linux_paste_tool_ready?: boolean
}
```

На Windows/Linux `accessibility` не считать буквальным permission. Для них это статус готовности paste tooling.

Если модель уже есть:

```ts
model_ready { source: "cached" }
```

Если модель скачалась:

```ts
model_ready { source: "downloaded" }
```

Правило определения `model_ready.source`:

- `cached` — модель была полной локально до текущего запуска sidecar
- `downloaded` — в текущем запуске был статус `downloading`, затем `ready`
- `unknown` — источник нельзя определить надёжно

## Dictation Session

Successful dictation = пользователь зажал hotkey, аудио >= 1s, текст распознался и результат вставился или скопировался.

Если paste не сработал, но текст скопировался в clipboard, это success.

Для текста считаем только длины, без содержимого:

- `raw_transcript_chars` / `raw_transcript_words` — до финальной обработки
- `final_output_chars` / `final_output_words` — финальный текст, который получил пользователь

Основные продуктовые метрики считать по `final_output_chars` и `final_output_words`.

## MVP Events

```txt
first_app_opened
app_opened

permission_granted
all_required_permissions_granted
requirements_ready

model_download_started
model_download_succeeded
model_download_failed
model_ready
settings_screen_viewed

dictation_started
dictation_output_succeeded

error_occurred
main_process_error
renderer_process_gone
app_crashed
```

## Common Event Fields

```ts
{
  anonymous_user_id: string,
  install_id: string,
  app_version: string,
  app_channel: "production" | "development" | "unknown",
  platform: "darwin" | "win32" | "linux",
  platform_name: "macOS" | "Windows" | "Linux",
  os_version: string,
  os_version_major: string,
  arch: "arm64" | "x64" | "arm" | "ia32" | "unknown",
  timestamp: string
}
```

## Dictation Event Fields

```ts
{
  session_id: string,
  provider: "gigaam_local" | "unknown",
  model: string,

  audio_duration_ms: number,
  raw_transcript_chars: number,
  raw_transcript_words: number,
  final_output_chars: number,
  final_output_words: number,

  output_method: "paste" | "clipboard",
  output_status:
    | "inserted_verified"
    | "inserted_unverified"
    | "clipboard_fallback"
    | "failed",

  total_latency_ms: number,
  transcription_latency_ms: number,
  output_latency_ms: number,

  success: boolean
}
```

## Errors

Raw stack trace не отправляем.

Формат ошибки:

```ts
{
  event: "error_occurred",
  error_area: "model_download",
  error_code: "DNS_FAILED",
  safe_message: "DNS resolution failed",
  stack_hash: "abc123",
  provider: "huggingface"
}
```

Error areas:

```txt
app_start
permissions
model_download
model_load
microphone
transcription
paste
clipboard
update
unknown
```

Crash reporting:

- отправлять typed events:
  - `main_process_error`
  - `renderer_process_gone`
  - `app_crashed`
- payload только sanitized
- PostHog Error Tracking включать только после sanitizer

`app_crashed` использовать только когда приложение действительно завершилось/упало. Если main поймал `uncaughtException` и продолжил работу, это `main_process_error`. Если упал renderer, это `renderer_process_gone`.

## Offline Queue

Если нет интернета:

- события складывать локально
- отправлять батчами
- flush каждые 30 секунд или каждые 20 событий
- хранить максимум 7 дней
- максимум 1000 событий
- старые события удалять
- telemetry payload локально не логировать

Формат хранения очереди:

- JSONL или SQLite в `app.getPath("userData")`
- без текста, аудио, clipboard и raw responses
- без debug logging payload

## One-Time Events Idempotency

One-time события отправлять один раз на `install_id`.

Локально хранить флаги:

```txt
first_app_opened_sent
settings_screen_viewed_sent
```

Повторная отправка допустима только при retry offline queue с тем же `event_id`.

# Dashboard Metrics

## North Star

### Successful Dictations

Количество `dictation_output_succeeded`.

Периоды:

- today
- 7d
- 30d

## Users

### Total Users

Unique `install_id`.

### DAU

Unique users с `dictation_output_succeeded` за день.

### WAU

Unique users с `dictation_output_succeeded` за последние 7 дней.

### MAU

Unique users с `dictation_output_succeeded` за последние 30 дней.

## Activation

### Activation Funnel To First Dictation

```txt
first_app_opened
→ requirements_ready
→ model_ready
→ settings_screen_viewed
→ dictation_output_succeeded
```

### Requirements Ready Conversion

```txt
requirements_ready / first_app_opened
```

### Model Ready Conversion

```txt
model_ready / requirements_ready
```

### Median Time To Activation

От `first_app_opened` до первого `dictation_output_succeeded`.

## Dictation Quality

### Dictation Success Rate

```txt
dictation_output_succeeded / dictation_started
```

### Clipboard Fallback Rate

```txt
output_status = clipboard_fallback / dictation_output_succeeded
```

### Average Dictations Per Active User

```txt
dictation_output_succeeded / active_users
```

### Median Dictations Per Active User Per Day

```txt
median(
  count(dictation_output_succeeded)
  per install_id
  per day
)
```

Активный пользователь = user с хотя бы одной успешной диктовкой в этот день.

Показывать:

- today
- 7d average
- 30d average

### Average Final Output Characters

Среднее `final_output_chars` на успешную диктовку.

### Average Final Output Words

Среднее `final_output_words` на успешную диктовку.

### Average Raw Transcript Characters

Среднее `raw_transcript_chars` на успешную диктовку.

### Average Raw Transcript Words

Среднее `raw_transcript_words` на успешную диктовку.

### Average Audio Duration

Среднее `audio_duration_ms` на успешную диктовку.

## Performance

### Median Total Latency

Median `total_latency_ms`.

### P95 Total Latency

P95 `total_latency_ms`.

### Median Transcription Latency

Median `transcription_latency_ms`.

### P95 Transcription Latency

P95 `transcription_latency_ms`.

### Median Output Latency

Median `output_latency_ms`.

### Time To Model Ready

От `first_app_opened` до `model_ready`.

Показывать median и p95.

### Time To First Successful Dictation

От `first_app_opened` до первого `dictation_output_succeeded`.

Показывать median и p95.

## Model Download

### Model Download Success Rate

```txt
model_download_succeeded / model_download_started
```

### Model Download Failure Rate

```txt
model_download_failed / model_download_started
```

### Model Ready Source

Breakdown:

```txt
cached
downloaded
```

### Top Model Download Errors

Группировка по:

```txt
error_code
provider
```

## Errors

### Total Errors

Количество `error_occurred`.

### Dictation Error Rate

```txt
error_occurred where error_area in (microphone, transcription, paste, clipboard)
/
dictation_started
```

Общие app/model/update ошибки считать отдельно, чтобы не раздувать error rate диктовки.

### Top Error Areas

Группировка по `error_area`.

### Top Error Codes

Группировка по `error_code`.

### Crash Count

Количество `app_crashed`.

### Main Process Error Count

Количество `main_process_error`.

### Renderer Process Gone Count

Количество `renderer_process_gone`.

### Crash-Free Users

```txt
users without app_crashed / active_users
```

## Platform Distribution

### Active Users By Platform

Unique users с `dictation_output_succeeded`, grouped by:

```txt
platform_name
```

### Successful Dictations By Platform

Количество `dictation_output_succeeded`, grouped by:

```txt
platform_name
```

### Activation Rate By Platform

```txt
dictation_output_succeeded / first_app_opened
```

Grouped by:

```txt
platform_name
```

### Dictation Success Rate By Platform

```txt
dictation_output_succeeded / dictation_started
```

Grouped by:

```txt
platform_name
```

### Error Rate By Platform

```txt
error_occurred / active_users
```

Grouped by:

```txt
platform_name
error_area
```

### Platform Version Distribution

Unique active users grouped by:

```txt
platform_name
os_version_major
arch
```

For Linux additionally:

```txt
linux_distro
linux_desktop_session
package_format
```

## Retention

### Weekly Dictation Retention

Из пользователей, которые сделали successful dictation на неделе N, сколько сделали successful dictation на неделе N+1.

### Monthly Dictation Retention

Из пользователей, которые сделали successful dictation в месяце N, сколько сделали successful dictation в месяце N+1.

## Breakdowns

Для ключевых метрик:

```txt
app_version
app_channel
platform
platform_name
os_version
os_version_major
arch
linux_distro
linux_desktop_session
package_format
provider
model
model_ready.source
output_method
output_status
error_area
error_code
```

## Acceptance Criteria

- В PostHog видна activation funnel.
- DAU / WAU / MAU считаются по successful dictation.
- Retention считается по weekly/monthly cohorts.
- Dashboard показывает median dictations per active user per day.
- Dashboard показывает распределение active users, successful dictations, activation rate и errors по платформам.
- Ошибки приходят без текста, аудио, clipboard и raw responses.
- Dev-события не попадают в production project.
- При тестовой диктовке с секретной фразой эта фраза не находится ни в telemetry payload, ни в PostHog.
