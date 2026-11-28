//! macOS hardware detection (HardwareDetectionBackend for macOS): `sysctl` + `system_profiler SPDisplaysDataType`.
//!
//! * Apple Silicon vs Intel: `hw.optional.arm64`; Rosetta 2 translation of *this* process: `sysctl.proc_translated`.
//! * CPU: brand, performance / efficiency core counts (`hw.perflevel0/1.physicalcpu`), logical cores.
//! * Memory: `hw.memsize`. On Apple Silicon this is **unified memory** shared by CPU, GPU and Neural Engine — it is
//!   never reported as GPU VRAM and no "discrete VRAM" budget is computed from it (see `profile::budget`).
//! * GPU: model, GPU core count, Metal support family (system_profiler). Intel Macs may have an AMD discrete GPU with
//!   its own VRAM (`spdisplays_vram`), which *is* reported as dedicated VRAM.
//! * VideoToolbox / MPS / MLX are **not** decided here: they are measured (real test encode, real tensor op) by
//!   `hwenc.mjs` and `scripts/accel_probe.py`.
//!
//! The parsers are pure and unit-tested on every platform; only `detect()` runs the tools (macOS only).

use super::manager::{Gpu, Kind};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppleCpu {
    pub apple_silicon: bool,
    pub rosetta: bool,
    pub brand: String,
    pub perf_cores: Option<u32>,
    pub efficiency_cores: Option<u32>,
    pub physical_cores: Option<u32>,
    pub logical_cores: Option<u32>,
    pub mem_bytes: u64,
    pub model: String,
}

/// Parse `sysctl key: value` lines (the output of `sysctl a b c`; missing keys are simply absent).
pub fn parse_sysctl(text: &str) -> HashMap<String, String> {
    text.lines().filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))).collect()
}

pub fn cpu_from_sysctl(m: &HashMap<String, String>) -> AppleCpu {
    let n = |k: &str| m.get(k).and_then(|v| v.parse::<u64>().ok());
    AppleCpu {
        apple_silicon: n("hw.optional.arm64") == Some(1),
        rosetta: n("sysctl.proc_translated") == Some(1),
        brand: m.get("machdep.cpu.brand_string").cloned().unwrap_or_default(),
        perf_cores: n("hw.perflevel0.physicalcpu").map(|x| x as u32),
        efficiency_cores: n("hw.perflevel1.physicalcpu").map(|x| x as u32),
        physical_cores: n("hw.physicalcpu").map(|x| x as u32),
        logical_cores: n("hw.logicalcpu").map(|x| x as u32),
        mem_bytes: n("hw.memsize").unwrap_or(0),
        model: m.get("hw.model").cloned().unwrap_or_default(),
    }
}

/// "16 GB" / "1536 MB" → MiB.
fn size_mib(s: &str) -> Option<u64> {
    let s = s.trim();
    let (num, unit) = s.split_once(' ')?;
    let v: f64 = num.replace(',', ".").parse().ok()?;
    Some(match unit.to_ascii_uppercase().as_str() {
        "GB" => (v * 1024.0) as u64,
        "MB" => v as u64,
        _ => return None,
    })
}

