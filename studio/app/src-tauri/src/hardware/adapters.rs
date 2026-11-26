//! Display adapters of any vendor (NVIDIA, AMD, Intel, Apple, …).

use crate::util::run;
use once_cell::sync::OnceCell;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    pub name: String,
    /// Lower-case 4-digit PCI vendor id ("10de", "1002", "8086"), "apple", or "" when unknown.
    pub vendor_id: String,
    pub driver: String,
}

impl Adapter {
    pub fn vendor(&self) -> &'static str {
        vendor_name(&self.vendor_id)
    }
}

pub fn vendor_name(id: &str) -> &'static str {
    match id {
        "10de" => "NVIDIA",
        "1002" | "1022" => "AMD",
        "8086" => "Intel",
        "apple" | "106b" => "Apple",
        "1414" => "Microsoft",
        _ => "其他",
    }
}

fn is_virtual(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["microsoft basic", "remote display", "virtual", "parsec", "meta virtual"].iter().any(|k| n.contains(k))
}

/// Parse `Get-CimInstance Win32_VideoController | Select Name,PNPDeviceID,DriverVersion | ConvertTo-Json`
/// (a single object when there is one adapter, an array otherwise).
pub fn parse_windows_json(text: &str) -> Vec<Adapter> {
    let v: Value = match serde_json::from_str(text.trim()) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let items = match v {
        Value::Array(a) => a,
        o @ Value::Object(_) => vec![o],
        _ => vec![],
    };
    items
        .iter()
        .filter_map(|a| {
            let name = a["Name"].as_str()?.trim().to_string();
            let pnp = a["PNPDeviceID"].as_str().unwrap_or("").to_ascii_uppercase();
            let vendor_id = pnp.find("VEN_").and_then(|i| pnp.get(i + 4..i + 8)).unwrap_or("").to_ascii_lowercase();
            Some(Adapter { name, vendor_id, driver: a["DriverVersion"].as_str().unwrap_or("").to_string() })
        })
        .filter(|a| !a.name.is_empty() && !is_virtual(&a.name))
        .collect()
}

/// Parse lines "0x10de 0x28e1" from /sys/class/drm/card*/device/{vendor,device}.
pub fn parse_linux_sysfs(text: &str) -> Vec<Adapter> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let v = it.next()?.trim_start_matches("0x").to_ascii_lowercase();
            let d = it.next().unwrap_or("").trim_start_matches("0x");
            (v.len() == 4).then(|| Adapter { name: format!("{} {d}", vendor_name(&v)), vendor_id: v, driver: String::new() })
        })
        .collect()
}

fn detect_now() -> Vec<Adapter> {
    let t = Duration::from_secs(20);
    if cfg!(windows) {
        let cmd = "Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID,DriverVersion | ConvertTo-Json -Compress";
        return run("powershell", &["-NoProfile", "-NonInteractive", "-Command", cmd], None, t)
            .ok()
            .filter(|o| o.ok())
            .map(|o| parse_windows_json(&o.stdout))
            .unwrap_or_default();
    }
    if cfg!(target_os = "linux") {
        let sh = r#"for d in /sys/class/drm/card*/device; do echo "$(cat $d/vendor 2>/dev/null) $(cat $d/device 2>/dev/null)"; done | sort -u"#;
        return run("sh", &["-c", sh], None, t).ok().map(|o| parse_linux_sysfs(&o.stdout)).unwrap_or_default();
    }
    if cfg!(target_os = "macos") {
        // Apple Silicon reports a single "Apple" GPU; Intel Macs list their AMD / Intel GPUs.
        if let Some(o) = run("system_profiler", &["SPDisplaysDataType", "-json"], None, t).ok().filter(|o| o.ok()) {
            if let Ok(v) = serde_json::from_str::<Value>(&o.stdout) {
                return v["SPDisplaysDataType"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|g| {
                                let vendor = g["spdisplays_vendor"].as_str().unwrap_or("");
                                let vid = if vendor.to_ascii_lowercase().contains("apple") { "apple".into() } else {
                                    vendor.rsplit("0x").next().unwrap_or("").chars().take(4).collect::<String>().to_ascii_lowercase()
                                };
                                Adapter { name: g["sppci_model"].as_str().or(g["_name"].as_str()).unwrap_or("GPU").into(), vendor_id: vid, driver: String::new() }
                            })
                            .collect()
                    })
                    .unwrap_or_default();
            }
        }
    }
    vec![]
}

/// Adapters of this machine (detected once per process; adapters don't change while Studio runs).
pub fn detect() -> &'static [Adapter] {
    static CELL: OnceCell<Vec<Adapter>> = OnceCell::new();
    CELL.get_or_init(detect_now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_windows_hybrid_laptop() {
        // real output of this machine's Win32_VideoController (AMD iGPU + NVIDIA dGPU)
        let j = r#"[{"Name":"AMD Radeon 740M Graphics","PNPDeviceID":"PCI\\VEN_1002&DEV_1901&SUBSYS_14F41043&REV_CA\\4&98C338A&0&0041","DriverVersion":"32.0.13058.2"},{"Name":"NVIDIA GeForce RTX 4050 Laptop GPU","PNPDeviceID":"PCI\\VEN_10DE&DEV_28E1&SUBSYS_14F41043&REV_A1\\4&31F04474&0&0009","DriverVersion":"32.0.16.2101"}]"#;
        let a = parse_windows_json(j);
        assert_eq!(a.len(), 2);
        assert_eq!((a[0].vendor_id.as_str(), a[0].vendor()), ("1002", "AMD"));
        assert_eq!((a[1].vendor_id.as_str(), a[1].vendor()), ("10de", "NVIDIA"));
    }

    #[test]
    fn parses_single_intel_object_and_skips_virtual() {
        let j = r#"{"Name":"Intel(R) UHD Graphics 770","PNPDeviceID":"PCI\\VEN_8086&DEV_4680","DriverVersion":"31.0.101.4502"}"#;
        assert_eq!(parse_windows_json(j)[0].vendor(), "Intel");
        let v = r#"[{"Name":"Microsoft Basic Display Adapter","PNPDeviceID":"ROOT\\BasicDisplay","DriverVersion":"10"}]"#;
        assert!(parse_windows_json(v).is_empty());
        assert!(parse_windows_json("").is_empty());
        assert!(parse_windows_json("not json").is_empty());
    }

    #[test]
    fn parses_linux_sysfs() {
        let a = parse_linux_sysfs("0x1002 0x73bf\n0x8086 0x4680\n garbage\n");
        assert_eq!(a.iter().map(|x| x.vendor()).collect::<Vec<_>>(), vec!["AMD", "Intel"]);
    }

    #[test]
    fn detect_never_panics_on_this_machine() {
        let a = detect();
        eprintln!("{a:?}");
    }
}
