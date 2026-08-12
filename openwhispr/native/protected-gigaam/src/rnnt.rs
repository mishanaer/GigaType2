//! GigaAM v3 e2e RNN-T: encoder + prediction network (decoder) + joiner, greedy
//! transducer decode. Ported from onnx-asr `GigaamV2Rnnt` / `_AsrWithTransducerDecoding`.
//!
//! The greedy loop mirrors `parakeet_engine`'s: at each frame it runs the prediction
//! network with the last emitted token, then the joiner, and advances the frame on a
//! blank or after `MAX_TOKENS_PER_STEP` emissions. Re-running the decoder every frame
//! (rather than caching it across blanks, as onnx-asr does) yields identical output for
//! a deterministic model — same (token, state) inputs → same result.
//!
//! Interfaces (verified against the `istupakov/gigaam-v3-onnx` int8 exports):
//!   encoder: IN `audio_signal` f32[1,64,T], `length` i64[1]
//!            OUT `encoded` f32[1,768,T'], `encoded_len` i32[1]
//!   decoder: IN `x` i64[1,1], `h.1` f32[1,1,320], `c.1` f32[1,1,320]
//!            OUT `dec` f32[1,1,320], `h` f32[1,1,320], `c` f32[1,1,320]
//!   joiner : IN `enc` f32[1,768,1], `dec` f32[1,320,1]
//!            OUT `joint` f32[1,1,1,V]   (V classes, blank as the last class)

use std::path::Path;

use anyhow::{anyhow, Result};
use ndarray::{Array1, Array2, Array3, ArrayD, IxDyn};

use super::featurizer::{Featurizer, N_MELS};
use super::model::{
    build_session, build_session_from_memory, find_blank_idx, ids_to_text, load_vocab,
    load_vocab_bytes,
};

/// LSTM prediction-network hidden size (`h`/`c` last dim).
const PRED_HIDDEN: usize = 320;
/// Cap on tokens emitted at a single encoder frame before forcing a frame advance
/// (GigaAM's `max_tokens_per_step` default).
const MAX_TOKENS_PER_STEP: usize = 3;

/// One decoded word with timing derived from the encoder frame each BPE piece was
/// emitted at, relative to the start of the transcribed waveform. Transducer emissions
/// lag the audio slightly (the joiner fires once enough acoustic evidence accumulated),
/// so treat boundaries as ~±1 frame (40 ms) soft.
#[derive(Debug, Clone, PartialEq)]
pub struct TimedWord {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// Group BPE pieces + their emission frames into [`TimedWord`]s. A piece starting with
/// the sentencepiece word marker `▁` (U+2581) opens a new word; everything else
/// (continuation pieces, punctuation) appends to the current word. `frame_ms` is the
/// duration of one encoder frame.
pub(super) fn tokens_to_timed_words(
    vocab: &[String],
    tokens: &[usize],
    frames: &[usize],
    frame_ms: f64,
) -> Vec<TimedWord> {
    let mut words: Vec<TimedWord> = Vec::new();
    for (&id, &frame) in tokens.iter().zip(frames) {
        let Some(piece) = vocab.get(id) else { continue };
        let start_ms = (frame as f64 * frame_ms).round() as i64;
        let end_ms = ((frame + 1) as f64 * frame_ms).round() as i64;
        let is_word_start = piece.starts_with('\u{2581}');
        let text = piece.replace('\u{2581}', "");
        match words.last_mut() {
            Some(last) if !is_word_start => {
                last.text.push_str(&text);
                last.end_ms = last.end_ms.max(end_ms);
            }
            _ => {
                if text.is_empty() {
                    continue; // a bare "▁" piece carries no word content
                }
                words.push(TimedWord {
                    text,
                    start_ms,
                    end_ms,
                });
            }
        }
    }
    words.retain(|w| !w.text.is_empty());
    words
}

/// Where the encoder runs. The prediction network and joiner are always ONNX (7 MB, and
/// their per-frame cost is negligible); only the encoder is worth moving off the CPU.
enum EncoderBackend {
    /// `v3_e2e_rnnt_encoder(.int8).onnx` through `ort`.
    Onnx(ort::session::Session),
}

pub struct RnntModel {
    encoder: EncoderBackend,
    decoder: ort::session::Session,
    joiner: ort::session::Session,
    featurizer: Featurizer,
    vocab: Vec<String>,
    blank: usize,
}

impl RnntModel {
    /// `model_files` order (from `GigaamVariant::model_files`): encoder, decoder, joiner.
    pub fn load(
        encoder_path: &Path,
        decoder_path: &Path,
        joiner_path: &Path,
        vocab_path: &Path,
    ) -> Result<Self> {
        let vocab = load_vocab(vocab_path)?;
        let blank = find_blank_idx(&vocab);
        Ok(Self {
            encoder: EncoderBackend::Onnx(build_session(encoder_path)?),
            decoder: build_session(decoder_path)?,
            joiner: build_session(joiner_path)?,
            featurizer: Featurizer::new(),
            vocab,
            blank,
        })
    }

