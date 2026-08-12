//! Authenticated, release-wide container for proprietary GigaAM weights.
//!
//! The `.memento-model` file is identical for every installation and may live on an
//! untrusted CDN or Yandex Disk.  A small content-encryption key (CEK) is issued separately
//! by the model gateway and wrapped to a hardware-backed key belonging to one installation.
//! Plaintext weights are never written to disk by this module.

use std::fs::File;
#[cfg(any(test, feature = "model-packaging"))]
use std::io::Write;
use std::io::{Read, Seek, SeekFrom};
#[cfg(any(test, feature = "model-packaging"))]
use std::path::PathBuf;
use std::path::{Component, Path};
use std::sync::Mutex;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
#[cfg(any(test, feature = "model-packaging"))]
use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
#[cfg(any(test, feature = "model-packaging"))]
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

const MAGIC: &[u8; 8] = b"MMODEL01";
const HEADER_LEN: u64 = 12;
const TAG_LEN: u64 = 16;
const ALGORITHM: &str = "XCHACHA20-POLY1305-HKDF-SHA256-CHUNKED";
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MIN_CHUNK_SIZE: u32 = 64 * 1024;
const MAX_CHUNK_SIZE: u32 = 16 * 1024 * 1024;
const MAX_ASSETS: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelManifest {
    pub schema: u32,
    pub model_id: String,
    pub release_id: String,
    pub key_id: String,
    pub min_client_version: String,
    pub algorithm: String,
    pub chunk_size: u32,
    pub files: Vec<ModelAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelAsset {
    /// Logical filename consumed by the model loader. It must be a single safe component.
    pub name: String,
    /// Offset relative to the start of the encrypted payload (not the whole container).
    pub payload_offset: u64,
    pub plaintext_size: u64,
    pub ciphertext_size: u64,
    pub plaintext_sha256: String,
    /// Random 128-bit prefix; the 64-bit chunk number completes each XChaCha nonce.
    pub nonce_prefix_b64: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedEnvelope {
    manifest_b64: String,
    signature_b64: String,
}

#[derive(Debug)]
pub struct VerifiedContainer {
    pub manifest: ModelManifest,
    payload_start: u64,
    container_len: u64,
    /// Keep the exact file that was signature-checked pinned for every subsequent asset read.
    /// Reopening by path would allow a same-length container to be swapped between assets.
    file: Mutex<File>,
}

/// CEK kept in zeroizing memory. It intentionally implements neither `Clone` nor `Debug`.
pub struct ContentKey(Zeroizing<[u8; 32]>);

impl ContentKey {
    pub fn from_slice(bytes: &[u8]) -> Result<Self> {
        let value: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow!("content key must contain exactly 32 bytes"))?;
        Ok(Self(Zeroizing::new(value)))
    }

    pub fn from_base64(value: &str) -> Result<Self> {
        let mut decoded = STANDARD
            .decode(value.trim())
            .context("decode content key")?;
        let result = Self::from_slice(&decoded);
        decoded.zeroize();
        result
    }

    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

fn safe_asset_name(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn decode_hex_32(value: &str, field: &str) -> Result<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("{field} must be a 64-character hexadecimal SHA-256 value");
    }
    let mut result = [0u8; 32];
    for (i, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)
            .with_context(|| format!("invalid {field}"))?;
    }
    Ok(result)
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0xf) as usize] as char);
    }
    output
}

