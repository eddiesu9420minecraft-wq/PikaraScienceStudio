//! Linux GPU detection without a desktop: the kernel's DRM devices in sysfs (every vendor, works over SSH and in
//! containers that mount /sys), plus `nvidia-smi` for NVIDIA VRAM / CUDA and `/dev/kfd` + `rocminfo` for AMD ROCm.
//!
//! What this decides is only *which adapters exist* and their likely role. Whether something really works is measured
//! elsewhere: encoders by a real encode (hwenc.mjs: NVENC, VA-API, libx264), WebGL by a real Chromium frame
//! (gpu-check.mjs), PyTorch backends by real tensor ops (accel_probe.py). Nothing here is assumed to work.

use super::manager::{vendor_name, Gpu, Kind};
use super::native::{CudaDevice, CudaInfo};
use std::path::Path;

/// One `/sys/class/drm/cardN` device.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DrmCard {
    pub card: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub driver: String,
    /// PCI address, e.g. "0000:01:00.0" (empty for platform devices)
    pub pci: String,
    pub render_node: Option<String>,
    pub boot_vga: bool,
    /// amdgpu / xe report VRAM in sysfs; others don't (None = unknown, never 0)
    pub vram_bytes: Option<u64>,
    pub connected_outputs: u32,
}

fn read(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

fn hex(s: Option<String>) -> u32 {
    s.and_then(|s| u32::from_str_radix(s.trim_start_matches("0x"), 16).ok()).unwrap_or(0)
}

/// Parse a sysfs tree (`root` = "/sys" normally; tests pass a fake tree).
pub fn drm_cards(root: &Path) -> Vec<DrmCard> {
    let drm = root.join("class/drm");
    let Ok(rd) = std::fs::read_dir(&drm) else { return vec![] };
    let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    names.sort();
    let mut out = vec![];
    for n in &names {
        // cardN only (cardN-HDMI-A-1 etc. are connectors)
        if !(n.starts_with("card") && n[4..].chars().all(|c| c.is_ascii_digit()) && n.len() > 4) {
            continue;
        }
        let dev = drm.join(n).join("device");
        let driver = std::fs::read_link(dev.join("driver")).ok().and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string())).unwrap_or_default();
        let pci = std::fs::canonicalize(&dev).ok().and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string())).filter(|s| s.contains(':')).unwrap_or_default();
        let render_node = std::fs::read_dir(dev.join("drm")).ok().and_then(|d| {
            let mut v: Vec<String> = d.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|s| s.starts_with("renderD")).collect();
            v.sort();
            v.into_iter().next().map(|r| format!("/dev/dri/{r}"))
        });
        let connected = names.iter().filter(|c| c.starts_with(&format!("{n}-"))).filter(|c| read(&drm.join(c).join("status")).as_deref() == Some("connected")).count() as u32;
        out.push(DrmCard {
            card: n.clone(),
            vendor_id: hex(read(&dev.join("vendor"))),
            device_id: hex(read(&dev.join("device"))),
            driver,
            pci,
            render_node,
            boot_vga: read(&dev.join("boot_vga")).as_deref() == Some("1"),
            vram_bytes: read(&dev.join("mem_info_vram_total")).and_then(|s| s.parse().ok()),
            connected_outputs: connected,
        });
    }
    out
}

/// `nvidia-smi --query-gpu=index,name,memory.total,driver_version,compute_cap,pci.bus_id --format=csv,noheader,nounits`
pub fn parse_nvidia_smi(csv: &str) -> Vec<(CudaDevice, String, String)> {
    csv.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(',').map(str::trim).collect();
            if f.len() < 6 {
                return None;
            }
            let bus = f[5].to_ascii_lowercase();
            // "00000000:01:00.0" → "0000:01:00.0" (sysfs form)
            let bus = if bus.len() > 12 { bus[bus.len() - 12..].to_string() } else { bus };
            Some((
                CudaDevice { index: f[0].parse().ok()?, name: f[1].into(), total_mem: f[2].parse::<u64>().unwrap_or(0) << 20, compute_capability: f[4].into(), luid_high: 0, luid_low: 0 },
                f[3].to_string(),
                bus,
            ))
        })
        .collect()
}

fn nvidia_smi() -> Option<String> {
    let o = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=index,name,memory.total,driver_version,compute_cap,pci.bus_id", "--format=csv,noheader,nounits"])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).to_string())
}

