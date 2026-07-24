# Type: системные решения и план тестирования

Дата анализа: 24 июля 2026

База: `main` / `01f507cb12026baa5f5b01d6b05af198ce9eeabd`

## Статус реализации в `codex/system-bugs-design`

В этот PR вошёл безопасный первый срез решений:

- `nircmd.exe` полностью удалён из runtime, packaging и release workflows; штатная вставка использует собственный `windows-fast-paste`, fallback — PowerShell без `ExecutionPolicy Bypass`;
- встроенный GigaAM больше не открывает TCP-порт по умолчанию и вызывается через Electron IPC; legacy HTTP включается только `GIGAAM_HTTP_BRIDGE=1`;
- Windows CLI HTTP bridge выключен по умолчанию и включается только `TYPE_CLI_BRIDGE=1`, поэтому штатный запуск не требует входящего Firewall rule;
- капсула имеет видимый CSS fallback, две bounded-попытки пересоздания WebGL renderer, `backgroundThrottling: false`, reload после renderer crash и один источник истины видимости в renderer; после Windows resume overlay возвращается в hidden/non-focusable/click-through и Windows hook запускается заново;
- ручное назначение Fn снова разрешено; при занятом системном действии показывается предупреждение, но сохранение не блокируется;
- Windows capture переведён на существующий low-level helper: `Win+клавиша`, `Caps Lock` и `Caps Lock+клавиша` принимаются без запуска системного сочетания; `Escape` отменяет capture; Caps Lock работает через native down/up backend в режимах «Нажатие» и «Удержание»;
- на macOS всегда создаётся menu-bar item, добавлена сохраняемая настройка Dock, а скрытие Dock не применяется, если recovery icon создать не удалось.

Остаются отдельными follow-up: Windows Named Pipe для CLI вместо opt-in TCP compatibility mode, Authenticode/signing gate, main-process coordinator настройки капсулы и расширенная GPU telemetry.

## Результаты первого ручного Windows-прогона

Проверена unsigned сборка из commit `cb67b5031791fcff0170ddb6915e70ad73e15d87`.

- `WIN-NET-04`: пройден — локальное распознавание работает без интернета.
- `HOTKEY-07`: пройден — после неуспешного назначения старый хоткей продолжает работать.
- `CAP-01`: не пройден — сразу после загрузки капсула могла появиться и тут же исчезнуть; через 1–2 минуты поведение стабилизировалось.
- `CAP-04`: не пройден — после sleep/wake звук и распознавание работали, но капсула могла не показываться; позже восстанавливалась. Наблюдалось взаимодействие с поиском Start, поэтому отдельно проверяется, что overlay не получает focus.
- `HOTKEY-08`: не пройден — `Win+F-key` и `Win+цифра` принимались, а часть `Win+буква` уходила Windows; Caps Lock не принимался; Escape ошибочно сохранялся как хоткей.
- `CAP-08`: требует уточнения режима дисплеев. В «Дублировать» одинаковая капсула на двух экранах является выводом Windows; в «Расширить» должна существовать одна капсула только на display курсора.

Follow-up реализация устраняет подтверждённые причины:

1. Renderer показывает окно только после фактического перехода audio state в `recording | processing`; main больше не показывает пустое окно до этого перехода.
2. `powerMonitor.resume` скрывает и восстанавливает свойства overlay, затем пересоздаёт требуемый low-level Windows hook.
3. Во время назначения low-level capture подавляет принятую последовательность до shell и возвращает канонический хоткей в renderer.
4. Escape завершает capture без `onChange`, поэтому старое назначение остаётся активным.

## Результаты второго ручного Windows-прогона

Проверена unsigned сборка из commit `247c9d3a92c8b5873c275316463c66f5f30218a3`.

- `HOTKEY-10`: пройден — Escape закрывает capture и сохраняет старый хоткей.
- `CAP-08`: пройден для режима «Дублировать» — одинаковая капсула на двух экранах является ожидаемым результатом зеркального вывода Windows.
- `HOTKEY-09`: частично — `Win+F3` назначается, но `Win+буква`/`Win+L` могли уйти Windows; при `Win+L` система блокировалась.
- `CAP-04`: улучшено, но после resume оставались редкие невидимые первые сессии.
- `CAP-10`: не пройден — при открытом меню «Пуск» диктовка запускалась, но капсула оставалась под shell surface и не была видна.

Второй follow-up закрывает две найденные гонки:

