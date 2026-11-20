//! NVIDIA GPU sampling (nvidia-smi) and detection of external GPU jobs
//! (render / TTS processes not started by Studio, or high VRAM use).

use crate::util::run;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub const QUERY_FIELDS: &str = "name,driver_version,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.sm,utilization.encoder,clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.sw_thermal_slowdown";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuSample {
    pub name: String,
    pub driver: String,
    pub util: f64,
    #[serde(rename = "vramUsedMiB")]
    pub vram_used_mib: u64,
    #[serde(rename = "vramTotalMiB")]
    pub vram_total_mib: u64,
    pub temp_c: f64,
    pub power_w: Option<f64>,
    #[serde(rename = "smClockMHz")]
    pub sm_clock_mhz: Option<f64>,
    pub encoder_util: Option<f64>,
    pub thermal_hw: bool,
    pub thermal_sw: bool,
}

fn num(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() || t.starts_with('[') || t.eq_ignore_ascii_case("N/A") {
        return None;
    }
    t.parse::<f64>().ok()
}

fn active(s: &str) -> bool {
    s.trim().eq_ignore_ascii_case("Active")
}

/// Parse one line of `nvidia-smi --query-gpu=QUERY_FIELDS --format=csv,noheader,nounits`.
/// The GPU name never contains commas for NVIDIA products, so a plain split is safe.
pub fn parse_query(csv: &str) -> Option<GpuSample> {
    let line = csv.lines().map(|l| l.trim()).find(|l| !l.is_empty())?;
    let f: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
    if f.len() < 11 {
        return None;
    }
    Some(GpuSample {
        name: f[0].to_string(),
        driver: f[1].to_string(),
        util: num(f[2])?,
        vram_used_mib: num(f[3])? as u64,
        vram_total_mib: num(f[4])? as u64,
        temp_c: num(f[5]).unwrap_or(0.0),
        power_w: num(f[6]),
        sm_clock_mhz: num(f[7]),
        encoder_util: num(f[8]),
        thermal_hw: active(f[9]),
        thermal_sw: active(f[10]),
    })
}

pub fn query() -> Option<GpuSample> {
    let q = format!("--query-gpu={QUERY_FIELDS}");
    let o = run("nvidia-smi", &[&q, "--format=csv,noheader,nounits"], None, Duration::from_secs(8)).ok()?;
    if !o.ok() {
        return None;
    }
    parse_query(&o.stdout)
}