    /// Load each ONNX graph from authenticated memory and discard its decrypted byte buffer
    /// before moving to the next graph. This bounds peak plaintext memory to the largest graph
    /// plus the ONNX Runtime sessions, instead of keeping the whole release decrypted.
    pub fn load_from_source<F>(mut read: F, files: &[&str], vocab_name: &str) -> Result<Self>
    where
        F: FnMut(&str) -> Result<zeroize::Zeroizing<Vec<u8>>>,
    {
        if files.len() != 3 {
            return Err(anyhow!(
                "RNN-T protected release must contain three ONNX graphs"
            ));
        }
        let vocab_bytes = read(vocab_name)?;
        let vocab = load_vocab_bytes(&vocab_bytes)?;
        let blank = find_blank_idx(&vocab);
        drop(vocab_bytes);

        let encoder_bytes = read(files[0])?;
        let encoder = build_session_from_memory(&encoder_bytes)?;
        drop(encoder_bytes);
        let decoder_bytes = read(files[1])?;
        let decoder = build_session_from_memory(&decoder_bytes)?;
        drop(decoder_bytes);
        let joiner_bytes = read(files[2])?;
        let joiner = build_session_from_memory(&joiner_bytes)?;
        drop(joiner_bytes);

        Ok(Self {
            encoder: EncoderBackend::Onnx(encoder),
            decoder,
            joiner,
            featurizer: Featurizer::new(),
            vocab,
            blank,
        })
    }

    /// Transcribe a 16 kHz mono waveform to punctuated Russian text.
    pub fn transcribe(&mut self, waveform: &[f32]) -> Result<String> {
        let (tokens, _, _) = self.decode_greedy(waveform)?;
        Ok(ids_to_text(&self.vocab, &tokens))
    }

    /// Transcribe a 16 kHz mono waveform into words with per-word timing (see
    /// [`TimedWord`]). Same greedy decode as [`Self::transcribe`] — identical text,
    /// plus the encoder frame each piece was emitted at.
    pub fn transcribe_with_words(&mut self, waveform: &[f32]) -> Result<Vec<TimedWord>> {
        let (tokens, frames, frame_ms) = self.decode_greedy(waveform)?;
        Ok(tokens_to_timed_words(
            &self.vocab,
            &tokens,
            &frames,
            frame_ms,
        ))
    }

