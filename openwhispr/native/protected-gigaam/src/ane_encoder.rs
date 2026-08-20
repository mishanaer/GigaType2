//! Drives the CoreML encoder helper (`macos-gigaam-encoder --from-memory`) over
//! its GENM/GENQ/GENR stdio protocol.
//!
//! Two shapes of release are supported. A release carrying the model *spec* plus
//! its weight blob is streamed to the helper over stdin and never leaves memory.
//! A release carrying an already-compiled `.mlmodelc` is materialised on a
//! [`ModelVolume`] — a RAM disk where available — because CoreML can only open a
//! compiled model through a filesystem path; the volume is torn down with the
//! encoder. The prediction network and joiner stay on ONNX Runtime — only the
//! expensive encoder moves to the ANE.

use std::io::{BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use anyhow::{anyhow, bail, Context, Result};

use crate::model_volume::ModelVolume;

const GENM: u32 = 0x4745_4e4d; // in-memory model header (sidecar → helper)
const GENH: u32 = 0x4745_4e48; // hello (helper → sidecar)
const GENQ: u32 = 0x4745_4e51; // request (sidecar → helper)
const GENR: u32 = 0x4745_4e52; // response (helper → sidecar)

const N_MELS: usize = 64;
/// The ANE graph has a fixed input window; longer utterances are chunked to it.
pub const WINDOW_FRAMES: usize = 3360;

/// A live encoder helper: a child process holding the ANE-loaded model, answering
/// log-mel → encoder-output requests. Dropping it closes the pipe and the child exits.
pub struct AneEncoder {
    child: Child,
    /// Dropped after the child is reaped, releasing the compiled model's backing
    /// store. `None` when the model was streamed in memory.
    _volume: Option<ModelVolume>,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    enc_dim: usize,
    next_id: u32,
}

fn read_u32(r: &mut impl Read) -> Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).context("read u32 from encoder helper")?;
    Ok(u32::from_le_bytes(b))
}

