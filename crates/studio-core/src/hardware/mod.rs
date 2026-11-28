//! Hardware capability detection. Three separate capabilities, detected separately:
//!
// * [`adapters`] — which display adapters exist (any vendor; PCI vendor id, name, driver). Used for reporting and to
//!   decide the *order* in which encoders are tested — never to decide whether something works.
// * [`encoders`] — which ffmpeg video encoders actually work: listed by `ffmpeg -encoders` **and** a short real test
//!   encode with the exact arguments render.mjs uses (NVENC / AMF / QSV / VideoToolbox / VA-API / Media Foundation,
//!   libx264 CPU fallback everywhere). The candidate table is `scripts/hw_encoders.json`, shared with render.mjs.
// * [`telemetry`] — NVIDIA-only live samples via nvidia-smi (VRAM, temperature, NVENC load). Other vendors have no
//!   telemetry; callers treat `None` as "unknown", never as an error.
//!
//! WebGL (Three.js / Remotion rendering) is a fourth, independent capability; it is measured by
//! `scripts/gpu-check.mjs` by rendering a probe frame in Chromium.
//!
//! Nothing here panics on missing drivers or tools: every probe returns a result describing the failure.

pub mod adapters;
pub mod apple;
pub mod linux;
pub mod profile;
pub mod encoders;
pub mod telemetry;
//
// v0.3 hardware layer (one place for all GPU decisions):
// * [`native`]   DXGI / D3D12 / CUDA driver API detection (no nvidia-smi, no name matching)
// * [`manager`]  HardwareManager: cached snapshot, classification, disabled / external devices, re-detect
// * [`selector`] DeviceSelector: UI / render / AI / encoder device per hardware + preferences, with fallbacks
// * [`usage`]    verification: per-process, per-adapter GPU Engine counters (what each process really uses)
// * the ResourceScheduler is [`crate::gpulock`] (one lease per adapter, machine-wide)

pub mod launch;
pub mod manager;
pub mod native;
pub mod selector;
pub mod usage;