/// GPUs from `system_profiler SPDisplaysDataType -json`.
pub fn gpus_from_profiler(j: &Value, cpu: &AppleCpu) -> Vec<Gpu> {
    let mut out = vec![];
    for (i, d) in j["SPDisplaysDataType"].as_array().cloned().unwrap_or_default().iter().enumerate() {
        let name = d["sppci_model"].as_str().or(d["_name"].as_str()).unwrap_or("GPU").to_string();
        let vendor_raw = d["spdisplays_vendor"].as_str().unwrap_or("");
        let apple = vendor_raw.to_ascii_lowercase().contains("apple") || name.starts_with("Apple ");
        let vendor_id = if apple {
            "106b".to_string()
        } else {
            // "sppci_vendor_AMD" / "AMD (0x1002)" / "Intel"
            let low = vendor_raw.to_ascii_lowercase();
            if let Some(h) = low.split("0x").nth(1) {
                h.chars().take(4).collect()
            } else if low.contains("amd") || low.contains("ati") {
                "1002".into()
            } else if low.contains("intel") {
                "8086".into()
            } else if low.contains("nvidia") {
                "10de".into()
            } else {
                String::new()
            }
        };
        let vram = d["spdisplays_vram"].as_str().or(d["spdisplays_vram_shared"].as_str()).and_then(size_mib).unwrap_or(0);
        let shared = d["spdisplays_vram_shared"].is_string() || apple;
        let metal = d["spdisplays_mtlgpufamilysupport"].as_str().or(d["spdisplays_metal"].as_str()).map(|s| s.replace("spdisplays_", ""));
        let cores = d["sppci_cores"].as_str().map(String::from);
        let kind = if apple || shared { Kind::Integrated } else { Kind::Discrete };
        let kind_source = if apple && cpu.apple_silicon {
            format!("Apple Silicon 統一記憶體（{} GPU 核心）", cores.clone().unwrap_or_else(|| "?".into()))
        } else if shared {
            "共用系統記憶體（內顯）".into()
        } else {
            "獨立 VRAM（spdisplays_vram）".into()
        };
        let outputs = d["spdisplays_ndrvs"].as_array().map(|a| a.len() as u32).unwrap_or(0);
        out.push(Gpu {
            key: format!("{}:{}#{}", if vendor_id.is_empty() { "mac" } else { &vendor_id }, name.replace(' ', "-").to_ascii_lowercase(), i),
            name: name.clone(),
            vendor: if apple { "Apple".into() } else { super::manager::vendor_name(u32::from_str_radix(&vendor_id, 16).unwrap_or(0)).into() },
            vendor_id: vendor_id.clone(),
            device_id: d["spdisplays_device-id"].as_str().unwrap_or("").trim_start_matches("0x").to_string(),
            kind,
            kind_source,
            luid: format!("mac:{i}"),
            // unified memory is NOT VRAM: report 0 dedicated, the shared pool separately
            dedicated_vram_mib: if kind == Kind::Discrete { vram } else { 0 },
            dedicated_system_mib: 0,
            shared_system_mib: if kind == Kind::Integrated { if apple { cpu.mem_bytes >> 20 } else { vram } } else { 0 },
            driver_version: metal.clone(),
            d3d12: None,
            d3d12_error: None,
            cuda_index: None,
            cuda_compute: None,
            encoder_family: Some("videotoolbox".into()),
            power_saving_rank: None,
            high_performance_rank: None,
            display_outputs: outputs,
            available: metal.is_some() || apple,
        });
    }
    out
}

pub const SYSCTL_KEYS: &[&str] = &[
    "hw.optional.arm64",
    "sysctl.proc_translated",
    "machdep.cpu.brand_string",
    "hw.perflevel0.physicalcpu",
    "hw.perflevel1.physicalcpu",
    "hw.physicalcpu",
    "hw.logicalcpu",
    "hw.memsize",
    "hw.model",
];

