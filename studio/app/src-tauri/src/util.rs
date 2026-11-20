//! Small helpers shared by every module: process spawning without console windows,
//! timestamps, hashing, app-data paths.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

/// %APPDATA%\PikaraScienceStudio (overridable with PIKARA_STUDIO_DATA for tests).
pub fn data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("PIKARA_STUDIO_DATA") {
        return PathBuf::from(p);
    }
    let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    base.join("PikaraScienceStudio")
}

pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}

/// Build a Command that never pops a console window.
pub fn cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.stdin(Stdio::null());
    c
}

pub struct RunOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl RunOut {
    pub fn ok(&self) -> bool {
        self.code == 0
    }
    pub fn combined(&self) -> String {
        let mut s = self.stdout.clone();
        if !self.stderr.trim().is_empty() {
            if !s.is_empty() && !s.ends_with('\n') {
                s.push('\n');
            }
            s.push_str(&self.stderr);
        }
        s
    }
}

fn to_runout(o: Output) -> RunOut {
    RunOut {
        code: o.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
    }
}

/// Run a program to completion with a timeout. Returns Err if it can't be started.
pub fn run(program: &str, args: &[&str], cwd: Option<&Path>, timeout: Duration) -> Result<RunOut, String> {
    run_env(program, args, cwd, &[], timeout)
}

pub fn run_env(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    env: &[(&str, &str)],
    timeout: Duration,
) -> Result<RunOut, String> {
    let mut c = cmd(program);
    c.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    c.env("PYTHONIOENCODING", "utf-8");
    for (k, v) in env {
        c.env(k, v);
    }
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    let child = c.spawn().map_err(|e| format!("cannot start {program}: {e}"))?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(o)) => Ok(to_runout(o)),
        Ok(Err(e)) => Err(format!("{program}: {e}")),
        Err(_) => {
            kill_tree(pid);
            Err(format!("{program} timed out after {}s", timeout.as_secs()))
        }
    }
}

/// Kill a whole process tree (render.mjs → node → chrome-headless-shell, python → python).
pub fn kill_tree(pid: u32) -> String {
    match run_raw("taskkill", &["/T", "/F", "/PID", &pid.to_string()]) {
        Ok(o) => o.combined(),
        Err(e) => e,
    }
}

fn run_raw(program: &str, args: &[&str]) -> Result<RunOut, String> {
    let mut c = cmd(program);
    c.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    c.output().map(to_runout).map_err(|e| e.to_string())
}

/// Locate an executable on PATH using where.exe; returns first hit.
pub fn which(name: &str) -> Option<String> {
    let o = run_raw("where.exe", &[name]).ok()?;
    if !o.ok() {
        return None;
    }
    o.stdout.lines().map(|l| l.trim()).find(|l| !l.is_empty()).map(|s| s.to_string())
}

/// TEST ONLY: `PIKARA_STUDIO_TEST_HIDE_TOOLS=ffprobe,ffmpeg` makes Studio behave as if these tools were not
/// installed (tool() returns None and job PATHs drop every folder that contains them). Used by the robustness
/// tests instead of uninstalling ffmpeg; never set in normal use.
pub fn hidden_tools() -> Vec<String> {
    std::env::var("PIKARA_STUDIO_TEST_HIDE_TOOLS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

/// PATH with the configured Node directory in front (pipeline scripts call `node`, `npx`).
pub fn path_with(dirs: &[&str]) -> String {
    let cur = std::env::var("PATH").unwrap_or_default();
    let hidden = hidden_tools();
    let keep = |d: &str| !hidden.iter().any(|t| Path::new(d).join(format!("{t}.exe")).exists());
    let mut parts: Vec<String> = dirs.iter().filter(|d| !d.is_empty() && keep(d)).map(|d| d.to_string()).collect();
    parts.extend(cur.split(';').filter(|d| !d.is_empty() && keep(d)).map(String::from));
    parts.join(";")
}

/// Is `child` inside `root` (after canonicalisation)?
pub fn is_inside(root: &Path, child: &Path) -> bool {
    let r = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let c = std::fs::canonicalize(child).unwrap_or_else(|_| child.to_path_buf());
    c.starts_with(&r)
}

/// Strip the \\?\ prefix canonicalize() adds on Windows.
pub fn clean_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(|x| x.to_string()).unwrap_or(s)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent dir")?;
    let tmp = dir.join(format!(
        ".{}.studio-tmp-{}",
        path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
        std::process::id()
    ));
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    // std::fs::rename uses MoveFileExW(MOVEFILE_REPLACE_EXISTING) on Windows → atomic replace on NTFS.
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename into {}: {e}", path.display())
    })
}

pub fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Absolute path of an external tool (ffmpeg, ffprobe…). `Command::new("ffmpeg")` alone fails for WinGet
/// installs on some PATH layouts, so resolve via where.exe, then the WinGet Links / Packages folders. Cached.
pub fn tool(name: &str) -> Option<String> {
    if hidden_tools().iter().any(|t| t == &name.to_ascii_lowercase()) {
        return None;
    }
    static CACHE: once_cell::sync::Lazy<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    if let Some(p) = CACHE.lock().unwrap().get(name) {
        return Some(p.clone());
    }
    let exe = format!("{name}.exe");
    let found = which(name).filter(|p| Path::new(p).exists()).or_else(|| {
        let la = std::env::var("LOCALAPPDATA").ok()?;
        let links = Path::new(&la).join(r"Microsoft\WinGet\Links").join(&exe);
        if links.exists() {
            return Some(links.to_string_lossy().into());
        }
        let pk = Path::new(&la).join(r"Microsoft\WinGet\Packages");
        for e in std::fs::read_dir(&pk).ok()?.flatten() {
            if !e.file_name().to_string_lossy().to_ascii_lowercase().contains("ffmpeg") {
                continue;
            }
            for sub in std::fs::read_dir(e.path()).ok()?.flatten() {
                let c = sub.path().join("bin").join(&exe);
                if c.exists() {
                    return Some(c.to_string_lossy().into());
                }
            }
        }
        None
    })?;
    CACHE.lock().unwrap().insert(name.to_string(), found.clone());
    Some(found)
}
