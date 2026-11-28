//! Which GPU each process is *actually* using — Windows "GPU Engine" and "GPU Process Memory" performance counters
//! (the same data as Task Manager's GPU / GPU engine columns), read with PDH using English counter names so it works
//! on Chinese Windows. Instance names look like `pid_1234_luid_0x00000000_0x0000D0F1_phys_0_eng_3_engtype_3D`.
//!
//! This is how Studio verifies the UI / render / AI / encoder device assignment instead of trusting its own settings.

use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcGpu {
    pub pid: u32,
    pub luid: String,
    /// utilisation per engine type ("3D", "Compute_0", "Cuda", "VideoEncode", "Copy" …), percent
    pub engines: HashMap<String, f64>,
    pub dedicated_mib: f64,
    pub shared_mib: f64,
}

/// Parse a counter instance name into (pid, "high,low" luid, engine type).
pub fn parse_instance(name: &str) -> Option<(u32, String, Option<String>)> {
    let p: Vec<&str> = name.split('_').collect();
    let pid = p.iter().position(|x| *x == "pid").and_then(|i| p.get(i + 1)).and_then(|s| s.parse().ok())?;
    let li = p.iter().position(|x| *x == "luid")?;
    let hi = i64::from_str_radix(p.get(li + 1)?.trim_start_matches("0x"), 16).ok()? as i32;
    let lo = u32::from_str_radix(p.get(li + 2)?.trim_start_matches("0x"), 16).ok()?;
    let eng = p.iter().position(|x| *x == "engtype").map(|i| p[i + 1..].join("_"));
    Some((pid, format!("{hi},{lo}"), eng))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::System::Performance::*;

    fn w(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn read_array(counter: PDH_HCOUNTER) -> Vec<(String, f64)> {
        let mut size = 0u32;
        let mut count = 0u32;
        let _ = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
        if size == 0 {
            return vec![];
        }
        let mut buf = vec![0u8; size as usize];
        let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
            return vec![];
        }
        (0..count as usize)
            .filter_map(|i| {
                let it = &*items.add(i);
                let name = it.szName.to_string().ok()?;
                Some((name, it.FmtValue.Anonymous.doubleValue))
            })
            .collect()
    }

    /// Sample for `ms` milliseconds (utilisation needs two collections).
    pub fn sample(ms: u64) -> Result<Vec<ProcGpu>, String> {
        unsafe {
            let mut q = PDH_HQUERY::default();
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut q) != 0 {
                return Err("PdhOpenQuery 失敗".into());
            }
            let mut c_eng = PDH_HCOUNTER::default();
            let mut c_ded = PDH_HCOUNTER::default();
            let mut c_shr = PDH_HCOUNTER::default();
            let e1 = PdhAddEnglishCounterW(q, PCWSTR(w(r"\GPU Engine(*)\Utilization Percentage").as_ptr()), 0, &mut c_eng);
            let _ = PdhAddEnglishCounterW(q, PCWSTR(w(r"\GPU Process Memory(*)\Dedicated Usage").as_ptr()), 0, &mut c_ded);
            let _ = PdhAddEnglishCounterW(q, PCWSTR(w(r"\GPU Process Memory(*)\Shared Usage").as_ptr()), 0, &mut c_shr);
            if e1 != 0 {
                let _ = PdhCloseQuery(q);
                return Err(format!("這台電腦沒有 GPU Engine 效能計數器（0x{e1:08x}）"));
            }
            let _ = PdhCollectQueryData(q);
            std::thread::sleep(std::time::Duration::from_millis(ms.max(250)));
            let _ = PdhCollectQueryData(q);
            let eng = read_array(c_eng);
            let ded = read_array(c_ded);
            let shr = read_array(c_shr);
            let _ = PdhCloseQuery(q);
            let mut map: HashMap<(u32, String), ProcGpu> = HashMap::new();
            for (n, v) in eng {
                if let Some((pid, luid, Some(et))) = parse_instance(&n) {
                    let e = map.entry((pid, luid.clone())).or_insert_with(|| ProcGpu { pid, luid, ..Default::default() });
                    *e.engines.entry(et.split("_").next().unwrap_or(&et).to_string()).or_insert(0.0) += v;
                }
            }
            for (list, ded) in [(ded, true), (shr, false)] {
                for (n, v) in list {
                    if let Some((pid, luid, _)) = parse_instance(&n) {
                        let e = map.entry((pid, luid.clone())).or_insert_with(|| ProcGpu { pid, luid, ..Default::default() });
                        if ded { e.dedicated_mib = v / 1048576.0 } else { e.shared_mib = v / 1048576.0 }
                    }
                }
            }
            Ok(map.into_values().collect())
        }
    }
}

