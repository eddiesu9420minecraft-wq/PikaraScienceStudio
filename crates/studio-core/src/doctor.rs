//! Environment doctor: real checks against this machine and project (ENVIRONMENT_SETUP.md §1).
//! Auto-fixes only touch the project / Studio folders; system-level fixes are returned as instructions.

use crate::db::Settings;
use crate::util::{clean_path, run, run_env};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

const T: Duration = Duration::from_secs(20);

#[derive(Debug, Clone)]
pub struct Check {
    pub id: &'static str,
    pub label: &'static str,
    pub status: &'static str,
    pub detail: String,
    pub value: Option<String>,
    pub fix: Option<Value>,
}

impl Check {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "label": self.label, "labelKey": self.id,
            "labelCn": crate::i18n::cn_label(&format!("check:{}", self.id)).or(crate::i18n::cn_label(self.id)), "status": self.status, "detail": self.detail, "value": self.value, "fix": self.fix})
    }
}

fn c(id: &'static str, label: &'static str, status: &'static str, detail: impl Into<String>, value: Option<String>, fix: Option<Value>) -> Check {
    Check { id, label, status, detail: detail.into(), value, fix }
}

fn auto(id: &str, label: &str) -> Option<Value> {
    Some(json!({"id": id, "label": label, "kind": "auto", "instructions": null}))
}

fn instr(id: &str, label: &str) -> Option<Value> {
    Some(json!({"id": id, "label": label, "kind": "instructions", "instructions": instructions(id)}))
}

pub fn instructions(id: &str) -> Option<&'static str> {
    Some(match id {
        "longpaths_instructions" => "LongPathsEnabled=0：Studio 不會修改系統設定。目前專案路徑夠短，不影響使用；若要啟用，請以「系統管理員」開啟 PowerShell 執行：\n  reg add HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem /v LongPathsEnabled /t REG_DWORD /d 1 /f\n然後重新開機。",
        "driver_instructions" => "請從顯示卡廠商官網安裝最新驅動（Studio 不會自動安裝或修改驅動）：\n  NVIDIA：https://www.nvidia.com/Download/index.aspx（CosyVoice 的 CUDA 12.1 需要 R530 以上）\n  AMD：https://www.amd.com/support\n  Intel：https://www.intel.com/content/www/us/en/download-center/home.html\n沒有 NVIDIA 顯示卡也能製作：畫面渲染與影片編碼會使用其他品牌 GPU 或 CPU，配音（CosyVoice）改用 CPU，速度較慢。",
        "install_python311" => "請安裝 Python 3.11：winget install Python.Python.3.11（或 uv python install 3.11），安裝後 `py -3.11 --version` 應可執行。",
        "install_ffmpeg" => "請安裝含硬體編碼器（NVENC／AMF／QSV）的 ffmpeg：winget install Gyan.FFmpeg（full build，GPLv3，Studio 不內含），安裝後重新開啟 Studio。沒有硬體編碼器時會用 libx264（CPU）編碼。",
        "install_node" => "請安裝 Node.js 20 以上（https://nodejs.org，LTS），或在 設定 > nodeDir 指定 node.exe 所在資料夾。",
        "install_git" => "請安裝 Git for Windows：winget install Git.Git",
        "install_claude" => "選用：安裝 Claude Code CLI（https://docs.claude.com/en/docs/claude-code），並在終端機自行執行 `claude` 登入。Studio 不會代為登入。",
        "cosy_setup" => "CosyVoice venv 或模型缺少大型元件（torch／模型權重數 GB）。請依 ENVIRONMENT_SETUP.md 的 cosy.venv／cosy.model 步驟手動安裝；Studio 只會自動安裝小型 pip 套件。",
        "free_disk" => "磁碟空間不足：可刪除 out/frames/ 下已完成影片的中間幀（Studio 不會自動刪除）。",
        "git_init" => "專案不是 git repo：在專案資料夾執行 `git init` 並做第一次 commit，Studio 的自動 commit 與回滾才能使用。",
        _ => return None,
    })
}

static RE_VER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?").unwrap());