/// AMD ROCm compute stack present (kernel driver node + runtime answering). Presence only — whether PyTorch-ROCm runs
/// CosyVoice correctly is not assumed (see docs/COMPATIBILITY.md).
pub fn rocm_present() -> bool {
    Path::new("/dev/kfd").exists()
        && std::process::Command::new("rocminfo").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

/// Virtual / emulated display adapters (no real acceleration).
fn virtual_vendor(v: u32) -> bool {
    matches!(v, 0x1af4 | 0x1234 | 0x15ad | 0x1414 | 0x80ee | 0x1b36)
}

/// Build the adapter list from sysfs + nvidia-smi output.
pub fn gpus(cards: &[DrmCard], smi: &[(CudaDevice, String, String)], rocm: bool) -> Vec<Gpu> {
    let mut out = vec![];
    for (i, c) in cards.iter().enumerate() {
        let nv = smi.iter().find(|(_, _, bus)| !c.pci.is_empty() && bus.eq_ignore_ascii_case(&c.pci));
        let vendor = vendor_name(c.vendor_id);
        // boot / firmware framebuffers (simpledrm, efifb, vesafb) are DRM cards without any GPU behind them
        // (seen on GitHub's Ubuntu VM: card0 "simple-framebuffer", vendor 0000)
        let framebuffer = c.vendor_id == 0 || ["simple-framebuffer", "simpledrm", "efi-framebuffer", "efifb", "vesa-framebuffer", "vesafb"].contains(&c.driver.as_str());
        let (kind, kind_source) = if framebuffer {
            (Kind::Software, format!("開機畫面緩衝區（{}），不是 GPU", if c.driver.is_empty() { "無驅動" } else { &c.driver }))
        } else if virtual_vendor(c.vendor_id) || c.driver == "virtio-pci" || c.driver == "virtio_gpu" || c.driver == "vmwgfx" || c.driver == "bochs-drm" {
            (Kind::Software, format!("虛擬顯示卡（{}）", if c.driver.is_empty() { "無驅動" } else { &c.driver }))
        } else {
            match c.vendor_id {
                0x10de => (Kind::Discrete, "NVIDIA（sysfs）".to_string()),
                // Intel Arc / Data Center GPUs are discrete; everything else from Intel is integrated
                0x8086 if (c.device_id >> 8) == 0x56 || (c.device_id >> 8) == 0xe2 || (c.device_id >> 8) == 0x0b => (Kind::Discrete, "Intel Arc（裝置 ID 推測）".into()),
                0x8086 => (Kind::Integrated, "Intel 內顯（sysfs）".into()),
                0x1002 => match c.vram_bytes {
                    Some(b) if b >= 2 << 30 => (Kind::Discrete, format!("AMD 獨顯（VRAM {} MiB，mem_info_vram_total）", b >> 20)),
                    Some(b) => (Kind::Integrated, format!("AMD APU（保留 VRAM {} MiB）", b >> 20)),
                    None => (Kind::Integrated, "AMD（未回報 VRAM，推測為內顯）".into()),
                },
                _ => (Kind::Integrated, "其他（sysfs，推測）".into()),
            }
        };
        let family = match c.vendor_id {
            0x10de => Some("nvenc"),
            0x1002 | 0x8086 => Some("vaapi"),
            _ => None,
        };
        let vram_mib = nv.map(|(d, _, _)| d.total_mem >> 20).or(c.vram_bytes.map(|b| b >> 20)).unwrap_or(0);
        let mut drv = c.driver.clone();
        if let Some((_, v, _)) = nv {
            drv = format!("nvidia {v}");
        } else if c.vendor_id == 0x1002 && rocm {
            drv = format!("{drv}（ROCm 執行環境存在）");
        }
        out.push(Gpu {
            key: format!("{:04x}:{:04x}:{}#{}", c.vendor_id, c.device_id, if c.pci.is_empty() { c.card.clone() } else { c.pci.clone() }, i),
            name: nv.map(|(d, _, _)| d.name.clone()).unwrap_or_else(|| format!("{vendor} GPU {:04x}", c.device_id)),
            vendor: vendor.into(),
            vendor_id: format!("{:04x}", c.vendor_id),
            device_id: format!("{:04x}", c.device_id),
            kind,
            kind_source,
            luid: c.render_node.clone().unwrap_or_else(|| c.card.clone()),
            dedicated_vram_mib: if kind == Kind::Discrete { vram_mib } else { 0 },
            dedicated_system_mib: 0,
            shared_system_mib: if kind == Kind::Integrated { vram_mib } else { 0 },
            driver_version: (!drv.is_empty()).then_some(drv),
            d3d12: None,
            d3d12_error: None,
            cuda_index: nv.map(|(d, _, _)| d.index),
            cuda_compute: nv.map(|(d, _, _)| d.compute_capability.clone()),
            encoder_family: family.map(String::from),
            power_saving_rank: None,
            high_performance_rank: None,
            display_outputs: c.connected_outputs,
            // a bound kernel driver is the minimum for any use; nouveau has no CUDA / NVENC
            available: !c.driver.is_empty() && c.driver != "nouveau" && kind != Kind::Software,
        });
    }
    out
}

/// Full detection on this machine.
pub fn detect() -> (Vec<Gpu>, CudaInfo, Option<String>) {
    let cards = drm_cards(Path::new("/sys"));
    let smi_out = nvidia_smi();
    let smi = smi_out.as_deref().map(parse_nvidia_smi).unwrap_or_default();
    let cuda = CudaInfo {
        available: !smi.is_empty(),
        driver_version: smi.first().map(|(_, v, _)| v.clone()),
        devices: smi.iter().map(|(d, _, _)| d.clone()).collect(),
        error: if smi.is_empty() { Some(if smi_out.is_some() { "nvidia-smi 沒有列出 GPU".into() } else { "沒有 NVIDIA 驅動（找不到 nvidia-smi）".into() }) } else { None },
    };
    let gpus = gpus(&cards, &smi, rocm_present());
    let err = cards.is_empty().then(|| "/sys/class/drm 沒有任何顯示裝置（伺服器／容器）：渲染與編碼使用 CPU".to_string());
    (gpus, cuda, err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn fake_sysfs() -> std::path::PathBuf {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("pss-sysfs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mk = |card: &str, pci: &str, vendor: &str, device: &str, driver: &str, vram: Option<&str>, render: &str| {
            let pdev = root.join("devices/pci0000:00").join(pci);
            std::fs::create_dir_all(pdev.join("drm").join(render)).unwrap();
            std::fs::write(pdev.join("vendor"), vendor).unwrap();
            std::fs::write(pdev.join("device"), device).unwrap();
            if let Some(v) = vram {
                std::fs::write(pdev.join("mem_info_vram_total"), v).unwrap();
            }
            let drv = root.join("bus/pci/drivers").join(driver);
            std::fs::create_dir_all(&drv).unwrap();
            symlink(&drv, pdev.join("driver")).unwrap();
            let c = root.join("class/drm").join(card);
            std::fs::create_dir_all(&c).unwrap();
            symlink(&pdev, c.join("device")).unwrap();
        };
        mk("card0", "0000:00:02.0", "0x8086", "0xa7a0", "i915", None, "renderD128");
        mk("card1", "0000:01:00.0", "0x10de", "0x28a1", "nvidia", None, "renderD129");
        mk("card2", "0000:03:00.0", "0x1002", "0x73df", "amdgpu", Some("12868124672"), "renderD130");
        let con = root.join("class/drm/card0-eDP-1");
        std::fs::create_dir_all(&con).unwrap();
        std::fs::write(con.join("status"), "connected").unwrap();
        root
    }

    #[cfg(unix)]
    #[test]
    fn sysfs_hybrid_laptop_plus_amd() {
        let root = fake_sysfs();
        let cards = drm_cards(&root);
        assert_eq!(cards.len(), 3, "{cards:?}");
        assert_eq!(cards[0].driver, "i915");
        assert_eq!(cards[0].render_node.as_deref(), Some("/dev/dri/renderD128"));
        assert_eq!(cards[0].connected_outputs, 1);
        assert_eq!(cards[1].pci, "0000:01:00.0");
        let smi = parse_nvidia_smi("0, NVIDIA GeForce RTX 4050 Laptop GPU, 6141, 580.82, 8.9, 00000000:01:00.0\n");
        let g = gpus(&cards, &smi, false);
        assert_eq!(g[0].kind, Kind::Integrated);
        assert_eq!(g[0].encoder_family.as_deref(), Some("vaapi"));
        assert_eq!(g[1].kind, Kind::Discrete);
        assert_eq!(g[1].cuda_index, Some(0));
        assert_eq!(g[1].dedicated_vram_mib, 6141);
        assert_eq!(g[1].name, "NVIDIA GeForce RTX 4050 Laptop GPU");
        assert_eq!(g[2].kind, Kind::Discrete);
        assert_eq!(g[2].dedicated_vram_mib, 12272);
        assert!(g.iter().all(|x| x.available));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn no_drm_devices_is_a_cpu_server() {
        let cards = drm_cards(Path::new("/definitely/not/sysfs"));
        assert!(cards.is_empty());
        assert!(gpus(&cards, &[], false).is_empty());
    }

    #[test]
    fn virtual_and_nouveau_are_not_usable() {
        let cards = vec![
            DrmCard { card: "card0".into(), vendor_id: 0x1af4, device_id: 0x1050, driver: "virtio-pci".into(), ..Default::default() },
            DrmCard { card: "card1".into(), vendor_id: 0x10de, device_id: 0x1b80, driver: "nouveau".into(), pci: "0000:01:00.0".into(), ..Default::default() },
        ];
        let g = gpus(&cards, &[], false);
        assert_eq!(g[0].kind, Kind::Software);
        assert!(!g[0].available);
        assert!(!g[1].available, "nouveau: no CUDA / NVENC");
        // GitHub ubuntu-24.04 runner: card0 = simple-framebuffer, vendor 0000
        let fb = gpus(&[DrmCard { card: "card0".into(), driver: "simple-framebuffer".into(), connected_outputs: 1, ..Default::default() }], &[], false);
        assert_eq!(fb[0].kind, Kind::Software);
        assert!(!fb[0].available, "a boot framebuffer is not a GPU");
    }

    #[test]
    fn nvidia_smi_bus_id_is_normalised() {
        let v = parse_nvidia_smi("1, Tesla T4, 15360, 535.104.05, 7.5, 00000000:3B:00.0\ngarbage\n");
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].2, "0000:3b:00.0");
        assert_eq!(v[0].0.total_mem >> 20, 15360);
    }
}