fn validate_manifest(manifest: &ModelManifest, payload_len: u64) -> Result<()> {
    if manifest.schema != 1 {
        bail!("unsupported protected-model schema {}", manifest.schema);
    }
    if manifest.model_id.trim().is_empty()
        || manifest.release_id.trim().is_empty()
        || manifest.key_id.trim().is_empty()
    {
        bail!("protected-model identity fields must not be empty");
    }
    if manifest.algorithm != ALGORITHM {
        bail!("unsupported protected-model algorithm");
    }
    if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&manifest.chunk_size) {
        bail!("protected-model chunk size is outside the accepted range");
    }
    if manifest.files.is_empty() || manifest.files.len() > MAX_ASSETS {
        bail!("protected-model asset count is outside the accepted range");
    }

    let mut expected_offset = 0u64;
    let mut names = std::collections::HashSet::new();
    for asset in &manifest.files {
        if !safe_asset_name(&asset.name) || !names.insert(&asset.name) {
            bail!("unsafe or duplicate protected-model asset name");
        }
        if asset.plaintext_size == 0 || asset.payload_offset != expected_offset {
            bail!("invalid protected-model asset layout");
        }
        let chunks = asset.plaintext_size.div_ceil(manifest.chunk_size as u64);
        let expected_ciphertext = asset
            .plaintext_size
            .checked_add(
                chunks
                    .checked_mul(TAG_LEN)
                    .ok_or_else(|| anyhow!("asset too large"))?,
            )
            .ok_or_else(|| anyhow!("asset too large"))?;
        if asset.ciphertext_size != expected_ciphertext {
            bail!("invalid ciphertext size for {}", asset.name);
        }
        let prefix = STANDARD
            .decode(&asset.nonce_prefix_b64)
            .context("decode nonce prefix")?;
        if prefix.len() != 16 {
            bail!("nonce prefix must contain 16 bytes");
        }
        decode_hex_32(&asset.plaintext_sha256, "plaintext_sha256")?;
        expected_offset = expected_offset
            .checked_add(asset.ciphertext_size)
            .ok_or_else(|| anyhow!("payload size overflow"))?;
    }
    if expected_offset != payload_len {
        bail!("protected-model payload length does not match its signed manifest");
    }
    Ok(())
}

/// Verify the Ed25519 signature and every structural bound before any decryption occurs.
pub fn open_verified(path: &Path, public_key: &[u8; 32]) -> Result<VerifiedContainer> {
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let container_len = file.metadata()?.len();
    let mut magic = [0u8; 8];
    file.read_exact(&mut magic)
        .context("read protected-model magic")?;
    if &magic != MAGIC {
        bail!("not a Memento protected-model container");
    }
    let mut len = [0u8; 4];
    file.read_exact(&mut len)?;
    let envelope_len = u32::from_be_bytes(len) as usize;
    if envelope_len == 0 || envelope_len > MAX_MANIFEST_BYTES {
        bail!("protected-model envelope length is invalid");
    }
    let payload_start = HEADER_LEN
        .checked_add(envelope_len as u64)
        .ok_or_else(|| anyhow!("protected-model size overflow"))?;
    if payload_start >= container_len {
        bail!("protected-model container is truncated");
    }

    let mut envelope_bytes = vec![0u8; envelope_len];
    file.read_exact(&mut envelope_bytes)?;
    let envelope: SignedEnvelope =
        serde_json::from_slice(&envelope_bytes).context("parse signed model envelope")?;
    let manifest_bytes = STANDARD
        .decode(envelope.manifest_b64)
        .context("decode signed model manifest")?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        bail!("protected-model manifest is too large");
    }
    let signature_bytes = STANDARD
        .decode(envelope.signature_b64)
        .context("decode model manifest signature")?;
    let signature = Signature::from_slice(&signature_bytes).context("invalid Ed25519 signature")?;
    let verifying_key =
        VerifyingKey::from_bytes(public_key).context("invalid Ed25519 public key")?;
    verifying_key
        .verify(&manifest_bytes, &signature)
        .context("protected-model manifest signature is invalid")?;
    let manifest: ModelManifest =
        serde_json::from_slice(&manifest_bytes).context("parse verified model manifest")?;
    validate_manifest(&manifest, container_len - payload_start)?;

    Ok(VerifiedContainer {
        manifest,
        payload_start,
        container_len,
        file: Mutex::new(file),
    })
}

fn derive_asset_key(cek: &[u8; 32], manifest: &ModelManifest, name: &str) -> Result<[u8; 32]> {
    let salt = format!(
        "memento-model\0{}\0{}",
        manifest.release_id, manifest.key_id
    );
    let info = format!("asset\0{}\0{name}", manifest.model_id);
    let hk = Hkdf::<Sha256>::new(Some(salt.as_bytes()), cek);
    let mut output = [0u8; 32];
    hk.expand(info.as_bytes(), &mut output)
        .map_err(|_| anyhow!("derive protected-model asset key"))?;
    Ok(output)
}