/// macOS / Linux: name and version (`sw_vers` / `/etc/os-release`), arch. No minimum is enforced on Linux: the CLI
/// binary needs only glibc; macOS needs 12+ (tauri.macos.conf.json).
fn check_os_unix() -> Check {
    let arch = crate::platform::ARCH;
    if cfg!(target_os = "macos") {
        let v = run("sw_vers", &["-productVersion"], None, T).ok().map(|o| o.stdout.trim().to_string()).filter(|s| !s.is_empty());
        let major: u32 = v.as_deref().and_then(|s| s.split('.').next()).and_then(|s| s.parse().ok()).unwrap_or(0);
        let st = if major == 0 || major >= 12 { "ok" } else { "error" };
        let d = match &v {
            Some(v) if st == "ok" => format!("macOS {v}（{arch}）"),
            Some(v) => format!("macOS {v}：需要 macOS 12 以上"),
            None => format!("macOS（{arch}，無法讀取版本）"),
        };
        return c("os.version", "作業系統版本", st, d, v, None);
    }
    let rel = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    let name = rel.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=")).map(|s| s.trim_matches('"').to_string()).unwrap_or_else(|| "Linux".into());
    let kernel = run("uname", &["-r"], None, T).ok().map(|o| o.stdout.trim().to_string()).unwrap_or_default();
    c("os.version", "作業系統版本", "ok", format!("{name}（kernel {kernel}，{arch}）"), Some(name), None)
}

fn check_os() -> Check {
    if !cfg!(windows) {
        return check_os_unix();
    }
    match run("cmd", &["/d", "/c", "ver"], None, T) {
        Ok(o) => match RE_VER.captures(&o.stdout) {
            Some(m) => {
                let build: u32 = m[3].parse().unwrap_or(0);
                let v = m[0].to_string();
                let (st, d) = if build >= 22000 {
                    ("ok", format!("Windows 11（build {build}）"))
                } else if build >= 17134 {
                    ("warn", format!("Windows 10 build {build}：可用，建議 Windows 11"))
                } else {
                    ("error", format!("build {build} 太舊，需要 Windows 10 1803（17134）以上"))
                };
                c("os.version", "Windows 版本", st, d, Some(v), None)
            }
            None => c("os.version", "Windows 版本", "warn", "無法解析 ver 輸出", None, None),
        },
        Err(e) => c("os.version", "Windows 版本", "error", e, None, None),
    }
}

fn reg_value(key: &str, name: &str) -> Option<String> {
    let o = run("reg", &["query", key, "/v", name], None, T).ok()?;
    if !o.ok() {
        return None;
    }
    o.stdout.lines().find(|l| l.trim_start().starts_with(name)).and_then(|l| l.split_whitespace().last().map(|s| s.to_string()))
}

fn check_longpaths(root: Option<&Path>) -> Check {
    if !cfg!(windows) {
        // MAX_PATH (260) is a Windows limit; macOS / Linux paths allow 1024 / 4096 bytes
        return c("os.longpaths", "長路徑支援", "ok", "不適用（只有 Windows 有 260 字元限制）", None, None);
    }
    let v = reg_value(r"HKLM\SYSTEM\CurrentControlSet\Control\FileSystem", "LongPathsEnabled");
    let on = v.as_deref().map(|x| x == "0x1").unwrap_or(false);
    if on {
        return c("os.longpaths", "長路徑支援", "ok", "LongPathsEnabled=1", v, None);
    }
    let chs = root.map(chs_path).map(|p| p.to_string_lossy().len());
    let d = match chs {
        Some(n) if n >= 240 => format!("LongPathsEnabled=0，chrome-headless-shell 路徑 {n} 字元 ≥ 240：lib.mjs 會改用短路徑複本"),
        Some(n) => format!("LongPathsEnabled=0（chrome-headless-shell 路徑 {n} 字元，目前不受影響）"),
        None => "LongPathsEnabled=0".into(),
    };
    c("os.longpaths", "長路徑支援", "warn", d, v, instr("longpaths_instructions", "如何啟用（需系統管理員）"))
}

