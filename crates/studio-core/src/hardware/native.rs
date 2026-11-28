//! Native Windows GPU detection — DXGI, D3D12 and the CUDA driver API. No nvidia-smi, no name matching.
//!
//! * DXGI 1.1 `EnumAdapters1`: name, PCI vendor / device / subsystem ids, LUID, dedicated VRAM, dedicated and shared
//!   system memory, software (WARP) flag; `CheckInterfaceSupport(IDXGIDevice)` gives the user-mode driver version.
//! * DXGI 1.6 `EnumAdapterByGpuPreference`: the order Windows itself uses for "power saving" and "high performance".
//! * D3D12: a device is created on every hardware adapter (proves Direct3D 12 works) and asked for its architecture —
//!   `UMA` (unified memory) is how an integrated GPU is identified, not its name or VRAM size.
//! * CUDA driver API (`nvcuda.dll`, loaded dynamically): device count, name, memory, compute capability and the LUID of
//!   every CUDA device, so a CUDA index is mapped to the exact DXGI adapter (works with several NVIDIA GPUs).
//!
//! Every call is fallible and returns a description of what failed; nothing here panics.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeAdapter {
    pub index: u32,
    pub name: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub subsys_id: u32,
    pub revision: u32,
    /// LUID as (HighPart, LowPart) — the key used by performance counters and Chromium's --use-adapter-luid
    pub luid_high: i32,
    pub luid_low: u32,
    pub dedicated_vram: u64,
    pub dedicated_system: u64,
    pub shared_system: u64,
    pub software: bool,
    pub driver_version: Option<String>,
    /// D3D12 device creation result: Some(max feature level, e.g. "12_1") or None
    pub d3d12: Option<String>,
    pub d3d12_error: Option<String>,
    /// unified memory architecture (integrated GPU) reported by D3D12
    pub uma: Option<bool>,
    /// position in Windows' minimum-power / high-performance orders (0 = first choice)
    pub power_saving_rank: Option<u32>,
    pub high_performance_rank: Option<u32>,
    /// number of display outputs (monitors) connected to this adapter — the adapter that presents to the screen
    pub outputs: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CudaDevice {
    pub index: i32,
    pub name: String,
    pub total_mem: u64,
    pub compute_capability: String,
    pub luid_high: i32,
    pub luid_low: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CudaInfo {
    pub available: bool,
    pub driver_version: Option<String>,
    pub devices: Vec<CudaDevice>,
    pub error: Option<String>,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::{Interface, PCSTR, PCWSTR};
    use windows::Win32::Graphics::Direct3D::*;
    use windows::Win32::Graphics::Direct3D12::*;
    use windows::Win32::Graphics::Dxgi::*;

    fn wstr(w: &[u16]) -> String {
        let n = w.iter().position(|&c| c == 0).unwrap_or(w.len());
        String::from_utf16_lossy(&w[..n]).trim().to_string()
    }

    fn fl_name(f: D3D_FEATURE_LEVEL) -> String {
        let v = f.0 as u32;
        format!("{}_{}", (v >> 12) & 0xF, (v >> 8) & 0xF)
    }

    fn d3d12_probe(a: &IDXGIAdapter1) -> (Option<String>, Option<bool>, Option<String>) {
        unsafe {
            let mut dev: Option<ID3D12Device> = None;
            if let Err(e) = D3D12CreateDevice(a, D3D_FEATURE_LEVEL_11_0, &mut dev) {
                return (None, None, Some(format!("{e}")));
            }
            let Some(dev) = dev else { return (None, None, Some("no device".into())) };
            let levels = [D3D_FEATURE_LEVEL_12_2, D3D_FEATURE_LEVEL_12_1, D3D_FEATURE_LEVEL_12_0, D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
            let mut fl = D3D12_FEATURE_DATA_FEATURE_LEVELS {
                NumFeatureLevels: levels.len() as u32,
                pFeatureLevelsRequested: levels.as_ptr(),
                MaxSupportedFeatureLevel: D3D_FEATURE_LEVEL_11_0,
            };
            let lvl = dev
                .CheckFeatureSupport(D3D12_FEATURE_FEATURE_LEVELS, &mut fl as *mut _ as *mut _, std::mem::size_of_val(&fl) as u32)
                .ok()
                .map(|_| fl_name(fl.MaxSupportedFeatureLevel))
                .unwrap_or_else(|| "11_0".into());
            let mut arch = D3D12_FEATURE_DATA_ARCHITECTURE::default();
            let uma = dev
                .CheckFeatureSupport(D3D12_FEATURE_ARCHITECTURE, &mut arch as *mut _ as *mut _, std::mem::size_of_val(&arch) as u32)
                .ok()
                .map(|_| arch.UMA.as_bool());
            (Some(lvl), uma, None)
        }
    }

    pub fn adapters() -> Result<Vec<NativeAdapter>, String> {
        unsafe {
            let f: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| format!("CreateDXGIFactory1：{e}"))?;
            let mut out = vec![];
            let mut i = 0u32;
            while let Ok(a) = f.EnumAdapters1(i) {
                let d = a.GetDesc1().map_err(|e| format!("GetDesc1：{e}"))?;
                let software = (d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0;
                let driver_version = a.CheckInterfaceSupport(&IDXGIDevice::IID).ok().map(|v| {
                    let v = v as u64;
                    format!("{}.{}.{}.{}", v >> 48, (v >> 32) & 0xFFFF, (v >> 16) & 0xFFFF, v & 0xFFFF)
                });
                let mut outputs = 0u32;
                while a.EnumOutputs(outputs).is_ok() {
                    outputs += 1;
                }
                let (d3d12, uma, d3d12_error) = if software { (None, None, Some("軟體轉接器".into())) } else { d3d12_probe(&a) };
                out.push(NativeAdapter {
                    index: i,
                    name: wstr(&d.Description),
                    vendor_id: d.VendorId,
                    device_id: d.DeviceId,
                    subsys_id: d.SubSysId,
                    revision: d.Revision,
                    luid_high: d.AdapterLuid.HighPart,
                    luid_low: d.AdapterLuid.LowPart,
                    dedicated_vram: d.DedicatedVideoMemory as u64,
                    dedicated_system: d.DedicatedSystemMemory as u64,
                    shared_system: d.SharedSystemMemory as u64,
                    software,
                    driver_version,
                    d3d12,
                    d3d12_error,
                    uma,
                    power_saving_rank: None,
                    high_performance_rank: None,
                    outputs,
                });
                i += 1;
            }
            // Windows' own preference orders (DXGI 1.6; absent on old systems)
            if let Ok(f6) = f.cast::<IDXGIFactory6>() {
                for (pref, slot) in [(DXGI_GPU_PREFERENCE_MINIMUM_POWER, 0), (DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, 1)] {
                    let mut k = 0u32;
                    while let Ok(a) = f6.EnumAdapterByGpuPreference::<IDXGIAdapter1>(k, pref) {
                        if let Ok(d) = a.GetDesc1() {
                            if let Some(x) = out.iter_mut().find(|x| x.luid_low == d.AdapterLuid.LowPart && x.luid_high == d.AdapterLuid.HighPart) {
                                if slot == 0 { x.power_saving_rank = Some(k) } else { x.high_performance_rank = Some(k) }
                            }
                        }
                        k += 1;
                    }
                }
            }
            Ok(out)
        }
    }

    type CuInit = unsafe extern "system" fn(u32) -> i32;
    type CuCount = unsafe extern "system" fn(*mut i32) -> i32;
    type CuGet = unsafe extern "system" fn(*mut i32, i32) -> i32;
    type CuName = unsafe extern "system" fn(*mut u8, i32, i32) -> i32;
    type CuMem = unsafe extern "system" fn(*mut usize, i32) -> i32;
    type CuLuid = unsafe extern "system" fn(*mut u8, *mut u32, i32) -> i32;
    type CuAttr = unsafe extern "system" fn(*mut i32, i32, i32) -> i32;
    type CuVer = unsafe extern "system" fn(*mut i32) -> i32;

    pub fn cuda() -> CudaInfo {
        use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
        unsafe {
            let name: Vec<u16> = "nvcuda.dll\0".encode_utf16().collect();
            let Ok(h) = LoadLibraryW(PCWSTR(name.as_ptr())) else {
                return CudaInfo { error: Some("找不到 nvcuda.dll（沒有 NVIDIA 驅動或不是 NVIDIA GPU）".into()), ..Default::default() };
            };
            macro_rules! sym {
                ($n:literal, $t:ty) => {
                    match GetProcAddress(h, PCSTR(concat!($n, "\0").as_ptr())) {
                        Some(p) => std::mem::transmute::<_, $t>(p),
                        None => return CudaInfo { error: Some(format!("nvcuda.dll 缺少 {}", $n)), ..Default::default() },
                    }
                };
            }
            let cu_init = sym!("cuInit", CuInit);
            let cu_count = sym!("cuDeviceGetCount", CuCount);
            let cu_get = sym!("cuDeviceGet", CuGet);
            let cu_name = sym!("cuDeviceGetName", CuName);
            let cu_mem = sym!("cuDeviceTotalMem_v2", CuMem);
            let cu_luid = sym!("cuDeviceGetLuid", CuLuid);
            let cu_attr = sym!("cuDeviceGetAttribute", CuAttr);
            let cu_ver = sym!("cuDriverGetVersion", CuVer);
            let r = cu_init(0);
            if r != 0 {
                return CudaInfo { error: Some(format!("cuInit 失敗（錯誤碼 {r}）")), ..Default::default() };
            }
            let mut ver = 0;
            let driver_version = (cu_ver(&mut ver) == 0).then(|| format!("{}.{}", ver / 1000, (ver % 1000) / 10));
            let mut n = 0;
            cu_count(&mut n);
            let mut devices = vec![];
            for i in 0..n {
                let mut dev = 0;
                if cu_get(&mut dev, i) != 0 {
                    continue;
                }
                let mut nm = [0u8; 256];
                cu_name(nm.as_mut_ptr(), 256, dev);
                let name = String::from_utf8_lossy(&nm[..nm.iter().position(|&c| c == 0).unwrap_or(0)]).to_string();
                let mut mem = 0usize;
                cu_mem(&mut mem, dev);
                let mut luid = [0u8; 8];
                let mut mask = 0u32;
                let (lo, hi) = if cu_luid(luid.as_mut_ptr(), &mut mask, dev) == 0 {
                    (u32::from_le_bytes([luid[0], luid[1], luid[2], luid[3]]), i32::from_le_bytes([luid[4], luid[5], luid[6], luid[7]]))
                } else {
                    (0, 0)
                };
                let (mut ma, mut mi) = (0, 0);
                cu_attr(&mut ma, 75, dev); // CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR
                cu_attr(&mut mi, 76, dev); // ..._MINOR
                devices.push(CudaDevice { index: i, name, total_mem: mem as u64, compute_capability: format!("{ma}.{mi}"), luid_high: hi, luid_low: lo });
            }
            CudaInfo { available: !devices.is_empty(), driver_version, devices, error: None }
        }
    }
}

#[cfg(windows)]
pub use imp::{adapters, cuda};

#[cfg(not(windows))]
pub fn adapters() -> Result<Vec<NativeAdapter>, String> {
    Err("DXGI 只在 Windows 上可用".into())
}
#[cfg(not(windows))]
pub fn cuda() -> CudaInfo {
    CudaInfo { error: Some("CUDA 偵測目前只支援 Windows".into()), ..Default::default() }
}
