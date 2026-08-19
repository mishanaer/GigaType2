use std::{
    collections::HashSet,
    env,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use type_protected_gigaam::{model_gateway, protected, rnnt::RnntModel};

const MODEL_ID: &str = "gigaam-v3-e2e-rnnt-en-ru";
const VOCAB: &str = "v3_e2e_rnnt_vocab.txt";
// macOS runs the encoder as an fp16 CoreML ML Program on the ANE, carried already
// compiled: the five files of a `.mlmodelc` flattened into single-component asset
// names (the container format allows no path separators), then the decoder and
// joiner. Other platforms keep the fp32 ONNX encoder (order: encoder, decoder,
// joiner). The order here is the contract with `RnntModel::load_from_source`.
#[cfg(target_os = "macos")]
const MODEL_FILES: [&str; 7] = [
    "v3_e2e_rnnt_encoder.mil",
    "v3_e2e_rnnt_encoder.weight.bin",
    "v3_e2e_rnnt_encoder.coremldata.bin",
    "v3_e2e_rnnt_encoder.metadata.json",
    "v3_e2e_rnnt_encoder.analytics.coremldata.bin",
    "v3_e2e_rnnt_decoder.onnx",
    "v3_e2e_rnnt_joint.onnx",
];
#[cfg(not(target_os = "macos"))]
const MODEL_FILES: [&str; 3] = [
    "v3_e2e_rnnt_encoder.onnx",
    "v3_e2e_rnnt_decoder.onnx",
    "v3_e2e_rnnt_joint.onnx",
];
const MAX_PCM_BYTES: usize = 16_000 * 4 * 60 * 10;

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Reply<'a> {
    Ready {
        release_id: &'a str,
        model_id: &'a str,
    },
    Transcript {
        text: &'a str,
    },
    Error {
        message: &'a str,
    },
}

fn write_frame(mut output: impl Write, value: &Reply<'_>) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    let len: u32 = bytes
        .len()
        .try_into()
        .map_err(|_| anyhow!("sidecar response is too large"))?;
    output.write_all(&len.to_le_bytes())?;
    output.write_all(&bytes)?;
    output.flush()?;
    Ok(())
}

fn validate_container(container: &protected::VerifiedContainer) -> Result<()> {
    if container.manifest.model_id != MODEL_ID {
        bail!(
            "protected model is for {}, expected {MODEL_ID}",
            container.manifest.model_id
        );
    }
    let expected: HashSet<&str> = MODEL_FILES.into_iter().chain([VOCAB]).collect();
    let actual: HashSet<&str> = container
        .manifest
        .files
        .iter()
        .map(|asset| asset.name.as_str())
        .collect();
    if actual != expected {
        bail!("protected model asset set is not the Type bilingual RNN-T release");
    }
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION"))?;
    let minimum = semver::Version::parse(&container.manifest.min_client_version)
        .context("parse protected-model minimum client version")?;
    if current < minimum {
        bail!("protected model requires Type {minimum} or newer");
    }
    Ok(())
}

fn load_model(
    container: &protected::VerifiedContainer,
    key: &protected::ContentKey,
) -> Result<RnntModel> {
    RnntModel::load_from_source(
        |name| container.decrypt_asset(name, key),
        &MODEL_FILES,
        VOCAB,
    )
}

async fn activate(path: &Path) -> Result<(RnntModel, String)> {
    let public_key = protected::pinned_manifest_public_key()?;
    let container = protected::open_verified(path, &public_key)?;
    validate_container(&container)?;
    let release_id = container.manifest.release_id.clone();
    let key_id = container.manifest.key_id.clone();

    if let Some(cached) = model_gateway::cached_content_key(&release_id, &key_id).await? {
        match load_model(&container, &cached) {
            Ok(model) => return Ok((model, release_id)),
            Err(error) => log::warn!("cached protected-model key is unusable: {error:#}"),
        }
    }

    let access = model_gateway::acquire_release(MODEL_ID, &release_id).await?;
    if access.release.release_id != release_id
        || access.release.key_id != key_id
        || access.release.container_size != container.container_len()
        || !access
            .release
            .container_sha256
            .eq_ignore_ascii_case(&container.container_sha256()?)
    {
        bail!("bundled protected model does not match the gateway release descriptor");
    }
    if access.release.min_client_version != container.manifest.min_client_version {
        bail!("gateway and bundled model disagree on the minimum client version");
    }
    let model = load_model(&container, &access.content_key)?;
    Ok((model, release_id))
}

