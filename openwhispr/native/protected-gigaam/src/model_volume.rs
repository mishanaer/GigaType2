//! Backing store for the decrypted CoreML encoder.
//!
//! CoreML loads a *compiled* model (`.mlmodelc`) only from a filesystem path, so
//! the release's encoder has to be materialised outside this process. A RAM disk
//! keeps the plaintext off persistent storage; when one cannot be created we fall
//! back to a private (0700) temp directory rather than failing transcription.
//!
//! Two mechanisms keep the decrypted model's exposure narrow:
//!   * [`ModelVolume::purge`] deletes the files the moment CoreML no longer needs
//!     them on disk (it holds the model via mmap after load). This collapses the
//!     window in which another same-user process could copy the plaintext, and
//!     leaves nothing to recover if the process is later killed.
//!   * a signal handler ejects the volume if the process is terminated *before*
//!     that purge — while the files are still present during model load — since
//!     `Drop` does not run on a signal. Stores orphaned by `SIGKILL` (uncatchable)
//!     or a crash are still swept on the next start by [`sweep_stale`].

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};

use anyhow::{anyhow, bail, Context, Result};

const PREFIX: &str = "GigaTypeANE-";
const SECTOR_BYTES: u64 = 512;
/// CoreML writes specialisation artefacts next to the model, so leave headroom.
const HEADROOM_NUMERATOR: u64 = 115;
const MIN_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
enum Backing {
    /// A `ram://` disk image; `device` is the `/dev/diskN` node to eject.
    Ram { device: String },
    TempDir { root: PathBuf },
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

/// Release a backing store: eject the RAM disk (falling back to a forced detach)
/// or remove the temp directory. Safe to call from the signal-cleanup thread and
/// from `Drop`; a second call after the store is gone simply fails and is ignored.
fn release(backing: &Backing) {
    match backing {
        Backing::Ram { device } => {
            if run("/usr/sbin/diskutil", &["eject", device]).is_err() {
                let _ = run("/usr/bin/hdiutil", &["detach", device, "-force"]);
            }
        }
        Backing::TempDir { root } => {
            let _ = fs::remove_dir_all(root);
        }
    }
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

// ---- signal-driven cleanup ------------------------------------------------
//
// `Drop` releases a volume on the normal path, but a terminating signal
// (SIGINT/SIGTERM/SIGHUP) unwinds nothing, so a process killed *during model
// load* — before `ModelVolume::purge` runs — would leave the decrypted files on
// a mounted RAM disk. A registry of live backings plus a self-pipe handler
// releases them on the way out, then re-raises the signal so the exit status is
// unchanged. The handler itself only writes one byte (async-signal-safe); the
// actual ejecting runs on a dedicated thread.

struct Cleanup {
    backings: Mutex<Vec<Backing>>,
    write_fd: libc::c_int,
}

static CLEANUP: OnceLock<Cleanup> = OnceLock::new();
static PENDING_SIGNAL: AtomicI32 = AtomicI32::new(0);

extern "C" fn on_terminating_signal(sig: libc::c_int) {
    PENDING_SIGNAL.store(sig, Ordering::SeqCst);
    if let Some(cleanup) = CLEANUP.get() {
        let byte = [1u8];
        // The only work permitted in a signal handler: a single async-signal-safe
        // write that wakes the cleanup thread. Its result is intentionally ignored.
        unsafe {
            libc::write(cleanup.write_fd, byte.as_ptr() as *const libc::c_void, 1);
        }
    }
}

fn cleanup() -> &'static Cleanup {
    CLEANUP.get_or_init(|| {
        let mut fds = [0 as libc::c_int; 2];
        // A failed pipe leaves write_fd = -1; the handler's write then no-ops and
        // we simply fall back to Drop / sweep_stale. Never abort the ASR path for it.
        let write_fd = if unsafe { libc::pipe(fds.as_mut_ptr()) } == 0 {
            let read_fd = fds[0];
            std::thread::spawn(move || cleanup_thread(read_fd));
            fds[1]
        } else {
            -1
        };

        if write_fd >= 0 {
            for sig in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
                unsafe {
                    let mut action: libc::sigaction = std::mem::zeroed();
                    let handler: extern "C" fn(libc::c_int) = on_terminating_signal;
                    action.sa_sigaction = handler as *const () as usize;
                    libc::sigemptyset(&mut action.sa_mask);
                    action.sa_flags = libc::SA_RESTART;
                    libc::sigaction(sig, &action, std::ptr::null_mut());
                }
            }
        }

        Cleanup {
            backings: Mutex::new(Vec::new()),
            write_fd,
        }
    })
}

fn cleanup_thread(read_fd: libc::c_int) -> ! {
    let mut buf = [0u8; 1];
    // Block until the handler signals; retry on EINTR/short reads.
    loop {
        let n = unsafe { libc::read(read_fd, buf.as_mut_ptr() as *mut libc::c_void, 1) };
        if n == 1 {
            break;
        }
    }

    if let Some(cleanup) = CLEANUP.get() {
        let backings = cleanup
            .backings
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        for backing in &backings {
            release(backing);
        }
    }

    // Re-raise with the default disposition so the exit status reflects the signal.
    let sig = PENDING_SIGNAL.load(Ordering::SeqCst);
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = libc::SIG_DFL;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(sig, &action, std::ptr::null_mut());
        libc::raise(sig);
    }
    std::process::exit(128 + sig);
}

fn register(backing: &Backing) {
    if let Ok(mut guard) = cleanup().backings.lock() {
        guard.push(backing.clone());
    }
}

fn deregister(backing: &Backing) {
    if let Some(cleanup) = CLEANUP.get() {
        if let Ok(mut guard) = cleanup.backings.lock() {
            if let Some(pos) = guard.iter().position(|b| b.same_store(backing)) {
                guard.swap_remove(pos);
            }
        }
    }
}

impl Backing {
    fn same_store(&self, other: &Backing) -> bool {
        match (self, other) {
            (Backing::Ram { device: a }, Backing::Ram { device: b }) => a == b,
            (Backing::TempDir { root: a }, Backing::TempDir { root: b }) => a == b,
            _ => false,
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

        let backing = match attach_ram_disk(bytes, &name) {
            Ok((device, root)) => {
                log::info!("[ane] model volume on RAM disk {device}");
                let backing = Backing::Ram { device };
                register(&backing);
                return Ok(Self { root, backing });
            }
            Err(error) => {
                log::warn!("[ane] RAM disk unavailable ({error}); using a private temp directory");
                let root = std::env::temp_dir().join(&name);
                let _ = fs::remove_dir_all(&root);
                fs::create_dir_all(&root).with_context(|| format!("create {}", root.display()))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                        .context("restrict model directory permissions")?;
                }
                Backing::TempDir { root: root.clone() }
            }
        };

        let root = match &backing {
            Backing::TempDir { root } => root.clone(),
            Backing::Ram { .. } => unreachable!("RAM path returns early"),
        };
        register(&backing);
        Ok(Self { root, backing })
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    /// Delete the decrypted model from the store while keeping the store itself.
    /// Call once CoreML has loaded the model (it then holds it via mmap and no
    /// longer reads the files), so the plaintext stops being copyable off disk.
    pub fn purge(&self) {
        if let Ok(entries) = fs::read_dir(&self.root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let _ = fs::remove_dir_all(&path);
                } else {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
}

impl Drop for ModelVolume {
    fn drop(&mut self) {
        deregister(&self.backing);
        release(&self.backing);
    }
}