1. UI переходит в состояние «слушаю хоткей» только после `READY` от установленного low-level Windows hook. До подтверждения renderer не принимает сочетание; таймаут отменяет capture и восстанавливает прежний хоткей. Поэтому `Win+L`/`Win+буква` не имеют окна, в котором событие может уйти Explorer.
2. На Windows капсула использует уровень `screen-saver`, после `showInactive()` вызывается `moveTop()`, а z-order повторно подтверждается через 0/75/250 мс. Ни один из этих путей не вызывает `focus()`, поэтому активный input/поиск сохраняется.

## Результаты третьего ручного Windows-прогона

Проверена unsigned сборка из commit `94a744c93799c1d2f55b4b762327c6695aa0b0c0`.

- Dr.Web не блокирует приложение и не мешает распознаванию.
- Общая стабильность капсулы улучшилась.
- `Win+L` всё ещё приводил к блокировке Windows.
- `Win+Space` не давал ожидаемого shake.
- При foreground-фокусе в открытом меню «Пуск» распознавание работало, но нижняя капсула оставалась невидимой.
- Физический `Fn` и сочетания с ним не обнаруживались.

Третий follow-up меняет контракт в проблемных местах:

1. Native capture больше не отдаёт сочетание в renderer на key-down. Он запоминает комбинацию, подавляет всю последовательность и отправляет результат только после отпускания base key и всех модификаторов. Поэтому остановка helper после validation больше не выпускает остаточные key-up в Windows.
2. `Win+L`, `Win+Space` и `Win+A` явно относятся к зарезервированным Windows сочетаниям: они подавляются во время capture, отклоняются с shake и не заменяют прежний хоткей.
3. При foreground-процессе `StartMenuExperienceHost`, `SearchHost` и совместимых Windows Search hosts капсула переносится к верхнему краю display. Это обходит защищённый z-order меню «Пуск» без закрытия меню и без `focus()`.
4. Аппаратный `Fn` на большинстве Windows-клавиатур обрабатывается firmware/драйвером и не создаёт стандартного virtual-key события. UI теперь сообщает «Fn недоступна» в самом режиме назначения; поддержка возможна только через vendor-specific keyboard API/driver.

## Резюме решений

1. На Windows полностью убрать `nircmd.exe` из исходников, сборки и runtime-цепочек. Вставку уже выполняет собственный `windows-fast-paste.exe`; функции управления медиа нужно оставить на GSMTC и перенести fallback в собственный подписанный helper. Все исполняемые файлы внутри дистрибутива должны быть подписаны и проверяться отдельным CI-gate.
2. Не просить пользователя разрешать Type входящие подключения в Windows Firewall. В штатном режиме приложению они не нужны. Локальный GigaAM перевести с loopback HTTP на Electron IPC, а CLI bridge — на Windows Named Pipe и Unix Domain Socket. До этой миграции нужно точно зафиксировать executable/PID, который вызывает prompt.
3. Капсула должна иметь видимый CSS/2D fallback и самостоятельно восстанавливаться после потери WebGL/GPU context, sleep/wake и падения renderer. Сейчас ошибка WebGL намеренно делает капсулу полностью прозрачной, а событие ошибки никто не обрабатывает.
4. На macOS разрешить назначение `Fn`, даже если за ним закреплено системное действие, но показывать понятное предупреждение о конфликте. Не менять системную настройку автоматически. `Caps Lock` добавить в модель допустимых одиночных клавиш; в первой версии гарантировать его для режима «Нажатие», а режим «Удержание» включать только после появления надёжного native key-down/key-up backend.
5. На macOS добавить два режима присутствия: «Dock + строка меню» и «Только строка меню». Сначала необходимо гарантированно создать menu-bar item, и только затем разрешать скрытие Dock. Управление `app.dock` и activation policy должно быть централизовано и учитывать сохранённую настройку во всех путях открытия окна.

## Что обнаружено в текущем `main`

### Windows: `nircmd.exe` и Firewall

- `prebuild:win` и Windows release workflow скачивают `nircmd.exe`.
- `electron-builder.json` явно кладёт его в `resources/bin`.
- `clipboard.js` использует его только как fallback после собственного `windows-fast-paste.exe`.
- `mediaPlayer.js` использует его только как fallback для клавиши Play/Pause после GSMTC.
- Сборка `windows-dev-build-wired` прямо помечена как unsigned. Это повышает риск SmartScreen/AV-срабатываний для приложения и всех helper-процессов.
- `nircmd.exe` является сторонней универсальной системной утилитой и закономерно попадает под эвристики антивирусов. Кроме того, в скрипте загрузки указана лицензия «Free for non-commercial use», что является отдельным основанием убрать зависимость из продукта.
- Распознавание продолжает работать после карантина `nircmd.exe`, потому что ASR с ним не связан, а основной путь вставки использует `windows-fast-paste.exe`.
- Type открывает как минимум два TCP listener от основного процесса:
  - GigaAM local ASR: `127.0.0.1:8765–8775`;
  - CLI bridge: `127.0.0.1:8200–8219`.
