//! Platform layer: every OS-specific decision lives here (paths, executable names, process trees, locks, power,
//! opening folders). Shared code calls these functions and never tests `cfg(windows)` itself.
//!
//! Windows behaviour is unchanged from v0.3.1 (same data dir, same taskkill tree kill, same share-mode locks, same
//! SetThreadExecutionState); macOS and Linux get native equivalents:
//!
//! | concern            | Windows                              | macOS                                   | Linux                         |
//! |--------------------|--------------------------------------|-----------------------------------------|-------------------------------|
//! | data dir           | `%APPDATA%\PikaraScienceStudio`      | `~/Library/Application Support/PikaraScienceStudio` | `$XDG_DATA_HOME/PikaraScienceStudio` |
//! | cache dir          | `%LOCALAPPDATA%\PikaraScienceStudio` | `~/Library/Caches/PikaraScienceStudio`  | `$XDG_CACHE_HOME/PikaraScienceStudio` |
//! | kill tree          | `taskkill /T /F`                     | SIGKILL to the process group + descendants (sysinfo) | same as macOS        |
//! | pause / resume     | `NtSuspendProcess` / `NtResumeProcess` per process in the tree | SIGSTOP / SIGCONT per process | same as macOS |
//! | exclusive lock     | `share_mode(0)`                      | `flock` (std `File::try_lock`)          | same as macOS                 |
//! | keep awake         | `SetThreadExecutionState`            | `caffeinate -i -w <pid>`                | `systemd-inhibit` if present  |
//! | venv python        | `<venv>\Scripts\python.exe`          | `<venv>/bin/python`                     | same as macOS                 |

pub mod process;

use std::path::{Path, PathBuf};

pub const OS: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "linux"
};

pub const ARCH: &str = std::env::consts::ARCH;

/// Path separator as a string (`\\` on Windows, `/` elsewhere) — for turning `a/b/c` relative paths into native ones.
pub const SEP: &str = std::path::MAIN_SEPARATOR_STR;

/// A `/`-separated relative path in native form (Windows keeps the exact backslash strings v0.3 used).
pub fn native(rel: &str) -> String {
    rel.replace('/', SEP)
}

/// Node's `process.platform` name for this OS (the key used by scripts/hw_encoders.json).
pub const NODE_PLATFORM: &str = if cfg!(windows) {
    "win32"
} else if cfg!(target_os = "macos") {
    "darwin"
} else {
    "linux"
};

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

pub fn home_dir() -> PathBuf {
    home()
}

/// Per-user roaming data base (the parent of `PikaraScienceStudio`).
pub fn data_base() -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home().join(".local").join("share"))
    }
}

/// Per-user machine-local cache base (downloads, model caches, browser copies).
pub fn cache_base() -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Caches")
    } else {
        std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home().join(".cache"))
    }
}

