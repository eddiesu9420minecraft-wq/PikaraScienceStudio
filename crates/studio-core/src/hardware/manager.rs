//! HardwareManager — one snapshot of the machine's GPUs, built from native APIs, cached for the session and
//! re-detectable on demand. Every other module asks the manager (and the [`super::selector`]) instead of probing
//! hardware itself.
//!
//! Sources, in order of trust:
//! 1. DXGI / D3D12 / CUDA driver API ([`super::native`]) — what exists, how much memory, integrated or discrete,
//!    Direct3D 12 working, driver version, CUDA devices mapped to adapters by LUID.
//! 2. Windows device manager (Win32_VideoController via CIM) — adapters that are **disabled or failing** (DXGI does not
//!    list them) and their ConfigManager error code; matched to DXGI adapters by PCI vendor/device id.
//! 3. ffmpeg test encodes ([`super::encoders`], only when already measured — never started from here) — which
//!    hardware encoders actually work.
//!
//! Detection runs in a separate thread with a time limit; a failure gives a snapshot with `error` set and the
//! software / CPU fallback, so Studio always starts.

use super::native::{self, CudaInfo, NativeAdapter};
use crate::util::now_iso;
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Integrated,
    Discrete,
    External,
    Software,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    /// stable across reboots: "<vendor>:<device>:<subsys>#<n>" (n = occurrence of identical cards)
    pub key: String,
    pub name: String,
    pub vendor: String,
    pub vendor_id: String,
    pub device_id: String,
    pub kind: Kind,
    /// how `kind` was decided ("D3D12 UMA", "D3D12 非 UMA", "DXGI 軟體旗標", "裝置移除原則"…)
    pub kind_source: String,
    pub luid: String,
    pub dedicated_vram_mib: u64,
    pub dedicated_system_mib: u64,
    pub shared_system_mib: u64,
    pub driver_version: Option<String>,
    pub d3d12: Option<String>,
    pub d3d12_error: Option<String>,
    pub cuda_index: Option<i32>,
    pub cuda_compute: Option<String>,
    /// hardware encoder families this vendor can provide (whether each works is measured separately)
    pub encoder_family: Option<String>,
    pub power_saving_rank: Option<u32>,
    pub high_performance_rank: Option<u32>,
    /// monitors connected to this adapter (it presents the desktop; other adapters' windows are copied to it)
    pub display_outputs: u32,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DisabledGpu {
    pub name: String,
    pub vendor_id: String,
    pub device_id: String,
    pub status: String,
    pub error_code: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub detected_at: String,
    pub source: String,
    pub gpus: Vec<Gpu>,
    pub disabled: Vec<DisabledGpu>,
    pub cuda: CudaInfo,
    pub encoders: Value,
    pub error: Option<String>,
}

pub fn vendor_name(id: u32) -> &'static str {
    match id {
        0x10de => "NVIDIA",
        0x1002 | 0x1022 => "AMD",
        0x8086 => "Intel",
        0x1414 => "Microsoft",
        0x106b => "Apple",
        0x5143 => "Qualcomm",
        _ => "其他",
    }
}

fn encoder_family(vendor_id: u32) -> Option<&'static str> {
    match vendor_id {
        0x10de => Some("nvenc"),
        0x1002 | 0x1022 => Some("amf"),
        0x8086 => Some("qsv"),
        _ => None,
    }
}

/// Classify: software flag → Software; D3D12 UMA → Integrated; D3D12 non-UMA → Discrete; no D3D12 answer →
/// fall back to "no dedicated VRAM beyond 512 MiB and listed first by Windows' power-saving order" (marked as 推測).
pub fn classify(a: &NativeAdapter) -> (Kind, String) {
    if a.software {
        return (Kind::Software, "DXGI 軟體旗標".into());
    }
    match a.uma {
        Some(true) => (Kind::Integrated, "D3D12 回報統一記憶體（UMA）".into()),
        Some(false) => (Kind::Discrete, "D3D12 回報獨立記憶體（非 UMA）".into()),
        None => {
            if a.dedicated_vram <= 512 * 1024 * 1024 && a.power_saving_rank == Some(0) {
                (Kind::Integrated, "推測：D3D12 不可用，專用記憶體 ≤ 512 MiB 且為省電首選".into())
            } else {
                (Kind::Discrete, "推測：D3D12 不可用，依專用記憶體判斷".into())
            }
        }
    }
}

