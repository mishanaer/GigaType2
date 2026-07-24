# Type Technical Reference for AI Assistants

This document provides comprehensive technical details about the Type project architecture for AI assistants working on the codebase.

## Project Overview

Type is an Electron-based desktop dictation application that uses GigaAM for speech-to-text transcription.

## Architecture Overview

### Core Technologies
- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite
- **Desktop Framework**: Electron 41 with context isolation
- **Database**: better-sqlite3 for local transcription history
- **UI Components**: shadcn/ui with Radix primitives
- **Speech Processing**: GigaAM v3 RNN-T in-process (onnxruntime-node in the ONNX utility process) / OpenAI-compatible transcription endpoint
- **Audio Processing**: FFmpeg (bundled via ffmpeg-static)
- **Node.js**: 24 (pinned in `.nvmrc` — CI uses Node 24, do NOT regenerate `package-lock.json` with a different major version)

### Key Architectural Decisions

1. **Dual Window Architecture**:
   - Main Window: Minimal overlay for dictation (draggable, always on top)
   - Control Panel: Full settings interface (normal window)
   - Both use same React codebase with URL-based routing

2. **Process Separation**:
   - Main Process: Electron main, IPC handlers, database operations
   - Renderer Process: React app with context isolation
   - Preload Script: Secure bridge between processes
   - ONNX Utility Process: hosts all `onnxruntime-node` inference (text embeddings, speaker embeddings, fbank). Lazy-spawned on first use via `src/helpers/onnxWorkerClient.js` → `src/workers/onnxWorker.js`. Native crashes (e.g., ORT `bad_alloc`) confine to the worker; main process rejects in-flight requests and respawns with backoff. Stopped in `will-quit`.

3. **Audio Pipeline**:
   - MediaRecorder API → Blob → multipart request → GigaAM `/audio/transcriptions`
   - GigaAM endpoint resolution is centralized in `src/utils/gigaamTranscription.js`

## File Structure and Responsibilities

### Main Process Files

- **main.js**: Application entry point, initializes all managers
- **preload.js**: Exposes safe IPC methods to renderer via window.api

### Native Resources (resources/)