- Оба listener ограничены loopback, поэтому разрешение входящего доступа из частных или публичных сетей не нужно. Сам факт создания server socket объясняет, почему Windows может показать dialog. Точный виновник всё равно необходимо подтвердить по executable/PID на чистой машине.
- Текущая инструкция Troubleshooting предлагает antivirus exclusion, запуск от администратора и разрешение Firewall. Для штатной диктовки это неверная продуктовая позиция и маскирует дефекты дистрибутива.

### Капсула

- Настройка `hideCapsule` хранится в renderer `localStorage`, а окно капсулы узнаёт об изменении через browser `storage` event.
- Main process показывает overlay независимо от этой настройки; renderer затем может тут же спрятать окно. Получается лишняя гонка между lifecycle окна и состоянием React.
- Новая Golos capsule требует WebGL2.
- При отсутствии WebGL, ошибке shader/framebuffer или `webglcontextlost` canvas получает `data-fallback="true"`.
- CSS для этого состояния устанавливает всей капсуле `opacity: 0`. То есть текущий fallback — это намеренное отсутствие любого индикатора.
- `SiriRenderer` отправляет `siri-render-error`, но компонент и main process на событие не подписаны: нет повторной инициализации, reload, диагностики или telemetry.
- Если browser сам не восстановит WebGL context, animation loop больше не запускается.
- Для окна капсулы не задано `backgroundThrottling: false`, хотя окно большую часть времени скрыто.
- `render-process-gone` только логируется; renderer капсулы не перезагружается.
- `powerMonitor.resume` не восстанавливает состояние overlay.

Это хорошо совпадает с симптомом «после перезапуска снова работает»: перезапуск создаёт новый renderer и новый WebGL context.

### `Fn` и `Caps Lock`

- `Fn` на macOS обрабатывается собственным Swift listener и поддерживает события down/up.
- После коммита `aa5bba6` UI блокирует назначение `Fn`, если private preference `AppleFnUsageType` не равен `0` или не читается. Это не техническая невозможность регистрации, а продуктовый запрет из-за возможного конфликта с системными Emoji/Input Source/Dictation.
- Само системное действие приложение подавить не может через используемый `NSEvent` global monitor.
- `Caps Lock` есть в списке modifier-кодов UI, но:
  - не преобразуется в значение хоткея;
  - не попадает в tracked modifier state;
  - на key-up не создаёт результат.
- Поэтому текущий capture для `Caps Lock` гарантированно завершается без назначения.
- Electron официально поддерживает `Capslock` как accelerator key code, поэтому для tap-to-toggle сначала следует использовать штатный `globalShortcut`, а не сразу расширять native helper.
- `globalShortcut` не даёт key-up semantics. Для настоящего push-to-talk на `Caps Lock` потребуется отдельный native backend либо явное ограничение UI.

### Dock на macOS

- `LSUIElement` сейчас равен `false`, и startup принудительно использует activation policy `regular`.
- macOS tray/menu-bar код уже есть и умеет открывать control panel и завершать приложение, но его создание намеренно пропускается.
- В нескольких местах `app.dock.show()` вызывается без проверки пользовательской настройки: открытие из tray, `ready-to-show`, `activate`.
- Ранее `app.dock.hide()` при закрытии панели уже был, но его удалили именно потому, что без menu-bar item пользователь терял путь обратно в UI.

## Решение 1. Windows без `nircmd.exe` и лишнего сетевого разрешения

### 1A. Полное удаление `nircmd.exe`

Изменения:

1. Удалить `download:nircmd`, шаги download из CI и `win.extraResources`.
2. Удалить `getNircmdPath`, `getNircmdStatus`, `pasteWithNircmd*` и nircmd-ветку из `mediaPlayer.js`.
3. Переименовать метрики/константы вида `win32_nircmd`, если они фактически используются собственным fast-paste.
4. Основной путь вставки оставить на `windows-fast-paste.exe`, который уже использует Win32 `SendInput`.
5. Временный fallback после ошибки fast-paste — PowerShell без `ExecutionPolicy Bypass`; целевое решение — собственный подписанный native subcommand.
6. GSMTC оставить основным способом pause/resume. Fallback media key перенести в собственный helper.
7. Обновить Troubleshooting: не предлагать exclusions и запуск от администратора как штатное решение.