fn nonce(prefix: &[u8], chunk_index: u64) -> Result<[u8; 24]> {
    let prefix: &[u8; 16] = prefix
        .try_into()
        .map_err(|_| anyhow!("nonce prefix must contain 16 bytes"))?;
    let mut value = [0u8; 24];
    value[..16].copy_from_slice(prefix);
    value[16..].copy_from_slice(&chunk_index.to_be_bytes());
    Ok(value)
}

fn aad(manifest: &ModelManifest, asset: &ModelAsset, index: u64, plain_len: usize) -> Vec<u8> {
    format!(
        "memento-model-v1\0{}\0{}\0{}\0{}\0{}",
        manifest.model_id, manifest.release_id, asset.name, index, plain_len
    )
    .into_bytes()
}

impl VerifiedContainer {
    pub fn container_len(&self) -> u64 {
        self.container_len
    }

    /// Hash the exact pinned container rather than reopening its path.
    pub fn container_sha256(&self) -> Result<String> {
        let mut file = self
            .file
            .lock()
            .map_err(|_| anyhow!("protected-model container lock is poisoned"))?;
        file.seek(SeekFrom::Start(0))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(hex(&hasher.finalize()))
    }

    pub fn asset(&self, name: &str) -> Result<&ModelAsset> {
        self.manifest
            .files
            .iter()
            .find(|asset| asset.name == name)
            .ok_or_else(|| anyhow!("protected-model asset {name:?} is missing"))
    }

    /// Authenticated decryption into anonymous process memory. No plaintext temp file exists.
    pub fn decrypt_asset(&self, name: &str, cek: &ContentKey) -> Result<Zeroizing<Vec<u8>>> {
        let asset = self.asset(name)?;
        let capacity: usize = asset
            .plaintext_size
            .try_into()
            .map_err(|_| anyhow!("asset does not fit in process address space"))?;
        let prefix = STANDARD.decode(&asset.nonce_prefix_b64)?;
        let mut key = derive_asset_key(cek.expose(), &self.manifest, name)?;
        let cipher = XChaCha20Poly1305::new((&key).into());
        key.zeroize();

        let mut file = self
            .file
            .lock()
            .map_err(|_| anyhow!("protected-model container lock is poisoned"))?;
        // This size check is an early corruption diagnostic, not the authenticity boundary.
        // Path replacement is prevented by the pinned handle above. Equal-length in-place
        // modification still fails closed because every chunk is authenticated with an AEAD tag
        // bound to the signed manifest coordinates, and the signed plaintext hash is checked
        // after the complete asset has been reconstructed.
        if file.metadata()?.len() != self.container_len {
            bail!("protected-model container changed after verification");
        }
        file.seek(SeekFrom::Start(self.payload_start + asset.payload_offset))?;
        let mut output = Zeroizing::new(Vec::with_capacity(capacity));
        let mut remaining = asset.plaintext_size;
        let mut index = 0u64;
        while remaining > 0 {
            let plain_len = remaining.min(self.manifest.chunk_size as u64) as usize;
            let mut encrypted = vec![0u8; plain_len + TAG_LEN as usize];
            file.read_exact(&mut encrypted)
                .with_context(|| format!("read encrypted chunk {index} of {name}"))?;
            let nonce = nonce(&prefix, index)?;
            let mut plain = cipher
                .decrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: &encrypted,
                        aad: &aad(&self.manifest, asset, index, plain_len),
                    },
                )
                .map_err(|_| anyhow!("authentication failed for {name} chunk {index}"))?;
            output.extend_from_slice(&plain);
            plain.zeroize();
            encrypted.zeroize();
            remaining -= plain_len as u64;
            index += 1;
        }
        let actual = Sha256::digest(output.as_slice());
        let expected = decode_hex_32(&asset.plaintext_sha256, "plaintext_sha256")?;
        if actual.as_slice() != expected {
            bail!("plaintext hash mismatch for {name}");
        }
        Ok(output)
    }
}

