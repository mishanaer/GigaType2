# Signing a protected macOS build

A protected build (`build:mac:protected:arm64`) ships the encrypted GigaAM
container plus the native helper that unlocks it. The helper creates a **Secure
Enclave** key, and macOS only allows that when the code carries the
`keychain-access-groups` + `com.apple.application-identifier` entitlements —
which AMFI honours only when an embedded **provisioning profile** authorizes
them. An unsigned or merely ad-hoc-signed build always fails activation with
`OSStatus -34018`; that is expected, not a bug.

A profile can only be embedded in a _bundle_, so `afterPack.js` wraps the helper:

```
Contents/Resources/bin/
  type-protected-gigaam                                   launcher (no privileged entitlements)
  macos-gigaam-encoder                                    ANE encoder helper
  TypeProtectedGigaAM.app/Contents/
    MacOS/type-protected-gigaam                           the real helper (signed WITH them)
    embedded.provisionprofile                             put here before signing
```

The launcher `exec`s the real helper, so the spawn path the app uses is
unchanged and the sidecar keeps its pid and stdio pipes. The nested bundle
deliberately claims the **same** bundle id as the app (`ai.gigatype.app`):
`model_identity.rs` sets no explicit `kSecAttrAccessGroup`, so the Secure Enclave
key lands in the default group — the signer's application-identifier.

## Who signs

Signer: **Mikhail Naer, team `SBHVKH5UUY`**. The certificate _and_ the profile
must come from the same team — a certificate from another team with this
profile is rejected by AMFI.

Certificate, profile, entitlements and a ready `sign-type.sh` live outside the
repo (they must never be committed):

```
~/.gigatype-release/apple-signing-misha/
```

See `~/.gigatype-release/README.md` for the inventory, the identity SHA-1 to
sign with, and where the `.p12` password is kept (macOS Keychain, not a file).

## Signing

```bash
~/.gigatype-release/apple-signing-misha/sign-type.sh /path/to/Type.app
```

It embeds the profile at both levels, signs inner-to-outer (nested Mach-O,
frameworks, Electron helper apps → `TypeProtectedGigaAM.app` with the helper
entitlements → the outer app last), and verifies. Sign by the identity's SHA-1,
never by name: a second certificate with the same display name exists and is not
in the profile.

Verify:

```bash
codesign --verify --deep --strict --verbose=2 Type.app
codesign -d --entitlements :- Type.app/Contents/Resources/bin/TypeProtectedGigaAM.app
node scripts/verify-macos-app-identity.js /path/to/Type.app
```

The helper's entitlements must show `SBHVKH5UUY.ai.gigatype.app` in both
`com.apple.application-identifier` and `keychain-access-groups`.

## Gotchas that have cost a round-trip each

- **Rebuilt `app.asar`?** Update `ElectronAsarIntegrity` in `Contents/Info.plist`
  or the signed app dies on launch with
  `ERR_FAILED (-2) loading …/app.asar/src/dist/index.html`. The check does not
  fire on ad-hoc-signed builds, so it only shows up after real signing:

  ```bash
  H=$(node -e "const a=require('@electron/asar'),c=require('crypto');console.log(c.createHash('sha256').update(a.getRawHeader('Type.app/Contents/Resources/app.asar').headerString).digest('hex'))")
  /usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash $H" Type.app/Contents/Info.plist
  ```

  Then re-sign — editing `Info.plist` invalidates the signature.

- **Signing a build that came out of a DMG?** Copy it off the read-only volume
  first, and re-sign _every_ nested Mach-O: a handed-over build may carry ad-hoc
  signatures inside, and mixed signatures fail `--verify --deep --strict`.

- **Permissions not sticking (Accessibility toggle does nothing)?** More than one
  app with bundle id `ai.gigatype.app` is registered — TCC matches on bundle id
  plus code requirement, and copies signed by different teams collide. Keep one
  install, unregister the others (`lsregister -u <path>`), then
  `tccutil reset Accessibility ai.gigatype.app`.

  Current builds repair the known legacy Type bundle IDs once when a returning
  user explicitly presses the Accessibility permission button. Release CI also
  rejects an outer or protected-helper bundle unless both its identifier and
  signing team remain `ai.gigatype.app` / `SBHVKH5UUY`.

- **Notarization** needs credentials for team `SBHVKH5UUY` that we do not have
  yet. Signed-but-unnotarized builds run locally; Gatekeeper warns elsewhere.

## Activation, once signed

First launch creates the Secure Enclave key, calls `gw.multitool.works` (falling
back to `gw2`), receives the content key wrapped to that Mac, decrypts the
container in memory and loads the fp16 encoder onto the Neural Engine. The
release bundled in the app must be registered on the gateway first — Type
resolves it by exact `release_id`. See `PROTECTED_BUNDLED_GIGAAM.md`.