Целевой runtime-контракт собственного Windows helper:

- код находится в этом репозитории;
- бинарник собирается из зафиксированного commit/source, а не скачивается по `latest`;
- SHA-256 артефакта проверяется перед упаковкой;
- Authenticode-подпись принадлежит тому же publisher, что и Type;
- helper имеет узкий интерфейс, например `paste`, `media-toggle`, `listen-hotkey`;
- helper не слушает сеть;
- ошибки возвращаются структурированным exit code/stdout без данных диктовки.

`SendInput` не сможет вставить текст в процесс с более высоким integrity level из обычного Type из-за UIPI. Это нормальное ограничение Windows: Type не должен запускаться от администратора ради обхода ограничения. В UI/логах нужно возвращать понятную причину для elevated target.

### 1B. Подпись и supply-chain gate

Production/QA artifact, по которому принимается задача, не должен быть unsigned.

CI должен падать, если:

- installer, portable exe, основной `Type.exe` или любой вложенный `.exe`/`.dll` не подписан;
- publisher отличается от ожидаемого;
- timestamp отсутствует или подпись невалидна;
- в artifact найден `nircmd.exe`;
- скачиваемый helper не имеет зафиксированной версии и hash.

Unsigned dev artifact можно оставить только для разработки, но нельзя использовать его как доказательство отсутствия AV/SmartScreen-проблем.

### 1C. Удаление штатных TCP listener

Целевое состояние по умолчанию: после запуска Type не имеет listening TCP/UDP ports.

1. Local ASR:
   - вынести из `GigaamLocalAsrManager` прямой метод транскрибации;
   - renderer вызывает его через ограниченный Electron IPC;
   - remote/cloud providers продолжают использовать HTTPS;
   - OpenAI-compatible loopback HTTP API не стартует в обычном desktop flow.
2. CLI bridge:
   - Windows: `\\.\pipe\gigatype-<user-scope>`;
   - macOS/Linux: Unix Domain Socket с правами только текущего пользователя;
   - существующий bearer token оставить как дополнительную защиту;
   - TCP compatibility mode, если он действительно нужен внешним клиентам, сделать выключенной advanced-настройкой с явным описанием.
3. Любые optional local servers (например, локальная LLM) запускать лениво только при выборе соответствующей функции.

Не следует автоматически добавлять broad inbound firewall rule для `Type.exe`: приложение не должно быть доступно из LAN.

## Решение 2. Самовосстанавливающаяся капсула

### Модель состояния

Добавить `CapsuleCoordinator`, который знает:

- пользовательскую настройку `showCapsule`;
- фазу `idle | listening | transcribing`;
- готовность renderer `initializing | ready | degraded | failed`;
- поколение renderer/context, чтобы игнорировать устаревшие callbacks.

Настройка должна иметь один main-process source of truth и рассылаться в оба renderer через IPC. `localStorage` можно оставить как миграционный источник, но не как межоконный transport.

### Отрисовка и восстановление

1. Всегда иметь видимый CSS/Canvas2D fallback с состояниями «запись» и «распознавание».
2. WebGL использовать как progressive enhancement поверх fallback.
3. На `siri-render-error` и `webglcontextlost`:
   - немедленно показать fallback;
   - остановить старый RAF;
   - пересоздать canvas/renderer с bounded backoff;
   - после успешного кадра плавно вернуть WebGL.
4. После заданного числа неудач не скрывать UI: оставить fallback до следующей сессии и записать безопасную диагностику.
5. Добавить `backgroundThrottling: false` окну капсулы.
6. На `powerMonitor.resume`, смену display configuration, `render-process-gone` и GPU child-process failure:
   - проверить health/ready handshake;
   - при необходимости reload/recreate только overlay renderer;
   - восстановить текущую фазу без запуска второй записи.
7. `showDictationPanel()` не должен показывать пустое окно:
   - если капсула выключена, окно вообще не показывается, но диктовка работает;
   - если включена, fallback может быть показан сразу, а WebGL подключается после ready.

### Наблюдаемость

Без текста и аудио отправлять:

- `capsule_render_failed` с platform, arch, reason category и GPU backend category;
- `capsule_context_restored` с количеством попыток;
- `capsule_renderer_reloaded`;
- `capsule_degraded_session`.

В debug log сохранять lifecycle: show request, renderer ack, context lost/restored, fallback active, hide reason.