/// Read the release signing key pinned into the native binary. Runtime override is accepted
/// only in debug builds; a release must not trust mutable process configuration.
pub fn pinned_manifest_public_key() -> Result<[u8; 32]> {
    let encoded = option_env!("TYPE_MODEL_MANIFEST_PUBLIC_KEY")
        .map(str::to_owned)
        .or_else(|| {
            cfg!(debug_assertions)
                .then(|| std::env::var("TYPE_MODEL_MANIFEST_PUBLIC_KEY").ok())
                .flatten()
        })
        .ok_or_else(|| anyhow!("this Type build has no pinned model-manifest public key"))?;
    let bytes = STANDARD
        .decode(encoded.trim())
        .context("decode pinned model key")?;
    bytes
        .try_into()
        .map_err(|_| anyhow!("pinned model-manifest public key must contain 32 bytes"))
}

/// Offline packaging support. This is used only by the `memento-model-pack` operator tool.
#[cfg(any(test, feature = "model-packaging"))]
pub mod packaging {
    use super::*;

    #[derive(Debug, Clone)]
    pub struct PackOptions {
        pub model_id: String,
        pub release_id: String,
        pub key_id: String,
        pub min_client_version: String,
        pub chunk_size: u32,
    }

    fn encrypt_file(
        source: &Path,
        encrypted: &Path,
        manifest: &ModelManifest,
        name: &str,
        cek: &[u8; 32],
    ) -> Result<ModelAsset> {
        let plaintext_size = source.metadata()?.len();
        if plaintext_size == 0 {
            bail!("refusing to package empty asset {name}");
        }
        let mut prefix = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut prefix);
        let mut key = derive_asset_key(cek, manifest, name)?;
        let cipher = XChaCha20Poly1305::new((&key).into());
        key.zeroize();
        let mut input = File::open(source)?;
        let mut output = File::create(encrypted)?;
        let mut hasher = Sha256::new();
        let mut remaining = plaintext_size;
        let mut index = 0u64;
        while remaining > 0 {
            let len = remaining.min(manifest.chunk_size as u64) as usize;
            let mut plain = vec![0u8; len];
            input.read_exact(&mut plain)?;
            hasher.update(&plain);
            let nonce = nonce(&prefix, index)?;
            let mut encrypted_chunk = cipher
                .encrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: &plain,
                        aad: &format!(
                            "memento-model-v1\0{}\0{}\0{}\0{}\0{}",
                            manifest.model_id, manifest.release_id, name, index, len
                        )
                        .into_bytes(),
                    },
                )
                .map_err(|_| anyhow!("encrypt {name} chunk {index}"))?;
            output.write_all(&encrypted_chunk)?;
            plain.zeroize();
            encrypted_chunk.zeroize();
            remaining -= len as u64;
            index += 1;
        }
        output.sync_all()?;
        Ok(ModelAsset {
            name: name.to_owned(),
            payload_offset: 0,
            plaintext_size,
            ciphertext_size: plaintext_size + index * TAG_LEN,
            plaintext_sha256: hex(&hasher.finalize()),
            nonce_prefix_b64: STANDARD.encode(prefix),
        })
    }

    pub fn pack(
        input_dir: &Path,
        output_path: &Path,
        files: &[String],
        options: PackOptions,
        cek: &ContentKey,
        signing_key: &SigningKey,
    ) -> Result<ModelManifest> {
        if files.is_empty() || files.len() > MAX_ASSETS {
            bail!("asset count is outside the accepted range");
        }
        if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&options.chunk_size) {
            bail!("chunk size is outside the accepted range");
        }
        if output_path.exists() {
            bail!("refusing to overwrite {}", output_path.display());
        }
        let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)?;
        let temp = tempfile::Builder::new()
            .prefix("memento-model-pack-")
            .tempdir_in(parent)?;
        let mut manifest = ModelManifest {
            schema: 1,
            model_id: options.model_id,
            release_id: options.release_id,
            key_id: options.key_id,
            min_client_version: options.min_client_version,
            algorithm: ALGORITHM.to_owned(),
            chunk_size: options.chunk_size,
            files: Vec::with_capacity(files.len()),
        };
        let mut encrypted_paths: Vec<PathBuf> = Vec::with_capacity(files.len());
        let mut offset = 0u64;
        for (i, name) in files.iter().enumerate() {
            if !safe_asset_name(name) {
                bail!("asset names must be single safe filename components");
            }
            let encrypted_path = temp.path().join(format!("asset-{i}"));
            let mut asset = encrypt_file(
                &input_dir.join(name),
                &encrypted_path,
                &manifest,
                name,
                cek.expose(),
            )?;
            asset.payload_offset = offset;
            offset = offset
                .checked_add(asset.ciphertext_size)
                .ok_or_else(|| anyhow!("payload too large"))?;
            manifest.files.push(asset);
            encrypted_paths.push(encrypted_path);
        }
        validate_manifest(&manifest, offset)?;
        let manifest_bytes = serde_json::to_vec(&manifest)?;
        let signature = signing_key.sign(&manifest_bytes);
        let envelope = serde_json::to_vec(&SignedEnvelope {
            manifest_b64: STANDARD.encode(manifest_bytes),
            signature_b64: STANDARD.encode(signature.to_bytes()),
        })?;
        if envelope.len() > MAX_MANIFEST_BYTES {
            bail!("signed envelope is too large");
        }

        let partial = output_path.with_extension("memento-model.partial");
        if partial.exists() {
            std::fs::remove_file(&partial)?;
        }
        let result = (|| -> Result<()> {
            let mut output = File::create(&partial)?;
            output.write_all(MAGIC)?;
            output.write_all(&(envelope.len() as u32).to_be_bytes())?;
            output.write_all(&envelope)?;
            for path in &encrypted_paths {
                std::io::copy(&mut File::open(path)?, &mut output)?;
            }
            output.sync_all()?;
            std::fs::rename(&partial, output_path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        result?;
        Ok(manifest)
    }

    pub fn decode_signing_key(value: &str) -> Result<SigningKey> {
        let mut bytes = STANDARD
            .decode(value.trim())
            .context("decode signing key")?;
        let secret: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("Ed25519 signing key must contain exactly 32 seed bytes"))?;
        bytes.zeroize();
        let key = SigningKey::from_bytes(&secret);
        let mut secret = secret;
        secret.zeroize();
        Ok(key)
    }

    pub fn generate_content_key() -> ContentKey {
        let mut value = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut value);
        ContentKey(Zeroizing::new(value))
    }

    pub fn public_key_b64(signing_key: &SigningKey) -> String {
        STANDARD.encode(signing_key.verifying_key().to_bytes())
    }

    pub fn content_key_b64(cek: &ContentKey) -> String {
        STANDARD.encode(cek.expose())
    }
}

