//! ResourceScheduler leases — machine-wide, shared by every GPU user of this project: the Studio queue (any number of
//! Studio processes), the test / benchmark scripts (`scripts/gpu_lock.py`) and the UI screenshot tour
//! (`scripts/ui_tour_capture.ps1`).
//!
//! * **Global lease** `gpu.lock`: taken by scripts that need the whole machine quiet (tests, benchmarks, screenshots).
//!   While it is held no Studio GPU job starts; the holder waits until running Studio jobs have finished.
//! * **Adapter leases** `gpu-<adapter key>.lock`: taken by Studio GPU jobs for exactly the adapters they use (from the
//!   DeviceSelector). Jobs on different GPUs run at the same time; jobs on the same GPU take turns. A job whose devices
//!   are all CPU takes the `cpu-heavy` lease so two CPU renders / CPU TTS runs don't overload the machine.
//!
//! Mechanism: the lock file is opened with share mode 0 (exclusive). Windows releases it automatically when the
//! holder exits or crashes — a dead holder never blocks. The holder writes `<lock>.json` (who, pid, since).
//! Re-entrancy: a holder exports `PIKARA_GPU_LOCK_OWNER=<pid>`; a child Studio (`--cli run-queue` started by a test
//! that holds the global lease) runs its jobs without re-acquiring.
//! Directory: `%ProgramData%\PikaraScience\` on Windows (not AppData, which MSIX launchers virtualize), the per-user
//! cache on macOS / Linux (see [`machine_lock_dir`]); `PIKARA_GPU_LOCK` overrides
//! the global lock path (adapter locks live next to it).

use serde_json::{json, Value};
use std::fs::File;
use std::path::{Path, PathBuf};

pub fn lock_path() -> PathBuf {
    if let Ok(p) = std::env::var("PIKARA_GPU_LOCK") {
        return PathBuf::from(p);
    }
    #[cfg(test)]
    {
        return std::env::temp_dir().join(format!("pss-gpu-test-{}", std::process::id())).join("gpu.lock");
    }
    #[allow(unreachable_code)]
    {
        machine_lock_dir().join("gpu.lock")
    }
}

/// Windows `%ProgramData%\PikaraScience` (machine-wide, not virtualized by MSIX); macOS / Linux the per-user cache
/// (`~/Library/Caches/PikaraScience`, `$XDG_CACHE_HOME/PikaraScience`). scripts/gpu_lock.py uses the same rule.
pub fn machine_lock_dir() -> PathBuf {
    if cfg!(windows) {
        let base = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into());
        PathBuf::from(base).join("PikaraScience")
    } else {
        crate::platform::cache_base().join("PikaraScience")
    }
}

pub fn adapter_lock_path(key: &str) -> PathBuf {
    let safe: String = key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    lock_path().with_file_name(format!("gpu-{safe}.lock"))
}

fn info_path(lock: &Path) -> PathBuf {
    let mut p = lock.as_os_str().to_os_string();
    p.push(".json");
    PathBuf::from(p)
}