- **windows-key-listener.c**: C source for Windows low-level keyboard hook (Push-to-Talk)
- **windows-mic-listener.c**: C source for WASAPI mic session monitor (event-driven mic detection)
- **macos-mic-listener.swift**: Swift source for CoreAudio mic property listener (event-driven mic detection)
- **globe-listener.swift**: Swift source for macOS Globe/Fn key detection
- **bin/**: Directory for compiled native binaries (paste/key/mic listeners and sidecars)

### Helper Modules (src/helpers/)

- **audioManager.js**: Handles audio device management
- **clipboard.js**: Cross-platform clipboard operations
  - macOS: AppleScript-based paste with accessibility permission check
  - Windows: first-party SendInput helper with PowerShell SendKeys fallback
  - Linux: Native XTest binary + compositor-aware fallbacks (xdotool, wtype, ydotool)
- **database.js**: SQLite operations for transcription history
- **debugLogger.js**: Debug logging system with file output
- **devServerManager.js**: Vite dev server integration
- **dragManager.js**: Window dragging functionality
- **environment.js**: Environment variable and OpenAI API management
- **hotkeyManager.js**: Global hotkey registration and management
  - Handles platform-specific defaults (GLOBE on macOS, backtick on Windows/Linux)
  - Auto-fallback to F8/F9 if default hotkey is unavailable
  - Notifies renderer via IPC when hotkey registration fails
  - Integrates with GnomeShortcutManager for GNOME Wayland support
  - Integrates with HyprlandShortcutManager for Hyprland Wayland support
- **gnomeShortcut.js**: GNOME Wayland global shortcut integration
  - Uses D-Bus service to receive hotkey toggle commands
  - Registers shortcuts via gsettings (visible in GNOME Settings → Keyboard → Shortcuts)
  - Converts Electron hotkey format to GNOME keysym format
  - Only active on Linux + Wayland + GNOME desktop
- **hyprlandShortcut.js**: Hyprland Wayland global shortcut integration
  - Uses D-Bus service to receive hotkey toggle commands (same `com.openwhispr.App` service)
  - Registers shortcuts via `hyprctl keyword bind` (runtime keybinding)
  - Converts Electron hotkey format to Hyprland bind format (`MODS, key`)
  - Only active on Linux + Wayland + Hyprland (detected via `HYPRLAND_INSTANCE_SIGNATURE`)
- **ipcHandlers.js**: Centralized IPC handler registration
- **windowsKeyManager.js**: Windows Push-to-Talk support with native key listener
  - Spawns native `windows-key-listener.exe` binary for low-level keyboard hooks
  - Supports compound hotkeys (e.g., `Ctrl+Shift+F11`, `CommandOrControl+Space`)
  - Emits `key-down` and `key-up` events for push-to-talk functionality
  - Graceful fallback if binary unavailable
- **meetingDetectionEngine.js**: Orchestrates meeting detection from all sources
  - Gates notifications during recording (tap-to-talk and push-to-talk)
  - Post-recording cooldown (2.5s) before showing queued notifications
  - Priority-based coalescing (process > audio) — one notification, not three
- **meetingProcessDetector.js**: Detects running meeting apps
  - macOS: Event-driven via `systemPreferences.subscribeWorkspaceNotification` (zero CPU)
  - Windows/Linux: Shared `processListCache` polling (30s interval)
- **audioActivityDetector.js**: Detects microphone usage for unscheduled meetings
  - macOS: Event-driven via `macos-mic-listener` binary (CoreAudio property listeners)
  - Windows: Event-driven via `windows-mic-listener.exe` (WASAPI sessions, self-PID exclusion)
  - Linux: Event-driven via `pactl subscribe` (PulseAudio source-output events)
  - All platforms: Graceful fallback to polling if native approach fails
- **processListCache.js**: Shared singleton process list cache (5s TTL, `ps-list` npm)
- **googleCalendarManager.js**: Google Calendar sync with exponential backoff
  - 10s socket timeout on API requests
  - Backoff: 2min → 4min → 8min → cap 30min on consecutive failures
  - Reset to normal interval on success
- **menuManager.js**: Application menu management
- **tray.js**: System tray icon and menu
- **gigaamLocalAsr.js**: local GigaAM ASR — in-process HTTP server (ports 8765–8775, `/v1/audio/transcriptions` + `/health`), model download/cache management, inference via the ONNX utility process. Same status-object shape the old Python sidecar had
- **qdrantManager.js**: Qdrant vector DB sidecar process lifecycle (spawn, health check, shutdown)
- **localEmbeddings.js**: Local text embedding via ONNX Runtime + all-MiniLM-L6-v2 (384-dim vectors)
- **vectorIndex.js**: Qdrant collection management — upsert, delete, search, batch reindex
- **windowConfig.js**: Centralized window configuration
- **windowManager.js**: Window creation and lifecycle management
- **cliBridge.js**: Optional loopback HTTP server on ports 8200–8219, bearer-token auth (token at `~/.openwhispr/cli-bridge.json`), 127.0.0.1-only. It is disabled by default on Windows to avoid an inbound-firewall prompt; `TYPE_CLI_BRIDGE=1` opts in.
- **postMigrationDetector.js**: Detects users returning from the pre-Gizmo bundle ID via a `.bundle-migrated` sentinel in userData; consumed by `ipcHandlers.js` to drive the `PostMigrationOnboarding` modal

### React Components (src/components/)

- **App.jsx**: Main dictation interface with recording states
- **ControlPanel.tsx**: Settings, history, model management UI
- **OnboardingFlow.tsx**: 8-step first-time setup wizard
- **PostMigrationOnboarding.tsx**: One-time modal for users returning from the pre-Gizmo bundle ID; reuses `PermissionsSection` to walk through re-granting Microphone, Accessibility, and System Audio. Triggered by `postMigrationDetector.js` (see Helper Modules)
- **SettingsPage.tsx**: Comprehensive settings interface
- **ui/**: Reusable UI components (buttons, cards, inputs, etc.)

### React Hooks (src/hooks/)

- **useAudioRecording.js**: MediaRecorder API wrapper with error handling
- **useClipboard.ts**: Clipboard operations hook
- **useDialogs.ts**: Electron dialog integration
- **useHotkey.js**: Hotkey state management
- **useLocalStorage.ts**: Type-safe localStorage wrapper
- **usePermissions.ts**: System permission checks and settings access
  - `openMicPrivacySettings()`: Opens OS microphone privacy settings
  - `openSoundInputSettings()`: Opens OS sound input device settings
  - `openAccessibilitySettings()`: Opens OS accessibility settings (macOS only)
- **useSettings.ts**: Application settings management

### Services

- **ReasoningService.ts**: AI processing for agent-addressed commands
  - Detects when user addresses their named agent and removes the agent name from final output
  - Provider implementations live in a registry at `src/services/ai/inferenceProviders/index.ts` covering 8 providers (`anthropic`, `enterprise`, `gemini`, `groq`, `lan`, `local`, `openai`, `openwhispr`), each implementing the `InferenceProvider` interface from `types.ts`
  - Per-scope LLM config: 4 scopes (`dictationCleanup`, `dictationAgent`, `noteFormatting`, `chatIntelligence`) defined in `src/config/inferenceScopes.ts`
  - `selectResolvedLLMConfig(state, scope)` in `settingsStore.ts` resolves provider/model per scope with fallback chains

### GigaAM Integration

- **Local ASR engine (no Python)**: `main.js` starts `GigaamLocalAsrManager` (`src/helpers/gigaamLocalAsr.js`). App-owned transcription travels over Electron IPC (no inbound TCP/firewall rule); inference runs in the shared ONNX utility process (`src/workers/onnxWorker.js`, handlers `gigaam.load` / `gigaam.transcribe`) via onnxruntime-node. Developers can opt into the legacy loopback HTTP API with `GIGAAM_HTTP_BRIDGE=1`.
- **ASR model**: `gigaam-v3-e2e-rnnt` (fp32, `istupakov/gigaam-v3-onnx`). Reuses the legacy HF snapshot cache under `userData/model-cache/huggingface/...`; fresh installs download 4 files (~892 MB) to `userData/model-cache/gigaam/gigaam-v3-e2e-rnnt/`
- **Featurizer**: exact port of onnx-asr's GigaamPreprocessor v3 (n_fft=win=320, hop=160, 64 mels); precomputed window/mel-fbank embedded in `src/workers/gigaamFbankAssets.js`
- **onnxruntime version lock**: onnxruntime-node is pinned to the exact version sherpa-onnx links (`libonnxruntime.1.23.2.dylib`); afterPack replaces the bin copy with a symlink into app.asar.unpacked. Do not bump one without the other
- **Audio decode**: WAV parsed natively in `gigaamLocalAsr.js`; other formats fall back to the slim custom ffmpeg in `resources/bin` (audio-only build, ~2 MB)
- **Endpoint config**: renderer uses `gigaamBaseUrl` / `remoteTranscriptionUrl` (unchanged)
- **Endpoint normalization**: `src/utils/gigaamTranscription.js` appends `/audio/transcriptions` when needed
- **Auth**: no renderer BYOK API key path for transcription

### Local Semantic Search (Qdrant + MiniLM)

Always-on offline semantic search that finds notes by meaning, not just keywords. Used by the AI agent's `search_notes` tool. Qdrant starts automatically on app launch; embedding model auto-downloads on first run if missing.

**Architecture**:
- **Qdrant sidecar**: Rust binary spawned as child process (`qdrantManager.js`), port 6333–6350
- **Embedding model**: `all-MiniLM-L6-v2` via ONNX Runtime (`localEmbeddings.js`), 384-dim vectors
- **Vector index**: Qdrant collection management (`vectorIndex.js`), cosine distance
- **Hybrid search**: FTS5 + Qdrant in parallel → Reciprocal Rank Fusion (K=60) with 0.3 cosine score threshold

**Pipeline**:
1. App launches → Qdrant binary starts → collection created. Embedding model auto-downloads if missing (~22MB)
2. Note create/update/delete → SQLite write → background vector upsert/delete via `_asyncVectorUpsert()`/`_asyncVectorDelete()`
3. Agent searches → `db-semantic-search-notes` IPC → parallel FTS5 + vector search → RRF merge → ranked results

**Search fallback chain** (in `searchNotesTool.ts`): cloud search → local semantic → FTS5 keyword

**Storage**:
- Qdrant data: `~/.cache/openwhispr/qdrant-data/`
- Qdrant binary: `resources/bin/qdrant-{platform}-{arch}` (bundled — downloaded during `prebuild` / `predev`)
- Embedding model: `~/.cache/openwhispr/embedding-models/all-MiniLM-L6-v2/` (auto-downloaded on first launch)

**Dependencies**: `@qdrant/js-client-rest`, `onnxruntime-node`

**Dev setup**: The Qdrant binary downloads automatically via `predev`/`prestart`. The embedding model auto-downloads on first app launch. To manually download: `npm run download:qdrant` and `npm run download:embedding-model`.

### Build Scripts (scripts/)

- **download-llama-server.js**: Downloads llama.cpp server for local LLM inference
- **download-windows-key-listener.js**: Downloads prebuilt Windows key listener binary
- **download-windows-mic-listener.js**: Downloads prebuilt Windows mic listener binary
- **download-sherpa-onnx.js**: Downloads sherpa-onnx diarization binary
- **download-qdrant.js**: Downloads Qdrant vector DB binary for local semantic search
- **download-minilm.js**: Downloads all-MiniLM-L6-v2 ONNX model + tokenizer for local embeddings
- **build-globe-listener.js**: Compiles macOS Globe key listener from Swift source
- **build-macos-mic-listener.js**: Compiles macOS mic listener from Swift source
- **build-windows-key-listener.js**: Compiles Windows key listener (for local development)
- **run-electron.js**: Development script to launch Electron with proper environment
- **lib/download-utils.js**: Shared utilities for downloading and extracting files
  - `fetchLatestRelease(repo, options)`: Fetches latest release from GitHub API
  - `downloadFile(url, dest)`: Downloads file with progress and retry logic
  - `extractZip(zipPath, destDir)`: Cross-platform zip extraction
  - `parseArgs()`: Parses CLI arguments for platform/arch targeting
  - Supports `GITHUB_TOKEN` for authenticated requests (higher rate limits)

## Key Implementation Details

### 1. FFmpeg Integration

FFmpeg is bundled with the app and doesn't require system installation:
```javascript
// FFmpeg is unpacked from ASAR to app.asar.unpacked/node_modules/ffmpeg-static/
```

### 2. Audio Recording Flow

1. User presses hotkey → MediaRecorder starts
2. Audio chunks collected in array
3. User presses hotkey again → Recording stops
4. Blob created from chunks
5. Renderer posts multipart audio to the configured GigaAM transcription endpoint
6. GigaAM response is normalized and saved locally

### 3. Database Schema

```sql
CREATE TABLE transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  original_text TEXT NOT NULL,
  processed_text TEXT,
  is_processed BOOLEAN DEFAULT 0,
  processing_method TEXT DEFAULT 'none',
  agent_name TEXT,
  error TEXT
);
```

### 4. Settings Storage

Settings stored in localStorage with these keys:
- `gigaamBaseUrl`: GigaAM API base URL
- `remoteTranscriptionUrl`: Optional explicit GigaAM transcription endpoint/base URL
- `preferredLanguage`: Selected transcription language code
- `agentName`: User's custom agent name
- `reasoningModel`: Selected AI model for processing
- `reasoningProvider`: AI provider (openai/anthropic/gemini/local)
- `hotkey`: Custom hotkey configuration
- `hasCompletedOnboarding`: Onboarding completion flag

`SECRET_KEYS` is intentionally empty. The renderer no longer exposes BYOK API key storage for transcription.

Non-secret runtime config is persisted to `.env` via `saveRuntimeConfigToEnvFile()`.

### 5. Language Support

58 languages supported (see src/utils/languages.ts):
- Each language has a two-letter code and label
- "auto" for automatic detection
- Passed to GigaAM as the transcription `language` field

### 6. Agent Naming System

- User names their agent during onboarding (step 6/8)
- Name stored in localStorage and database
- ReasoningService detects "Hey [AgentName]" patterns
- AI processes command and removes agent reference from output
- Supports multiple AI providers (all models defined in `src/models/modelRegistryData.json`):
  - **OpenAI** (Responses API):
    - GPT-5.5 (`gpt-5.5`) - Latest flagship frontier model, 1M context
    - GPT-5.2 (`gpt-5.2`) - Strong reasoning model
    - GPT-5 Mini (`gpt-5-mini`) - Fast and cost-efficient
    - GPT-5 Nano (`gpt-5-nano`) - Ultra-fast, low latency
    - GPT-4.1 Series (`gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`) - Strong baseline with 1M context
  - **Anthropic** (Via IPC bridge to avoid CORS):
    - Claude Opus 4.7 (`claude-opus-4-7`) - Most capable Claude model, 1M context
    - Claude Sonnet 4.6 (`claude-sonnet-4-6`) - Balanced performance
    - Claude Haiku 4.5 (`claude-haiku-4-5`) - Fast with near-frontier intelligence
    - Claude Opus 4.6 (`claude-opus-4-6`) - Previous Opus generation, 1M context
    - Claude Sonnet 4.5 (`claude-sonnet-4-5`) - Previous Sonnet generation
    - Claude Opus 4.5 (`claude-opus-4-5`) - Earlier Opus model
  - **Google Gemini** (Direct API integration):
    - Gemini 3.1 Pro (`gemini-3.1-pro-preview`) - Most capable Gemini model
    - Gemini 3 Flash (`gemini-3-flash-preview`) - Ultra-fast, high-capability next-gen model
    - Gemini 2.5 Flash Lite (`gemini-2.5-flash-lite`) - Lowest latency and cost
  - **Local**: GGUF models via llama.cpp (Qwen, Llama, Mistral, GPT-OSS)

### 7. Model Registry Architecture

All AI model definitions are centralized in `src/models/modelRegistryData.json` as the single source of truth:
```json
{
  "cloudProviders": [...],   // OpenAI, Anthropic, Gemini API models
  "localProviders": [...]    // GGUF models with download URLs
}
```

**Key files:**
- `src/models/modelRegistryData.json` - Single source of truth for all models
- `src/models/ModelRegistry.ts` - TypeScript wrapper with helper methods
- `src/config/aiProvidersConfig.ts` - Derives AI_MODES from registry
- `src/utils/languages.ts` - Derives REASONING_PROVIDERS from registry
- `src/helpers/modelManagerBridge.js` - Handles local model downloads

**Local model features:**
- Each model has `hfRepo` for direct HuggingFace download URLs
- `promptTemplate` defines the chat format (ChatML, Llama, Mistral)
- Download URLs constructed as: `{baseUrl}/{hfRepo}/resolve/main/{fileName}`

### 8. API Integrations and Updates

**OpenAI Responses API (September 2025)**:
- Migrated from Chat Completions to new Responses API
- Endpoint: `https://api.openai.com/v1/responses`
- Simplified request format with `input` array instead of `messages`
- New response format with `output` array containing typed items
- Automatic handling of GPT-5 and o-series model requirements
- No temperature parameter for newer models (GPT-5, o-series)

**Anthropic Integration**:
- Routes through IPC handler to avoid CORS issues in renderer process
- Uses main process for API calls with proper error handling
- Model IDs use alias format (e.g., `claude-sonnet-4-6` not date-suffixed versions)

**Gemini Integration**:
- Direct API calls from renderer process
- Increased token limits for Gemini 3.1 Pro (2000 minimum)
- Proper handling of thinking process in responses
- Error handling for MAX_TOKENS finish reason

### 9. System Settings Integration

The app can open OS-level settings for microphone permissions, sound input selection, and accessibility:

**IPC Handlers** (in `ipcHandlers.js`):
- `open-microphone-settings`: Opens microphone privacy settings
- `open-sound-input-settings`: Opens sound/audio input device settings
- `open-accessibility-settings`: Opens accessibility privacy settings (macOS only)

**Platform-specific URLs**:
| Platform | Microphone Privacy | Sound Input | Accessibility |
|----------|-------------------|-------------|---------------|
| macOS | `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` | `x-apple.systempreferences:com.apple.preference.sound?input` | `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` |
| Windows | `ms-settings:privacy-microphone` | `ms-settings:sound` | N/A |
| Linux | Manual (no URL scheme) | Manual (e.g., pavucontrol) | N/A |

**UI Component** (`MicPermissionWarning.tsx`):
- Shows platform-appropriate buttons and messages
- Linux only shows "Open Sound Settings" (no separate privacy settings)
- macOS/Windows show both sound and privacy buttons

### 10. Debug Mode

Enable with `--log-level=debug` or `OPENWHISPR_LOG_LEVEL=debug` (can be set in `.env`):
- Logs saved to platform-specific app data directory
- Comprehensive logging of audio pipeline
- FFmpeg path resolution details
- Audio level analysis
- Complete reasoning pipeline debugging with stage-by-stage logging

### 11. Windows Push-to-Talk

Native Windows support for true push-to-talk functionality using low-level keyboard hooks:

**Architecture**:
- `resources/windows-key-listener.c`: Native C program using Windows `SetWindowsHookEx` for keyboard hooks
- `src/helpers/windowsKeyManager.js`: Node.js wrapper that spawns and manages the native binary
- Binary outputs `KEY_DOWN` and `KEY_UP` to stdout when target key is pressed/released

**Compound Hotkey Support**:
- Parses hotkey strings like `CommandOrControl+Shift+F11`
- Maps modifiers: `CommandOrControl`/`Ctrl` → VK_CONTROL, `Alt`/`Option` → VK_MENU, `Shift` → VK_SHIFT
- Verifies all required modifiers are held before emitting key events

**Binary Distribution**:
- Prebuilt binary downloaded from GitHub releases (`windows-key-listener-v*` tags)
- Download script: `scripts/download-windows-key-listener.js`
- CI workflow: `.github/workflows/build-windows-key-listener.yml`
- Fallback to tap mode if binary unavailable

**IPC Events**:
- `windows-key-listener:key-down`: Fired when hotkey pressed (start recording)
- `windows-key-listener:key-up`: Fired when hotkey released (stop recording)

### 12. GNOME Wayland Global Hotkeys

On GNOME Wayland, Electron's `globalShortcut` API doesn't work due to Wayland's security model. Type uses native GNOME shortcuts:

**Architecture**:
1. `main.js` enables `GlobalShortcutsPortal` feature flag for Wayland
2. `hotkeyManager.js` detects GNOME + Wayland and initializes `GnomeShortcutManager`
3. `gnomeShortcut.js` creates D-Bus service at `com.openwhispr.App`
4. Shortcuts registered via `gsettings` as custom GNOME keybindings
5. GNOME triggers `dbus-send` command which calls the D-Bus `Toggle()` method

**Key Constants**:
- D-Bus service: `com.openwhispr.App`
- D-Bus path: `/com/openwhispr/App`
- gsettings path: `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr/`

**IPC Integration**:
- `get-hotkey-mode-info`: Returns `{ isUsingGnome, isUsingHyprland, isUsingNativeShortcut }` to renderer
- UI hides activation mode selector when `isUsingNativeShortcut` is true
- Forces tap-to-talk mode (push-to-talk not supported)

**Hotkey Format Conversion**:
- Electron format: `Alt+R`, `CommandOrControl+Shift+Space`
- GNOME format: `<Alt>r`, `<Control><Shift>space`
- Backtick (`) → `grave` in GNOME keysym format

### 13. Hyprland Wayland Global Hotkeys

On Hyprland (wlroots Wayland compositor), Electron's `globalShortcut` API and the `GlobalShortcutsPortal` feature don't work reliably. Type uses native Hyprland keybindings:

**Architecture**:
1. `main.js` enables `GlobalShortcutsPortal` feature flag for Wayland (fallback)
2. `hotkeyManager.js` detects Hyprland + Wayland and initializes `HyprlandShortcutManager`
3. `hyprlandShortcut.js` creates D-Bus service at `com.openwhispr.App` (same as GNOME)
4. Shortcuts registered via `hyprctl keyword bind` (runtime keybinding)
5. Hyprland triggers `dbus-send` command which calls the D-Bus `Toggle()` method

**Detection**:
- Primary: `HYPRLAND_INSTANCE_SIGNATURE` environment variable (set by Hyprland)
- Fallback: `XDG_CURRENT_DESKTOP` contains "hyprland"

**Hotkey Format Conversion**:
- Electron format: `Alt+R`, `CommandOrControl+Shift+Space`
- Hyprland format: `ALT, R`, `CTRL SHIFT, space`
- Modifier-only combos (e.g., `Control+Super`) → `CTRL, Super_L`

**Bind/Unbind Commands**:
- Register: `hyprctl keyword bind "ALT, R, exec, dbus-send --session ..."`
- Unregister: `hyprctl keyword unbind "ALT, R"`
- Bindings are ephemeral (don't survive Hyprland restart) but re-registered on app startup

**Limitations**:
- Push-to-talk not supported (Hyprland `bind` fires a single exec, not key-down/key-up)
- Requires `hyprctl` on PATH (ships with Hyprland)

### 14. Meeting Detection (Event-Driven)

Detects meetings via three independent sources, orchestrated by `MeetingDetectionEngine`:

**Architecture**:
- `MeetingDetectionEngine` listens to events from `MeetingProcessDetector` and `AudioActivityDetector`
- `GoogleCalendarManager` provides calendar context (imminent events, active meetings)
- All three sources feed into a unified notification pipeline

**Process Detection** (known meeting apps — Zoom, Teams, Webex, FaceTime):
- macOS: `systemPreferences.subscribeWorkspaceNotification` — zero CPU, instant detection
- Windows/Linux: `processListCache` shared polling (30s interval, `ps-list` npm)

**Microphone Detection** (unscheduled/browser meetings like Google Meet):
- macOS: `macos-mic-listener` binary — CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` property listeners with hot-plug support
- Windows: `windows-mic-listener.exe` — WASAPI `IAudioSessionManager2` session monitoring, `--exclude-pid` for self-mic exclusion
- Linux: `pactl subscribe` — PulseAudio source-output events
- All platforms: Graceful fallback to polling if native binary/command unavailable

**UX Rules**:
- During recording (tap-to-talk or push-to-talk): ALL notifications suppressed
- After recording: 2.5s cooldown before showing queued notifications
- Multiple signals coalesced: process > audio priority, one notification shown
- Calendar-aware: if imminent calendar event exists, notification shows event name
- Active calendar meeting recording: all detections suppressed

**Binary Distribution**:
- macOS: Compiled from Swift source via `scripts/build-macos-mic-listener.js` during `compile:native`
- Windows: Prebuilt binary downloaded via `scripts/download-windows-mic-listener.js` during `prebuild:win`
- CI workflow: `.github/workflows/build-windows-mic-listener.yml` auto-builds on push to main

**Calendar Sync Resilience**:
- 10s socket timeout on all Google Calendar API requests
- Exponential backoff on consecutive failures: 2min → 4min → 8min → cap 30min
- Reset to normal 2min interval on any successful sync

### 15. Auto-Update (electron-updater) and Releasing

`src/updater.js` (`UpdateManager`) owns auto-update. It uses electron-updater's
**generic** provider — the feed URL is baked into `app-update.yml` at build time
from `publish` in `electron-builder.json` (SberCloud OBS, S3-compatible:
`…/function_descriptions/gigatype-electron/prod`). There is **no GitHub release
or git tag in the update mechanism** — the installed app only reads YAML
manifests + binaries from that bucket.

**Runtime flow** (packaged builds only; on by default):
1. `checkForUpdatesOnStartup()` runs the check ~3s after launch, then every 4h.
2. electron-updater fetches the channel manifest and compares its version to
   `app.getVersion()`. macOS uses **arch-specific channels** so arm64/x64 don't
   race on the shared manifest: arm64 → `latest-arm64-mac.yml`, x64 →
   `latest-x64-mac.yml` (Rosetta x64-on-arm self-heals to the arm64 channel).
   Windows → `latest.yml`, Linux → `latest-linux.yml`.
3. If strictly newer, it downloads in the background (**differential/blockmap**:
   only changed blocks are fetched, so the unchanged ~851 MB bundled GigaAM
   model is copied from the installed app rather than re-downloaded — updates are
   effectively "app only" unless the model changed). First update after a fresh
   install has no local artifact to diff against and falls back to a full download.
4. Native dialog (localized, `updater.*` i18n keys): **Install & Restart** or
   **Later**. "Later" defers that version for 24h (persisted to
   `userData/updater-skip.json`). A manual check lives in the app menu →
   "Check for Updates…" (`runManualUpdateCheck`, surfaces failures).
5. Install shuts down **all sidecars first** (`setPrepareForInstall` →
   `performSyncTeardown()` + `sidecarRegistry.shutdownAll()`) before
   `quitAndInstall`. Required on Windows (file locks) and macOS (.app swap). The
   `before-quit` handler in `main.js` skips its own `app.exit(0)` while
   `updateManager.isInstalling` so the installer isn't aborted.

Config: `autoDownload=false`, `autoInstallOnAppQuit=false` (we drive both so
install always goes through the sidecar teardown), `disableDifferentialDownload=false`.
Env overrides: `GIGATYPE_DISABLE_AUTO_UPDATES` (opt out in the field),
`GIGATYPE_FORCE_UPDATE_CHECKS` (force on for QA on any build).

**Releasing a new version** (`.github/workflows/release.yml`, triggered by a git
tag `v*.*.*` or manual `workflow_dispatch`):
1. **Bump `version` in `package.json`** and commit. The build uses this version —
   the tag does NOT set it. Tagging `v1.9.0` while `package.json` still says
   `1.8.0` republishes `1.8.0` and nobody updates.
2. Push a matching tag: `git tag v1.9.0 && git push origin v1.9.0`.
3. CI builds every platform (macOS is signed + notarized), then
   `scripts/publish.py` uploads to OBS. Binaries + `.blockmap`s go up first,
   `latest*.yml` manifests last, so the feed is never pointed at a missing file.
   The mac job mints `latest-<arch>-mac.yml` from `latest-mac.yml` per arch.
4. Manual publish: `npm run build:mac -- --arm64 --publish never`, then
   `python scripts/publish.py --from dist` with `OBS_*` / `S3_*` env set (see
   `.env.example`). For mac, `scripts/publish.py --mac-arch arm64` mints the
   arch manifest.

Caveats: OBS stores everything under a flat `…/prod/` prefix (no version
folders) — each release adds binaries and overwrites the manifest; old binaries
stay for differential diffing. macOS auto-update **requires a valid signature +
notarization** (Squirrel.Mac verifies the downloaded `.zip`); an unsigned build
downloads but fails to install.

## Development Guidelines

### Internationalization (i18n) — REQUIRED

All user-facing strings **must** use the i18n system. Never hardcode UI text in components.

**Setup**: react-i18next (v15) with i18next (v25). Translation files in `src/locales/{lang}/translation.json`.

**Supported languages**: en, es, fr, de, pt, it, ru, zh-CN, zh-TW

**How to use**:
```tsx
import { useTranslation } from "react-i18next";

const { t } = useTranslation();
// Simple: t("notes.list.title")
// With interpolation: t("notes.upload.using", { model: "GigaAM" })
```

**Rules**:
1. Every new UI string must have a translation key in `en/translation.json` and all other language files
2. Use `useTranslation()` hook in components and hooks
3. Keep `{{variable}}` interpolation syntax for dynamic values
4. Do NOT translate: brand names (Type, Pro), technical terms (Markdown, Signal ID), format names (MP3, WAV), AI system prompts
5. Group keys by feature area (e.g., `notes.editor.*`, `referral.toasts.*`)

### Adding New Features

1. **New IPC Channel**: Add to both ipcHandlers.js and preload.js
2. **New Setting**: Update useSettings.ts and SettingsPage.tsx
3. **New UI Component**: Follow shadcn/ui patterns in src/components/ui
4. **New Manager**: Create in src/helpers/, initialize in main.js
5. **New UI Strings**: Add translation keys to all 10 language files (see i18n section above)
6. **New Sidecar Binary**: Add download script in `scripts/`, add to `prebuild*` scripts in package.json, add manager in `src/helpers/`, initialize in `main.js`. Spawn the child with `detached: process.platform !== "win32"` so it has its own process group on Unix. Right after spawn call `sidecarPidFile.write(name, child.pid)` and on `close` call `sidecarPidFile.clear(name)`. Add the binary fragment to `EXPECTED_BINARY_FRAGMENTS` in `sidecarReaper.js`. Register a stop function via `sidecarRegistry.register(name, () => manager.stop())` in `registerSidecars()` — that single registration replaces the old `will-quit` line.

### Testing Checklist

- [ ] Test GigaAM transcription with the local in-process engine
- [ ] Verify hotkey works globally
- [ ] Check clipboard pasting on all platforms
- [ ] Test with different audio input devices
- [ ] Verify GigaAM local ASR status and restart flow
- [ ] Check agent naming functionality
- [ ] Verify Windows Push-to-Talk with compound hotkeys
- [ ] Test GNOME Wayland hotkeys (if on GNOME + Wayland)
- [ ] Test Hyprland Wayland hotkeys (if on Hyprland + Wayland)
- [ ] Verify activation mode selector is hidden on GNOME Wayland and Hyprland Wayland
- [ ] Verify meeting detection works with event-driven mode (check debug logs for "event-driven")
- [ ] Test meeting notification suppression during recording
- [ ] Test post-recording cooldown (notifications shouldn't flash immediately)
- [ ] Create a note about "quarterly revenue projections", search via agent for "financial forecast" — should match semantically
- [ ] Verify Qdrant starts on app launch (check debug logs for "qdrant started successfully")
- [ ] Kill Qdrant process manually — verify FTS5 keyword search still works as fallback

### Common Issues and Solutions

1. **No Audio Detected**:
   - Check FFmpeg path resolution
   - Verify microphone permissions
   - Check audio levels in debug logs

2. **Transcription Fails**:
   - Check GigaAM local ASR status (`/health` on ports 8765-8775)
   - Verify `gigaamBaseUrl` / `remoteTranscriptionUrl`
   - Verify FFmpeg is executable if audio conversion was involved

3. **Clipboard Not Working**:
   - macOS: Check accessibility permissions (required for AppleScript paste)
   - Linux: Native `linux-fast-paste` binary (XTest) is tried first, works for X11 and XWayland apps
     - X11: xdotool fallback if native binary unavailable
     - GNOME/KDE Wayland: xdotool (XWayland apps) → ydotool (requires ydotoold daemon)
     - wlroots Wayland (Sway, Hyprland): wtype → xdotool → ydotool
   - Windows: first-party SendInput helper or PowerShell SendKeys fallback

4. **Build Issues**:
   - Use `npm run pack` for unsigned builds (CSC_IDENTITY_AUTO_DISCOVERY=false)
   - Signing requires Apple Developer account
   - ASAR unpacking needed for FFmpeg
   - afterSign.js automatically skips signing when CSC_IDENTITY_AUTO_DISCOVERY=false
   - **Lockfile**: Always use Node 24 when running `npm install` (matches CI). If your local Node version differs, use `nvm exec 24 npm install`. Running `npm install` with a different major version will produce an incompatible `package-lock.json` that breaks `npm ci` in CI.

5. **Windows Push-to-Talk Binary**:
   - Prebuilt binary downloaded automatically on Windows during build
   - If download fails, push-to-talk falls back to tap mode
   - To compile locally: install Visual Studio Build Tools or MinGW-w64
   - CI workflow (`.github/workflows/build-windows-key-listener.yml`) auto-builds on push to main

6. **Meeting Detection Not Working**:
   - Check debug logs for "event-driven" vs "polling" mode
   - macOS: Verify `macos-mic-listener` binary exists in `resources/bin/` (compiled during `npm run compile:native`)
   - Windows: Verify `windows-mic-listener.exe` exists in `resources/bin/` (downloaded during `prebuild:win`)
   - Linux: Verify `pactl` is installed (`pulseaudio-utils` or `pipewire-pulse` package)
   - If event-driven binary is missing, detection falls back to polling automatically

7. **Local Semantic Search Not Working**:
   - Qdrant binary should be in `resources/bin/qdrant-{platform}-{arch}` (auto-downloaded during `predev`/`prebuild`)
   - Embedding model should be in `~/.cache/openwhispr/embedding-models/all-MiniLM-L6-v2/model.onnx` (auto-downloaded on first app launch)
   - Run `npm run download:qdrant` and `npm run download:embedding-model` manually if missing
   - Check debug logs for "qdrant" entries (port, health check, errors)
   - If Qdrant fails to start, search still works via FTS5 keyword fallback
   - Semantic search is only available through the AI agent's `search_notes` tool, not the manual search UI

### Platform-Specific Notes

**macOS**:
- Requires accessibility permissions for clipboard (auto-paste)
- Requires microphone permission (prompted by system)
- Uses AppleScript for reliable pasting
- Notarization needed for distribution
- Shows in dock with indicator dot when running (LSUIElement: false)
- System settings accessible via `x-apple.systempreferences:` URL scheme

**Windows**:
- No special accessibility permissions needed
- Microphone privacy settings at `ms-settings:privacy-microphone`
- Sound settings at `ms-settings:sound`
- NSIS installer for distribution
- **Push-to-Talk**: Native key listener binary (`windows-key-listener.exe`) enables true push-to-talk
  - Uses Windows Low-Level Keyboard Hook (`WH_KEYBOARD_LL`)
  - Supports compound hotkeys (e.g., `Ctrl+Shift+F11`)
  - Prebuilt binary auto-downloaded from GitHub releases
  - Falls back to tap mode if unavailable

**Linux**:
- Multiple package manager support
- Standard XDG directories
- AppImage for distribution
- No standardized URL scheme for system settings (user must open manually)
- Privacy settings button hidden in UI (not applicable on Linux)
- Recommend `pavucontrol` for audio device management
- **Clipboard paste tools** (at least one required for auto-paste):
  - **X11**: `xdotool` (recommended)
  - **Wayland** (non-GNOME): `wtype` (requires virtual keyboard protocol) or `xdotool` (works via XWayland, recommended for Electron apps)
  - **GNOME Wayland**: `xdotool` for XWayland apps only (native Wayland apps require manual paste)
  - Terminal detection: Auto-detects terminal emulators and uses Ctrl+Shift+V
  - Fallback: Text copied to clipboard with manual paste instructions
- **GNOME Wayland global hotkeys**:
  - Uses native GNOME shortcuts via D-Bus and gsettings (no special permissions needed)
  - Hotkeys visible in GNOME Settings → Keyboard → Shortcuts → Custom
  - Default hotkey: `Alt+R` (backtick not supported)
  - Push-to-talk unavailable (GNOME shortcuts only fire single toggle event)
  - Falls back to X11/globalShortcut if GNOME integration fails
  - `dbus-next` npm package used for D-Bus communication

## Code Style and Conventions

- Use TypeScript for new React components
- Follow existing patterns in helpers/
- Descriptive error messages for users
- Comprehensive debug logging
- Clean up resources (files, listeners)
- Handle edge cases gracefully

## Performance Considerations

- GigaAM local ASR startup (model load ~1-2 s from cache) and endpoint health
- Audio blob size before multipart upload
- Memory usage with local LLM, embedding, and diarization models
- Process timeout protection (5 minutes)
- Meeting detection uses event-driven OS APIs (near-zero CPU) with polling fallback
- Process list cache shared between detectors to avoid duplicate `tasklist`/`pgrep` calls
- Google Calendar sync uses exponential backoff to avoid hammering API on network failures

## Security Considerations

- API keys and enterprise cloud creds (12 secrets total) encrypted at rest via Electron `safeStorage` → OS keychain (Keychain / DPAPI / libsecret), stored as per-key files in `userData/secure-keys/`. Linux without a keyring falls back to plaintext (Electron default). Closed in #629.
- Context isolation enabled
- No remote code execution
- Sanitized file paths
- Limited IPC surface area

## Future Enhancements to Consider

- Streaming transcription support
- Custom wake word detection
- ~~Multi-language UI~~ (implemented — 9 languages via react-i18next)
- Cloud model selection
- Batch transcription
- Export formats beyond clipboard
