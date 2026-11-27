//! Environment diagnosis and safe repair for Python virtual environments (CosyVoice), v0.2.1.
//!
//! The EP06 incident: `uv` was run from a terminal inside the Claude desktop app, which is an MSIX package.
//! Windows redirects that process's writes to `%APPDATA%` into the package's private copy
//! (`%LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming`). The venv's `pyvenv.cfg` then points at
//! `%APPDATA%\uv\python\cpython-3.10.22…`, which exists only for processes inside the package. Studio runs outside
//! it, sees an empty folder, and the venv launcher fails with "No Python at …".
//!
//! `diagnose` tells the two environments apart; `repair` copies the interpreter from the private copy (no download)
//! to `<venv parent>\.python-<version>` — outside AppData, visible to every process — rewrites `home` in
//! `pyvenv.cfg` (backup kept), and verifies by running the venv's Python. Site-packages (PyTorch, CUDA wheels),
//! models and caches are never touched.

use crate::util::{clean_path, run};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VenvDiag {
    pub venv: String,
    pub cfg_found: bool,
    pub home: String,
    pub version: String,
    pub home_exists: bool,
    /// The interpreter exists only in an MSIX package's private AppData copy (e.g. the Claude desktop app).
    pub private_copy: Option<String>,
    pub package: Option<String>,
    /// Studio itself runs inside an MSIX package (then its view of AppData is the private one).
    pub studio_packaged: bool,
    pub python_ok: bool,
    pub python_output: String,
    pub problem: Option<String>,
    pub fixable: bool,
}

/// Name of the MSIX package the current process runs in, if any (GetCurrentPackageFullName).
pub fn current_package() -> Option<String> {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentPackageFullName(len: *mut u32, name: *mut u16) -> i32;
        }
        let mut len: u32 = 0;
        // ERROR_INSUFFICIENT_BUFFER (122) when packaged; APPMODEL_ERROR_NO_PACKAGE (15700) otherwise
        let r = unsafe { GetCurrentPackageFullName(&mut len, std::ptr::null_mut()) };
        if r != 122 || len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        let r = unsafe { GetCurrentPackageFullName(&mut len, buf.as_mut_ptr()) };
        if r != 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..(len as usize).saturating_sub(1)]))
    }
    #[cfg(not(windows))]
    None
}

fn read_cfg(venv: &Path) -> Option<(String, String)> {
    let s = std::fs::read_to_string(venv.join("pyvenv.cfg")).ok()?;
    let get = |k: &str| s.lines().find_map(|l| l.split_once('=').filter(|(a, _)| a.trim() == k).map(|(_, b)| b.trim().to_string()));
    Some((get("home")?, get("version_info").or_else(|| get("version")).unwrap_or_default()))
}

/// Candidate private copies of `path` (under %APPDATA% or %LOCALAPPDATA%) in MSIX packages' LocalCache.
pub fn private_copies(path: &Path, appdata: &Path, localappdata: &Path) -> Vec<(PathBuf, String)> {
    let p = path.to_string_lossy().to_lowercase();
    let (base, sub) = if p.starts_with(&appdata.to_string_lossy().to_lowercase()) {
        (appdata, "Roaming")
    } else if p.starts_with(&localappdata.to_string_lossy().to_lowercase()) && !p.contains("\\packages\\") {
        (localappdata, "Local")
    } else {
        return vec![];
    };
    let rel = &path.to_string_lossy()[base.to_string_lossy().len()..].trim_start_matches(['\\', '/']).to_string();
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(localappdata.join("Packages")) {
        for e in rd.flatten() {
            let cand = e.path().join("LocalCache").join(sub).join(rel);
            if cand.join("python.exe").is_file() {
                out.push((cand, e.file_name().to_string_lossy().to_string()));
            }
        }
    }
    out
}

fn env_dir(k: &str) -> PathBuf {
    PathBuf::from(std::env::var(k).unwrap_or_default())
}

fn python_check(venv: &Path) -> (bool, String) {
    let py = crate::platform::venv_python(venv);
    match run(&py.to_string_lossy(), &["-c", "import sys; print(sys.version.split()[0], sys.base_prefix)"], None, Duration::from_secs(60)) {
        Ok(o) => (o.ok(), o.combined().trim().chars().take(400).collect()),
        Err(e) => (false, e),
    }
}

