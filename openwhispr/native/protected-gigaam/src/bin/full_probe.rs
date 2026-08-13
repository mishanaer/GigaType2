//! Dev probe: full macOS protected ASR path from a packed fp16 container —
//! verify signature, decrypt with the release-secret CEK, load the RNN-T model
//! (encoder on the ANE from memory, decoder/joiner on ONNX), transcribe a WAV.
//! No gateway involved. Usage: full_probe <container> <release-secret.json> <wav>
//! Env: TYPE_MODEL_MANIFEST_PUBLIC_KEY (debug pin), TYPE_ANE_ENCODER_PATH.
#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    use std::path::Path;
    use type_protected_gigaam::{protected, rnnt::RnntModel};

    let args: Vec<String> = std::env::args().collect();
    let container = Path::new(&args[1]);
    let secret: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let wav = &args[3];

    let public_key = protected::pinned_manifest_public_key()?;
    let verified = protected::open_verified(container, &public_key)?;
    eprintln!(
        "container ok: model={} release={} assets={}",
        verified.manifest.model_id,
        verified.manifest.release_id,
        verified.manifest.files.len()
    );
    let cek = protected::ContentKey::from_base64(secret["content_key_b64"].as_str().unwrap())?;

    let files = [
        "v3_e2e_rnnt_encoder.mlmodel",
        "v3_e2e_rnnt_encoder.weight.bin",
        "v3_e2e_rnnt_decoder.onnx",
        "v3_e2e_rnnt_joint.onnx",
    ];
    let t = std::time::Instant::now();
    let mut model =
        RnntModel::load_from_source(|name| verified.decrypt_asset(name, &cek), &files, "v3_e2e_rnnt_vocab.txt")?;
    eprintln!("model loaded (ANE encoder + ONNX decoder/joiner) in {:.1}s", t.elapsed().as_secs_f32());

    let samples = read_wav_16k_mono(wav)?;
    let t = std::time::Instant::now();
    let text = model.transcribe(&samples)?;
    eprintln!(
        "transcribed {:.1}s audio in {} ms:\n  {text}",
        samples.len() as f32 / 16000.0,
        t.elapsed().as_millis()
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn read_wav_16k_mono(path: &str) -> anyhow::Result<Vec<f32>> {
    let bytes = std::fs::read(path)?;
    anyhow::ensure!(&bytes[0..4] == b"RIFF", "not a RIFF wav");
    let mut off = 12usize;
    let (mut data, mut rate, mut ch, mut bits) = (None, 0u32, 0u16, 0u16);
    while off + 8 <= bytes.len() {
        let id = &bytes[off..off + 4];
        let len = u32::from_le_bytes(bytes[off + 4..off + 8].try_into().unwrap()) as usize;
        if id == b"fmt " {
            ch = u16::from_le_bytes(bytes[off + 10..off + 12].try_into().unwrap());
            rate = u32::from_le_bytes(bytes[off + 12..off + 16].try_into().unwrap());
            bits = u16::from_le_bytes(bytes[off + 22..off + 24].try_into().unwrap());
        } else if id == b"data" {
            data = Some((off + 8, len));
        }
        off += 8 + len + (len & 1);
    }
    anyhow::ensure!((rate, ch, bits) == (16000, 1, 16), "need 16k mono s16");
    let (s, l) = data.unwrap();
    Ok(bytes[s..s + l]
        .chunks_exact(2)
        .map(|p| i16::from_le_bytes([p[0], p[1]]) as f32 / 32768.0)
        .collect())
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("full_probe is macOS-only");
}