/// Parse `--query-compute-apps=pid,process_name,used_memory`. On WDDM laptops used_memory is "[N/A]".
pub fn parse_compute_apps(csv: &str) -> Vec<(u32, String, Option<u64>)> {
    csv.lines()
        .filter_map(|l| {
            let mut it = l.splitn(3, ',');
            let pid = it.next()?.trim().parse::<u32>().ok()?;
            let rest = it.next()?.trim().to_string();
            let mem = it.next().and_then(|m| num(m)).map(|m| m as u64);
            Some((pid, rest, mem))
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtProc {
    pub pid: u32,
    pub name: String,
    pub cmd: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExternalGpu {
    pub busy: bool,
    pub reasons: Vec<String>,
    pub processes: Vec<ExtProc>,
    #[serde(rename = "vramUsedMiB")]
    pub vram_used_mib: Option<u64>,
}

/// Is this process a GPU pipeline job? (matches last night's renders/TTS)
pub fn classify(name: &str, cmd: &str) -> Option<&'static str> {
    let n = name.to_ascii_lowercase();
    let c = cmd.to_ascii_lowercase().replace('\\', "/");
    if n.starts_with("chrome-headless-shell") {
        return Some("chrome-headless-shell（Remotion 渲染）");
    }
    if n.starts_with("python") || n == "py.exe" {
        if c.contains("generate_voiceover_cosy") {
            return Some("CosyVoice TTS（generate_voiceover_cosy.py）");
        }
        if c.contains("cosyvoice") && (c.contains("webui") || c.contains("inference")) {
            return Some("CosyVoice 推論");
        }
        if c.contains("whisper") {
            return Some("Whisper");
        }
    }
    if n.starts_with("node") {
        for s in ["scripts/render.mjs", "scripts/stills.mjs", "scripts/gpu-check.mjs", "scripts/benchmark.mjs", "remotion-cli.js render", "remotion render"] {
            if c.contains(s) {
                return Some("Node 渲染（render.mjs / Remotion）");
            }
        }
    }
    if n.starts_with("ffmpeg") && (c.contains("nvenc") || c.contains("cuda")) {
        return Some("ffmpeg NVENC 編碼");
    }
    None
}

/// Process snapshot: pid → (parent, name, cmd)
pub struct ProcSnap {
    pub procs: HashMap<u32, (Option<u32>, String, String)>,
}

pub fn snapshot() -> ProcSnap {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    let mut procs = HashMap::new();
    for (pid, p) in sys.processes() {
        let cmd = p.cmd().iter().map(|s| s.to_string_lossy()).collect::<Vec<_>>().join(" ");
        procs.insert(pid.as_u32(), (p.parent().map(|x| x.as_u32()), p.name().to_string_lossy().to_string(), cmd));
    }
    ProcSnap { procs }
}

impl ProcSnap {
    /// True if `pid` is `root` or a descendant of any pid in `roots`.
    pub fn descends_from(&self, pid: u32, roots: &HashSet<u32>) -> bool {
        let mut cur = Some(pid);
        let mut guard = 0;
        while let Some(p) = cur {
            if roots.contains(&p) {
                return true;
            }
            guard += 1;
            if guard > 64 {
                break;
            }
            cur = self.procs.get(&p).and_then(|x| x.0).filter(|pp| *pp != p);
        }
        false
    }
}

/// Decide whether the GPU is in use by something other than Studio.
/// `own_roots`: pids of processes Studio spawned (their descendants are ours too).
/// `studio_holds_gpu`: Studio itself runs a GPU job (then VRAM use is expected and not counted).
pub fn external_status(own_roots: &HashSet<u32>, vram_busy_mib: u32, studio_holds_gpu: bool, sample: Option<&GpuSample>) -> ExternalGpu {
    let snap = snapshot();
    external_from(&snap, own_roots, vram_busy_mib, studio_holds_gpu, sample)
}

pub fn external_from(snap: &ProcSnap, own_roots: &HashSet<u32>, vram_busy_mib: u32, studio_holds_gpu: bool, sample: Option<&GpuSample>) -> ExternalGpu {
    let me = std::process::id();
    let mut out = ExternalGpu { vram_used_mib: sample.map(|s| s.vram_used_mib), ..Default::default() };
    let mut seen = HashSet::new();
    let mut ids: Vec<&u32> = snap.procs.keys().collect();
    ids.sort();
    for pid in ids {
        let (_, name, cmd) = &snap.procs[pid];
        if *pid == me {
            continue;
        }
        if let Some(kind) = classify(name, cmd) {
            if snap.descends_from(*pid, own_roots) {
                continue;
            }
            if seen.insert(kind) {
                out.reasons.push(format!("外部 GPU 工作：{kind}（PID {pid}）"));
            }
            out.processes.push(ExtProc { pid: *pid, name: name.clone(), cmd: cmd.chars().take(300).collect() });
        }
    }
    if let Some(s) = sample {
        if !studio_holds_gpu && s.vram_used_mib as u32 > vram_busy_mib {
            out.reasons.push(format!("VRAM 已使用 {} MiB，超過門檻 {} MiB（可能有其他程式在用 GPU）", s.vram_used_mib, vram_busy_mib));
        }
    }
    out.busy = !out.reasons.is_empty();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/nvidia_smi_query.csv");
    const APPS: &str = include_str!("../tests/fixtures/nvidia_smi_apps.csv");

    #[test]
    fn parses_real_nvidia_smi_output() {
        let s = parse_query(FIXTURE).expect("fixture parses");
        assert_eq!(s.name, "NVIDIA GeForce RTX 4050 Laptop GPU");
        assert_eq!(s.driver, "621.01");
        assert_eq!(s.vram_total_mib, 6141);
        assert!(s.vram_used_mib > 0 && s.vram_used_mib <= 6141);
        assert!(!s.thermal_hw && !s.thermal_sw);
        assert!(s.power_w.is_some());
    }

    #[test]
    fn parses_na_fields_and_active_flags() {
        let s = parse_query("NVIDIA RTX A2000, 550.10, 97, 4100, 6144, 71, [N/A], 1800, 12, Active, Not Active").unwrap();
        assert_eq!(s.power_w, None);
        assert_eq!(s.encoder_util, Some(12.0));
        assert!(s.thermal_hw);
        assert!(parse_query("garbage").is_none());
        assert!(parse_query("").is_none());
    }

    #[test]
    fn parses_compute_apps_with_na_memory() {
        let apps = parse_compute_apps(APPS);
        assert!(!apps.is_empty());
        assert!(apps.iter().all(|a| a.2.is_none())); // WDDM laptop: [N/A]
    }

    #[test]
    fn classifies_pipeline_processes() {
        assert!(classify("chrome-headless-shell.exe", "").is_some());
        assert!(classify("python.exe", r"D:\x\.venv\Scripts\python.exe -u scripts/generate_voiceover_cosy.py --seq ep01").is_some());
        assert!(classify("node.exe", r#""C:\Program Files\nodejs\node.exe" scripts\render.mjs gpu --comp EP01-30fps"#).is_some());
        assert!(classify("node.exe", "node server.js").is_none());
        assert!(classify("python.exe", "py -3.11 scripts/qa_video.py").is_none());
    }

    #[test]
    fn own_children_are_not_external() {
        let mut procs = HashMap::new();
        procs.insert(100, (None, "cmd.exe".into(), "cmd /c node scripts/render.mjs".into()));
        procs.insert(101, (Some(100), "node.exe".into(), "node scripts/render.mjs gpu".into()));
        procs.insert(102, (Some(101), "chrome-headless-shell.exe".into(), "".into()));
        procs.insert(200, (None, "python.exe".into(), "python scripts/generate_voiceover_cosy.py".into()));
        let snap = ProcSnap { procs };
        let own: HashSet<u32> = [100].into_iter().collect();
        let e = external_from(&snap, &own, 2500, true, None);
        assert!(e.busy);
        assert_eq!(e.processes.len(), 1);
        assert_eq!(e.processes[0].pid, 200);
        let none: HashSet<u32> = [100, 200].into_iter().collect();
        assert!(!external_from(&snap, &none, 2500, true, None).busy);
        // VRAM rule only applies when Studio doesn't hold the GPU
        let s = parse_query("X, 1, 50, 4000, 6000, 50, 10, 1000, 0, Not Active, Not Active").unwrap();
        assert!(external_from(&snap, &none, 2500, false, Some(&s)).busy);
        assert!(!external_from(&snap, &none, 2500, true, Some(&s)).busy);
    }
}
