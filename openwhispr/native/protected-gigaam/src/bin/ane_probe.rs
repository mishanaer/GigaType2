//! Dev probe: drive the ANE encoder helper from Rust with a real spec+blob and a
//! zero mel window, to validate the GENM/GENQ/GENR framing end to end.
//! Usage: ane_probe <helper> <spec.mlmodel> <weight.bin>
#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    use std::path::PathBuf;
    use type_protected_gigaam::ane_encoder::{AneEncoder, WINDOW_FRAMES};
    let args: Vec<String> = std::env::args().collect();
    let helper = PathBuf::from(&args[1]);
    let spec = std::fs::read(&args[2])?;
    let weights = std::fs::read(&args[3])?;
    eprintln!("spec {} B, weights {} B", spec.len(), weights.len());
    let started = std::time::Instant::now();
    let mut enc = AneEncoder::spawn(&helper, &spec, &weights)?;
    eprintln!("spawned + loaded in {:.1}s, enc_dim={}", started.elapsed().as_secs_f32(), enc.enc_dim());

    // Single full window of zeros.
    let feats = vec![0f32; 64 * WINDOW_FRAMES];
    let t = std::time::Instant::now();
    let (encoded, dim, frames) = enc.encode_full(&feats, WINDOW_FRAMES)?;
    let finite = encoded.iter().take(4096).all(|v| v.is_finite());
    eprintln!(
        "encode_full: dim={dim} frames={frames} len={} finite={finite} in {} ms",
        encoded.len(),
        t.elapsed().as_millis()
    );

    // Two-window input to exercise chunk stitching.
    let feats2 = vec![0f32; 64 * (WINDOW_FRAMES + 100)];
    let (e2, d2, f2) = enc.encode_full(&feats2, WINDOW_FRAMES + 100)?;
    eprintln!("two-chunk: dim={d2} frames={f2} len={} (expect frames = ceil(3360/4)+ceil(100/4) = 840+25 = 865)", e2.len());
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("ane_probe is macOS-only");
}