#[cfg(test)]
mod tests {
    use super::packaging::{pack, PackOptions};
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    fn fixture() -> (tempfile::TempDir, PathBuf, ContentKey, SigningKey) {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("encoder.onnx"), vec![0x42; 170_000]).unwrap();
        std::fs::write(temp.path().join("vocab.txt"), b"hello 0\n<blk> 1\n").unwrap();
        let output = temp.path().join("release.memento-model");
        let cek = ContentKey::from_slice(&[7u8; 32]).unwrap();
        let signing = SigningKey::from_bytes(&[9u8; 32]);
        pack(
            temp.path(),
            &output,
            &["encoder.onnx".into(), "vocab.txt".into()],
            PackOptions {
                model_id: "gigaam-e2e-rnnt-en-ru".into(),
                release_id: "2026-08-12.1".into(),
                key_id: "gigaam-en-ru-1".into(),
                min_client_version: "0.6.0".into(),
                chunk_size: MIN_CHUNK_SIZE,
            },
            &cek,
            &signing,
        )
        .unwrap();
        (temp, output, cek, signing)
    }

    #[test]
    fn round_trip_never_needs_a_plaintext_output_file() {
        let (_temp, output, cek, signing) = fixture();
        let verified = open_verified(&output, &signing.verifying_key().to_bytes()).unwrap();
        let encoder = verified.decrypt_asset("encoder.onnx", &cek).unwrap();
        assert_eq!(encoder.len(), 170_000);
        assert!(encoder.iter().all(|byte| *byte == 0x42));
        let vocab = verified.decrypt_asset("vocab.txt", &cek).unwrap();
        assert_eq!(vocab.as_slice(), b"hello 0\n<blk> 1\n");
    }

    #[cfg(unix)]
    #[test]
    fn path_replacement_after_verification_cannot_swap_the_loaded_release() {
        let (temp, output, cek, signing) = fixture();
        let verified = open_verified(&output, &signing.verifying_key().to_bytes()).unwrap();
        let pinned_hash = verified.container_sha256().unwrap();

        std::fs::write(temp.path().join("encoder.onnx"), vec![0x24; 170_000]).unwrap();
        let replacement = temp.path().join("replacement.memento-model");
        pack(
            temp.path(),
            &replacement,
            &["encoder.onnx".into(), "vocab.txt".into()],
            PackOptions {
                model_id: "gigaam-e2e-rnnt-en-ru".into(),
                release_id: "2026-08-12.1".into(),
                key_id: "gigaam-en-ru-1".into(),
                min_client_version: "0.6.0".into(),
                chunk_size: MIN_CHUNK_SIZE,
            },
            &cek,
            &signing,
        )
        .unwrap();
        assert_eq!(
            std::fs::metadata(&output).unwrap().len(),
            std::fs::metadata(&replacement).unwrap().len()
        );
        std::fs::rename(&replacement, &output).unwrap();

        let pinned = verified.decrypt_asset("encoder.onnx", &cek).unwrap();
        assert!(pinned.iter().all(|byte| *byte == 0x42));
        assert_eq!(verified.container_sha256().unwrap(), pinned_hash);

        let replacement = open_verified(&output, &signing.verifying_key().to_bytes()).unwrap();
        assert_ne!(replacement.container_sha256().unwrap(), pinned_hash);
        let newly_opened = replacement.decrypt_asset("encoder.onnx", &cek).unwrap();
        assert!(newly_opened.iter().all(|byte| *byte == 0x24));
    }

    #[test]
    fn manifest_tampering_fails_before_decryption() {
        let (_temp, output, _cek, signing) = fixture();
        let mut bytes = std::fs::read(&output).unwrap();
        let index = bytes.iter().position(|b| *b == b'e').unwrap();
        bytes[index] ^= 1;
        std::fs::write(&output, bytes).unwrap();
        assert!(open_verified(&output, &signing.verifying_key().to_bytes()).is_err());
    }

    #[test]
    fn wrong_cek_fails_closed() {
        let (_temp, output, _cek, signing) = fixture();
        let verified = open_verified(&output, &signing.verifying_key().to_bytes()).unwrap();
        let wrong = ContentKey::from_slice(&[8u8; 32]).unwrap();
        assert!(verified.decrypt_asset("encoder.onnx", &wrong).is_err());
    }

    #[test]
    fn same_length_in_place_tampering_between_assets_fails_closed() {
        let (_temp, output, cek, signing) = fixture();
        let verified = open_verified(&output, &signing.verifying_key().to_bytes()).unwrap();
        assert!(verified.decrypt_asset("encoder.onnx", &cek).is_ok());

        let original_len = std::fs::metadata(&output).unwrap().len();
        let vocab_offset =
            verified.payload_start + verified.asset("vocab.txt").unwrap().payload_offset;
        let mut bytes = std::fs::read(&output).unwrap();
        bytes[vocab_offset as usize] ^= 1;
        std::fs::write(&output, bytes).unwrap();
        assert_eq!(std::fs::metadata(&output).unwrap().len(), original_len);
        assert!(verified.decrypt_asset("vocab.txt", &cek).is_err());
    }

    #[test]
    fn unsafe_names_are_rejected() {
        for name in ["../model.onnx", "a/model.onnx", "", "."] {
            assert!(!safe_asset_name(name), "{name:?}");
        }
    }

    #[test]
    fn public_key_is_base64url_safe_when_needed_for_fingerprints() {
        let signing = SigningKey::from_bytes(&[9u8; 32]);
        let fingerprint =
            URL_SAFE_NO_PAD.encode(Sha256::digest(signing.verifying_key().as_bytes()));
        assert!(!fingerprint.contains('='));
    }
}