fn parse_enc_dim(json: &[u8]) -> Option<usize> {
    // Tiny extractor for {"encDim":768,...} — avoids a JSON dep for one field.
    let s = std::str::from_utf8(json).ok()?;
    let key = "\"encDim\":";
    let start = s.find(key)? + key.len();
    let rest = &s[start..];
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

impl AneEncoder {
    /// Spawn the helper against an already-compiled `.mlmodelc` directory. The
    /// `volume` backing that directory is held for the encoder's lifetime.
    pub fn spawn_from_dir(helper: &Path, model: &Path, volume: ModelVolume) -> Result<Self> {
        let child = Command::new(helper)
            .arg(model)
            .args(["--compute-units", "all"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("spawn ANE encoder helper {}", helper.display()))?;
        Self::handshake(child, Some(volume))
    }

    /// Spawn the helper and hand it the decrypted spec + weight blob. Blocks
    /// through the helper's first-run ANE specialization (its warmup pass).
    /// Used by releases that carry the model spec; kept alongside
    /// [`Self::spawn_from_dir`] so either release shape can be loaded.
    #[allow(dead_code)]
    pub fn spawn(helper: &Path, spec: &[u8], weights: &[u8]) -> Result<Self> {
        let mut child = Command::new(helper)
            .arg("--from-memory")
            .args(["--compute-units", "all"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("spawn ANE encoder helper {}", helper.display()))?;
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("ANE encoder helper has no stdin"))?;

        let mut header = Vec::with_capacity(12);
        header.extend_from_slice(&GENM.to_le_bytes());
        header.extend_from_slice(&(spec.len() as u32).to_le_bytes());
        header.extend_from_slice(&(weights.len() as u32).to_le_bytes());
        stdin.write_all(&header).context("send model header")?;
        stdin.write_all(spec).context("send model spec")?;
        stdin.write_all(weights).context("send model weights")?;
        stdin.flush().context("flush model to helper")?;
        Self::handshake(child, None)
    }

    /// Read the helper's GENH hello and capture the encoder geometry it reports.
    fn handshake(mut child: Child, volume: Option<ModelVolume>) -> Result<Self> {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("ANE encoder helper has no stdin"))?;
        let mut stdout = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| anyhow!("ANE encoder helper has no stdout"))?,
        );

        let magic = read_u32(&mut stdout)?;
        if magic != GENH {
            bail!("expected GENH hello from encoder helper, got {magic:#010x}");
        }
        let json_len = read_u32(&mut stdout)? as usize;
        if json_len > 64 * 1024 {
            bail!("encoder helper hello is implausibly large ({json_len} bytes)");
        }
        let mut json = vec![0u8; json_len];
        stdout.read_exact(&mut json).context("read hello body")?;
        let enc_dim = parse_enc_dim(&json).ok_or_else(|| anyhow!("encoder hello lacks encDim"))?;

        // GENH means the helper has loaded and warmed the model, so CoreML now
        // holds it via mmap and no longer reads the files. Delete the decrypted
        // model from its backing volume immediately: after this point another
        // same-user process has no file to copy, and a later kill leaves nothing
        // to recover. The helper keeps running from its open mapping.
        if let Some(volume) = &volume {
            volume.purge();
        }

        Ok(Self {
            child,
            _volume: volume,
            stdin,
            stdout,
            enc_dim,
            next_id: 1,
        })
    }

    /// Encoder output dimension (`D` in `encoded[1, D, T']`).
    pub fn enc_dim(&self) -> usize {
        self.enc_dim
    }

    /// Run one chunk of at most [`WINDOW_FRAMES`] feature frames. `mel_major` is
    /// `[N_MELS, frames]` row-major (`mel_major[mel * frames + t]`). Returns the
    /// encoder output `encoded[enc_dim, out_frames]` row-major and `out_frames`.
    pub fn run_chunk(&mut self, mel_major: &[f32], frames: usize) -> Result<(Vec<f32>, usize)> {
        if frames == 0 || frames > WINDOW_FRAMES || mel_major.len() != frames * N_MELS {
            bail!(
                "invalid ANE encoder chunk: frames={frames}, floats={}",
                mel_major.len()
            );
        }
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);

        let payload_floats = frames * N_MELS;
        let mut request = Vec::with_capacity(16 + payload_floats * 4);
        request.extend_from_slice(&GENQ.to_le_bytes());
        request.extend_from_slice(&id.to_le_bytes());
        request.extend_from_slice(&(frames as u32).to_le_bytes());
        request.extend_from_slice(&(payload_floats as u32).to_le_bytes());
        for &value in mel_major {
            request.extend_from_slice(&value.to_le_bytes());
        }
        self.stdin
            .write_all(&request)
            .context("send encoder request")?;
        self.stdin.flush().context("flush encoder request")?;

        let magic = read_u32(&mut self.stdout)?;
        if magic != GENR {
            bail!("expected GENR response from encoder helper, got {magic:#010x}");
        }
        let resp_id = read_u32(&mut self.stdout)?;
        let status = read_u32(&mut self.stdout)?;
        let enc_dim = read_u32(&mut self.stdout)? as usize;
        let enc_frames = read_u32(&mut self.stdout)? as usize;
        let msg_len = read_u32(&mut self.stdout)? as usize;
        if resp_id != id {
            bail!("encoder response id {resp_id} does not match request {id}");
        }
        if status != 0 {
            let mut msg = vec![0u8; msg_len.min(64 * 1024)];
            self.stdout.read_exact(&mut msg).ok();
            bail!(
                "encoder helper error: {}",
                String::from_utf8_lossy(&msg)
            );
        }
        if enc_dim != self.enc_dim {
            bail!("encoder returned dim {enc_dim}, expected {}", self.enc_dim);
        }
        let count = enc_dim
            .checked_mul(enc_frames)
            .ok_or_else(|| anyhow!("encoder output size overflow"))?;
        let mut bytes = vec![0u8; count * 4];
        self.stdout
            .read_exact(&mut bytes)
            .context("read encoder output")?;
        let mut out = Vec::with_capacity(count);
        for chunk in bytes.chunks_exact(4) {
            out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        Ok((out, enc_frames))
    }

    /// Encode a full `[N_MELS, frames]` feature block, chunking to the fixed ANE
    /// window and concatenating the per-chunk encoder outputs along time. Returns
    /// `encoded[enc_dim, total_frames]` row-major, `enc_dim`, and `total_frames`.
    pub fn encode_full(
        &mut self,
        features: &[f32],
        frames: usize,
    ) -> Result<(Vec<f32>, usize, usize)> {
        if frames == 0 {
            return Ok((Vec::new(), self.enc_dim, 0));
        }
        if features.len() != N_MELS * frames {
            bail!(
                "feature block is {} floats, expected {}",
                features.len(),
                N_MELS * frames
            );
        }

        let mut chunk_outputs: Vec<(Vec<f32>, usize)> = Vec::new();
        let mut total_frames = 0usize;
        let mut start = 0usize;
        while start < frames {
            let len = (frames - start).min(WINDOW_FRAMES);
            // Repack this time-slice as [N_MELS, len] row-major. The source frame
            // stride is the FULL length, so a slice can't be borrowed contiguously.
            let mut mel_major = vec![0f32; N_MELS * len];
            for mel in 0..N_MELS {
                let src = mel * frames + start;
                let dst = mel * len;
                mel_major[dst..dst + len].copy_from_slice(&features[src..src + len]);
            }
            let (enc, out_frames) = self.run_chunk(&mel_major, len)?;
            total_frames += out_frames;
            chunk_outputs.push((enc, out_frames));
            start += len;
        }

        if chunk_outputs.len() == 1 {
            let (enc, out_frames) = chunk_outputs.pop().expect("one chunk");
            return Ok((enc, self.enc_dim, out_frames));
        }

        // Stitch chunks along time into one [enc_dim, total_frames] row-major buffer.
        let mut encoded = vec![0f32; self.enc_dim * total_frames];
        let mut time_offset = 0usize;
        for (enc, out_frames) in &chunk_outputs {
            for d in 0..self.enc_dim {
                let src = d * out_frames;
                let dst = d * total_frames + time_offset;
                encoded[dst..dst + out_frames].copy_from_slice(&enc[src..src + out_frames]);
            }
            time_offset += out_frames;
        }
        Ok((encoded, self.enc_dim, total_frames))
    }
}

impl Drop for AneEncoder {
    fn drop(&mut self) {
        // Closing stdin makes the helper hit EOF and exit; reap it so we don't
        // leave a zombie if the sidecar keeps running.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
