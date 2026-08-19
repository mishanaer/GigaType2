//! Backing store for the decrypted CoreML encoder.
//!
//! CoreML loads a *compiled* model (`.mlmodelc`) only from a filesystem path, so
//! the release's encoder has to be materialised outside this process. A RAM disk
//! keeps the plaintext off persistent storage; when one cannot be created we fall
//! back to a private (0700) temp directory rather than failing transcription.
//! Either way the store is torn down when the encoder is dropped, and stale
//! stores left behind by a previous crash are swept on the way in.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};

const PREFIX: &str = "GigaTypeANE-";
const SECTOR_BYTES: u64 = 512;
/// CoreML writes specialisation artefacts next to the model, so leave headroom.
const HEADROOM_NUMERATOR: u64 = 115;
const MIN_BYTES: u64 = 64 * 1024 * 1024;

enum Backing {
    /// A `ram://` disk image; `device` is the `/dev/diskN` node to eject.
    Ram { device: String },
    TempDir,
}

/// A private directory holding the decrypted encoder for the helper's lifetime.
pub struct ModelVolume {
    root: PathBuf,
    backing: Backing,
}

fn first_token(value: &str) -> Option<String> {
    value.split_whitespace().next().map(str::to_owned)
}

fn run(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("run {program}"))?;
    if !output.status.success() {
        bail!(
            "{program} {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn pid_is_running(pid: &str) -> bool {
    // `kill -0` reports liveness without signalling; a failure means the owner of
    // a leftover store is gone and the store is ours to reclaim.
    Command::new("/bin/kill")
        .args(["-0", pid])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn sweep_stale(current: &str) {
    if let Ok(entries) = fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(pid) = name.strip_prefix(PREFIX) else {
                continue;
            };
            if pid == current || pid_is_running(pid) {
                continue;
            }
            log::warn!("[ane] reclaiming stale model volume {name}");
            let _ = run("/usr/sbin/diskutil", &["eject", &format!("/Volumes/{name}")]);
        }
    }
    if let Ok(entries) = fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(pid) = name.strip_prefix(PREFIX) else {
                continue;
            };
            if pid == current || pid_is_running(pid) {
                continue;
            }
            log::warn!("[ane] removing stale model directory {name}");
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn attach_ram_disk(bytes: u64, name: &str) -> Result<(String, PathBuf)> {
    let sized = (bytes.saturating_mul(HEADROOM_NUMERATOR) / 100).max(MIN_BYTES);
    let sectors = sized.div_ceil(SECTOR_BYTES);
    let spec = format!("ram://{sectors}");
    let device = first_token(&run("/usr/bin/hdiutil", &["attach", "-nomount", &spec])?)
        .ok_or_else(|| anyhow!("hdiutil returned no device node"))?;
    // `diskutil eraseVolume` formats *and* mounts, which a bare `mount` cannot do
    // without root. Any failure past this point must still release the RAM.
    match run(
        "/usr/sbin/diskutil",
        &["eraseVolume", "HFS+", name, &device],
    ) {
        Ok(_) => Ok((device, PathBuf::from(format!("/Volumes/{name}")))),
        Err(error) => {
            let _ = run("/usr/bin/hdiutil", &["detach", &device, "-force"]);
            Err(error)
        }
    }
}

impl ModelVolume {
    /// Create a store with room for `bytes` of model data. Prefers a RAM disk and
    /// degrades to a private temp directory, which is why this returns the chosen
    /// backing in its log line rather than failing when RAM is unavailable.
    pub fn create(bytes: u64) -> Result<Self> {
        let pid = std::process::id().to_string();
        sweep_stale(&pid);
        let name = format!("{PREFIX}{pid}");

        match attach_ram_disk(bytes, &name) {
            Ok((device, root)) => {
                log::info!("[ane] model volume on RAM disk {device}");
                return Ok(Self {
                    root,
                    backing: Backing::Ram { device },
                });
            }
            Err(error) => {
                log::warn!("[ane] RAM disk unavailable ({error}); using a private temp directory");
            }
        }

        let root = std::env::temp_dir().join(&name);
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).with_context(|| format!("create {}", root.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .context("restrict model directory permissions")?;
        }
        Ok(Self {
            root,
            backing: Backing::TempDir,
        })
    }

    pub fn path(&self) -> &Path {
        &self.root
    }
}

impl Drop for ModelVolume {
    fn drop(&mut self) {
        match &self.backing {
            Backing::Ram { device } => {
                if run("/usr/sbin/diskutil", &["eject", device]).is_err() {
                    let _ = run("/usr/bin/hdiutil", &["detach", device, "-force"]);
                }
            }
            Backing::TempDir => {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }
}