/// `name` + the platform executable suffix (`ffmpeg` → `ffmpeg.exe` on Windows).
pub fn exe(name: &str) -> String {
    if cfg!(windows) && !name.to_ascii_lowercase().ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// The interpreter inside a Python virtual environment.
pub fn venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// `node` inside a configured Node directory (Windows installs put node.exe at the top, Unix tarballs in bin/).
pub fn node_in(dir: &Path) -> Option<PathBuf> {
    [dir.join(exe("node")), dir.join("bin").join("node")].into_iter().find(|p| p.is_file())
}

/// The node binary to run: the configured Node directory if it has one, else `node` from PATH.
pub fn node_program(node_dir: &str) -> String {
    if !node_dir.is_empty() {
        if let Some(p) = node_in(Path::new(node_dir)) {
            return p.to_string_lossy().into_owned();
        }
    }
    which("node").unwrap_or_else(|| "node".into())
}

/// Default CosyVoice virtual environment interpreter inside a project (`tools/CosyVoice/.venv`).
pub fn default_cosy_python(root: &Path) -> PathBuf {
    venv_python(&root.join("tools").join("CosyVoice").join(".venv"))
}

/// Remotion's downloaded chrome-headless-shell for this OS / CPU (node_modules/.remotion/chrome-headless-shell/…).
pub fn remotion_chs(root: &Path) -> PathBuf {
    let plat = match (OS, ARCH) {
        ("windows", _) => "win64",
        ("macos", "aarch64") => "mac-arm64",
        ("macos", _) => "mac-x64",
        _ => "linux64",
    };
    root.join("node_modules").join(".remotion").join("chrome-headless-shell").join(plat).join(format!("chrome-headless-shell-{plat}")).join(exe("chrome-headless-shell"))
}

/// Launcher for the system Python 3.11 used by the pipeline helper scripts: (program, leading args).
/// Windows keeps the `py -3.11` launcher; elsewhere `python3.11`, falling back to `python3`.
pub fn python311() -> (String, Vec<String>) {
    if cfg!(windows) {
        return ("py".into(), vec!["-3.11".into()]);
    }
    for c in ["python3.11", "python3"] {
        if let Some(p) = which(c) {
            return (p, vec![]);
        }
    }
    ("python3".into(), vec![])
}

/// Search PATH (plus PATHEXT on Windows) in-process — no `where.exe` / `which` child process.
pub fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) && Path::new(name).extension().is_none() {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into()).split(';').filter(|e| !e.is_empty()).map(|e| e.to_ascii_lowercase()).collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path) {
        for e in &exts {
            let p = dir.join(format!("{name}{e}"));
            if is_executable(&p) {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn is_executable(p: &Path) -> bool {
    let Ok(m) = std::fs::metadata(p) else { return false };
    if !m.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        m.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

/// Join PATH entries with the platform separator (`;` on Windows, `:` elsewhere).
pub fn join_path_list<I: IntoIterator<Item = String>>(parts: I) -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    parts.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(sep)
}

pub fn split_path_list(s: &str) -> Vec<String> {
    std::env::split_paths(s).map(|p| p.to_string_lossy().into_owned()).filter(|p| !p.is_empty()).collect()
}

/// Open an exclusive advisory lock file. A second open (any process) fails while the returned handle lives; the OS
/// releases it when the process exits, also on a crash.
pub fn open_exclusive(p: &Path) -> std::io::Result<std::fs::File> {
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let mut o = std::fs::OpenOptions::new();
    o.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        o.share_mode(0); // no sharing: a second open fails while we hold it
        o.open(p)
    }
    #[cfg(not(windows))]
    {
        let f = o.open(p)?;
        match f.try_lock() {
            Ok(()) => Ok(f),
            Err(std::fs::TryLockError::WouldBlock) => Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "locked by another process")),
            Err(std::fs::TryLockError::Error(e)) => Err(e),
        }
    }
}

/// Directory link `link` → `target` without admin rights: an NTFS junction on Windows (`mklink /J`, as since v0.1),
/// a symbolic link elsewhere. Returns the tool output on Windows (shown in reports).
pub fn link_dir(link: &Path, target: &Path) -> Result<String, String> {
    #[cfg(windows)]
    {
        // chcp 65001 first: otherwise mklink prints the (Chinese) paths in the console code page
        let (l, t) = (crate::util::clean_path(link), crate::util::clean_path(target));
        let o = crate::util::run("cmd", &["/d", "/c", "chcp", "65001", ">nul", "&", "mklink", "/J", &l, &t], None, std::time::Duration::from_secs(30))?;
        if o.ok() { Ok(o.combined()) } else { Err(o.combined()) }
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).map(|_| format!("{} -> {}", link.display(), target.display())).map_err(|e| e.to_string())
    }
}

/// Remove a directory link created by [`link_dir`] — only the link, never the target's contents.
pub fn unlink_dir(link: &Path) -> std::io::Result<()> {
    if cfg!(windows) {
        std::fs::remove_dir(link) // RemoveDirectoryW on a junction removes the link itself
    } else {
        std::fs::remove_file(link) // a symlink is a file entry on Unix
    }
}

