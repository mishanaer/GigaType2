//! Offline operator tool: build the signed, encrypted `.memento-model`
//! container that protected Type builds bundle.
//!
//! Mirrors Memento's `memento-model-pack` (same container format, same
//! release-secret JSON the gateway registry consumes) but lives in the Type
//! crate so the writer and the shipped fail-closed reader share one codebase.
//! Build only with `--features model-packaging`; it is never part of the app.
//!
//! Environment:
//!   TYPE_MODEL_SIGNING_KEY   base64 32-byte Ed25519 seed (required; offline)
//!   TYPE_MODEL_CONTENT_KEY   base64 32-byte CEK (optional; random otherwise)

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use type_protected_gigaam::protected::packaging::{
    content_key_b64, decode_signing_key, generate_content_key, pack, public_key_b64, PackOptions,
};
use type_protected_gigaam::protected::ContentKey;
use zeroize::Zeroize;

#[derive(Serialize)]
struct ReleaseSecret<'a> {
    schema: u32,
    model_id: &'a str,
    release_id: &'a str,
    key_id: &'a str,
    content_key_b64: String,
}

struct Args {
    input_dir: PathBuf,
    output: PathBuf,
    model_id: String,
    release_id: String,
    key_id: String,
    min_client_version: String,
    chunk_size: u32,
    files: Vec<String>,
    release_secret_out: PathBuf,
}

fn usage() -> ! {
    eprintln!(
        "usage: type-model-pack --input-dir <dir> --output <container> \\\n\
         \x20  --release-id <id> --key-id <id> --min-client-version <semver> \\\n\
         \x20  --release-secret-out <file> --file <name> [--file <name> ...] \\\n\
         \x20  [--model-id <id>] [--chunk-size <bytes>]"
    );
    std::process::exit(2);
}

fn parse_args() -> Result<Args> {
    let mut input_dir = None;
    let mut output = None;
    let mut model_id = "gigaam-v3-e2e-rnnt-en-ru".to_owned();
    let mut release_id = None;
    let mut key_id = None;
    let mut min_client_version = None;
    let mut chunk_size = 4 * 1024 * 1024u32;
    let mut files = Vec::new();
    let mut release_secret_out = None;

    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let mut value = || {
            args.next()
                .with_context(|| format!("{flag} requires a value"))
        };
        match flag.as_str() {
            "--input-dir" => input_dir = Some(PathBuf::from(value()?)),
            "--output" => output = Some(PathBuf::from(value()?)),
            "--model-id" => model_id = value()?,
            "--release-id" => release_id = Some(value()?),
            "--key-id" => key_id = Some(value()?),
            "--min-client-version" => min_client_version = Some(value()?),
            "--chunk-size" => chunk_size = value()?.parse().context("parse --chunk-size")?,
            "--file" => files.push(value()?),
            "--release-secret-out" => release_secret_out = Some(PathBuf::from(value()?)),
            _ => usage(),
        }
    }
    match (input_dir, output, release_id, key_id, min_client_version, release_secret_out) {
        (Some(input_dir), Some(output), Some(release_id), Some(key_id), Some(min_client_version), Some(release_secret_out))
            if !files.is_empty() =>
        {
            Ok(Args {
                input_dir,
                output,
                model_id,
                release_id,
                key_id,
                min_client_version,
                chunk_size,
                files,
                release_secret_out,
            })
        }
        _ => usage(),
    }
}

fn create_secret_file(path: &PathBuf, body: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("create release secret {}", path.display()))?;
    file.write_all(body)?;
    file.sync_all()?;
    Ok(())
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let mut signing_value = std::env::var("TYPE_MODEL_SIGNING_KEY")
        .context("TYPE_MODEL_SIGNING_KEY (base64 Ed25519 seed) is required")?;
    let signing_key = decode_signing_key(&signing_value)?;
    signing_value.zeroize();
    let cek = match std::env::var("TYPE_MODEL_CONTENT_KEY") {
        Ok(mut value) => {
            let result = ContentKey::from_base64(&value);
            value.zeroize();
            result?
        }
        Err(_) => generate_content_key(),
    };

    if args.release_secret_out.exists() {
        bail!(
            "refusing to overwrite release secret {}",
            args.release_secret_out.display()
        );
    }
    let manifest = pack(
        &args.input_dir,
        &args.output,
        &args.files,
        PackOptions {
            model_id: args.model_id.clone(),
            release_id: args.release_id.clone(),
            key_id: args.key_id.clone(),
            min_client_version: args.min_client_version,
            chunk_size: args.chunk_size,
        },
        &cek,
        &signing_key,
    )?;
    let secret = serde_json::to_vec_pretty(&ReleaseSecret {
        schema: 1,
        model_id: &args.model_id,
        release_id: &args.release_id,
        key_id: &args.key_id,
        content_key_b64: content_key_b64(&cek),
    })?;
    if let Err(error) = create_secret_file(&args.release_secret_out, &secret) {
        let _ = std::fs::remove_file(&args.output);
        return Err(error.context("container removed because its CEK could not be persisted"));
    }

    println!("container={}", args.output.display());
    println!("release_secret={}", args.release_secret_out.display());
    println!("manifest_public_key_b64={}", public_key_b64(&signing_key));
    println!("assets={}", manifest.files.len());
    Ok(())
}