fn check_webview2() -> Check {
    if cfg!(target_os = "macos") {
        return c("webview2", "介面瀏覽器元件", "ok", "WKWebView（macOS 內建）", None, None);
    }
    if !cfg!(windows) {
        return c("webview2", "介面瀏覽器元件", "ok", "不需要（Linux 只有指令列，沒有 WebView）", None, None);
    }
    const G: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let keys = [
        format!(r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{G}"),
        format!(r"HKCU\Software\Microsoft\EdgeUpdate\Clients\{G}"),
    ];
    for k in &keys {
        if let Some(v) = reg_value(k, "pv").filter(|v| v != "0.0.0.0") {
            return c("webview2", "WebView2 Runtime", "ok", format!("WebView2 {v}"), Some(v), None);
        }
    }
    c("webview2", "WebView2 Runtime", "error", "找不到 WebView2 Runtime", None, None)
}

/// Display adapters of any vendor. NVIDIA additionally reports VRAM and the driver (CUDA for CosyVoice).
/// Missing NVIDIA is a warning, not an error: rendering and encoding have other-vendor and CPU paths.
fn check_gpu() -> Check {
    const L: &str = "GPU 與驅動";
    let adapters = crate::hardware::adapters::detect();
    let list = adapters.iter().map(|a| format!("{}（{}，驅動 {}）", a.name, a.vendor(), if a.driver.is_empty() { "?" } else { &a.driver })).collect::<Vec<_>>().join("；");
    let has_nv = adapters.iter().any(|a| a.vendor_id == "10de");
    match run("nvidia-smi", &["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"], None, T) {
        Ok(o) if o.ok() => {
            let line = o.stdout.lines().next().unwrap_or("").to_string();
            let f: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            if f.len() < 3 {
                return c("gpu.driver", L, "warn", format!("nvidia-smi 輸出無法解析：{line}；顯示卡：{list}"), None, None);
            }
            let vram: f64 = f[2].parse().unwrap_or(0.0);
            let drv_major: u32 = f[1].split('.').next().and_then(|x| x.parse().ok()).unwrap_or(0);
            let mut issues = vec![];
            if vram < 5900.0 {
                issues.push(format!("VRAM {vram} MiB 低於 6 GB"));
            }
            if drv_major < 530 {
                issues.push(format!("驅動 {} 低於 R530（CUDA 12.1）", f[1]));
            }
            let others: Vec<&str> = adapters.iter().filter(|a| a.vendor_id != "10de").map(|a| a.name.as_str()).collect();
            let more = if others.is_empty() { String::new() } else { format!("；其他顯示卡：{}", others.join("、")) };
            let detail = format!("{}，驅動 {}，VRAM {} MiB（CUDA 配音可用）{more}", f[0], f[1], f[2]);
            if issues.is_empty() {
                c("gpu.driver", L, "ok", detail, Some(line), None)
            } else {
                c("gpu.driver", L, "warn", format!("{detail}：{}", issues.join("；")), Some(line), instr("driver_instructions", "更新驅動說明"))
            }
        }
        r => {
            let why = match r {
                Ok(o) => format!("nvidia-smi 失敗：{}", o.combined().trim()),
                Err(_) if has_nv => "偵測到 NVIDIA 顯示卡但找不到 nvidia-smi（驅動可能未安裝完整）".into(),
                Err(_) => "沒有 NVIDIA 顯示卡".into(),
            };
            if adapters.is_empty() {
                return c("gpu.driver", L, "warn", format!("{why}；也沒有偵測到其他顯示卡。畫面渲染、編碼與配音都會用 CPU（較慢）"), None, instr("driver_instructions", "驅動說明"));
            }
            c("gpu.driver", L, "warn", format!("{list}。{why}：畫面渲染與影片編碼可用這些顯示卡（實際能力見「ffmpeg 硬體編碼」與 GPU 實測），CosyVoice 配音沒有 CUDA，會用 CPU（較慢）"), Some(list.clone()), instr("driver_instructions", "驅動說明"))
        }
    }
}

pub fn node_exe(s: &Settings) -> String {
    let p = Path::new(&s.node_dir).join(crate::platform::exe("node"));
    if p.exists() { p.to_string_lossy().into() } else { crate::platform::node_program(&s.node_dir) }
}

fn check_node(s: &Settings) -> Check {
    let node = node_exe(s);
    match run(&node, &["-v"], None, T) {
        Ok(o) if o.ok() => {
            let v = o.stdout.trim().to_string();
            let major: u32 = v.trim_start_matches('v').split('.').next().and_then(|x| x.parse().ok()).unwrap_or(0);
            let npm = Path::new(&node).parent().map(|d| d.join(if cfg!(windows) { "npm.cmd" } else { "npm" })).filter(|p| p.exists());
            let npm_v = npm
                .and_then(|p| if cfg!(windows) { run_env("cmd", &["/d", "/c", &p.to_string_lossy(), "-v"], None, &[], T).ok() } else { run(&p.to_string_lossy(), &["-v"], None, T).ok() })
                .filter(|o| o.ok())
                .map(|o| o.stdout.trim().to_string());
            let d = format!("Node {v}（{node}），npm {}", npm_v.clone().unwrap_or("未找到".into()));
            if major >= 20 && npm_v.is_some() {
                c("node", "Node.js / npm", "ok", d, Some(v), None)
            } else {
                c("node", "Node.js / npm", if major >= 20 { "warn" } else { "error" }, format!("{d}：需要 Node 20 以上與 npm"), Some(v), instr("install_node", "安裝 Node.js 說明"))
            }
        }
        _ => c("node", "Node.js / npm", "error", "找不到 node", None, instr("install_node", "安裝 Node.js 說明")),
    }
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn check_npm_deps(root: &Path) -> Check {
    let installed = read_json(&root.join(crate::platform::native("node_modules/remotion/package.json"))).and_then(|j| j["version"].as_str().map(String::from));
    let locked = read_json(&root.join("package-lock.json")).and_then(|j| j["packages"]["node_modules/remotion"]["version"].as_str().map(String::from));
    match (installed, locked) {
        (Some(i), Some(l)) if i == l => c("npm.deps", "專案 node_modules（Remotion）", "ok", format!("remotion {i}（與 package-lock 一致）"), Some(i), None),
        (Some(i), Some(l)) => c("npm.deps", "專案 node_modules（Remotion）", "warn", format!("已安裝 remotion {i}，lockfile 為 {l}"), Some(i), auto("npm_install", "在專案執行 npm install")),
        (Some(i), None) => c("npm.deps", "專案 node_modules（Remotion）", "ok", format!("remotion {i}（沒有 package-lock）"), Some(i), None),
        (None, _) => c("npm.deps", "專案 node_modules（Remotion）", "error", "node_modules 缺少 remotion", None, auto("npm_install", "在專案執行 npm install（Remotion 授權：remotion.dev/license）")),
    }
}

pub fn chs_path(root: &Path) -> PathBuf {
    crate::platform::remotion_chs(root)
}

fn check_chs(root: &Path) -> Check {
    let p = chs_path(root);
    if p.exists() {
        let n = p.to_string_lossy().len();
        let st = if n >= 240 { "warn" } else { "ok" };
        c("browser.chs", "Remotion chrome-headless-shell", st, format!("{}（{n} 字元）", clean_path(&p)), Some(clean_path(&p)), None)
    } else {
        c("browser.chs", "Remotion chrome-headless-shell", "error", "尚未下載 chrome-headless-shell", None, auto("remotion_browser_ensure", "執行 remotion browser ensure（約 100 MB）"))
    }
}

/// ffmpeg presence + video encoders. Hardware encoders of every vendor are candidates; without "GPU 實測" only the
/// encoder list and the results render.mjs cached (`out/hwenc-cache.json`) are shown — no GPU is touched.
fn check_ffmpeg(root: Option<&Path>, gpu_tests: bool, gpu_free: bool) -> (Check, Check) {
    const L: &str = "ffmpeg 硬體編碼";
    let Some(path) = crate::util::tool("ffmpeg") else {
        return (
            c("ffmpeg.present", "ffmpeg", "error", "PATH 上找不到 ffmpeg", None, instr("install_ffmpeg", "安裝 ffmpeg 說明")),
            c("ffmpeg.hwenc", L, "skipped", "沒有 ffmpeg", None, None),
        );
    };
    let ver = run(&path, &["-version"], None, T).ok();
    let first = ver.as_ref().and_then(|o| o.stdout.lines().next().map(String::from)).unwrap_or_default();
    let nonfree = ver.as_ref().map(|o| o.stdout.contains("--enable-nonfree")).unwrap_or(false);
    let present = c(
        "ffmpeg.present",
        "ffmpeg",
        if nonfree { "warn" } else { "ok" },
        format!("{first}（{path}）{}", if nonfree { "；含 --enable-nonfree：不可散布，個人使用可" } else { "" }),
        Some(first.clone()),
        None,
    );
    use crate::hardware::encoders;
    let listed = encoders::parse_encoder_list(&run(&path, &["-hide_banner", "-encoders"], None, T).map(|o| o.stdout).unwrap_or_default());
    let test = gpu_tests && gpu_free;
    // 找到第一個可用的編碼器就停（all=false）：不在每次環境檢查時對每張顯示卡、每個編碼器試編碼。
    // 2026-11-23 17:21–17:23 對所有編碼器（NVENC／AMF／QSV／MF）連續試編碼期間，Windows 記錄到顯示驅動逾時重置
    // （LiveKernelEvent 141/117，工作列無回應）；只是時間吻合、未證實因果，但環境檢查不需要冒這個風險。
    // 要逐一實測全部候選，手動執行 node scripts/hwenc.mjs --all --force。
    let p = encoders::probe(root, &path, &listed, crate::hardware::adapters::detect(), "h264", test, false);
    let show = |r: &encoders::EncResult| match r.works {
        Some(true) => format!("{} ✓（{} ms）", r.id, r.ms),
        Some(false) if !r.listed => format!("{} 未編譯", r.id),
        Some(false) => format!("{} ✗", r.id),
        None => format!("{} 已列出、未實測", r.id),
    };
    let summary = p.results.iter().map(show).collect::<Vec<_>>().join("、");
    let hw_listed = p.results.iter().any(|r| r.listed && r.family != "cpu");
    let value = serde_json::to_string(&p).ok();
    let how = if test { "實測 1 秒 720p60：" } else if gpu_tests { "GPU 使用中，略過實測；" } else { "未實測（勾選「GPU 實測」可測試）；" };
    let chk = if p.selected_hardware {
        c("ffmpeg.hwenc", L, "ok", format!("使用 {}。{how}{summary}", p.selected.clone().unwrap_or_default()), value, None)
    } else if test || p.results.iter().any(|r| r.family != "cpu" && r.works == Some(false) && r.listed) {
        c("ffmpeg.hwenc", L, "warn", format!("沒有可用的硬體編碼器，會用 libx264（CPU，較慢、畫質相同）。{how}{summary}"), value, instr("driver_instructions", "檢查驅動"))
    } else if hw_listed {
        c("ffmpeg.hwenc", L, "ok", format!("{how}{summary}；渲染時會實測並自動選用，失敗自動改用下一個、最後是 libx264"), value, None)
    } else {
        c("ffmpeg.hwenc", L, "warn", format!("這個 ffmpeg 沒有任何硬體編碼器，會用 libx264（CPU）。{summary}"), value, instr("install_ffmpeg", "改用含硬體編碼器的 ffmpeg"))
    };
    (present, chk)
}

fn check_py311() -> Check {
    let (prog, lead) = crate::platform::python311();
    let mut a: Vec<&str> = lead.iter().map(|s| s.as_str()).collect();
    a.push("-c");
    a.push("import sys;print(sys.version.split()[0]);import importlib.util as u;print(','.join(m for m in ['opencc','numpy'] if u.find_spec(m) is None))");
    match run(&prog, &a, None, T) {
        Ok(o) if o.ok() => {
            let mut l = o.stdout.lines();
            let v = l.next().unwrap_or("").trim().to_string();
            let missing = l.next().unwrap_or("").trim().to_string();
            if missing.is_empty() {
                c("py311", "Python 3.11", "ok", format!("Python {v}（opencc、numpy 可匯入）"), Some(v), None)
            } else {
                c("py311", "Python 3.11", "warn", format!("Python {v}，缺少套件：{missing}（make_cn.py 需要 opencc；numpy 為選用）"), Some(v), None)
            }
        }
        _ => c("py311", "Python 3.11", "error", if cfg!(windows) { "`py -3.11` 無法執行".to_string() } else { format!("`{prog}` 無法執行（需要 Python 3.11）") }, None, instr("install_python311", "安裝 Python 3.11 說明")),
    }
}

/// Small packages we may pip-install automatically into the CosyVoice venv.
const SMALL_PKGS: &[(&str, &str)] = &[("opencc", "opencc"), ("hyperpyyaml", "hyperpyyaml"), ("inflect", "inflect"), ("conformer", "conformer"), ("wget", "wget"), ("pyworld", "pyworld")];
const BIG_PKGS: &[&str] = &["torch", "torchaudio", "faster_whisper", "onnxruntime", "modelscope"];

pub fn cosy_python(root: &Path, s: &Settings) -> PathBuf {
    s.cosy_python.clone().map(PathBuf::from).unwrap_or_else(|| crate::platform::default_cosy_python(root))
}

/// The venv exists but its Python does not start: tell an MSIX-redirected interpreter (repairable by copying,
/// see envfix.rs) apart from a really missing one.
fn venv_broken(py: &Path, output: String) -> Check {
    let venv = py.parent().and_then(|p| p.parent()).unwrap_or(py);
    let d = crate::envfix::diagnose(venv);
    let detail = match &d.problem {
        Some(p) => format!("{p}\n（{}）", output.trim().chars().take(300).collect::<String>()),
        None => output,
    };
    if d.fixable {
        c("cosy.venv", "CosyVoice venv", "error", detail, None, auto("venv_repair", "修復 Python 環境（複製解譯器，不下載、不動套件與模型）"))
    } else {
        c("cosy.venv", "CosyVoice venv", "error", detail, None, instr("cosy_setup", "安裝說明"))
    }
}

fn check_cosy(root: &Path, s: &Settings) -> Vec<Check> {
    let py = cosy_python(root, s);
    let mut out = vec![];
    if !py.exists() {
        out.push(c("cosy.venv", "CosyVoice venv", "error", format!("找不到 {}", clean_path(&py)), None, instr("cosy_setup", "安裝說明")));
    } else {
        // find_spec only — never imports torch, so this never touches CUDA/GPU.
        let mods: Vec<&str> = BIG_PKGS.iter().copied().chain(SMALL_PKGS.iter().map(|x| x.0)).collect();
        let code = format!(
            "import sys,importlib.util as u;print(sys.version.split()[0]);print(','.join(m for m in {:?} if u.find_spec(m) is None))",
            mods
        );
        match run(&py.to_string_lossy(), &["-c", &code], Some(root), Duration::from_secs(60)) {
            Ok(o) if o.ok() => {
                let mut l = o.stdout.lines();
                let v = l.next().unwrap_or("").trim().to_string();
                let missing: Vec<String> = l.next().unwrap_or("").split(',').filter(|x| !x.is_empty()).map(String::from).collect();
                if missing.is_empty() {
                    out.push(c("cosy.venv", "CosyVoice venv", "ok", format!("Python {v}；torch、torchaudio、faster_whisper、onnxruntime 等套件齊全（未初始化 CUDA）"), Some(v), None));
                } else if let Some(small) = missing.iter().find_map(|m| SMALL_PKGS.iter().find(|x| x.0 == m)) {
                    out.push(c("cosy.venv", "CosyVoice venv", "warn", format!("Python {v}，缺少：{}", missing.join(", ")), Some(v), auto(&format!("pip_install:{}", small.1), &format!("pip install {}", small.1))));
                } else {
                    out.push(c("cosy.venv", "CosyVoice venv", "error", format!("Python {v}，缺少大型套件：{}", missing.join(", ")), Some(v), instr("cosy_setup", "安裝說明")));
                }
            }
            Ok(o) => out.push(venv_broken(&py, o.combined())),
            Err(e) => out.push(venv_broken(&py, e)),
        }
    }
    let md = root.join(crate::platform::native("tools/CosyVoice/pretrained_models/Fun-CosyVoice3-0.5B"));
    let need = ["cosyvoice3.yaml", "llm.pt", "flow.pt", "hift.pt", "campplus.onnx", "speech_tokenizer_v3.onnx"];
    let missing: Vec<&str> = need.iter().copied().filter(|f| !md.join(f).exists()).collect();
    let size: u64 = std::fs::read_dir(&md).map(|rd| rd.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()).unwrap_or(0);
    out.push(if missing.is_empty() {
        c("cosy.model", "CosyVoice3 模型", "ok", format!("{}（{:.1} GB）", clean_path(&md), size as f64 / 1e9), Some(clean_path(&md)), None)
    } else {
        c("cosy.model", "CosyVoice3 模型", "error", format!("缺少：{}", missing.join(", ")), None, instr("cosy_setup", "下載模型說明（約 9 GB，Apache-2.0）"))
    });
    let wm = root.join(crate::platform::native("tools/CosyVoice/pretrained_models/whisper/large-v3-turbo/model.bin"));
    out.push(match std::fs::metadata(&wm) {
        Ok(m) => c("whisper.model", "Whisper large-v3-turbo", "ok", format!("model.bin {:.2} GB", m.len() as f64 / 1e9), Some(clean_path(&wm)), None),
        Err(_) => c("whisper.model", "Whisper large-v3-turbo", "warn", "沒有本機 Whisper 模型；第一次對齊時 generate_voiceover_cosy.py 會自動下載（約 1.6 GB）", None, None),
    });
    out
}

fn check_disk(root: Option<&Path>) -> Check {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let target = root.map(|r| clean_path(r).to_ascii_uppercase()).unwrap_or_else(|| "C:\\".into());
    let mut best: Option<(&sysinfo::Disk, usize)> = None;
    for d in disks.list() {
        let mp = d.mount_point().to_string_lossy().to_ascii_uppercase();
        if target.starts_with(&mp) && best.map(|b| mp.len() > b.1).unwrap_or(true) {
            best = Some((d, mp.len()));
        }
    }
    let Some((d, _)) = best else { return c("disk.free", "磁碟空間", "warn", "找不到專案所在磁碟", None, None) };
    let free = d.available_space() as f64 / 1e9;
    let total = d.total_space() as f64 / 1e9;
    let mp = d.mount_point().to_string_lossy().to_string();
    let detail = format!("{mp} 可用 {free:.0} GB／共 {total:.0} GB");
    let st = if free < 10.0 { "error" } else if free < 25.0 { "warn" } else { "ok" };
    c("disk.free", "磁碟空間", st, detail, Some(format!("{free:.1}")), if st == "ok" { None } else { instr("free_disk", "清理說明") })
}

fn check_git(root: Option<&Path>) -> Check {
    match run("git", &["--version"], None, T) {
        Ok(o) if o.ok() => {
            let v = o.stdout.trim().to_string();
            if let Some(r) = root {
                let st = crate::gitops::status(r);
                if !st.is_repo {
                    return c("git", "Git", "warn", format!("{v}；專案不是 git repo"), Some(v), instr("git_init", "初始化說明"));
                }
                return c("git", "Git", "ok", format!("{v}；分支 {}，未提交變更 {} 個", st.branch.unwrap_or_default(), st.dirty.len()), Some(v), None);
            }
            c("git", "Git", "ok", v.clone(), Some(v), None)
        }
        _ => c("git", "Git", "error", "找不到 git", None, instr("install_git", "安裝 Git 說明")),
    }
}

fn check_claude() -> Check {
    let d = crate::claude::detect();
    if d["found"] == true {
        c("claude", "Claude Code CLI（選用）", "ok", format!("{}（{}）", d["version"].as_str().unwrap_or("?"), d["path"].as_str().unwrap_or("")), d["version"].as_str().map(String::from), None)
    } else {
        c("claude", "Claude Code CLI（選用）", "warn", "沒有安裝；AI 協作功能停用", None, instr("install_claude", "安裝說明"))
    }
}

pub const PROJECT_FOLDERS: &[&str] = &["out", "out/qa", "out/reports", "out/subtitles", "out/frames", "public/assets/audio/mix", ".studio/worktrees"];

fn check_folders(root: &Path) -> Check {
    let missing: Vec<&str> = PROJECT_FOLDERS.iter().copied().filter(|f| !root.join(crate::platform::native(f)).is_dir()).collect();
    if missing.is_empty() {
        c("project.folders", "專案輸出資料夾", "ok", "out/、out/qa、out/reports、out/subtitles、out/frames、mix、.studio 皆存在", None, None)
    } else {
        c("project.folders", "專案輸出資料夾", "warn", format!("缺少：{}", missing.join("、")), None, auto("create_folders", "建立缺少的資料夾"))
    }
}

pub fn create_folders(root: &Path) -> Result<String, String> {
    let mut made = vec![];
    for f in PROJECT_FOLDERS {
        let p = root.join(f);
        if !p.is_dir() {
            std::fs::create_dir_all(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            made.push(*f);
        }
    }
    if root.join(".git").exists() {
        let _ = crate::claude::ensure_excluded(root);
    }
    Ok(if made.is_empty() { "所有資料夾都已存在".into() } else { format!("已建立：{}", made.join("、")) })
}

/// Run every check. `gpu_free` must come from the queue's GPU lock + external detection.
pub fn run_all(root: Option<&Path>, s: &Settings, gpu_tests: bool, gpu_free: bool) -> Vec<Check> {
    // Independent checks run in parallel threads (each spawns short read-only commands).
    let r = root.map(|p| p.to_path_buf());
    let s2 = s.clone();
    let h_cosy = r.clone().map(|rr| {
        let s = s2.clone();
        std::thread::spawn(move || check_cosy(&rr, &s))
    });
    let r_ff = r.clone();
    let h_ff = std::thread::spawn(move || check_ffmpeg(r_ff.as_deref(), gpu_tests, gpu_free));
    let h_claude = std::thread::spawn(check_claude);
    let h_gpu = std::thread::spawn(check_gpu);
    let mut v = vec![check_os(), check_longpaths(root), check_webview2()];
    // a crashing probe (driver bug, odd tool output) must never take Studio down: it becomes an "error" row
    v.push(h_gpu.join().unwrap_or_else(|_| c("gpu.driver", "GPU 與驅動", "error", "顯示卡檢查發生內部錯誤（已略過）", None, None)));
    v.push(check_node(s));
    if let Some(rt) = root {
        v.push(check_npm_deps(rt));
        v.push(check_chs(rt));
    }
    let (fp, fnv) = h_ff.join().unwrap_or_else(|_| {
        (c("ffmpeg.present", "ffmpeg", "error", "ffmpeg 檢查發生內部錯誤（已略過）", None, None), c("ffmpeg.hwenc", "ffmpeg 硬體編碼", "error", "編碼器檢查發生內部錯誤（已略過）", None, None))
    });
    v.push(fp);
    v.push(fnv);
    v.push(check_py311());
    if let Some(h) = h_cosy {
        v.extend(h.join().unwrap_or_default());
    }
    v.push(check_disk(root));
    v.push(check_git(root));
    v.push(h_claude.join().unwrap_or_else(|_| c("claude", "Claude Code", "error", "檢查發生內部錯誤（已略過）", None, None)));
    if let Some(rt) = root {
        v.push(check_folders(rt));
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_doctor_run_on_this_machine() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let root = std::fs::canonicalize(&root).unwrap();
        let checks = run_all(Some(&root), &Settings::default(), false, false);
        let ids: Vec<&str> = checks.iter().map(|c| c.id).collect();
        for want in ["os.version", "os.longpaths", "webview2", "gpu.driver", "node", "npm.deps", "browser.chs", "ffmpeg.present", "ffmpeg.hwenc", "py311", "cosy.venv", "cosy.model", "whisper.model", "disk.free", "git", "claude", "project.folders"] {
            assert!(ids.contains(&want), "missing check {want}");
        }
        for c in &checks {
            assert!(["ok", "warn", "error", "skipped"].contains(&c.status));
            eprintln!("{:<16} {:<7} {}", c.id, c.status, c.detail);
            if c.status == "warn" || c.status == "error" {
                // system-level problems must never come with an auto fix
                if ["os.longpaths", "gpu.driver", "webview2", "os.version"].contains(&c.id) {
                    assert!(c.fix.as_ref().map(|f| f["kind"] != "auto").unwrap_or(true));
                }
            }
        }
        // never runs the GPU test encode unless asked
        let hw = checks.iter().find(|c| c.id == "ffmpeg.hwenc").unwrap();
        assert!(!hw.detail.contains("實測 1 秒"), "{}", hw.detail);
    }

    #[test]
    fn create_folders_fix_is_real() {
        let d = std::env::temp_dir().join(format!("pss-doc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(check_folders(&d).status, "warn");
        create_folders(&d).unwrap();
        assert_eq!(check_folders(&d).status, "ok");
        let _ = std::fs::remove_dir_all(&d);
    }
}