/// Build the snapshot from raw native results (pure; unit-tested with mock hardware).
pub fn build(native: Result<Vec<NativeAdapter>, String>, cuda: CudaInfo, pnp: Vec<DisabledGpu>, external_ids: &[(String, String)], encoders: Value) -> Snapshot {
    let mut gpus = vec![];
    let mut error = None;
    match native {
        Ok(list) => {
            let mut seen: std::collections::HashMap<String, u32> = Default::default();
            for a in list {
                let base = format!("{:04x}:{:04x}:{:08x}", a.vendor_id, a.device_id, a.subsys_id);
                let n = seen.entry(base.clone()).or_insert(0);
                let key = format!("{base}#{n}");
                *n += 1;
                let (mut kind, mut src) = classify(&a);
                let vid = format!("{:04x}", a.vendor_id);
                let did = format!("{:04x}", a.device_id);
                if kind == Kind::Discrete && external_ids.iter().any(|(v, d)| *v == vid && *d == did) {
                    kind = Kind::External;
                    src = "裝置移除原則：可熱插拔（外接）".into();
                }
                let cuda_dev = cuda.devices.iter().find(|c| c.luid_high == a.luid_high && c.luid_low == a.luid_low && (c.luid_low != 0 || c.luid_high != 0));
                gpus.push(Gpu {
                    key,
                    name: a.name.clone(),
                    vendor: vendor_name(a.vendor_id).into(),
                    vendor_id: vid,
                    device_id: did,
                    kind,
                    kind_source: src,
                    luid: format!("{},{}", a.luid_high, a.luid_low),
                    dedicated_vram_mib: a.dedicated_vram >> 20,
                    dedicated_system_mib: a.dedicated_system >> 20,
                    shared_system_mib: a.shared_system >> 20,
                    driver_version: a.driver_version.clone(),
                    d3d12: a.d3d12.clone(),
                    d3d12_error: a.d3d12_error.clone(),
                    cuda_index: cuda_dev.map(|c| c.index),
                    cuda_compute: cuda_dev.map(|c| c.compute_capability.clone()),
                    encoder_family: if a.software { None } else { encoder_family(a.vendor_id).map(String::from) },
                    power_saving_rank: a.power_saving_rank,
                    high_performance_rank: a.high_performance_rank,
                    display_outputs: a.outputs,
                    available: a.software || a.d3d12.is_some() || a.d3d12_error.is_none(),
                });
            }
        }
        Err(e) => error = Some(e),
    }
    Snapshot { detected_at: now_iso(), source: "DXGI 1.6 + D3D12 + CUDA driver API".into(), gpus, disabled: pnp, cuda, encoders, error }
}

/// Disabled / failing adapters and hot-pluggable (external) ones from the Windows device manager. Best effort.
fn pnp_status() -> (Vec<DisabledGpu>, Vec<(String, String)>) {
    if !cfg!(windows) {
        return (vec![], vec![]);
    }
    let ps = "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_VideoController | ForEach-Object { $rp = (Get-PnpDeviceProperty -InstanceId $_.PNPDeviceID -KeyName 'DEVPKEY_Device_RemovalPolicy').Data; [pscustomobject]@{ Name=$_.Name; Pnp=$_.PNPDeviceID; Err=$_.ConfigManagerErrorCode; Status=$_.Status; Removal=$rp } } | ConvertTo-Json -Compress";
    let out = crate::util::run("powershell", &["-NoProfile", "-NonInteractive", "-Command", ps], None, Duration::from_secs(25)).ok().filter(|o| o.ok()).map(|o| o.stdout).unwrap_or_default();
    parse_pnp(&out)
}