/// Run the tools (macOS). `sysctl` prints nothing for unknown keys (Intel has no perflevel / arm64 keys) — fine.
pub fn detect() -> (AppleCpu, Vec<Gpu>, Option<String>) {
    use std::time::Duration;
    let t = Duration::from_secs(20);
    let sc = crate::util::run("/usr/sbin/sysctl", SYSCTL_KEYS, None, t).map(|o| o.stdout).unwrap_or_default();
    let cpu = cpu_from_sysctl(&parse_sysctl(&sc));
    match crate::util::run("/usr/sbin/system_profiler", &["SPDisplaysDataType", "-json"], None, t) {
        Ok(o) if o.ok() => match serde_json::from_str::<Value>(&o.stdout) {
            Ok(j) => {
                let g = gpus_from_profiler(&j, &cpu);
                (cpu, g, None)
            }
            Err(e) => (cpu, vec![], Some(format!("system_profiler 輸出無法解析：{e}"))),
        },
        Ok(o) => (cpu, vec![], Some(format!("system_profiler 失敗：{}", o.combined().trim()))),
        Err(e) => (cpu, vec![], Some(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const M2_SYSCTL: &str = "hw.optional.arm64: 1\nsysctl.proc_translated: 0\nmachdep.cpu.brand_string: Apple M2\nhw.perflevel0.physicalcpu: 4\nhw.perflevel1.physicalcpu: 4\nhw.physicalcpu: 8\nhw.logicalcpu: 8\nhw.memsize: 17179869184\nhw.model: Mac14,3\n";

    #[test]
    fn m2_mac_mini_is_apple_silicon_with_unified_memory_not_vram() {
        let cpu = cpu_from_sysctl(&parse_sysctl(M2_SYSCTL));
        assert!(cpu.apple_silicon && !cpu.rosetta);
        assert_eq!((cpu.perf_cores, cpu.efficiency_cores, cpu.mem_bytes >> 30), (Some(4), Some(4), 16));
        let j = json!({"SPDisplaysDataType": [{"_name": "Apple M2", "sppci_model": "Apple M2", "spdisplays_vendor": "sppci_vendor_Apple", "sppci_cores": "10", "spdisplays_mtlgpufamilysupport": "spdisplays_metal3", "spdisplays_ndrvs": [{"_name": "DELL"}]}]});
        let g = gpus_from_profiler(&j, &cpu);
        assert_eq!(g.len(), 1);
        assert_eq!((g[0].vendor.as_str(), g[0].kind, g[0].dedicated_vram_mib), ("Apple", Kind::Integrated, 0), "unified memory is never VRAM");
        assert_eq!(g[0].shared_system_mib, 16384);
        assert_eq!(g[0].driver_version.as_deref(), Some("metal3"));
        assert!(g[0].kind_source.contains("10 GPU"));
        assert_eq!(g[0].encoder_family.as_deref(), Some("videotoolbox"));
    }

    /// Verbatim `system_profiler SPDisplaysDataType -json` from the real Mac mini M2 (macOS 27.0.1, 2026-11-28;
    /// display identifiers trimmed) and its real `sysctl` answers.
    const REAL_M2_PROFILER: &str = r#"{"SPDisplaysDataType":[{"_name":"Apple M2","spdisplays_mtlgpufamilysupport":"spdisplays_metal4",
        "spdisplays_ndrvs":[{"_name":"P27FBB-RGGL","_spdisplays_pixels":"1920 x 1080","spdisplays_main":"spdisplays_yes",
        "spdisplays_online":"spdisplays_yes","spdisplays_resolution":"1920 x 1080 @ 60.00Hz"}],
        "spdisplays_vendor":"sppci_vendor_Apple","sppci_bus":"spdisplays_builtin","sppci_cores":"10",
        "sppci_device_type":"spdisplays_gpu","sppci_model":"Apple M2"}]}"#;

    #[test]
    fn real_mac_mini_m2_output() {
        let real_sysctl = "hw.optional.arm64: 1\nsysctl.proc_translated: 0\nhw.perflevel0.physicalcpu: 4\nhw.perflevel1.physicalcpu: 4\nhw.physicalcpu: 8\nhw.logicalcpu: 8\nhw.memsize: 17179869184\nmachdep.cpu.brand_string: Apple M2\n";
        let cpu = cpu_from_sysctl(&parse_sysctl(real_sysctl));
        assert!(cpu.apple_silicon && !cpu.rosetta);
        assert_eq!((cpu.perf_cores, cpu.efficiency_cores, cpu.logical_cores), (Some(4), Some(4), Some(8)));
        let g = gpus_from_profiler(&serde_json::from_str(REAL_M2_PROFILER).unwrap(), &cpu);
        assert_eq!(g.len(), 1);
        assert_eq!((g[0].name.as_str(), g[0].kind, g[0].dedicated_vram_mib, g[0].shared_system_mib), ("Apple M2", Kind::Integrated, 0, 16384));
        assert_eq!(g[0].driver_version.as_deref(), Some("metal4"), "macOS 27 reports Metal 4");
        assert_eq!(g[0].display_outputs, 1);
        assert!(g[0].available);
    }

    #[test]
    fn intel_mac_with_amd_dgpu_reports_real_vram_and_rosetta() {
        let cpu = cpu_from_sysctl(&parse_sysctl("machdep.cpu.brand_string: Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz\nhw.physicalcpu: 8\nhw.logicalcpu: 16\nhw.memsize: 34359738368\nsysctl.proc_translated: 0\n"));
        assert!(!cpu.apple_silicon && cpu.perf_cores.is_none());
        let j = json!({"SPDisplaysDataType": [
            {"sppci_model": "Intel UHD Graphics 630", "spdisplays_vendor": "Intel", "spdisplays_vram_shared": "1536 MB", "spdisplays_mtlgpufamilysupport": "spdisplays_metal3"},
            {"sppci_model": "AMD Radeon Pro 5500M", "spdisplays_vendor": "sppci_vendor_amd", "spdisplays_vram": "8 GB", "spdisplays_mtlgpufamilysupport": "spdisplays_metal3"}]});
        let g = gpus_from_profiler(&j, &cpu);
        assert_eq!((g[0].kind, g[0].dedicated_vram_mib, g[0].shared_system_mib), (Kind::Integrated, 0, 1536));
        assert_eq!((g[1].kind, g[1].dedicated_vram_mib, g[1].vendor.as_str()), (Kind::Discrete, 8192, "AMD"));
        let r = cpu_from_sysctl(&parse_sysctl("sysctl.proc_translated: 1\nhw.optional.arm64: 1\n"));
        assert!(r.rosetta && r.apple_silicon, "x64 build under Rosetta on Apple Silicon");
    }
}