#[cfg(windows)]
pub use imp::sample;

#[cfg(not(windows))]
pub fn sample(_ms: u64) -> Result<Vec<ProcGpu>, String> {
    Err("GPU Engine 計數器只在 Windows 上可用".into())
}

/// Group a sample by role using the process tree: Studio's own WebView2 (UI), the renderer's Chromium, Python (AI),
/// ffmpeg (encoder). Returns per role: which adapter (LUID) carried the load and how much.
pub fn by_role(sample: &[ProcGpu], ui_root: u32) -> serde_json::Value {
    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let name_of = |pid: u32| sys.process(sysinfo::Pid::from_u32(pid)).map(|p| p.name().to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let is_desc = |pid: u32, root: u32| {
        let mut cur = Some(sysinfo::Pid::from_u32(pid));
        for _ in 0..12 {
            match cur {
                Some(c) if c.as_u32() == root => return true,
                Some(c) => cur = sys.process(c).and_then(|p| p.parent()),
                None => return false,
            }
        }
        false
    };
    let role_of = |p: &ProcGpu| -> Option<&'static str> {
        let n = name_of(p.pid);
        if n.starts_with("msedgewebview2") && is_desc(p.pid, ui_root) {
            Some("ui")
        } else if n.contains("chrome-headless-shell") || (n.starts_with("chrome") && !is_desc(p.pid, ui_root)) {
            Some("render")
        } else if n.starts_with("python") {
            Some("ai")
        } else if n.starts_with("ffmpeg") {
            Some("encoder")
        } else {
            None
        }
    };
    let mut out: HashMap<&str, HashMap<String, (f64, f64, Vec<u32>, HashMap<String, f64>)>> = HashMap::new();
    for p in sample {
        if let Some(r) = role_of(p) {
            let e = out.entry(r).or_default().entry(p.luid.clone()).or_default();
            e.0 += p.engines.values().sum::<f64>();
            e.1 += p.dedicated_mib;
            if !e.2.contains(&p.pid) {
                e.2.push(p.pid);
            }
            for (k, v) in &p.engines {
                *e.3.entry(k.clone()).or_insert(0.0) += v;
            }
        }
    }
    serde_json::json!(out
        .into_iter()
        .map(|(role, m)| (role, m.into_iter().map(|(luid, (util, ded, pids, eng))| serde_json::json!({"luid": luid, "utilPct": (util * 10.0).round() / 10.0, "dedicatedMiB": ded.round(), "pids": pids, "engines": eng})).collect::<Vec<_>>()))
        .collect::<HashMap<_, _>>())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_counter_instances() {
        let (pid, luid, eng) = parse_instance("pid_1234_luid_0x00000000_0x0000D0F1_phys_0_eng_3_engtype_3D").unwrap();
        assert_eq!((pid, luid.as_str(), eng.as_deref()), (1234, "0,53489", Some("3D")));
        let (_, _, e2) = parse_instance("pid_9_luid_0x00000001_0x00010A2B_phys_0_eng_1_engtype_VideoEncode").unwrap();
        assert_eq!(e2.as_deref(), Some("VideoEncode"));
        assert_eq!(parse_instance("pid_9_luid_0x00000000_0x00001000_phys_0").unwrap().1, "0,4096");
        assert!(parse_instance("garbage").is_none());
    }
    #[test]
    fn sampling_never_panics_on_this_machine() {
        match sample(300) {
            Ok(v) => eprintln!("{} process/adapter pairs", v.len()),
            Err(e) => eprintln!("no counters: {e}"),
        }
    }
}
