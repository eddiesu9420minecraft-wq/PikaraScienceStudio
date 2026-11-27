//! MachineProfile + resource budgets for the power modes (省電 eco / 平衡 balanced / 高效能 performance / 自訂 custom).
//!
//! One cross-platform description of the machine (CPU cores, memory, memory architecture, accelerators) and one
//! function that turns it plus a mode into concrete limits for every job kind. The limits are *starting points and
//! ceilings*; render.mjs still measures and adapts its concurrency inside them, the voice backend still measures its
//! own peak memory. Nothing here is allowed to make the system unresponsive:
//!
//! * at least 2 logical cores are always left to the OS / UI, more in eco;
//! * a fixed memory reserve for the OS + UI (4 GiB; 6 GiB in eco) is never handed out;
//! * on Apple Silicon (unified memory) the *same* pool feeds CPU, GPU and ANE, so render and AI budgets are taken from
//!   one shared budget — there is no separate "VRAM" number, and no discrete-VRAM formula is applied.

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MachineProfile {
    pub os: String,
    pub arch: String,
    pub cpu_brand: String,
    pub physical_cores: u32,
    pub logical_cores: u32,
    pub perf_cores: Option<u32>,
    pub efficiency_cores: Option<u32>,
    pub ram_mib: u64,
    /// Apple Silicon: CPU / GPU / ANE share one memory pool
    pub unified_memory: bool,
    pub apple_silicon: bool,
    /// this process is an x86_64 build translated by Rosetta 2
    pub rosetta: bool,
    /// largest dedicated VRAM of a discrete GPU (Windows / Intel Mac dGPU); None on unified-memory machines
    pub discrete_vram_mib: Option<u64>,
    pub gpus: Vec<String>,
    pub cuda: bool,
    pub metal: Option<String>,
    /// measured by scripts/accel_probe.py (None = not measured yet; never guessed)
    pub mps: Option<bool>,
    pub mlx: Option<bool>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub mode: String,
    /// Chromium render tabs: start and hard ceiling (render.mjs adapts in between)
    pub render_start: u32,
    pub render_max: u32,
    /// lines synthesised per TTS batch (1 = sequential); the voice backend lowers it after a measured OOM
    pub tts_batch: u32,
    /// CPU threads for torch / ctranslate2 / ffmpeg software paths
    pub cpu_threads: u32,
    /// memory the AI + render jobs together may use (MiB); on unified memory this includes "GPU" memory
    pub mem_budget_mib: u64,
    /// at most this many heavy jobs at once (GPU / unified memory)
    pub heavy_jobs: u32,
    /// lower OS scheduling priority for pipeline processes
    pub low_priority: bool,
    pub reasons: Vec<String>,
}

pub fn detect() -> MachineProfile {
    use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()).with_cpu(CpuRefreshKind::nothing()));
    let snap = super::manager::snapshot();
    let mut p = MachineProfile {
        os: crate::platform::OS.into(),
        arch: crate::platform::ARCH.into(),
        cpu_brand: sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
        physical_cores: sys.physical_core_count().unwrap_or(0) as u32,
        logical_cores: sys.cpus().len() as u32,
        ram_mib: sys.total_memory() >> 20,
        gpus: snap.gpus.iter().map(|g| g.name.clone()).collect(),
        cuda: snap.cuda.available,
        discrete_vram_mib: snap.gpus.iter().filter(|g| matches!(g.kind, super::manager::Kind::Discrete | super::manager::Kind::External)).map(|g| g.dedicated_vram_mib).max(),
        ..Default::default()
    };
    if cfg!(target_os = "macos") {
        let (cpu, _, _) = super::apple::detect();
        p.apple_silicon = cpu.apple_silicon;
        p.rosetta = cpu.rosetta;
        p.perf_cores = cpu.perf_cores;
        p.efficiency_cores = cpu.efficiency_cores;
        if !cpu.brand.is_empty() {
            p.cpu_brand = cpu.brand;
        }
        if cpu.mem_bytes > 0 {
            p.ram_mib = cpu.mem_bytes >> 20;
        }
        p.unified_memory = cpu.apple_silicon;
        if p.unified_memory {
            p.discrete_vram_mib = None;
        }
        p.metal = snap.gpus.iter().find_map(|g| g.driver_version.clone());
        if p.rosetta {
            p.notes.push("這個 Studio 是 x86_64 版本，正透過 Rosetta 2 在 Apple Silicon 上執行：請改用 ARM64 版本（MLX／Metal 加速只在原生 ARM64 可用）".into());
        }
    }
    if let Some(v) = read_probe() {
        p.mps = v["mps"]["ok"].as_bool();
        p.mlx = v["mlx"]["ok"].as_bool();
    }
    p
}