    /// Greedy transducer decode → (token ids, emission encoder-frame per token, ms per
    /// encoder frame).
    fn decode_greedy(&mut self, waveform: &[f32]) -> Result<(Vec<usize>, Vec<usize>, f64)> {
        let (feats, t) = self.featurizer.compute(waveform);
        if t == 0 {
            return Ok((Vec::new(), Vec::new(), 0.0));
        }

        // Encoder → owned `encoded` [1,D,T'] (row-major), dims, and valid length.
        let (encoded, enc_dim, enc_tp, enc_len) = self.encode(feats, t)?;
        // Feature frames are HOP samples (10 ms) apart; the encoder subsamples T → T',
        // so one encoder frame spans t/T' feature frames (4× ⇒ 40 ms for GigaAM v3).
        let feature_frame_ms =
            super::featurizer::HOP as f64 / super::featurizer::SAMPLE_RATE as f64 * 1000.0;
        let frame_ms = if enc_tp > 0 {
            t as f64 * feature_frame_ms / enc_tp as f64
        } else {
            feature_frame_ms
        };

        // Greedy transducer decode.
        let mut h: ArrayD<f32> = ArrayD::zeros(IxDyn(&[1, 1, PRED_HIDDEN]));
        let mut c: ArrayD<f32> = ArrayD::zeros(IxDyn(&[1, 1, PRED_HIDDEN]));
        let mut tokens: Vec<usize> = Vec::new();
        let mut frames: Vec<usize> = Vec::new();
        let mut t_idx = 0usize;
        let mut emitted = 0usize;

        while t_idx < enc_len {
            let last_token = tokens.last().copied().unwrap_or(self.blank) as i64;
            // encoded is [1, D, T'] row-major: element [0,d,t] = d*T' + t.
            let enc_frame: Vec<f32> = (0..enc_dim).map(|d| encoded[d * enc_tp + t_idx]).collect();

            let (logits, h_new, c_new) =
                self.decode_step(last_token, &h, &c, enc_frame, enc_dim)?;
            let token = argmax(&logits);

            if token != self.blank {
                // Commit the prediction-network state only when a real token is emitted.
                h = h_new;
                c = c_new;
                tokens.push(token);
                frames.push(t_idx);
                emitted += 1;
            }
            if token == self.blank || emitted >= MAX_TOKENS_PER_STEP {
                t_idx += 1;
                emitted = 0;
            }
        }
        Ok((tokens, frames, frame_ms))
    }

    /// Run the encoder on log-mel `features` (row-major `[N_MELS][frames]`, taken by value so
    /// the ONNX path can wrap it without a copy). Returns owned `encoded` [1,D,T'] flattened
    /// row-major, D, T', and the valid time length (clamped to T'), whichever backend is
    /// loaded.
    fn encode(
        &mut self,
        features: Vec<f32>,
        frames: usize,
    ) -> Result<(Vec<f32>, usize, usize, usize)> {
        let features = Array3::from_shape_vec((1, N_MELS, frames), features)
            .map_err(|e| anyhow!("feature reshape: {e}"))?;
        let length = Array1::from_vec(vec![frames as i64]);
        self.encode_onnx(&features, &length)
    }

    /// The ONNX encoder path.
    fn encode_onnx(
        &mut self,
        features: &Array3<f32>,
        length: &Array1<i64>,
    ) -> Result<(Vec<f32>, usize, usize, usize)> {
        use ort::inputs;
        use ort::value::TensorRef;

        let EncoderBackend::Onnx(session) = &mut self.encoder;
        let f_ref = TensorRef::from_array_view(features.view())
            .map_err(|e| anyhow!("enc features: {e}"))?;
        let l_ref =
            TensorRef::from_array_view(length.view()).map_err(|e| anyhow!("enc length: {e}"))?;
        let out = session
            .run(inputs!["audio_signal" => f_ref, "length" => l_ref])
            .map_err(|e| anyhow!("encoder run: {e}"))?;

        let enc = out
            .get("encoded")
            .ok_or_else(|| anyhow!("encoder output 'encoded' missing"))?
            .try_extract_array::<f32>()
            .map_err(|e| anyhow!("encoded extract: {e}"))?;
        let shape = enc.shape(); // [1, D, T']
        let (d, tp) = (shape[1], shape[2]);
        let flat: Vec<f32> = enc.iter().copied().collect();

        let enc_len = out
            .get("encoded_len")
            .ok_or_else(|| anyhow!("encoder output 'encoded_len' missing"))?
            .try_extract_array::<i32>()
            .map_err(|e| anyhow!("encoded_len extract: {e}"))?
            .iter()
            .next()
            .copied()
            .unwrap_or(tp as i32)
            .max(0) as usize;

        Ok((flat, d, tp, enc_len.min(tp)))
    }