## Решение 3. `Fn` и `Caps Lock`

### Единая таблица возможностей

Вместо распределённых `if (platform...)` завести capability model:

| Клавиша   |       macOS tap |                          macOS push |                         Windows tap |                            Windows push |
| --------- | --------------: | ----------------------------------: | ----------------------------------: | --------------------------------------: |
| Fn/Globe  |          native |                      native down/up | недоступно на большинстве клавиатур |                              недоступно |
| Caps Lock | Electron/native | только после native down/up backend |                     Electron/native | existing low-level hook после доработки |

UI показывает только реально поддерживаемые комбинации и объясняет ограничение до сохранения.

### `Fn`

1. Заменить boolean `isFnHotkeyAvailable()` на структурированный результат:
   - listener доступен/недоступен;
   - обнаружено ли системное действие;
   - тип известного конфликта;
   - можно ли продолжить.
2. Если native listener получил Fn event, позволить назначение.
3. При `AppleFnUsageType != 0` показать предупреждение:
   - Type и системное действие могут сработать одновременно;
   - дать кнопку перехода в Keyboard Settings;
   - «Использовать всё равно» и «Отмена».
4. Не менять `com.apple.HIToolbox` автоматически: это private и нестабильная настройка.
5. При неизвестном значении разрешать назначение после предупреждения, а не блокировать без объяснения.
6. Регистрацию сделать транзакционной: старый хоткей остаётся активным, пока новый backend не подтвердил успех.

### `Caps Lock`

1. Исправить capture: `CapsLock` — отдельный special key, а не обычный tracked modifier.
2. Нормализовать значение в один формат (`Capslock` для Electron, каноническое значение store — `CapsLock`).
3. Для режима «Нажатие» сначала использовать `globalShortcut.register("Capslock")`.
4. Проверить на реальном macOS, подавляет ли регистрация обычное переключение регистра:
   - если да — это достаточный backend;
   - если нет — использовать keyboard event tap и подавлять Caps Lock только пока он назначен хоткеем.
5. Для режима «Удержание» до появления надёжного native key-down/key-up:
   - не сохранять неподдерживаемую конфигурацию;
   - предложить переключиться в «Нажатие»;
   - старый хоткей не снимать.
6. При снятии назначения normal Caps Lock должен немедленно восстановиться.

## Решение 4. Скрытие иконки из Dock

### UX

macOS-настройка:

`Показывать Type в Dock` — включена по умолчанию.

При выключении:

- Type исчезает из Dock и App Switcher;
- menu-bar item остаётся;
- хоткей и диктовка продолжают работать;
- закрытие control panel скрывает окно, но не завершает приложение;
- из menu-bar доступны «Открыть Type» и «Завершить Type».

Не давать одновременно скрыть и Dock, и menu-bar item: это создаёт «невидимый» процесс без понятного recovery path.

### Архитектура

Добавить единственный `MacPresenceManager`:

- хранит persisted mode в main-process settings;
- сначала создаёт и проверяет `Tray`;
- применяет `regular` для Dock mode и `accessory` для menu-bar-only mode;
- сериализует `dock.hide()`/`dock.show()`;
- учитывает известное ограничение Electron: повторный `dock.hide()` менее чем через секунду может не сработать;
- предоставляет `ensureVisibleForCriticalDialog()` для updater/error dialogs;
- является единственным местом прямых вызовов `app.dock.*` и `app.setActivationPolicy`.

Нужно удалить безусловные `app.dock.show()` из:

- `TrayManager.showControlPanelFromTray`;
- `WindowManager.createControlPanelWindow/ready-to-show`;
- `app.on("activate")`.

Если menu-bar icon создать не удалось, выключение Dock отклоняется с понятной ошибкой.

## Порядок реализации

1. PR Windows hygiene:
   - удалить `nircmd`;
   - подписать внутренние helper binaries;
   - добавить artifact inventory/signature gates;
   - исправить Troubleshooting.
2. PR Capsule resilience:
   - fallback, recovery, main setting sync, lifecycle diagnostics.
3. PR Hotkey capability model:
   - вернуть Fn с предупреждением;
   - Caps Lock tap;
   - transactional registration.
4. PR macOS presence:
   - menu-bar item;
   - persisted Dock toggle;
   - central presence manager.
5. Отдельный более крупный PR Local IPC:
   - ASR без TCP;
   - CLI bridge через named pipe/socket;
   - проверка отсутствия firewall prompt.

Причина вынести local IPC отдельно: это более широкая смена transport и её не следует смешивать с удалением `nircmd`.