pub fn diagnose(venv: &Path) -> VenvDiag {
    diagnose_with(venv, &env_dir("APPDATA"), &env_dir("LOCALAPPDATA"))
}

pub fn diagnose_with(venv: &Path, appdata: &Path, localappdata: &Path) -> VenvDiag {
    let mut d = VenvDiag { venv: clean_path(venv), studio_packaged: current_package().is_some(), ..Default::default() };
    let Some((home, version)) = read_cfg(venv) else {
        d.problem = Some(format!("找不到 {}（不是 Python 虛擬環境，或尚未安裝 CosyVoice）", clean_path(&venv.join("pyvenv.cfg"))));
        return d;
    };
    d.cfg_found = true;
    d.home = home.clone();
    d.version = version;
    let home_p = PathBuf::from(&home);
    d.home_exists = home_p.join("python.exe").is_file();
    if !d.home_exists {
        if let Some((cand, pkg)) = private_copies(&home_p, appdata, localappdata).into_iter().next() {
            d.private_copy = Some(clean_path(&cand));
            d.package = Some(pkg.clone());
            d.fixable = true;
            d.problem = Some(format!(
                "虛擬環境指向的 Python（{home}）只存在於 MSIX 套件「{pkg}」的私有 AppData 副本中。這通常是在 Claude Desktop 等 MSIX 應用程式內的終端機執行 uv／pip 造成的：Windows 把寫入 %APPDATA% 的檔案重新導向到該套件的 LocalCache，Studio 在套件外執行，看不到這些檔案。可安全修復：把這份 Python 複製到虛擬環境旁（不下載、不動 PyTorch 與模型），並更新 pyvenv.cfg。"
            ));
        } else {
            d.problem = Some(format!(
                "虛擬環境指向的 Python 不存在：{home}。找不到可複製的副本；請用 uv 重新安裝相同版本（uv python install {}），並在 Studio 執行的同一個環境（一般的 PowerShell，不要在 MSIX 應用程式內的終端機）執行。",
                d.version
            ));
        }
        return d;
    }
    let (ok, out) = python_check(venv);
    d.python_ok = ok;
    d.python_output = out.clone();
    if !ok {
        d.problem = Some(format!("虛擬環境的 Python 無法執行：{out}"));
    }
    d
}

fn copy_dir(a: &Path, b: &Path) -> Result<u64, String> {
    std::fs::create_dir_all(b).map_err(|e| e.to_string())?;
    let mut n = 0;
    for e in std::fs::read_dir(a).map_err(|e| e.to_string())?.flatten() {
        let (pa, pb) = (e.path(), b.join(e.file_name()));
        let ft = e.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            n += copy_dir(&pa, &pb)?;
        } else if ft.is_file() {
            if !pb.exists() {
                std::fs::copy(&pa, &pb).map_err(|x| format!("複製 {} 失敗：{x}", clean_path(&pa)))?;
            }
            n += 1;
        }
    }
    Ok(n)
}

/// Repair a venv whose interpreter only exists in an MSIX private copy. Returns a report; Err when not repairable
/// or when the repaired venv still does not run (the original pyvenv.cfg is restored then).
pub fn repair(venv: &Path) -> Result<String, String> {
    repair_with(venv, &env_dir("APPDATA"), &env_dir("LOCALAPPDATA"))
}

