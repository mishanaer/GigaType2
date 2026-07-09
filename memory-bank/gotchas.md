# Gotchas

- `RC-0.0.1` exists on `origin` as a Git tag, not as a branch. A plain `git checkout RC-0.0.1` failed until the tag was fetched explicitly.
- `openwhispr/README.md` says "No data collection, no telemetry", but this tag contains `TelemetryService` and startup telemetry calls in `openwhispr/main.js`.
- Use npm for this project; `openwhispr/package-lock.json` is present and no pnpm/yarn lockfile was found.
- Build scripts download model/runtime assets during prebuild. Network and cached files in `openwhispr/resources/bin` affect build time and artifact contents.
- Electron fullscreen-related BrowserWindow option is `fullscreenable`, not `fullScreenable`.
- macOS overlay windows may need `setVisibleOnAllWorkspaces(... visibleOnFullScreen: true)` / always-on-top behavior re-applied around `showInactive()` when the active app is in a fullscreen Space.
- Telemetry events and properties must be added to `openwhispr/src/helpers/telemetryService.js` allowlists, otherwise they are silently dropped before reaching PostHog.
- Settings hotkey capture uses a hidden `HotkeyInput` and a separate visible wallet cell. Invalid captures must exit/blur the hidden input; otherwise it can keep swallowing keyboard events while the UI looks normal.
- macOS builds for existing Type users must keep bundle id `ai.gigatype.app` and Team ID `SBHVKH5UUY`; signing with a different Team ID risks new TCC permission prompts.
- The local bundled Node runtime only includes `node`; `electron-builder` still shells out to `npm` because `package-lock.json` is present. Do not switch package managers; put an npm CLI on PATH for the build.
- The login keychain can contain duplicate `Developer ID Application: Mikhail Naer (SBHVKH5UUY)` identities. Signing by common name is ambiguous; use a concrete SHA-1 identity hash or an isolated keychain.
- After custom macOS signing, verify the app inside the produced DMG, not only `dist-*/mac-arm64/Type.app`. A stale/unsigned app inside the DMG will pass local staged-app checks but fail notarization.
- macOS paste restore must not depend on AX verification: Accessibility can fail to read the focused field (`unreadable-after-paste`) even after Cmd+V succeeds. Follow upstream OpenWhispr's model: restore after the paste delay only if clipboard still contains the dictated text, and serialize paste attempts until restore completes.