    /// One transducer step: prediction network (decoder) then joiner. Returns the joint
    /// logits over the vocab plus the new LSTM state.
    fn decode_step(
        &mut self,
        last_token: i64,
        h: &ArrayD<f32>,
        c: &ArrayD<f32>,
        enc_frame: Vec<f32>,
        enc_dim: usize,
    ) -> Result<(Vec<f32>, ArrayD<f32>, ArrayD<f32>)> {
        use ort::inputs;
        use ort::value::TensorRef;

        // Prediction network. Extract everything owned before the joiner call so the
        // `&mut self.decoder` borrow is released.
        let (dec, h_new, c_new) = {
            let x = Array2::from_shape_vec((1, 1), vec![last_token])
                .map_err(|e| anyhow!("dec x: {e}"))?;
            let x_ref =
                TensorRef::from_array_view(x.view()).map_err(|e| anyhow!("dec x ref: {e}"))?;
            let h_ref =
                TensorRef::from_array_view(h.view()).map_err(|e| anyhow!("dec h ref: {e}"))?;
            let c_ref =
                TensorRef::from_array_view(c.view()).map_err(|e| anyhow!("dec c ref: {e}"))?;
            let out = self
                .decoder
                .run(inputs!["x" => x_ref, "h.1" => h_ref, "c.1" => c_ref])
                .map_err(|e| anyhow!("decoder run: {e}"))?;
            let dec: Vec<f32> = out
                .get("dec")
                .ok_or_else(|| anyhow!("decoder output 'dec' missing"))?
                .try_extract_array::<f32>()
                .map_err(|e| anyhow!("dec extract: {e}"))?
                .iter()
                .copied()
                .collect();
            let h_new = out
                .get("h")
                .ok_or_else(|| anyhow!("decoder output 'h' missing"))?
                .try_extract_array::<f32>()
                .map_err(|e| anyhow!("h extract: {e}"))?
                .to_owned();
            let c_new = out
                .get("c")
                .ok_or_else(|| anyhow!("decoder output 'c' missing"))?
                .try_extract_array::<f32>()
                .map_err(|e| anyhow!("c extract: {e}"))?
                .to_owned();
            (dec, h_new, c_new)
        };

        // Joiner: enc frame [1,D,1] + prediction output reshaped to [1,320,1].
        let enc_in = Array3::from_shape_vec((1, enc_dim, 1), enc_frame)
            .map_err(|e| anyhow!("joiner enc: {e}"))?;
        let dec_in = Array3::from_shape_vec((1, PRED_HIDDEN, 1), dec)
            .map_err(|e| anyhow!("joiner dec: {e}"))?;
        let joint: Vec<f32> = {
            let e_ref = TensorRef::from_array_view(enc_in.view())
                .map_err(|e| anyhow!("joiner enc ref: {e}"))?;
            let d_ref = TensorRef::from_array_view(dec_in.view())
                .map_err(|e| anyhow!("joiner dec ref: {e}"))?;
            let out = self
                .joiner
                .run(inputs!["enc" => e_ref, "dec" => d_ref])
                .map_err(|e| anyhow!("joiner run: {e}"))?;
            out.get("joint")
                .ok_or_else(|| anyhow!("joiner output 'joint' missing"))?
                .try_extract_array::<f32>()
                .map_err(|e| anyhow!("joint extract: {e}"))?
                .iter()
                .copied()
                .collect()
        };

        Ok((joint, h_new, c_new))
    }
}

fn argmax(v: &[f32]) -> usize {
    v.iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(i, _)| i)
        .unwrap_or(0)
}
