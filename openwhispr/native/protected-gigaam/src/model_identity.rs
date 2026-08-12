//! Per-install hardware identity used only by the proprietary-model service.
//!
//! This is intentionally separate from `gateway_identity`: `MEMENTO_REGISTRATION_KEY` and
//! the existing install JWT remain unchanged. The install JWT bootstraps a short-lived model
//! token, while requests for that token and for a wrapped CEK must also prove possession of
//! this non-exportable signing key.

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::protected::ContentKey;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicJwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
    pub y: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelDeviceIdentity {
    pub signing_jwk: PublicJwk,
    pub wrapping_jwk: PublicJwk,
    pub signing_fingerprint: String,
    pub wrapping_fingerprint: String,
    /// Client-reported backend for diagnostics only. The gateway must not treat this field
    /// as hardware attestation: a modified client can send any string here.
    pub hardware: &'static str,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WrappedContentKey {
    pub algorithm: String,
    pub ephemeral_public_key_b64: String,
    pub salt_b64: String,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
    pub release_id: String,
    pub key_id: String,
    pub wrapping_fingerprint: String,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use chacha20poly1305::aead::{Aead, KeyInit, Payload};
    use chacha20poly1305::{XChaCha20Poly1305, XNonce};
    use core_foundation::data::CFData;
    use hkdf::Hkdf;
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::item::{
        ItemSearchOptions, KeyClass, Location, Reference, SearchResult,
    };
    use security_framework::key::{Algorithm, GenerateKeyOptions, KeyType, SecKey, Token};
    #[allow(deprecated)]
    use security_framework::os::macos::key::SecKeyExt;
    use security_framework_sys::access_control::kSecAccessControlPrivateKeyUsage;
    use security_framework_sys::base::errSecItemNotFound;
    use zeroize::Zeroize;

    const SIGNING_LABEL: &str = "ai.gigatype.model-signing.v1";
    const WRAPPING_LABEL: &str = "ai.gigatype.model-wrapping.v1";
    const WRAP_ALGORITHM: &str = "ECDH-P256-HKDF-SHA256-XCHACHA20-POLY1305";

    pub struct HardwareIdentity {
        signing: SecKey,
        wrapping: SecKey,
    }

    fn find_private_key(label: &str) -> Result<Option<SecKey>> {
        let result = ItemSearchOptions::new()
            .key_class(KeyClass::private())
            .label(label)
            .load_refs(true)
            .search();
        let items = match result {
            Ok(items) => items,
            Err(error) if error.code() == errSecItemNotFound => return Ok(None),
            Err(error) => return Err(anyhow!("search macOS Keychain for model key: {error}")),
        };
        match items.into_iter().next() {
            Some(SearchResult::Ref(Reference::Key(key))) => Ok(Some(key)),
            None => Ok(None),
            Some(_) => bail!("macOS Keychain returned an unexpected model-key item"),
        }
    }

    fn create_key(label: &str) -> Result<SecKey> {
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
            kSecAccessControlPrivateKeyUsage,
        )
        .context("create Secure Enclave access policy")?;
        let mut options = GenerateKeyOptions::default();
        options
            .set_key_type(KeyType::ec())
            .set_size_in_bits(256)
            .set_label(label)
            .set_token(Token::SecureEnclave)
            .set_location(Location::DataProtectionKeychain)
            .set_access_control(access);
        SecKey::new(&options).map_err(|error| {
            anyhow!(
                "Secure Enclave P-256 key creation failed; protected models require supported hardware: {error}"
            )
        })
    }

    fn load_or_create(label: &str) -> Result<SecKey> {
        if let Some(key) = find_private_key(label)? {
            return Ok(key);
        }
        match create_key(label) {
            Ok(key) => Ok(key),
            // A concurrent caller may have won the create race. Re-read once, but never
            // silently replace a Keychain access error with a new identity.
            Err(create_error) => find_private_key(label)?.ok_or(create_error),
        }
    }

    fn public_bytes(key: &SecKey) -> Result<Vec<u8>> {
        let public = key
            .public_key()
            .ok_or_else(|| anyhow!("model key has no public key"))?;
        let bytes = public
            .external_representation()
            .ok_or_else(|| anyhow!("model public key is not exportable"))?
            .to_vec();
        if bytes.len() != 65 || bytes[0] != 4 {
            bail!("model public key is not an uncompressed P-256 point");
        }
        Ok(bytes)
    }

    fn jwk(bytes: &[u8]) -> Result<PublicJwk> {
        if bytes.len() != 65 || bytes[0] != 4 {
            bail!("invalid P-256 public key encoding");
        }
        Ok(PublicJwk {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: URL_SAFE_NO_PAD.encode(&bytes[1..33]),
            y: URL_SAFE_NO_PAD.encode(&bytes[33..65]),
        })
    }

    fn fingerprint(bytes: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(bytes))
    }

    fn der_integer(input: &[u8], cursor: &mut usize) -> Result<[u8; 32]> {
        if input.get(*cursor) != Some(&0x02) {
            bail!("malformed ECDSA signature integer");
        }
        *cursor += 1;
        let len = *input
            .get(*cursor)
            .ok_or_else(|| anyhow!("truncated ECDSA signature"))? as usize;
        *cursor += 1;
        let value = input
            .get(*cursor..*cursor + len)
            .ok_or_else(|| anyhow!("truncated ECDSA signature integer"))?;
        *cursor += len;
        let value = if value.first() == Some(&0) {
            &value[1..]
        } else {
            value
        };
        if value.is_empty() || value.len() > 32 {
            bail!("invalid ECDSA signature integer width");
        }
        let mut output = [0u8; 32];
        output[32 - value.len()..].copy_from_slice(value);
        Ok(output)
    }

    fn der_to_jose(signature: &[u8]) -> Result<[u8; 64]> {
        if signature.first() != Some(&0x30) || signature.len() < 8 {
            bail!("malformed DER ECDSA signature");
        }
        let mut cursor = 1usize;
        let sequence_len = *signature
            .get(cursor)
            .ok_or_else(|| anyhow!("truncated DER signature"))? as usize;
        cursor += 1;
        if sequence_len & 0x80 != 0 || sequence_len != signature.len() - cursor {
            bail!("unsupported DER ECDSA signature length");
        }
        let r = der_integer(signature, &mut cursor)?;
        let s = der_integer(signature, &mut cursor)?;
        if cursor != signature.len() {
            bail!("trailing data in DER ECDSA signature");
        }
        let mut output = [0u8; 64];
        output[..32].copy_from_slice(&r);
        output[32..].copy_from_slice(&s);
        Ok(output)
    }

    impl HardwareIdentity {
        pub fn load() -> Result<Self> {
            Ok(Self {
                signing: load_or_create(SIGNING_LABEL)?,
                wrapping: load_or_create(WRAPPING_LABEL)?,
            })
        }

        pub fn public_identity(&self) -> Result<ModelDeviceIdentity> {
            let signing = public_bytes(&self.signing)?;
            let wrapping = public_bytes(&self.wrapping)?;
            Ok(ModelDeviceIdentity {
                signing_jwk: jwk(&signing)?,
                wrapping_jwk: jwk(&wrapping)?,
                signing_fingerprint: fingerprint(&signing),
                wrapping_fingerprint: fingerprint(&wrapping),
                hardware: "apple-secure-enclave",
            })
        }

        pub fn sign_jose(&self, message: &[u8]) -> Result<[u8; 64]> {
            let der = self
                .signing
                .create_signature(Algorithm::ECDSASignatureMessageX962SHA256, message)
                .map_err(|error| anyhow!("sign model request in Secure Enclave: {error:?}"))?;
            der_to_jose(&der)
        }

        pub fn unwrap(&self, wrapped: &WrappedContentKey) -> Result<ContentKey> {
            if wrapped.algorithm != WRAP_ALGORITHM {
                bail!("unsupported wrapped content-key algorithm");
            }
            let public = public_bytes(&self.wrapping)?;
            if wrapped.wrapping_fingerprint != fingerprint(&public) {
                bail!("wrapped content key belongs to a different installation");
            }
            let ephemeral = STANDARD
                .decode(&wrapped.ephemeral_public_key_b64)
                .context("decode ephemeral P-256 key")?;
            if ephemeral.len() != 65 || ephemeral[0] != 4 {
                bail!("invalid ephemeral P-256 key");
            }
            #[allow(deprecated)]
            let ephemeral_key = SecKey::from_data(KeyType::ec(), &CFData::from_buffer(&ephemeral))
                .map_err(|error| anyhow!("import ephemeral P-256 key: {error:?}"))?;
            let mut shared = self
                .wrapping
                .key_exchange(Algorithm::ECDHKeyExchangeStandard, &ephemeral_key, 32, None)
                .map_err(|error| anyhow!("Secure Enclave key agreement: {error:?}"))?;
            let salt = STANDARD
                .decode(&wrapped.salt_b64)
                .context("decode CEK wrap salt")?;
            if salt.len() != 32 {
                shared.zeroize();
                bail!("CEK wrap salt must contain 32 bytes");
            }
            let info = format!(
                "memento-cek-wrap-v1\0{}\0{}\0{}",
                wrapped.release_id, wrapped.key_id, wrapped.wrapping_fingerprint
            );
            let hk = Hkdf::<Sha256>::new(Some(&salt), &shared);
            let mut kek = [0u8; 32];
            hk.expand(info.as_bytes(), &mut kek)
                .map_err(|_| anyhow!("derive CEK wrapping key"))?;
            shared.zeroize();
            let nonce = STANDARD
                .decode(&wrapped.nonce_b64)
                .context("decode CEK wrap nonce")?;
            if nonce.len() != 24 {
                kek.zeroize();
                bail!("CEK wrap nonce must contain 24 bytes");
            }
            let ciphertext = STANDARD
                .decode(&wrapped.ciphertext_b64)
                .context("decode wrapped CEK")?;
            let cipher = XChaCha20Poly1305::new((&kek).into());
            kek.zeroize();
            let mut plaintext = cipher
                .decrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: info.as_bytes(),
                    },
                )
                .map_err(|_| anyhow!("wrapped content-key authentication failed"))?;
            let result = ContentKey::from_slice(&plaintext);
            plaintext.zeroize();
            result
        }
    }

    #[cfg(test)]
    mod tests {
        use super::der_to_jose;

        #[test]
        fn converts_short_positive_der_integers_to_jose_width() {
            let der = [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02];
            let jose = der_to_jose(&der).unwrap();
            assert_eq!(jose[31], 1);
            assert_eq!(jose[63], 2);
        }

        #[test]
        fn rejects_non_minimal_or_trailing_der() {
            assert!(der_to_jose(&[0x30, 0x06, 0x02, 0x01, 1, 0x02, 0x01]).is_err());
            assert!(der_to_jose(&[0x30, 0x06, 0x02, 0x01, 1, 0x02, 0x01, 2, 0]).is_err());
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use chacha20poly1305::aead::{Aead, KeyInit, Payload};
    use chacha20poly1305::{XChaCha20Poly1305, XNonce};
    use hkdf::Hkdf;
    use windows::core::HSTRING;
    use windows::Win32::Security::Cryptography::{
        NCryptCreatePersistedKey, NCryptDeriveKey, NCryptExportKey, NCryptFinalizeKey,
        NCryptFreeObject, NCryptGetProperty, NCryptImportKey, NCryptOpenKey,
        NCryptOpenStorageProvider, NCryptSecretAgreement, NCryptSetProperty, NCryptSignHash,
        BCRYPT_ECCPUBLIC_BLOB, BCRYPT_ECDH_PUBLIC_P256_MAGIC, BCRYPT_ECDSA_PUBLIC_P256_MAGIC,
        BCRYPT_KDF_RAW_SECRET, CERT_KEY_SPEC, MS_PLATFORM_CRYPTO_PROVIDER,
        NCRYPT_ALLOW_KEY_AGREEMENT_FLAG, NCRYPT_ALLOW_SIGNING_FLAG, NCRYPT_ECDH_P256_ALGORITHM,
        NCRYPT_ECDSA_P256_ALGORITHM, NCRYPT_EXPORT_POLICY_PROPERTY, NCRYPT_FLAGS, NCRYPT_HANDLE,
        NCRYPT_IMPL_HARDWARE_FLAG, NCRYPT_IMPL_TYPE_PROPERTY, NCRYPT_KEY_HANDLE,
        NCRYPT_KEY_USAGE_PROPERTY, NCRYPT_PROV_HANDLE, NCRYPT_SECRET_HANDLE, NCRYPT_SILENT_FLAG,
    };
    use windows::Win32::Security::OBJECT_SECURITY_INFORMATION;
    use zeroize::Zeroize;

    const SIGNING_LABEL: &str = "ai.gigatype.model-signing.v1";
    const WRAPPING_LABEL: &str = "ai.gigatype.model-wrapping.v1";
    const WRAP_ALGORITHM: &str = "ECDH-P256-HKDF-SHA256-XCHACHA20-POLY1305";
    const NO_FLAGS: NCRYPT_FLAGS = NCRYPT_FLAGS(0);

    struct ProviderHandle(NCRYPT_PROV_HANDLE);
    struct KeyHandle(NCRYPT_KEY_HANDLE);
    struct SecretHandle(NCRYPT_SECRET_HANDLE);

    impl Drop for ProviderHandle {
        fn drop(&mut self) {
            // SAFETY: this wrapper uniquely owns the handle returned by NCrypt.
            let _ = unsafe { NCryptFreeObject(self.0.into()) };
        }
    }

    impl Drop for KeyHandle {
        fn drop(&mut self) {
            // SAFETY: this wrapper uniquely owns the handle returned by NCrypt.
            let _ = unsafe { NCryptFreeObject(self.0.into()) };
        }
    }

    impl Drop for SecretHandle {
        fn drop(&mut self) {
            // SAFETY: this wrapper uniquely owns the handle returned by NCrypt.
            let _ = unsafe { NCryptFreeObject(NCRYPT_HANDLE((self.0).0)) };
        }
    }

    pub struct HardwareIdentity {
        signing: KeyHandle,
        wrapping: KeyHandle,
        // Rust drops fields in declaration order, so the provider deliberately comes last
        // and outlives both keys created/opened through it.
        _provider: ProviderHandle,
    }

    fn read_u32_property(handle: NCRYPT_HANDLE, property: windows::core::PCWSTR) -> Result<u32> {
        let mut bytes = [0u8; 4];
        let mut written = 0u32;
        // SAFETY: the handle is live and `bytes` is a valid output buffer.
        unsafe {
            NCryptGetProperty(
                handle,
                property,
                Some(&mut bytes),
                &mut written,
                OBJECT_SECURITY_INFORMATION(0),
            )
        }
        .context("read Windows CNG key property")?;
        if written != bytes.len() as u32 {
            bail!("Windows CNG property has an unexpected width");
        }
        Ok(u32::from_ne_bytes(bytes))
    }

    fn open_provider() -> Result<ProviderHandle> {
        let mut handle = NCRYPT_PROV_HANDLE::default();
        // SAFETY: `handle` is a valid out pointer and the provider name is static UTF-16.
        unsafe { NCryptOpenStorageProvider(&mut handle, MS_PLATFORM_CRYPTO_PROVIDER, 0) }
            .context("open Microsoft Platform Crypto Provider (TPM required)")?;
        let provider = ProviderHandle(handle);
        let implementation = read_u32_property(provider.0.into(), NCRYPT_IMPL_TYPE_PROPERTY)?;
        if implementation & NCRYPT_IMPL_HARDWARE_FLAG == 0 {
            bail!("Microsoft Platform Crypto Provider is not hardware-backed");
        }
        Ok(provider)
    }

    fn open_key(provider: &ProviderHandle, label: &str) -> Result<KeyHandle> {
        let mut handle = NCRYPT_KEY_HANDLE::default();
        let label = HSTRING::from(label);
        // SAFETY: provider is live, `handle` is a valid out pointer, and the name is live.
        unsafe {
            NCryptOpenKey(
                provider.0,
                &mut handle,
                &label,
                CERT_KEY_SPEC(0),
                NCRYPT_SILENT_FLAG,
            )
        }
        .context("open persisted Windows TPM model key")?;
        Ok(KeyHandle(handle))
    }

    fn create_key(
        provider: &ProviderHandle,
        label: &str,
        algorithm: windows::core::PCWSTR,
        usage: u32,
    ) -> Result<KeyHandle> {
        let mut handle = NCRYPT_KEY_HANDLE::default();
        let label = HSTRING::from(label);
        // SAFETY: provider is live and all pointers remain valid for the call.
        unsafe {
            NCryptCreatePersistedKey(
                provider.0,
                &mut handle,
                algorithm,
                &label,
                CERT_KEY_SPEC(0),
                NCRYPT_SILENT_FLAG,
            )
        }
        .context("create persisted Windows TPM model key")?;
        let key = KeyHandle(handle);
        let no_export = 0u32.to_ne_bytes();
        let usage = usage.to_ne_bytes();
        // Explicitly deny private-key export and restrict each key to its one purpose.
        // SAFETY: key is live and both property buffers have the required u32 width.
        unsafe {
            NCryptSetProperty(
                key.0.into(),
                NCRYPT_EXPORT_POLICY_PROPERTY,
                &no_export,
                NO_FLAGS,
            )?;
            NCryptSetProperty(key.0.into(), NCRYPT_KEY_USAGE_PROPERTY, &usage, NO_FLAGS)?;
            NCryptFinalizeKey(key.0, NCRYPT_SILENT_FLAG)?;
        }
        Ok(key)
    }

    fn verify_key_policy(key: &KeyHandle, expected_usage: u32) -> Result<()> {
        let export_policy = read_u32_property(key.0.into(), NCRYPT_EXPORT_POLICY_PROPERTY)?;
        if export_policy != 0 {
            bail!("Windows TPM model key unexpectedly permits private-key export");
        }
        let usage = read_u32_property(key.0.into(), NCRYPT_KEY_USAGE_PROPERTY)?;
        if usage & expected_usage == 0 {
            bail!("Windows TPM model key does not permit its required operation");
        }
        Ok(())
    }

    fn load_or_create(
        provider: &ProviderHandle,
        label: &str,
        algorithm: windows::core::PCWSTR,
        usage: u32,
    ) -> Result<KeyHandle> {
        let key = match open_key(provider, label) {
            Ok(key) => key,
            Err(open_error) => match create_key(provider, label, algorithm, usage) {
                Ok(key) => key,
                // Another process may have won the create race. Re-open once; return the
                // creation failure if the persisted key still is not available.
                Err(create_error) => open_key(provider, label).map_err(|_| {
                    anyhow!(
                        "Windows TPM model key was neither openable ({open_error:#}) nor creatable ({create_error:#})"
                    )
                })?,
            },
        };
        verify_key_policy(&key, usage)?;
        Ok(key)
    }

    fn public_bytes(key: &KeyHandle, expected_magic: u32) -> Result<Vec<u8>> {
        let mut required = 0u32;
        // SAFETY: key is live and this first call requests only the output size.
        unsafe {
            NCryptExportKey(
                key.0,
                None,
                BCRYPT_ECCPUBLIC_BLOB,
                None,
                None,
                &mut required,
                NO_FLAGS,
            )
        }
        .context("size Windows TPM public-key export")?;
        let mut blob = vec![0u8; required as usize];
        let mut written = 0u32;
        // SAFETY: key is live and `blob` has the size requested by NCrypt.
        unsafe {
            NCryptExportKey(
                key.0,
                None,
                BCRYPT_ECCPUBLIC_BLOB,
                None,
                Some(&mut blob),
                &mut written,
                NO_FLAGS,
            )
        }
        .context("export Windows TPM public key")?;
        blob.truncate(written as usize);
        parse_public_blob(&blob, expected_magic)
    }

    fn parse_public_blob(blob: &[u8], expected_magic: u32) -> Result<Vec<u8>> {
        if blob.len() < 8 {
            bail!("truncated Windows ECC public-key blob");
        }
        let magic = u32::from_le_bytes(blob[0..4].try_into().expect("fixed slice"));
        let coordinate_size =
            u32::from_le_bytes(blob[4..8].try_into().expect("fixed slice")) as usize;
        if magic != expected_magic || coordinate_size != 32 || blob.len() != 8 + 64 {
            bail!("Windows model key is not a P-256 public key");
        }
        let mut sec1 = Vec::with_capacity(65);
        sec1.push(4);
        sec1.extend_from_slice(&blob[8..]);
        Ok(sec1)
    }

    fn ecc_public_blob(sec1: &[u8]) -> Result<Vec<u8>> {
        if sec1.len() != 65 || sec1[0] != 4 {
            bail!("invalid ephemeral P-256 key");
        }
        let mut blob = Vec::with_capacity(72);
        blob.extend_from_slice(&BCRYPT_ECDH_PUBLIC_P256_MAGIC.to_le_bytes());
        blob.extend_from_slice(&32u32.to_le_bytes());
        blob.extend_from_slice(&sec1[1..]);
        Ok(blob)
    }

    fn jwk(bytes: &[u8]) -> Result<PublicJwk> {
        if bytes.len() != 65 || bytes[0] != 4 {
            bail!("invalid P-256 public key encoding");
        }
        Ok(PublicJwk {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: URL_SAFE_NO_PAD.encode(&bytes[1..33]),
            y: URL_SAFE_NO_PAD.encode(&bytes[33..65]),
        })
    }

    fn fingerprint(bytes: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(bytes))
    }

    impl HardwareIdentity {
        pub fn load() -> Result<Self> {
            let provider = open_provider()?;
            let signing = load_or_create(
                &provider,
                SIGNING_LABEL,
                NCRYPT_ECDSA_P256_ALGORITHM,
                NCRYPT_ALLOW_SIGNING_FLAG,
            )?;
            let wrapping = load_or_create(
                &provider,
                WRAPPING_LABEL,
                NCRYPT_ECDH_P256_ALGORITHM,
                NCRYPT_ALLOW_KEY_AGREEMENT_FLAG,
            )?;
            Ok(Self {
                signing,
                wrapping,
                _provider: provider,
            })
        }

        pub fn public_identity(&self) -> Result<ModelDeviceIdentity> {
            let signing = public_bytes(&self.signing, BCRYPT_ECDSA_PUBLIC_P256_MAGIC)?;
            let wrapping = public_bytes(&self.wrapping, BCRYPT_ECDH_PUBLIC_P256_MAGIC)?;
            Ok(ModelDeviceIdentity {
                signing_jwk: jwk(&signing)?,
                wrapping_jwk: jwk(&wrapping)?,
                signing_fingerprint: fingerprint(&signing),
                wrapping_fingerprint: fingerprint(&wrapping),
                hardware: "windows-platform-crypto-provider",
            })
        }

        pub fn sign_jose(&self, message: &[u8]) -> Result<[u8; 64]> {
            let digest = Sha256::digest(message);
            let mut signature = [0u8; 64];
            let mut written = 0u32;
            // ECDSA signatures returned by CNG are already the JOSE `r || s` form.
            // SAFETY: the key is live and the signature output buffer is valid.
            unsafe {
                NCryptSignHash(
                    self.signing.0,
                    None,
                    &digest,
                    Some(&mut signature),
                    &mut written,
                    NCRYPT_SILENT_FLAG,
                )
            }
            .context("sign model request with Windows TPM key")?;
            if written != signature.len() as u32 {
                bail!("Windows TPM produced an unexpected ECDSA signature width");
            }
            Ok(signature)
        }

        pub fn unwrap(&self, wrapped: &WrappedContentKey) -> Result<ContentKey> {
            if wrapped.algorithm != WRAP_ALGORITHM {
                bail!("unsupported wrapped content-key algorithm");
            }
            let public = public_bytes(&self.wrapping, BCRYPT_ECDH_PUBLIC_P256_MAGIC)?;
            if wrapped.wrapping_fingerprint != fingerprint(&public) {
                bail!("wrapped content key belongs to a different installation");
            }
            let ephemeral = STANDARD
                .decode(&wrapped.ephemeral_public_key_b64)
                .context("decode ephemeral P-256 key")?;
            let blob = ecc_public_blob(&ephemeral)?;
            let mut ephemeral_handle = NCRYPT_KEY_HANDLE::default();
            // SAFETY: provider is live, blob has a validated BCRYPT_ECCKEY_BLOB layout, and
            // the output pointer is valid.
            unsafe {
                NCryptImportKey(
                    self._provider.0,
                    None,
                    BCRYPT_ECCPUBLIC_BLOB,
                    None,
                    &mut ephemeral_handle,
                    &blob,
                    NO_FLAGS,
                )
            }
            .context("import ephemeral P-256 key for Windows TPM agreement")?;
            let ephemeral_key = KeyHandle(ephemeral_handle);
            let mut secret_handle = NCRYPT_SECRET_HANDLE::default();
            // SAFETY: both key handles are live and the secret output pointer is valid.
            unsafe {
                NCryptSecretAgreement(
                    self.wrapping.0,
                    ephemeral_key.0,
                    &mut secret_handle,
                    NCRYPT_SILENT_FLAG,
                )
            }
            .context("perform Windows TPM P-256 key agreement")?;
            let secret = SecretHandle(secret_handle);
            let mut shared = [0u8; 32];
            let mut written = 0u32;
            // SAFETY: the secret is live and `shared` is a valid output buffer.
            unsafe {
                NCryptDeriveKey(
                    secret.0,
                    BCRYPT_KDF_RAW_SECRET,
                    None,
                    Some(&mut shared),
                    &mut written,
                    0,
                )
            }
            .context("derive raw Windows TPM ECDH secret")?;
            if written != shared.len() as u32 {
                shared.zeroize();
                bail!("Windows TPM produced an unexpected ECDH secret width");
            }
            // CNG's RAW_SECRET KDF is little-endian; the server and standard P-256 ECDH
            // representation are big-endian.
            shared.reverse();
            let salt = STANDARD
                .decode(&wrapped.salt_b64)
                .context("decode CEK wrap salt")?;
            if salt.len() != 32 {
                shared.zeroize();
                bail!("CEK wrap salt must contain 32 bytes");
            }
            let info = format!(
                "memento-cek-wrap-v1\0{}\0{}\0{}",
                wrapped.release_id, wrapped.key_id, wrapped.wrapping_fingerprint
            );
            let hk = Hkdf::<Sha256>::new(Some(&salt), &shared);
            let mut kek = [0u8; 32];
            hk.expand(info.as_bytes(), &mut kek)
                .map_err(|_| anyhow!("derive CEK wrapping key"))?;
            shared.zeroize();
            let nonce = STANDARD
                .decode(&wrapped.nonce_b64)
                .context("decode CEK wrap nonce")?;
            if nonce.len() != 24 {
                kek.zeroize();
                bail!("CEK wrap nonce must contain 24 bytes");
            }
            let ciphertext = STANDARD
                .decode(&wrapped.ciphertext_b64)
                .context("decode wrapped CEK")?;
            let cipher = XChaCha20Poly1305::new((&kek).into());
            kek.zeroize();
            let mut plaintext = cipher
                .decrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: info.as_bytes(),
                    },
                )
                .map_err(|_| anyhow!("wrapped content-key authentication failed"))?;
            let result = ContentKey::from_slice(&plaintext);
            plaintext.zeroize();
            result
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_cng_p256_public_blob() {
            let mut blob = Vec::new();
            blob.extend_from_slice(&BCRYPT_ECDSA_PUBLIC_P256_MAGIC.to_le_bytes());
            blob.extend_from_slice(&32u32.to_le_bytes());
            blob.extend_from_slice(&[7u8; 64]);
            let sec1 = parse_public_blob(&blob, BCRYPT_ECDSA_PUBLIC_P256_MAGIC).unwrap();
            assert_eq!(sec1[0], 4);
            assert_eq!(&sec1[1..], &[7u8; 64]);
        }

        #[test]
        fn rejects_wrong_cng_public_blob_type() {
            let mut blob = Vec::new();
            blob.extend_from_slice(&BCRYPT_ECDSA_PUBLIC_P256_MAGIC.to_le_bytes());
            blob.extend_from_slice(&32u32.to_le_bytes());
            blob.extend_from_slice(&[0u8; 64]);
            assert!(parse_public_blob(&blob, BCRYPT_ECDH_PUBLIC_P256_MAGIC).is_err());
        }

        #[test]
        #[ignore = "requires a physical Windows TPM and persists the per-install keys"]
        fn loads_real_tpm_identity_and_signs() {
            let identity = HardwareIdentity::load().unwrap();
            let public = identity.public_identity().unwrap();
            assert_eq!(public.hardware, "windows-platform-crypto-provider");
            assert_eq!(
                identity.sign_jose(b"memento TPM smoke test").unwrap().len(),
                64
            );
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;

    pub struct HardwareIdentity;

    impl HardwareIdentity {
        pub fn load() -> Result<Self> {
            bail!("protected models require a hardware-backed identity; this platform backend is not enabled")
        }

        pub fn public_identity(&self) -> Result<ModelDeviceIdentity> {
            unreachable!()
        }

        pub fn sign_jose(&self, _message: &[u8]) -> Result<[u8; 64]> {
            unreachable!()
        }

        pub fn unwrap(&self, _wrapped: &WrappedContentKey) -> Result<ContentKey> {
            unreachable!()
        }
    }
}

pub use platform::HardwareIdentity;

#[derive(Serialize)]
struct DpopHeader<'a> {
    typ: &'a str,
    alg: &'a str,
    jwk: &'a PublicJwk,
}