pub fn repair_with(venv: &Path, appdata: &Path, localappdata: &Path) -> Result<String, String> {
    let d = diagnose_with(venv, appdata, localappdata);
    if d.home_exists && d.python_ok {
        return Ok(format!("虛擬環境正常：{}（{}）", d.venv, d.python_output));
    }
    let src = d.private_copy.clone().filter(|_| d.fixable).ok_or(d.problem.clone().unwrap_or("無法自動修復".into()))?;
    let ver = if d.version.is_empty() { "copy".to_string() } else { d.version.clone() };
    let dst = venv.parent().unwrap_or(venv).join(format!(".python-{ver}"));
    let files = copy_dir(Path::new(&src), &dst)?;
    let cfg = venv.join("pyvenv.cfg");
    let original = std::fs::read_to_string(&cfg).map_err(|e| e.to_string())?;
    let backup = venv.join(format!("pyvenv.cfg.bak-{}", chrono_stamp()));
    std::fs::write(&backup, &original).map_err(|e| e.to_string())?;
    let nl = if original.contains("\r\n") { "\r\n" } else { "\n" };
    let updated: Vec<String> = original.lines().map(|l| if l.split_once('=').map(|(a, _)| a.trim() == "home").unwrap_or(false) { format!("home = {}", dst.to_string_lossy()) } else { l.to_string() }).collect();
    std::fs::write(&cfg, updated.join(nl) + nl).map_err(|e| e.to_string())?;
    let (ok, out) = python_check(venv);
    if !ok {
        let _ = std::fs::write(&cfg, &original);
        return Err(format!("修復後虛擬環境仍無法執行，已還原 pyvenv.cfg：{out}"));
    }
    Ok(format!(
        "已修復：從「{}」的私有副本複製 Python {}（{files} 個檔案）到 {}，pyvenv.cfg 的 home 已更新（備份 {}）。驗證：{out}",
        d.package.unwrap_or_default(),
        d.version,
        clean_path(&dst),
        clean_path(&backup)
    ))
}

fn chrono_stamp() -> String {
    crate::util::now_iso().chars().filter(|c| c.is_ascii_digit()).take(14).collect()
}

/// Does a failed job's text look like a broken Python environment (interpreter / venv / DLL)?
pub fn looks_like_env_failure(text: &str) -> bool {
    ["No Python at", "did not find executable", "python.exe' is not recognized", "DLL load failed", "找不到 CosyVoice 的 Python", "Could not find platform independent libraries", "Fatal Python error"]
        .iter()
        .any(|k| text.contains(k))
}

/// A missing Python module in the job text (diagnosis only; installing packages is left to the user / doctor).
pub fn missing_module(text: &str) -> Option<String> {
    let i = text.find("No module named ")?;
    let rest = &text[i + 16..];
    Some(rest.trim_start_matches(['\'', '"']).split(['\'', '"', '\n', ' ']).next()?.to_string()).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_and_repairs_private_copy() {
        let base = std::env::temp_dir().join(format!("pikara-envfix-{}", uuid::Uuid::new_v4()));
        let appdata = base.join("Roaming");
        let local = base.join("Local");
        let home = appdata.join(r"uv\python\cpython-3.10.22-windows-x86_64-none");
        // the interpreter only in the package's private copy
        let private = local.join(r"Packages\Claude_test123\LocalCache\Roaming\uv\python\cpython-3.10.22-windows-x86_64-none");
        std::fs::create_dir_all(private.join("Lib")).unwrap();
        std::fs::write(private.join("python.exe"), b"MZ").unwrap();
        std::fs::write(private.join("Lib").join("os.py"), b"#").unwrap();
        let venv = base.join(r"CosyVoice\.venv");
        std::fs::create_dir_all(venv.join("Scripts")).unwrap();
        std::fs::write(venv.join("pyvenv.cfg"), format!("home = {}\r\nimplementation = CPython\r\nversion_info = 3.10.22\r\n", home.display())).unwrap();
        let d = diagnose_with(&venv, &appdata, &local);
        assert!(!d.home_exists && d.fixable, "{d:?}");
        assert_eq!(d.package.as_deref(), Some("Claude_test123"));
        assert!(d.problem.unwrap().contains("MSIX"));
        // repair copies and rewrites; verification fails here (fake python.exe) → cfg restored
        let r = repair_with(&venv, &appdata, &local);
        assert!(r.is_err());
        assert!(venv.parent().unwrap().join(r".python-3.10.22\Lib\os.py").exists(), "interpreter copied");
        let cfg = std::fs::read_to_string(venv.join("pyvenv.cfg")).unwrap();
        assert!(cfg.contains("uv\\python"), "original restored after failed verification: {cfg}");
        assert!(std::fs::read_dir(&venv).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("pyvenv.cfg.bak-")));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn failure_text_classification() {
        assert!(looks_like_env_failure("[stderr] No Python at '\"%USERPROFILE%\\python.exe'"));
        assert!(!looks_like_env_failure("CUDA out of memory"));
        assert_eq!(missing_module("ModuleNotFoundError: No module named 'whisper'").as_deref(), Some("whisper"));
    }
}