/// Profile detected once per process (hardware does not change while Studio runs; re-detect restarts it).
pub fn cached() -> MachineProfile {
    static P: once_cell::sync::Lazy<MachineProfile> = once_cell::sync::Lazy::new(detect);
    P.clone()
}

/// Last measured accelerator probe (written by `scripts/accel_probe.py --out <cache>/accel-probe.json`).
pub fn read_probe() -> Option<Value> {
    let p = crate::util::cache_dir().join("accel-probe.json");
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// Concrete limits for one power mode. `custom` (mode "custom") may override any Budget field by camelCase name;
/// overrides are clamped to the same safety floors.
pub fn budget(p: &MachineProfile, mode: &str, custom: Option<&Value>) -> Budget {
    let mode = match mode {
        "eco" | "balanced" | "performance" | "custom" => mode,
        _ => "balanced",
    };
    let base = if mode == "custom" { "balanced" } else { mode };
    let logical = p.logical_cores.max(1);
    let mut reasons = vec![];
    // cores: leave room for the OS / UI
    let keep = match base {
        "eco" => (logical / 2).max(2),
        "performance" => 2,
        _ => (logical / 4).max(2),
    };
    let cpu_threads = logical.saturating_sub(keep).max(1);
    // memory: fixed reserve, then a fraction of the rest
    let reserve = if base == "eco" { 6144 } else { 4096 };
    let frac = match base {
        "eco" => 0.40,
        "performance" => 0.75,
        _ => 0.60,
    };
    let free_pool = p.ram_mib.saturating_sub(reserve);
    let mem_budget_mib = (free_pool as f64 * frac) as u64;
    reasons.push(format!("記憶體 {} MiB：保留 {reserve} MiB 給系統與介面，{:.0}% 給製作工作 → {mem_budget_mib} MiB", p.ram_mib, frac * 100.0));
    if p.unified_memory {
        reasons.push("Apple Silicon 統一記憶體：渲染與 AI 共用同一份預算，不另計 VRAM".into());
    }
    // render tabs: ~700 MiB of system memory per chrome-headless-shell tab at 1080p (Three.js scenes); render.mjs
    // measures and adapts below this ceiling
    const TAB_MIB: u64 = 700;
    let by_mem = (mem_budget_mib / TAB_MIB).max(1) as u32;
    // same CPU rule render.mjs has used since v0.3 (half the logical cores), so Windows limits do not change
    let by_cpu = (logical / 2).max(1);
    let (start, ceil) = match base {
        "eco" => (1, 2),
        "performance" => (3, 8),
        _ => (2, 4),
    };
    let render_max = ceil.min(by_mem).min(by_cpu).max(1);
    let render_start = start.min(render_max);
    if render_max < ceil {
        reasons.push(format!("渲染並行上限 {render_max}（受{}限制）", if by_mem < by_cpu { "記憶體" } else { "CPU 核心數" }));
    }
    // TTS batch: resident CosyVoice 3 model (~2.5 GiB fp16 on CUDA / ~5 GiB fp32 on CPU or MPS) + ~600 MiB per
    // concurrent line. Discrete GPU → VRAM decides; unified / CPU → the shared budget.
    let (pool, model) = match (p.cuda, p.discrete_vram_mib) {
        (true, Some(v)) => (v * 85 / 100, 2560),
        _ => (mem_budget_mib, 5120),
    };
    let per_line = 600;
    let max_batch = match base {
        "eco" => 1,
        "performance" => 8,
        _ => 4,
    };
    let tts_batch = (((pool.saturating_sub(model)) / per_line) as u32).clamp(1, max_batch);
    reasons.push(format!("配音批次 {tts_batch}（{}可用 {pool} MiB，模型約 {model} MiB，每句約 {per_line} MiB）", if p.cuda { "VRAM " } else { "" }));
    let mut b = Budget {
        mode: mode.into(),
        render_start,
        render_max,
        tts_batch,
        cpu_threads,
        mem_budget_mib,
        heavy_jobs: if base == "performance" && !p.unified_memory && p.discrete_vram_mib.unwrap_or(0) >= 12_000 { 2 } else { 1 },
        low_priority: base == "eco",
        reasons,
    };
    if mode == "custom" {
        if let Some(c) = custom {
            let u = |k: &str| c.get(k).and_then(|v| v.as_u64());
            if let Some(v) = u("renderMax") {
                b.render_max = (v as u32).clamp(1, 16);
            }
            if let Some(v) = u("renderStart") {
                b.render_start = (v as u32).clamp(1, b.render_max);
            }
            if let Some(v) = u("ttsBatch") {
                b.tts_batch = (v as u32).clamp(1, 16);
            }
            if let Some(v) = u("cpuThreads") {
                b.cpu_threads = (v as u32).clamp(1, logical.saturating_sub(1).max(1));
            }
            if let Some(v) = u("memBudgetMib") {
                b.mem_budget_mib = v.min(p.ram_mib.saturating_sub(2048));
            }
            if let Some(v) = c.get("lowPriority").and_then(|v| v.as_bool()) {
                b.low_priority = v;
            }
            b.reasons.push("自訂模式：已套用使用者設定（仍保留至少 1 個核心與 2 GiB 記憶體給系統）".into());
        }
    }
    b.render_start = b.render_start.min(b.render_max);
    b
}

/// Environment variables the pipeline scripts read for the active budget.
pub fn budget_env(b: &Budget) -> Vec<(String, String)> {
    vec![
        ("PIKARA_RENDER_MAX_CONC".into(), b.render_max.to_string()),
        ("PIKARA_TTS_BATCH_MAX".into(), b.tts_batch.to_string()),
        ("PIKARA_CPU_THREADS".into(), b.cpu_threads.to_string()),
        ("PIKARA_MEM_BUDGET_MIB".into(), b.mem_budget_mib.to_string()),
        ("PIKARA_LOW_PRIORITY".into(), if b.low_priority { "1" } else { "0" }.into()),
    ]
}

pub fn report() -> Value {
    let p = detect();
    let modes: Vec<Budget> = ["eco", "balanced", "performance"].iter().map(|m| budget(&p, m, None)).collect();
    json!({"profile": p, "budgets": modes, "probe": read_probe()})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m2_16() -> MachineProfile {
        MachineProfile { os: "macos".into(), arch: "aarch64".into(), logical_cores: 8, physical_cores: 8, perf_cores: Some(4), efficiency_cores: Some(4), ram_mib: 16384, unified_memory: true, apple_silicon: true, ..Default::default() }
    }
    fn rtx4050_laptop() -> MachineProfile {
        MachineProfile { os: "windows".into(), arch: "x86_64".into(), logical_cores: 16, physical_cores: 8, ram_mib: 32768, cuda: true, discrete_vram_mib: Some(6141), ..Default::default() }
    }

    #[test]
    fn unified_memory_budget_never_uses_vram_and_keeps_reserve() {
        let p = m2_16();
        for m in ["eco", "balanced", "performance"] {
            let b = budget(&p, m, None);
            assert!(b.mem_budget_mib <= 16384 - 4096, "{m}: reserve kept");
            assert!(b.cpu_threads <= 6, "{m}: at least 2 cores left");
            assert!(b.reasons.iter().any(|r| r.contains("統一記憶體")));
            assert_eq!(b.heavy_jobs, 1, "one heavy job at a time on unified memory");
        }
        let eco = budget(&p, "eco", None);
        let perf = budget(&p, "performance", None);
        assert!(eco.render_max <= perf.render_max && eco.tts_batch <= perf.tts_batch && eco.low_priority && !perf.low_priority);
        assert_eq!(eco.tts_batch, 1);
    }

    #[test]
    fn cuda_laptop_batch_follows_vram_not_ram() {
        let b = budget(&rtx4050_laptop(), "balanced", None);
        // 6141 MiB * 0.85 = 5219; minus 2560 model = 2659 / 600 = 4 lines
        assert_eq!(b.tts_batch, 4);
        assert!(b.reasons.iter().any(|r| r.contains("VRAM")));
        assert!(b.render_max >= 2);
    }

    #[test]
    fn eight_gib_mac_degrades_safely() {
        let p = MachineProfile { ram_mib: 8192, ..m2_16() };
        let b = budget(&p, "performance", None);
        assert!(b.mem_budget_mib <= 4096 && b.tts_batch == 1 && b.render_max >= 1, "{b:?}");
    }

    #[test]
    fn custom_overrides_are_clamped() {
        let c = json!({"renderMax": 99, "renderStart": 50, "cpuThreads": 999, "memBudgetMib": 1_000_000, "ttsBatch": 0});
        let b = budget(&m2_16(), "custom", Some(&c));
        assert_eq!((b.render_max, b.render_start, b.cpu_threads, b.tts_batch), (16, 16, 7, 1));
        assert_eq!(b.mem_budget_mib, 16384 - 2048);
        assert_eq!(budget(&m2_16(), "nonsense", None).mode, "balanced");
    }
}
