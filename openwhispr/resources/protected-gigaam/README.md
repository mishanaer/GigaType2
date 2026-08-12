# Protected GigaAM release input

Protected macOS builds stage `gigaam-en-ru.memento-model` here from a secured release
artifact. The plaintext ONNX files, release CEK, and Ed25519 signing seed must never enter
this repository or the application bundle.

Required build inputs:

- `TYPE_PROTECTED_GIGAAM_MODEL_SOURCE`: path to the signed encrypted container;
- `TYPE_MODEL_MANIFEST_PUBLIC_KEY`: base64 Ed25519 public key pinned into the native loader;
- `TYPE_REGISTRATION_KEY`: gateway bootstrap key pinned into the native loader.

Run `npm run prepare:protected-gigaam` after `npm run compile:protected-gigaam`. The prepare
step verifies the container signature, identity, size, and SHA-256 through the native loader
and creates `required.json`. Electron packages only the encrypted container and that public
metadata.