enum Command {
    Serve(PathBuf),
    Inspect(PathBuf),
}

fn command() -> Result<Command> {
    let mut args = env::args_os().skip(1);
    match (args.next(), args.next(), args.next(), args.next()) {
        (Some(flag), Some(path), None, None) if flag == "--model" => {
            Ok(Command::Serve(PathBuf::from(path)))
        }
        (Some(inspect), Some(flag), Some(path), None)
            if inspect == "--inspect" && flag == "--model" =>
        {
            Ok(Command::Inspect(PathBuf::from(path)))
        }
        _ => bail!("usage: type-protected-gigaam [--inspect] --model <container.memento-model>"),
    }
}

fn inspect(path: &Path) -> Result<()> {
    let public_key = protected::pinned_manifest_public_key()?;
    let container = protected::open_verified(path, &public_key)?;
    validate_container(&container)?;
    println!(
        "{}",
        serde_json::json!({
            "modelId": container.manifest.model_id,
            "releaseId": container.manifest.release_id,
            "keyId": container.manifest.key_id,
            "minClientVersion": container.manifest.min_client_version,
            "containerBytes": container.container_len(),
            "containerSha256": container.container_sha256()?,
        })
    );
    Ok(())
}

fn serve(mut model: RnntModel, release_id: String) -> Result<()> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    write_frame(
        &mut output,
        &Reply::Ready {
            release_id: &release_id,
            model_id: MODEL_ID,
        },
    )?;

    let stdin = io::stdin();
    let mut input = stdin.lock();
    loop {
        let mut header = [0u8; 4];
        match input.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        let len = u32::from_le_bytes(header) as usize;
        if len == 0 {
            return Ok(());
        }
        if len > MAX_PCM_BYTES || len % 4 != 0 {
            let message = "invalid PCM frame length";
            write_frame(&mut output, &Reply::Error { message })?;
            continue;
        }
        let mut bytes = vec![0u8; len];
        input.read_exact(&mut bytes)?;
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("four-byte chunk")))
            .collect();
        match model.transcribe(&samples) {
            Ok(text) => write_frame(&mut output, &Reply::Transcript { text: &text })?,
            Err(error) => {
                let message = format!("protected GigaAM inference failed: {error:#}");
                write_frame(&mut output, &Reply::Error { message: &message })?;
            }
        }
    }
}

/// Refuse debugger attachment on release macOS builds. `PT_DENY_ATTACH` makes
/// `task_for_pid`/lldb fail (and terminates the process if a debugger later
/// attaches), which raises the bar for dumping the decrypted model out of the
/// live process. Non-fatal if the syscall is rejected; a determined attacker
/// with root can still bypass it — this is defence-in-depth, not a guarantee.
#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn deny_debugger_attachment() {
    const PT_DENY_ATTACH: i32 = 31;
    extern "C" {
        fn ptrace(request: i32, pid: i32, addr: *mut i8, data: i32) -> i32;
    }
    // SAFETY: PT_DENY_ATTACH ignores the addr/data arguments; the call owns no
    // memory and a non-zero return is tolerated.
    unsafe {
        let _ = ptrace(PT_DENY_ATTACH, 0, std::ptr::null_mut(), 0);
    }
}

#[cfg(not(all(target_os = "macos", not(debug_assertions))))]
fn deny_debugger_attachment() {}

#[tokio::main]
async fn main() {
    deny_debugger_attachment();
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();
    let result = async {
        match command()? {
            Command::Inspect(path) => inspect(&path),
            Command::Serve(path) => {
                let (model, release_id) = activate(&path).await?;
                serve(model, release_id)
            }
        }
    }
    .await;
    if let Err(error) = result {
        eprintln!("type-protected-gigaam: {error:#}");
        std::process::exit(1);
    }
}
