# Protected bundled GigaAM for Type

Type can ship the same signed `.memento-model` container format used by the Memento
protected-model implementation at commit `1b87e410`. The macOS application contains one
common encrypted RU+EN RNN-T container. Plaintext ONNX weights, the release CEK, and the
Ed25519 signing seed are not included in the application or this repository.

This path is intentionally opt-in until the production container and model-gateway service
exist. Normal Type builds keep their current CoreML/ONNX packaging.

## Runtime

`GigaamLocalAsrManager` detects `Contents/Resources/protected-gigaam/required.json` and then
uses `type-protected-gigaam` instead of the plaintext/CoreML paths. The signed native helper:

1. verifies the container signature, identity, asset set, layout, and minimum client version;
2. reuses a cached per-device wrapped CEK when it can be unwrapped by this installation;
3. otherwise registers with the existing Type gateway and obtains a short-lived DPoP-bound
   model token and a CEK wrapped to the device's hardware key;
4. checks the gateway release descriptor against the exact bundled container;
5. decrypts each ONNX asset into memory and creates the ONNX Runtime sessions without writing
   plaintext weights to disk;
6. serves Float32 16 kHz mono PCM over a length-prefixed stdio protocol.

On macOS the signing and wrapping keys live in Secure Enclave and are this-device-only. The
wrapped CEK is cached in Keychain. After one successful online activation, model loading and
transcription work offline on the same installation. A cleared Secure Enclave key, OS erase,
or motherboard replacement requires online re-enrollment.

The protected build is fail-closed. A missing helper/container/key, a signature failure, a
different release descriptor, or an incomplete protected package does not fall back to a
public download or plaintext weights.

## Build

The release operator supplies:

- `TYPE_PROTECTED_GIGAAM_MODEL_SOURCE`: signed `gigaam-v3-e2e-rnnt-en-ru` container;
- `TYPE_MODEL_MANIFEST_PUBLIC_KEY`: base64 Ed25519 verifying key;
- `TYPE_REGISTRATION_KEY`: existing Type gateway registration key.

Build an Apple Silicon package with:

```bash
TYPE_PROTECTED_GIGAAM_MODEL_SOURCE=/secure/release.memento-model \
TYPE_MODEL_MANIFEST_PUBLIC_KEY=... \
TYPE_REGISTRATION_KEY=... \
npm run build:mac:protected:arm64
```

Use `build:mac:protected:x64` for Intel. Secrets are compiled into the native helper only;
they must come from the release secret store. `prepare:protected-gigaam` verifies the signed
container using that helper and creates the ignored `required.json` marker. `afterPack`
re-verifies the packaged artifact, removes `gigaam-model`, `gigaam-ane`, and the CoreML helper,
and registers the protected helper for code signing.

Because this implementation loads authenticated ONNX bytes from memory, the protected macOS
build currently uses ONNX CPU rather than the filesystem-backed CoreML/ANE encoder. Expect an
approximately 892 MB encrypted model and higher CPU/RAM use than the current Apple Silicon
CoreML build. Protecting a CoreML package without recreating readable files is separate work.

## Gateway contract

The client uses the existing `/register` and `/me` routes and requires these additive routes:

- `POST /model/v1/token`;
- `GET /model/v1/releases/{release_id}?model_id=...`;
- `POST /model/v1/releases/{release_id}/key`.

The exact-release lookup is required because an older installer may first activate after a
newer model has become current. The key route must validate entitlement/admission, the DPoP
token, model/release/key identity, and wrapping fingerprint before wrapping the release CEK.
The gateway/KMS owns the release CEK and signing operation; neither belongs in desktop CI.

## Release gates

- provision the production Ed25519 key, encrypted container, CEK custody, and gateway routes;
- exercise first activation, cached offline restart, key deletion/re-enrollment, revocation,
  wrong-device unwrap, tamper, truncated-container, and gateway-unavailable cases on real Macs;
- notarize and verify the final app contains the encrypted container and native helper but no
  `*.onnx`, `*.mlmodelc`, CEK, or signing seed;
- run transcription quality/performance checks against the current RU+EN model;
- complete gateway rate limits, monitoring, and the chosen admission/attestation policy.

Client-side encryption substantially raises the cost of copying weights from an installer or
cache, but it is not absolute DRM: an authorized, modified native process can still inspect
plaintext model memory after hardware unwrap. Server-side inference is the only way to keep
weights entirely outside an untrusted client.