pub fn parse_pnp(text: &str) -> (Vec<DisabledGpu>, Vec<(String, String)>) {
    let v: Value = serde_json::from_str(text.trim()).unwrap_or(Value::Null);
    let items = match v {
        Value::Array(a) => a,
        o @ Value::Object(_) => vec![o],
        _ => vec![],
    };
    let mut disabled = vec![];
    let mut external = vec![];
    for it in items {
        let pnp = it["Pnp"].as_str().unwrap_or("").to_ascii_uppercase();
        let vid = pnp.find("VEN_").and_then(|i| pnp.get(i + 4..i + 8)).unwrap_or("").to_ascii_lowercase();
        let did = pnp.find("DEV_").and_then(|i| pnp.get(i + 4..i + 8)).unwrap_or("").to_ascii_lowercase();
        let code = it["Err"].as_i64().unwrap_or(0);
        // removal policy 3 = expect surprise removal (Thunderbolt / USB4 eGPU). Internal hybrid-laptop dGPUs report 2
        // (orderly, for power gating) — measured on an RTX 4050 Laptop — so 2 is NOT treated as external.
        if it["Removal"].as_i64() == Some(3) {
            external.push((vid.clone(), did.clone()));
        }
        if code != 0 {
            let status = match code {
                22 => "已停用".to_string(),
                43 => "驅動回報錯誤（代碼 43）".to_string(),
                45 => "目前未連接".to_string(),
                c => format!("裝置管理員錯誤代碼 {c}"),
            };
            disabled.push(DisabledGpu { name: it["Name"].as_str().unwrap_or("").into(), vendor_id: vid, device_id: did, status, error_code: code });
        }
    }
    (disabled, external)
}

fn detect_now() -> Snapshot {
    if cfg!(target_os = "macos") {
        let (cpu, gpus, error) = super::apple::detect();
        let src = if cpu.apple_silicon { "sysctl + system_profiler（Apple Silicon，統一記憶體）" } else { "sysctl + system_profiler（Intel Mac）" };
        return Snapshot {
            detected_at: now_iso(),
            source: src.into(),
            gpus,
            disabled: vec![],
            cuda: CudaInfo { error: Some("macOS 沒有 CUDA（Apple GPU 使用 Metal／MPS／MLX）".into()), ..Default::default() },
            encoders: Value::Null,
            error,
        };
    }
    if !cfg!(windows) {
        // Linux (also headless / SSH / containers): kernel DRM devices in sysfs + nvidia-smi + ROCm runtime presence
        let (gpus, cuda, error) = super::linux::detect();
        return Snapshot { detected_at: now_iso(), source: "Linux sysfs（/sys/class/drm）＋ nvidia-smi".into(), gpus, disabled: vec![], cuda, encoders: Value::Null, error };
    }
    // DXGI / D3D12 / CUDA on a worker thread with a time limit: a hung driver must not block Studio's start
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let r = std::panic::catch_unwind(|| (native::adapters(), native::cuda()));
        let _ = tx.send(r);
    });
    let (nat, cuda) = match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => (Err("GPU 偵測時發生內部錯誤（已攔截）".to_string()), CudaInfo::default()),
        Err(_) => (Err("GPU 偵測超過 15 秒沒有回應（驅動可能異常），改用軟體／CPU 模式".to_string()), CudaInfo::default()),
    };
    let (disabled, external) = pnp_status();
    let enc = Value::Null; // filled per project from the measured encoder cache (encoder_cache)
    build(nat, cuda, disabled, &external, enc)
}

static SNAP: Lazy<Mutex<Option<Snapshot>>> = Lazy::new(|| Mutex::new(None));