## Где тестировать

### Обязательные реальные устройства

- MacBook Apple Silicon с физической клавишей Globe/Fn: Fn, Caps Lock, sleep/wake, lid close/open, Spaces, full-screen.
- Windows x64 компьютер с актуальным Dr.Web: real-time quarantine, keyboard hook, SendInput и работа с обычными desktop-приложениями.

### Подходящие чистые VM

- Последняя поддерживаемая Windows 11 x64: installer/portable, Firewall, Defender, SmartScreen, autostart, update.
- Минимальная официально поддерживаемая Type версия Windows: regression smoke.
- Текущая и минимальная поддерживаемая macOS: install/upgrade, Dock/menu bar, сохранение настройки.

Fn/Globe нельзя принимать только на VM или по удалённому доступу: нужен физический Apple keyboard path. AV-задачу также нельзя принимать только по VirusTotal.

### Приложения для проверки вставки

Windows:

- Notepad;
- Word;
- Edge/Chrome: input, textarea, contenteditable;
- Telegram;
- VS Code;
- Windows Terminal;
- одно elevated тестовое поле для проверки ожидаемого UIPI-отказа.

macOS:

- TextEdit;
- Notes;
- Safari/Chrome;
- Telegram;
- VS Code;
- full-screen приложение и приложение в другом Space.

## Build gates перед ручным тестированием

Из `openwhispr/`:

1. `npm ci`
2. `npm test`
3. `npm run typecheck`
4. `npm run lint`
5. `npm run build:renderer`
6. Платформенная package build из release workflow.

Для каждого artifact зафиксировать:

- commit SHA;
- installer/portable/DMG SHA-256;
- platform/arch;
- signing identity;
- список вложенных executable;
- результат AV scan;
- канал обновления.

## Тестовые сценарии

### WIN-AV: антивирус и состав дистрибутива

**WIN-AV-01 — Статический состав**

1. Распаковать installer и portable artifact.
2. Найти все файлы с именем/строкой `nircmd`.
3. Проверить список вложенных `.exe`, `.dll`, `.node`.

Ожидание: `nircmd` отсутствует; каждый executable объяснён в manifest.

**WIN-AV-02 — Authenticode**

1. Проверить installer, portable, основной exe и каждый helper через `Get-AuthenticodeSignature`.
2. Проверить publisher и timestamp.

Ожидание: статус `Valid`, один ожидаемый publisher; unsigned вложенных exe нет.

**WIN-AV-03 — Чистая установка с Dr.Web**

1. Вернуть VM snapshot.
2. Обновить Dr.Web базы.
3. Скачать artifact обычным браузером.
4. Установить, запустить, выполнить 20 диктовок, pause/resume media и update.
5. Проверить quarantine/events.

Ожидание: нет detection/quarantine; Type не просит exclusions.

**WIN-AV-04 — Defender/SmartScreen**

Повторить clean install с включёнными Defender real-time protection и SmartScreen.

Ожидание: production-signed artifact проходит без неизвестного publisher; helper не карантинятся.

**WIN-AV-05 — Отказ helper**

В специальной QA-сборке инъецировать exit code/timeout `windows-fast-paste`.

Ожидание: UI не теряет транскрипцию; текст остаётся в clipboard; лог содержит безопасный fallback reason.

### WIN-NET: Firewall и сеть

**WIN-NET-01 — Первый запуск**

1. Чистая Windows VM, правила Type отсутствуют.
2. Установить и запустить Type.
3. Пройти onboarding и выполнить локальную диктовку.

Ожидание: dialog Windows Firewall не появляется.

**WIN-NET-02 — Listening sockets**

1. После запуска получить listening TCP/UDP endpoints и сопоставить OwningProcess с executable.
2. Повторить во время записи и распознавания.

Ожидание целевой архитектуры: в default mode у Type и helper нет TCP/UDP listener.

**WIN-NET-03 — Firewall rules**

Проверить application filters/rules до и после установки и первого запуска.

Ожидание: installer не создаёт broad inbound allow rule для private/public networks.

**WIN-NET-04 — Local ASR offline**

1. Отключить внешнюю сеть.
2. Оставить Firewall в default deny inbound.
3. Выполнить 10 локальных диктовок.

Ожидание: ASR и вставка работают без inbound exception.

**WIN-NET-05 — Cloud outbound**

С заблокированными inbound и разрешённым HTTPS outbound выполнить cloud transcription.

Ожидание: cloud mode работает; продукт не предлагает разрешить inbound.