#[derive(Serialize)]
struct DpopClaims<'a> {
    htm: &'a str,
    htu: &'a str,
    iat: i64,
    jti: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ath: Option<String>,
}

/// RFC 9449 proof bound to one exact method, URL, and optional bearer token.
pub fn dpop_proof(
    identity: &HardwareIdentity,
    method: &str,
    url: &str,
    access_token: Option<&str>,
) -> Result<String> {
    let public = identity.public_identity()?;
    let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&DpopHeader {
        typ: "dpop+jwt",
        alg: "ES256",
        jwk: &public.signing_jwk,
    })?);
    let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&DpopClaims {
        htm: method,
        htu: url,
        iat: chrono::Utc::now().timestamp(),
        jti: uuid::Uuid::new_v4().to_string(),
        ath: access_token.map(|token| URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))),
    })?);
    let signing_input = format!("{header}.{claims}");
    let signature = identity.sign_jose(signing_input.as_bytes())?;
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

pub fn fingerprint_from_jwk(jwk: &PublicJwk) -> Result<String> {
    if jwk.kty != "EC" || jwk.crv != "P-256" {
        bail!("model identity JWK must be P-256");
    }
    let x = URL_SAFE_NO_PAD.decode(&jwk.x).context("decode JWK x")?;
    let y = URL_SAFE_NO_PAD.decode(&jwk.y).context("decode JWK y")?;
    if x.len() != 32 || y.len() != 32 {
        bail!("model identity JWK coordinates must be 32 bytes");
    }
    let mut point = Vec::with_capacity(65);
    point.push(4);
    point.extend_from_slice(&x);
    point.extend_from_slice(&y);
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(point)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jwk_fingerprint_is_stable_and_rejects_wrong_curve() {
        let jwk = PublicJwk {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: URL_SAFE_NO_PAD.encode([1u8; 32]),
            y: URL_SAFE_NO_PAD.encode([2u8; 32]),
        };
        assert_eq!(fingerprint_from_jwk(&jwk).unwrap().len(), 43);
        let mut bad = jwk;
        bad.crv = "P-384".into();
        assert!(fingerprint_from_jwk(&bad).is_err());
    }
}
