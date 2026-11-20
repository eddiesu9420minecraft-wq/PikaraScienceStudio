//! Resource monitor: CPU/RAM via sysinfo, GPU via nvidia-smi. Real values only.

use crate::gpu::{self, ExternalGpu, GpuSample};
use serde::Serialize;
use std::sync::Mutex;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub usage: f64,
    pub cores: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RamInfo {
    #[serde(rename = "usedMiB")]
    pub used_mib: u64,
    #[serde(rename = "totalMiB")]
    pub total_mib: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSample {
    pub ts: i64,
    pub cpu: CpuInfo,
    pub ram: RamInfo,
    pub gpu: Option<GpuSample>,
    pub external: ExternalGpu,
}

pub struct Monitor {
    sys: Mutex<System>,
}

impl Default for Monitor {
    fn default() -> Self {
        Self::new()
    }
}

impl Monitor {
    pub fn new() -> Self {
        let mut sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
                .with_memory(MemoryRefreshKind::nothing().with_ram()),
        );
        sys.refresh_cpu_usage();
        Monitor { sys: Mutex::new(sys) }
    }

    /// CPU% is measured between consecutive calls; the first call waits the minimum interval.
    pub fn cpu_ram(&self) -> (CpuInfo, RamInfo) {
        let mut sys = self.sys.lock().unwrap();
        sys.refresh_cpu_usage();
        if sys.global_cpu_usage() == 0.0 {
            std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
            sys.refresh_cpu_usage();
        }
        sys.refresh_memory();
        (
            CpuInfo { usage: (sys.global_cpu_usage() as f64 * 10.0).round() / 10.0, cores: sys.cpus().len() },
            RamInfo { used_mib: sys.used_memory() / 1_048_576, total_mib: sys.total_memory() / 1_048_576 },
        )
    }

    pub fn sample(&self, external: impl FnOnce(Option<&GpuSample>) -> ExternalGpu) -> MonitorSample {
        let (cpu, ram) = self.cpu_ram();
        let g = gpu::query();
        let ext = external(g.as_ref());
        MonitorSample { ts: crate::util::now_ms(), cpu, ram, gpu: g, external: ext }
    }
}