/// Open a folder in the platform file manager (optionally revealing / selecting one file).
pub fn open_in_file_manager(path: &Path, reveal: bool) -> Result<(), String> {
    let mut c;
    #[cfg(windows)]
    {
        c = std::process::Command::new("explorer.exe");
        if reveal {
            c.arg(format!("/select,{}", path.display()));
        } else {
            c.arg(path);
        }
    }
    #[cfg(target_os = "macos")]
    {
        c = std::process::Command::new("open");
        if reveal {
            c.arg("-R");
        }
        c.arg(path);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        c = std::process::Command::new("xdg-open");
        // xdg-open has no "reveal": open the containing folder
        c.arg(if reveal { path.parent().unwrap_or(path) } else { path });
    }
    c.spawn().map(drop).map_err(|e| e.to_string())
}

/// Ask the OS not to sleep while jobs run. Idempotent; `false` releases.
pub fn set_keep_awake(on: bool) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
        if on {
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        } else {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
    #[cfg(unix)]
    {
        // a helper process that holds a sleep assertion until it is killed or Studio exits (-w <our pid>)
        static HELPER: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);
        let mut h = HELPER.lock().unwrap_or_else(|e| e.into_inner());
        if on {
            if h.as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false) {
                return;
            }
            let pid = std::process::id().to_string();
            let child = if cfg!(target_os = "macos") {
                std::process::Command::new("/usr/bin/caffeinate").args(["-i", "-w", &pid]).stdin(std::process::Stdio::null()).spawn().ok()
            } else {
                which("systemd-inhibit").and_then(|si| {
                    std::process::Command::new(si)
                        .args(["--what=idle:sleep", "--who=Pikara Science Studio", "--why=video production jobs running", "sh", "-c", &format!("while kill -0 {pid} 2>/dev/null; do sleep 30; done")])
                        .stdin(std::process::Stdio::null())
                        .spawn()
                        .ok()
                })
            };
            *h = child;
        } else if let Some(mut c) = h.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Is this process running inside a packaged-app container (Windows MSIX) whose AppData writes are virtualized?
/// Tests must know this before touching any data dir (see docs/TESTING.md).
pub fn packaged_container() -> Option<String> {
    crate::envfix::current_package()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_suffix_and_venv_layout() {
        if cfg!(windows) {
            assert_eq!(exe("ffmpeg"), "ffmpeg.exe");
            assert_eq!(exe("ffmpeg.EXE"), "ffmpeg.EXE");
            assert!(venv_python(Path::new("v")).ends_with(Path::new("Scripts").join("python.exe")));
        } else {
            assert_eq!(exe("ffmpeg"), "ffmpeg");
            assert!(venv_python(Path::new("v")).ends_with(Path::new("bin").join("python")));
        }
    }

    #[test]
    fn path_list_round_trip() {
        let j = join_path_list(vec!["a".into(), String::new(), "b".into()]);
        assert_eq!(split_path_list(&j), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn data_dirs_are_platform_native() {
        let d = data_base();
        let c = cache_base();
        assert!(d.is_absolute() && c.is_absolute(), "{d:?} {c:?}");
        if cfg!(target_os = "macos") {
            assert!(d.ends_with("Library/Application Support") && c.ends_with("Library/Caches"));
        }
    }

    #[test]
    fn exclusive_lock_is_exclusive() {
        let dir = std::env::temp_dir().join(format!("pikara-lock-test-{}", std::process::id()));
        let p = dir.join("x.lock");
        let a = open_exclusive(&p).expect("first open");
        assert!(open_exclusive(&p).is_err(), "second open must fail while the first is held");
        drop(a);
        assert!(open_exclusive(&p).is_ok(), "lock released on drop");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn which_finds_a_shell() {
        let name = if cfg!(windows) { "cmd" } else { "sh" };
        assert!(which(name).is_some());
        assert!(which("definitely-not-a-real-tool-xyz").is_none());
    }
}
