//! Operator verification: decrypt a REAL packed container in memory and run
//! actual RNN-T inference on a WAV, exactly as the shipped sidecar would after
//! CEK unwrap. Ignored by default — it needs a real container and its release
//! secret, which never live in the repository.
//!
//! ```bash
//! TYPE_MODEL_MANIFEST_PUBLIC_KEY="$(cat ~/.gigatype-release/type-model-manifest-public.key)" \
//! TYPE_E2E_CONTAINER=~/.gigatype-release/gigaam-en-ru-2026-08-13.1.memento-model \
//! TYPE_E2E_RELEASE_SECRET=~/.gigatype-release/gigaam-en-ru-1.memento-release-secret.json \
//! TYPE_E2E_WAV=/path/to/16k-mono-s16.wav \
//! cargo test --test protected_container_e2e -- --ignored --nocapture
//! ```
//!
//! (The runtime TYPE_MODEL_MANIFEST_PUBLIC_KEY override only exists in debug
//! builds, which is exactly what `cargo test` produces.)

use std::path::PathBuf;

use type_protected_gigaam::{protected, rnnt::RnntModel};

const VOCAB: &str = "v3_e2e_rnnt_vocab.txt";
const MODEL_FILES: [&str; 3] = [
    "v3_e2e_rnnt_encoder.onnx",
    "v3_e2e_rnnt_decoder.onnx",
    "v3_e2e_rnnt_joint.onnx",
];

fn env_path(name: &str) -> PathBuf {
    let value = std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"));
    PathBuf::from(shellexpand_home(&value))
}

fn shellexpand_home(value: &str) -> String {
    match (value.strip_prefix("~/"), std::env::var("HOME")) {
        (Some(rest), Ok(home)) => format!("{home}/{rest}"),
        _ => value.to_owned(),
    }
}

fn read_wav_16k_mono_f32(path: &PathBuf) -> Vec<f32> {
    let bytes = std::fs::read(path).expect("read wav");
    assert_eq!(&bytes[0..4], b"RIFF", "not a RIFF wav");
    let mut offset = 12usize;
    let mut data: Option<(usize, usize)> = None;
    let (mut rate, mut channels, mut bits) = (0u32, 0u16, 0u16);
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let len = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        if id == b"fmt " {
            channels = u16::from_le_bytes(bytes[offset + 10..offset + 12].try_into().unwrap());
            rate = u32::from_le_bytes(bytes[offset + 12..offset + 16].try_into().unwrap());
            bits = u16::from_le_bytes(bytes[offset + 22..offset + 24].try_into().unwrap());
        } else if id == b"data" {
            data = Some((offset + 8, len));
        }
        offset += 8 + len + (len % 2);
    }
    assert_eq!((rate, channels, bits), (16_000, 1, 16), "need 16k mono s16 wav");
    let (start, len) = data.expect("wav data chunk");
    bytes[start..start + len]
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes(pair.try_into().unwrap()) as f32 / 32768.0)
        .collect()
}

#[test]
#[ignore = "needs a real packed container, its release secret, and a wav file"]
fn decrypts_real_container_and_transcribes() {
    let container_path = env_path("TYPE_E2E_CONTAINER");
    let secret_path = env_path("TYPE_E2E_RELEASE_SECRET");
    let wav_path = env_path("TYPE_E2E_WAV");

    let public_key = protected::pinned_manifest_public_key().expect("pinned public key");
    let container = protected::open_verified(&container_path, &public_key).expect("verify container");

    let secret: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&secret_path).expect("read release secret"))
            .expect("parse release secret");
    assert_eq!(secret["release_id"], container.manifest.release_id.as_str());
    assert_eq!(secret["key_id"], container.manifest.key_id.as_str());
    let cek = protected::ContentKey::from_base64(secret["content_key_b64"].as_str().expect("cek"))
        .expect("decode CEK");

    let started = std::time::Instant::now();
    let mut model = RnntModel::load_from_source(
        |name| container.decrypt_asset(name, &cek),
        &MODEL_FILES,
        VOCAB,
    )
    .expect("decrypt + load model in memory");
    println!("model decrypted + loaded in {:.1}s", started.elapsed().as_secs_f32());

    let samples = read_wav_16k_mono_f32(&wav_path);
    let started = std::time::Instant::now();
    let text = model.transcribe(&samples).expect("transcribe");
    println!(
        "transcribed {:.1}s of audio in {:.1}s: {text}",
        samples.len() as f32 / 16_000.0,
        started.elapsed().as_secs_f32()
    );
    assert!(!text.trim().is_empty(), "transcript must not be empty");
}