/// The cached snapshot (detected on first use).
pub fn snapshot() -> Snapshot {
    let mut g = SNAP.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        *g = Some(detect_now());
    }
    g.clone().unwrap()
}

/// Detect again (user pressed 重新偵測硬體, or a device was added / removed).
pub fn redetect() -> Snapshot {
    let s = detect_now();
    *SNAP.lock().unwrap_or_else(|e| e.into_inner()) = Some(s.clone());
    s
}

/// Fast path for the UI window (needed before the WebView starts): DXGI only, no device manager query.
pub fn quick_adapters() -> Vec<NativeAdapter> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(std::panic::catch_unwind(native::adapters));
    });
    match rx.recv_timeout(Duration::from_secs(4)) {
        Ok(Ok(Ok(v))) => v,
        _ => vec![],
    }
}

#[cfg(test)]
pub mod mock {
    //! Mock hardware for selector / scheduler tests. **Not real-machine verification.**
    use super::*;
    pub fn adapter(index: u32, name: &str, vendor: u32, device: u32, vram_mib: u64, uma: Option<bool>, luid_low: u32) -> NativeAdapter {
        NativeAdapter {
            index,
            name: name.into(),
            vendor_id: vendor,
            device_id: device,
            subsys_id: 0x1234,
            revision: 0,
            luid_high: 0,
            luid_low,
            dedicated_vram: vram_mib << 20,
            dedicated_system: 0,
            shared_system: 8192 << 20,
            software: false,
            driver_version: Some("32.0.0.1".into()),
            d3d12: Some("12_1".into()),
            d3d12_error: None,
            uma,
            power_saving_rank: Some(index),
            high_performance_rank: None,
            outputs: 0,
        }
    }
    pub fn warp(index: u32) -> NativeAdapter {
        NativeAdapter { software: true, d3d12: None, uma: None, ..adapter(index, "Microsoft Basic Render Driver", 0x1414, 0x8c, 0, None, 9999) }
    }
    pub fn cuda_for(devs: &[(i32, &NativeAdapter, u64)]) -> CudaInfo {
        CudaInfo {
            available: !devs.is_empty(),
            driver_version: Some("12.6".into()),
            devices: devs.iter().map(|(i, a, m)| native::CudaDevice { index: *i, name: a.name.clone(), total_mem: m << 20, compute_capability: "8.9".into(), luid_high: a.luid_high, luid_low: a.luid_low }).collect(),
            error: None,
        }
    }
}

/// Measured hardware-encoder results of a project (render.mjs / doctor test encodes, `out/hwenc-cache.json`).
pub fn encoder_cache(root: &std::path::Path) -> Value {
    std::fs::read_to_string(root.join("out").join("hwenc-cache.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pnp_status_disabled_and_external() {
        // real values of this laptop (RTX 4050 internal: removal 2) + mock disabled card + mock Thunderbolt eGPU
        let j = r#"[{"Name":"AMD Radeon 740M Graphics","Pnp":"PCI\\VEN_1002&DEV_1901&SUBSYS_14F41043","Err":0,"Removal":1},
                    {"Name":"NVIDIA GeForce RTX 4050 Laptop GPU","Pnp":"PCI\\VEN_10DE&DEV_28E1&SUBSYS_14F41043","Err":0,"Removal":2},
                    {"Name":"Mock disabled","Pnp":"PCI\\VEN_8086&DEV_56A0","Err":22,"Removal":1},
                    {"Name":"Mock eGPU","Pnp":"PCI\\VEN_10DE&DEV_2684","Err":0,"Removal":3}]"#;
        let (dis, ext) = parse_pnp(j);
        assert_eq!(dis.len(), 1);
        assert_eq!(dis[0].status, "已停用");
        assert_eq!(ext, vec![("10de".to_string(), "2684".to_string())], "internal dGPU (removal 2) is not external");
    }
}