pub fn holder_of(lock: &Path) -> Value {
    std::fs::read_to_string(info_path(lock)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

pub fn holder() -> Value {
    holder_of(&lock_path())
}

fn holder_text_of(lock: &Path) -> String {
    let h = holder_of(lock);
    match h["who"].as_str() {
        Some(w) => format!("{w}（PID {}，自 {} 起）", h["pid"], h["since"].as_str().unwrap_or("?")),
        None => "另一個程式".into(),
    }
}

pub fn holder_text() -> String {
    holder_text_of(&lock_path())
}

/// A held lease; released (file closed, info removed) on drop. `None` file = held by an ancestor process.
#[derive(Debug)]
pub struct GpuLease {
    file: Option<File>,
    path: PathBuf,
}

impl Drop for GpuLease {
    fn drop(&mut self) {
        if self.file.take().is_some() {
            let _ = std::fs::remove_file(info_path(&self.path));
        }
    }
}

fn open_exclusive(p: &Path) -> std::io::Result<File> {
    crate::platform::open_exclusive(p)
}

fn is_free(p: &Path) -> bool {
    open_exclusive(p).map(drop).is_ok()
}

/// True when an ancestor process (PIKARA_GPU_LOCK_OWNER) holds the global lease right now.
fn inherited() -> bool {
    let Ok(owner) = std::env::var("PIKARA_GPU_LOCK_OWNER") else { return false };
    let held_by_owner = holder()["pid"].as_u64().map(|p| p.to_string() == owner).unwrap_or(false);
    held_by_owner && !is_free(&lock_path())
}

fn take(p: &Path, who: &str) -> Result<GpuLease, String> {
    match open_exclusive(p) {
        Ok(f) => {
            let info = json!({"who": who, "pid": std::process::id(), "since": crate::util::now_iso()});
            let _ = std::fs::write(info_path(p), info.to_string());
            Ok(GpuLease { file: Some(f), path: p.to_path_buf() })
        }
        Err(_) => Err(holder_text_of(p)),
    }
}

/// Global lease (whole machine), without waiting.
pub fn try_acquire(who: &str) -> Result<GpuLease, String> {
    if inherited() {
        return Ok(GpuLease { file: None, path: lock_path() });
    }
    take(&lock_path(), who)
}

/// Leases for a Studio job: refuses while a script holds the global lease (unless it is our ancestor), then takes
/// every adapter lease in `keys` (all or nothing). Empty `keys` = CPU-only job → the `cpu-heavy` lease.
pub fn try_acquire_job(who: &str, keys: &[String]) -> Result<Vec<GpuLease>, String> {
    if inherited() {
        return Ok(vec![]);
    }
    if !is_free(&lock_path()) {
        return Err(format!("GPU 由其他程式使用中：{}", holder_text()));
    }
    let keys: Vec<String> = if keys.is_empty() { vec!["cpu-heavy".into()] } else { keys.to_vec() };
    let mut got = vec![];
    for k in &keys {
        match take(&adapter_lock_path(k), who) {
            Ok(l) => got.push(l),
            Err(h) => return Err(format!("{} 使用中：{h}", if k == "cpu-heavy" { "CPU 密集工作".to_string() } else { format!("GPU {k}") })),
        }
    }
    Ok(got)
}

/// Adapter / cpu-heavy leases currently held (by any process).
pub fn busy_adapters() -> Vec<Value> {
    let dir = lock_path().parent().map(Path::to_path_buf).unwrap_or_default();
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.file_name().map(|n| { let n = n.to_string_lossy(); n.starts_with("gpu-") && n.ends_with(".lock") }).unwrap_or(false))
                .filter(|p| !is_free(p))
                .map(|p| json!({"lock": p.file_name().map(|n| n.to_string_lossy().to_string()), "holder": holder_of(&p)}))
                .collect()
        })
        .unwrap_or_default()
}

pub fn status() -> Value {
    let free = is_free(&lock_path());
    json!({"path": lock_path(), "free": free, "holder": if free { Value::Null } else { holder() }, "adapters": busy_adapters()})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_and_adapter_leases() {
        let a = try_acquire("測試 A").unwrap();
        assert!(try_acquire("測試 B").is_err(), "second global holder refused");
        assert!(try_acquire_job("工作", &["10de:28e1#0".into()]).unwrap_err().contains("其他程式"), "no Studio job while a script holds the machine");
        drop(a);
        assert!(status()["free"].as_bool().unwrap());
        // two jobs on different adapters run together; same adapter waits; CPU-only jobs serialize on cpu-heavy
        let j1 = try_acquire_job("渲染", &["10de:28e1#0".into()]).unwrap();
        let j2 = try_acquire_job("介面測試", &["1002:1901#0".into()]).unwrap();
        assert!(try_acquire_job("配音", &["10de:28e1#0".into()]).is_err());
        let c1 = try_acquire_job("CPU 渲染", &[]).unwrap();
        assert!(try_acquire_job("CPU 配音", &[]).is_err());
        assert_eq!(busy_adapters().len(), 3);
        drop((j1, j2, c1));
        assert!(busy_adapters().is_empty());
        let _ = std::fs::remove_dir_all(lock_path().parent().unwrap());
    }
}
