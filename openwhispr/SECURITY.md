# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.7.x   | :white_check_mark: |
| < 1.7   | :x:                |

## Reporting a Vulnerability

**Please do not open public issues for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/Type/openwhispr/security/advisories/new)
to submit a report. You can also email security@openwhispr.com.

We will acknowledge your report within **48 hours** and aim to release a fix
within **7 days** for critical issues.

## Scope

The following are in scope:

- Remote code execution via crafted audio files or transcription output
- Privilege escalation through native binaries (key listeners, paste helpers)
- Credential exposure (API keys, OAuth tokens, database credentials)
- Cross-site scripting (XSS) in the Electron renderer
- Insecure IPC between main and renderer processes
- Supply chain attacks via dependencies or native compilation

Out of scope:

- Issues requiring physical access to an already-unlocked machine
- Denial of service against the local application
- Social engineering

## Security Model

- **Local-first audio processing** — Audio is transcribed through the bundled
  GigaAM sidecar by default. Recordings are not sent to external transcription
  providers unless the user explicitly configures a remote GigaAM-compatible
  endpoint.
- **Credential storage** — The transcription path no longer exposes BYOK API
  key storage. Non-secret preferences (regions, endpoints, hotkeys, flags)
  continue to live in `.env`.
- **Native binaries** — Platform-specific helpers (key listeners, paste
  utilities) are compiled from source during the build process.
- **Context isolation** — The Electron renderer runs with context isolation
  enabled and a restricted preload bridge.

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will credit
reporters in the changelog (unless they prefer to remain anonymous).