**WIN-NET-06 — CLI bridge**

1. Запустить desktop app и CLI от того же пользователя.
2. Выполнить read/write команды.
3. Попробовать доступ от другого пользователя.

Ожидание: named pipe/socket работает для текущего пользователя; другой пользователь не получает доступ; TCP port не открывается.

### CAP: стабильность капсулы

**CAP-01 — Базовые циклы**

100 циклов start/stop/cancel в режимах «Нажатие» и «Удержание».

Ожидание: капсула появляется каждый раз, не перехватывает focus/click, скрывается после завершения.

**CAP-02 — Настройка видимости**

1. Выключить капсулу.
2. Выполнить диктовку.
3. Включить капсулу и повторить.
4. Повторить после restart и reboot.

Ожидание: диктовка всегда работает; состояние сохраняется; при включённой настройке следующая сессия всегда видима.

**CAP-03 — Долгий idle**

Оставить приложение скрытым минимум на 8 часов, затем начать диктовку.

Ожидание: капсула видна с первой попытки без restart.

**CAP-04 — Sleep/wake**

1. Sleep/wake 20 раз.
2. Отдельно закрыть/открыть крышку.
3. После каждого resume запустить диктовку.

Ожидание: нет невидимой капсулы; при потере WebGL показывается fallback.

**CAP-05 — Потеря WebGL context**

Через QA-only hook вызвать `WEBGL_lose_context`, затем восстановление.

Ожидание: fallback появляется сразу; UI не становится прозрачным; WebGL восстанавливается без restart.

**CAP-06 — WebGL2 недоступен**

Запустить QA-build с отключённым GPU/WebGL2.

Ожидание: видимый fallback отображает recording/transcribing; диктовка работает.

**CAP-07 — Renderer/GPU crash**

Через QA-only hook завершить renderer overlay и отдельно GPU process.

Ожидание: overlay пересоздаётся; следующая диктовка видима; запись/результат не дублируются.

**CAP-08 — Displays/Spaces/full-screen**

Подключить/отключить внешний монитор, менять scaling, перемещать курсор между displays, запускать из full-screen Space.

Ожидание: капсула появляется на display курсора, не обрезана и остаётся поверх.

**CAP-09 — Быстрые события**

Серия быстрых start/stop/start, одновременное изменение настройки и завершение распознавания.

Ожидание: старые callbacks не скрывают новую сессию; итоговое состояние соответствует последней команде.

**CAP-10 — Открытое меню «Пуск»**

1. Открыть меню «Пуск», оставить курсор в поле поиска.
2. Запустить и завершить диктовку 30 раз в режимах «Нажатие» и «Удержание».
3. Повторить сразу после unlock и после sleep/wake.

Ожидание: капсула видна над меню «Пуск» с первой сессии; поиск остаётся активным, капсула не получает focus/click; распознанный текст попадает в исходное поле согласно обычному контракту вставки.

### HOTKEY: Fn и Caps Lock

**HOTKEY-01 — Fn без системного действия**

На macOS установить системное действие Fn «ничего», назначить Fn и проверить tap/push по 30 раз.

Ожидание: назначение сохраняется, down/up не теряются, restart не меняет хоткей.

**HOTKEY-02 — Fn занят системой**

Повторить для Change Input Source, Emoji и Dictation.

Ожидание: Type показывает конкретное предупреждение; «Отмена» сохраняет старый хоткей; «Использовать всё равно» назначает Fn и честно допускает одновременное системное действие.

**HOTKEY-03 — Fn preference неизвестен**

В QA-build инъецировать unreadable/unknown `AppleFnUsageType`.

Ожидание: нет безмолвного shake/reject; пользователь получает предупреждение и может продолжить, если native event был получен.

**HOTKEY-04 — Caps Lock tap**

Назначить `Caps Lock`, перезапустить Type и выполнить 30 срабатываний в разных приложениях.

Ожидание: хоткей назначается с первой попытки и сохраняется; срабатывает ровно один раз на нажатие.

**HOTKEY-05 — Caps Lock и обычный регистр**

Проверить состояние Caps Lock до назначения, во время назначения и после смены хоткея.

Ожидание: во время назначения поведение соответствует выбранному продуктом контракту и не даёт случайного двойного срабатывания; после снятия назначения обычный Caps Lock полностью восстановлен.

**HOTKEY-06 — Caps Lock push**

Выбрать режим «Удержание» и попытаться назначить Caps Lock.

Ожидание: start на physical down, stop на physical up, включая короткие и длинные удержания; Caps Lock не переключает регистр, пока назначен хоткеем.

