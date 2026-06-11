# Network Allowlist

Outbound hosts the GigaType desktop app contacts. For firewall, proxy, and
DNS filter configuration.

All connections are client-initiated over TLS. No inbound ports.

## Required by default

Contacted by every install using GigaType Cloud (the default after
onboarding).

| Host | Protocol | Port | Purpose |
| --- | --- | --- | --- |
| `api.openwhispr.com` | HTTPS | 443 | Cloud API: sync, account-backed features, settings, usage. |
| `auth.openwhispr.com` | HTTPS | 443 | Account sign-in and session refresh (Better Auth). |
| `github.com`, `objects.githubusercontent.com` | HTTPS | 443 | Application auto-update (release artifacts via electron-updater, GitHub provider). |

## Optional for remote GigaAM transcription

Only required if the user overrides the bundled GigaAM sidecar with a remote
GigaAM-compatible endpoint.

| Host | Protocol | Port | Purpose |
| --- | --- | --- | --- |
| User-configured host | HTTPS | 443 | Remote GigaAM-compatible transcription endpoint. |

## Required for local model downloads

Contacted only when a local LLM, embedding, diarization, or VAD model needs to
be downloaded.

| Host | Protocol | Port | Purpose |
| --- | --- | --- | --- |
| `huggingface.co` | HTTPS | 443 | GGUF, VAD, diarization, and embedding model downloads. |
| `cdn-lfs.huggingface.co`, `cdn-lfs-us-1.huggingface.co` | HTTPS | 443 | HuggingFace large-file CDN (LFS-backed model files). |
| `github.com`, `objects.githubusercontent.com` | HTTPS | 443 | sherpa-onnx diarization, llama.cpp, and Qdrant binaries (GitHub releases). |

## Required for Google Calendar (optional feature)

Contacted only if the user connects Google Calendar in settings.

| Host | Protocol | Port | Purpose |
| --- | --- | --- | --- |
| `accounts.google.com` | HTTPS | 443 | OAuth authorization. |
| `oauth2.googleapis.com` | HTTPS | 443 | OAuth token exchange and revoke. |
| `www.googleapis.com` | HTTPS | 443 | Calendar event and calendar list reads. |
| `openwhispr.com` | HTTPS | 443 | OAuth desktop callback redirect (`/auth/desktop-callback`). |

## Notes

- The app uses Electron's network stack, which honors system proxy settings
  (macOS System Settings, Windows Internet Options / WPAD, GNOME proxy) and
  PAC scripts on all platforms.
- Connections fail with `ENOTFOUND` if DNS is filtered, `ECONNREFUSED` /
  `ETIMEDOUT` if a firewall blocks the host, and `CERT_HAS_EXPIRED` /
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` if a TLS-intercepting proxy is in the
  path without its root certificate trusted by the OS.
- IP-pinning is not supported. The hosts above resolve to provider-managed
  IPs that change without notice.
- On minimal Linux containers without a system CA bundle (Alpine, distroless),
  set `NODE_EXTRA_CA_CERTS` to your CA bundle path so corporate TLS interception
  is trusted.

## How to test

Run from a machine on the same network as the user. A successful response
(any HTTP status, including `401`) confirms the network path works.

```sh
# GigaType Cloud reachability
curl -v https://api.openwhispr.com/api/health

# Model downloads (only when local models are in use)
curl -v -I https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx
```

If a request returns `Could not resolve host`, the DNS layer (resolver,
filter, or ad blocker) is blocking the domain. If it hangs or returns
`Connection refused`, a firewall is blocking the port. If it returns a TLS
error, a proxy is intercepting the connection without a trusted root.
