# Architecture

- Repository root contains the Electron desktop app in `openwhispr/` and a Python GigaAM sidecar prototype in `gigaam-sidecar/`.
- `openwhispr/package.json` is npm-based (`package-lock.json`) and requires Node.js `>=24`.
- The desktop app uses Electron main process entry `openwhispr/main.js` and renderer build output from `openwhispr/src` via Vite.
- Electron packaging is configured in `openwhispr/electron-builder.json`; packaged artifacts are written to `openwhispr/dist`.
- Native helper binaries are built by npm `compile:*` scripts and packaged from `openwhispr/resources/bin`.
- macOS packaging targets `dmg` and `zip`; Linux and Windows targets are also configured in `electron-builder.json`.
- Telemetry is initialized in the Electron main process through `openwhispr/src/helpers/telemetryService`.