**HOTKEY-07 — Неуспешная регистрация**

Занять выбранный accelerator другим процессом и попытаться сохранить.

Ожидание: ошибка понятна; старый хоткей продолжает работать; UI не остаётся в capture mode.

**HOTKEY-08 — Capture lifecycle**

Проверить Escape, blur, повторный click, invalid key, быстрое открытие/закрытие settings.

Ожидание: global shortcuts/native listeners всегда восстанавливаются; клавиатура не остаётся «перехваченной».

**HOTKEY-09 — Windows shell combinations**

1. Назначить по очереди `Win+F3`, `Win+1`, `Win+A`, `Win+L`, `Caps Lock`, `Caps Lock+A`.
2. Для каждого успешного назначения проверить tap/push, restart и sleep/wake.
3. Для зарезервированного/невалидного сочетания проверить shake/error и старый хоткей.

Ожидание: поле получает каждую физическую последовательность; во время capture не открываются Start, Lock, Settings и другие Windows actions; успешное сочетание срабатывает один раз, отказ не снимает старое.

**HOTKEY-10 — Escape отменяет назначение**

1. Запомнить рабочий хоткей.
2. Открыть capture и нажать Escape.
3. Повторить после попытки `Win+L` и после blur.

Ожидание: Escape не становится хоткеем, capture закрывается, старый хоткей сразу продолжает работать.

### MAC-PRESENCE: Dock и menu bar

**MAC-PRESENCE-01 — Значение по умолчанию**

Чистая установка.

Ожидание: Type виден в Dock; menu-bar item доступен; control panel открывается.

**MAC-PRESENCE-02 — Скрыть Dock**

Выключить «Показывать Type в Dock».

Ожидание: Dock/App Switcher icon исчезает; menu-bar item остаётся; hotkey и диктовка работают.

**MAC-PRESENCE-03 — Закрытие панели**

В menu-bar-only mode закрыть control panel красной кнопкой.

Ожидание: приложение продолжает работать; повторное открытие из menu bar показывает одну панель без Dock icon.

**MAC-PRESENCE-04 — Вернуть Dock**

Включить настройку обратно.

Ожидание: Dock icon возвращается; click/activate открывает существующую панель; дубликатов окон нет.

**MAC-PRESENCE-05 — Persistence**

Проверить restart, logout/login, autostart и reboot в обоих режимах.

Ожидание: режим сохраняется; нет кратковременного зависания в состоянии без Dock и без menu bar.

**MAC-PRESENCE-06 — Быстрое переключение**

10 раз быстро переключить настройку.

Ожидание: итоговое состояние соответствует последнему значению с учётом сериализации Electron Dock API.

**MAC-PRESENCE-07 — Tray failure**

В QA-build инъецировать ошибку загрузки menu-bar icon.

Ожидание: Dock не скрывается; показано понятное сообщение; у пользователя остаётся recovery path.

**MAC-PRESENCE-08 — Update/error/permissions**

В menu-bar-only mode вызвать update dialog, ошибку модели и системные permission dialogs.

Ожидание: dialog видим и активируем; после закрытия Type возвращается в menu-bar-only mode.

**MAC-PRESENCE-09 — Quit**

Завершить Type из menu bar.

Ожидание: процесс Type и helper/sidecar процессы завершены; hotkey освобождён; повторный запуск успешен.

## Общие критерии приёмки

- Ни один сценарий не требует antivirus exclusion, Run as administrator или разрешения public/private inbound networks.
- После отказа нового хоткея старый продолжает работать.
- При любой ошибке WebGL пользователь видит fallback, а не пустое место.
- В menu-bar-only mode всегда остаётся явный способ открыть и завершить приложение.
- Production artifact подписан целиком, а не только на уровне installer.
- Результаты ручного прогона привязаны к commit SHA и hash артефакта.

## Платформенные источники

- Electron App: activation policy `regular/accessory/prohibited`

  https://www.electronjs.org/docs/latest/api/app

- Electron Dock: `dock.hide()`, `dock.show()` и ограничение повторного `hide()` в течение секунды

  https://www.electronjs.org/docs/latest/api/dock

- Electron Keyboard Shortcuts: `Capslock` входит в список accelerator key codes

  https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts

- Microsoft Win32 `SendInput`: UIPI разрешает injection только в процесс равного или более низкого integrity level

  https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput

- Microsoft Windows Firewall rules: inbound по умолчанию блокируется, outbound обычно разрешён; prompt относится к входящему исключению

  https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules
