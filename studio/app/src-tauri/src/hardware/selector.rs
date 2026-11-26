//! DeviceSelector — which device does each role use. Pure function of (hardware snapshot, preferences), so every
//! hardware combination is testable with mock snapshots.
//!
//! Roles: `ui` (Studio's WebView2), `render` (Remotion / Three.js in Chromium, ANGLE D3D11), `ai` (CosyVoice /
//! Whisper, CUDA), `encoder` (ffmpeg video encoder).
//!
//! Automatic rules (each decision carries a human-readable reason; a manual choice that is impossible falls back to
//! the automatic one and says why):
//! * UI: an integrated GPU when there is also another GPU (keeps the discrete GPU free for rendering); one GPU → that
//!   GPU; several discrete and no integrated → the discrete GPU the renderer does not use; nothing usable → software.
//! * AI: the CUDA device with the most memory; no CUDA → CPU (this project's TTS has no DirectML / ROCm path).
//! * Render: the discrete GPU with the most dedicated VRAM; with two or more discrete GPUs, one that AI does not use
//!   (≥ 2 GiB VRAM) so both can run at once; only integrated → integrated; nothing usable → CPU (SwiftShader).
//! * Encoder: the render GPU's family (NVENC / AMF / Quick Sync) when the measured test encode works; otherwise the
//!   first measured working one; nothing measured → "auto" (render.mjs measures and falls back to libx264 itself).

use super::manager::{Gpu, Kind, Snapshot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HwPrefs {
    /// "auto" | "integrated" | "discrete" | "gpu:<key>"
    pub ui_gpu: String,
    /// "auto" | "integrated" | "discrete" | "gpu:<key>" | "cpu"
    pub render_gpu: String,
    /// "auto" | "cpu" | "gpu:<key>" (CUDA device)
    pub ai_device: String,
    /// "auto" | an encoder id from scripts/hw_encoders.json (h264_nvenc, h264_amf, h264_qsv, libx264 …)
    pub encoder: String,
    /// render VRAM ceiling in % of the render GPU's dedicated VRAM (render.mjs --vram-cap) and scheduler guard
    pub gpu_mem_limit_pct: u32,
}

impl Default for HwPrefs {
    fn default() -> Self {
        HwPrefs { ui_gpu: "auto".into(), render_gpu: "auto".into(), ai_device: "auto".into(), encoder: "auto".into(), gpu_mem_limit_pct: 85 }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub role: String,
    /// "gpu" | "software" | "cpu"
    pub target: String,
    pub gpu_key: Option<String>,
    pub gpu_name: Option<String>,
    pub luid: Option<String>,
    pub cuda_index: Option<i32>,
    pub reason: String,
    /// set when the preference could not be honoured
    pub fallback: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub ui: Choice,
    pub render: Choice,
    pub ai: Choice,
    pub encoder: Value,
    pub mem_limit_pct: u32,
    /// render.mjs VRAM cap in MiB (None = render.mjs default)
    pub render_vram_cap_mib: Option<u64>,
}

fn usable(s: &Snapshot) -> Vec<&Gpu> {
    s.gpus.iter().filter(|g| g.kind != Kind::Software && g.available).collect()
}

fn pick(role: &str, g: &Gpu, reason: impl Into<String>) -> Choice {
    Choice { role: role.into(), target: "gpu".into(), gpu_key: Some(g.key.clone()), gpu_name: Some(g.name.clone()), luid: Some(g.luid.clone()), cuda_index: g.cuda_index, reason: reason.into(), fallback: None }
}

fn none(role: &str, target: &str, reason: impl Into<String>) -> Choice {
    Choice { role: role.into(), target: target.into(), gpu_key: None, gpu_name: None, luid: None, cuda_index: None, reason: reason.into(), fallback: None }
}

fn by_pref<'a>(gs: &[&'a Gpu], pref: &str) -> Option<&'a Gpu> {
    pref.strip_prefix("gpu:").and_then(|k| gs.iter().find(|g| g.key == k).copied())
}

fn integrated<'a>(gs: &[&'a Gpu]) -> Option<&'a Gpu> {
    gs.iter().filter(|g| g.kind == Kind::Integrated).min_by_key(|g| g.power_saving_rank.unwrap_or(99)).copied()
}

fn best_discrete<'a>(gs: &[&'a Gpu], exclude: Option<&str>) -> Option<&'a Gpu> {
    gs.iter().filter(|g| matches!(g.kind, Kind::Discrete | Kind::External) && Some(g.key.as_str()) != exclude).max_by_key(|g| g.dedicated_vram_mib).copied()
}

fn ai_choice(s: &Snapshot, gs: &[&Gpu], pref: &str) -> Choice {
    let cuda: Vec<&Gpu> = gs.iter().filter(|g| g.cuda_index.is_some()).copied().collect();
    let auto = || match cuda.iter().max_by_key(|g| g.dedicated_vram_mib) {
        Some(g) => pick("ai", g, format!("CUDA 裝置 {}（{} MiB）", g.cuda_index.unwrap_or(0), g.dedicated_vram_mib)),
        None => none("ai", "cpu", s.cuda.error.clone().map(|e| format!("沒有可用的 CUDA：{e}；使用 CPU（較慢）")).unwrap_or_else(|| "沒有可用的 CUDA，使用 CPU（較慢）".into())),
    };
    match pref {
        "cpu" => none("ai", "cpu", "設定：使用 CPU"),
        "auto" | "" => auto(),
        p => match by_pref(gs, p) {
            Some(g) if g.cuda_index.is_some() => pick("ai", g, "設定指定的 CUDA 裝置"),
            Some(g) => Choice { fallback: Some(format!("{} 不支援 CUDA，改用自動選擇", g.name)), ..auto() },
            None => Choice { fallback: Some("設定的裝置已不存在（被停用或移除），改用自動選擇".into()), ..auto() },
        },
    }
}

fn render_choice(gs: &[&Gpu], pref: &str, ai: &Choice) -> Choice {
    let auto = || {
        let ai_key = ai.gpu_key.as_deref();
        let n_discrete = gs.iter().filter(|g| matches!(g.kind, Kind::Discrete | Kind::External)).count();
        if n_discrete >= 2 {
            if let Some(g) = best_discrete(gs, ai_key).filter(|g| g.dedicated_vram_mib >= 2048) {
                return pick("render", g, format!("另一張獨顯（{} MiB），與 AI 推理分開，可同時進行", g.dedicated_vram_mib));
            }
        }
        if let Some(g) = best_discrete(gs, None) {
            return pick("render", g, format!("專用記憶體最多的獨顯（{} MiB）", g.dedicated_vram_mib));
        }
        if let Some(g) = integrated(gs) {
            return pick("render", g, "只有內顯，正式渲染使用內顯（較慢）");
        }
        none("render", "cpu", "沒有可用的 GPU，使用 CPU 軟體渲染（SwiftShader，很慢）")
    };
    match pref {
        "auto" | "" => auto(),
        "cpu" => none("render", "cpu", "設定：CPU 軟體渲染"),
        "integrated" => integrated(gs).map(|g| pick("render", g, "設定：內顯")).unwrap_or_else(|| Choice { fallback: Some("沒有可用的內顯，改用自動選擇".into()), ..auto() }),
        "discrete" => best_discrete(gs, None).map(|g| pick("render", g, "設定：獨顯")).unwrap_or_else(|| Choice { fallback: Some("沒有可用的獨顯，改用自動選擇".into()), ..auto() }),
        p => by_pref(gs, p).map(|g| pick("render", g, "設定指定的 GPU")).unwrap_or_else(|| Choice { fallback: Some("設定的 GPU 已不存在（被停用或移除），改用自動選擇".into()), ..auto() }),
    }
}

fn ui_choice(gs: &[&Gpu], pref: &str, render: &Choice) -> Choice {
    let auto = || {
        let others = gs.len();
        if let Some(g) = integrated(gs).filter(|_| others >= 2) {
            return pick("ui", g, "內顯負責介面，獨顯留給渲染與 AI");
        }
        if gs.len() == 1 {
            return pick("ui", gs[0], "只有一張 GPU，介面與渲染共用（由排程器限制競爭）");
        }
        if let Some(g) = gs.iter().filter(|g| Some(g.key.as_str()) != render.gpu_key.as_deref()).min_by_key(|g| g.dedicated_vram_mib) {
            return pick("ui", g, "沒有內顯：介面使用渲染沒有用到的 GPU");
        }
        none("ui", "software", "沒有可用的 GPU，介面使用軟體繪製（WARP）")
    };
    match pref {
        "auto" | "" => auto(),
        "integrated" => integrated(gs).map(|g| pick("ui", g, "設定：內顯")).unwrap_or_else(|| Choice { fallback: Some("沒有可用的內顯，改用自動選擇".into()), ..auto() }),
        "discrete" => best_discrete(gs, None).map(|g| pick("ui", g, "設定：獨顯")).unwrap_or_else(|| Choice { fallback: Some("沒有可用的獨顯，改用自動選擇".into()), ..auto() }),
        p => by_pref(gs, p).map(|g| pick("ui", g, "設定指定的 GPU")).unwrap_or_else(|| Choice { fallback: Some("設定的 GPU 已不存在（被停用或移除），改用自動選擇".into()), ..auto() }),
    }
}

fn family_encoder(family: &str) -> &'static str {
    match family {
        "nvenc" => "h264_nvenc",
        "amf" => "h264_amf",
        "qsv" => "h264_qsv",
        _ => "libx264",
    }
}

/// Measured working encoders from the project's encoder cache (`{"results": {"h264_nvenc": {"works": true}, …}}`).
fn measured(s: &Snapshot) -> Option<Vec<(String, bool)>> {
    let r = s.encoders.get("results")?.as_object()?;
    Some(r.iter().map(|(k, v)| (k.clone(), v["works"].as_bool().unwrap_or(false))).collect())
}

fn encoder_choice(s: &Snapshot, gs: &[&Gpu], pref: &str, render: &Choice) -> Value {
    let fam = render.gpu_key.as_ref().and_then(|k| gs.iter().find(|g| &g.key == k)).and_then(|g| g.encoder_family.clone());
    let want = fam.as_deref().map(family_encoder);
    let m = measured(s);
    let works = |id: &str| m.as_ref().and_then(|m| m.iter().find(|(k, _)| k == id).map(|(_, w)| *w));
    let auto = || -> Value {
        match (want, &m) {
            (Some(w), Some(_)) if works(w) == Some(true) => json!({"encoder": w, "reason": format!("渲染 GPU 的硬體編碼器（實測可用）")}),
            (_, Some(list)) => match list.iter().find(|(k, ok)| *ok && k.as_str() != "libx264") {
                Some((k, _)) => json!({"encoder": k, "reason": "渲染 GPU 的編碼器不可用，改用其他實測可用的硬體編碼器"}),
                None => json!({"encoder": "libx264", "reason": "沒有實測可用的硬體編碼器，使用 CPU（libx264）"}),
            },
            (Some(w), None) => json!({"encoder": "auto", "preferred": w, "reason": "尚未實測編碼器：渲染時會實際試編碼並自動降級"}),
            (None, None) => json!({"encoder": "auto", "reason": "尚未實測編碼器：渲染時會實際試編碼並自動降級"}),
        }
    };
    match pref {
        "auto" | "" => auto(),
        "libx264" => json!({"encoder": "libx264", "reason": "設定：CPU 編碼"}),
        p => match works(p) {
            Some(true) => json!({"encoder": p, "reason": "設定（實測可用）"}),
            Some(false) => { let mut a = auto(); a["fallback"] = json!(format!("{p} 實測不可用，改用自動選擇")); a }
            None if gs.iter().any(|g| g.encoder_family.as_deref().map(family_encoder) == Some(p)) => json!({"encoder": p, "reason": "設定（尚未實測；渲染時失敗會自動降級）"}),
            None => { let mut a = auto(); a["fallback"] = json!(format!("這台電腦沒有支援 {p} 的 GPU，改用自動選擇")); a }
        },
    }
}

pub fn select(s: &Snapshot, p: &HwPrefs) -> Assignment {
    let gs = usable(s);
    let ai = ai_choice(s, &gs, &p.ai_device);
    let render = render_choice(&gs, &p.render_gpu, &ai);
    let ui = ui_choice(&gs, &p.ui_gpu, &render);
    let encoder = encoder_choice(s, &gs, &p.encoder, &render);
    let pct = p.gpu_mem_limit_pct.clamp(30, 100);
    let cap = render.gpu_key.as_ref().and_then(|k| gs.iter().find(|g| &g.key == k)).filter(|g| g.dedicated_vram_mib >= 1024).map(|g| g.dedicated_vram_mib * pct as u64 / 100);
    Assignment { ui, render, ai, encoder, mem_limit_pct: pct, render_vram_cap_mib: cap }
}

/// Options for the settings page, generated from the detected hardware only.
pub fn options(s: &Snapshot) -> Value {
    let gs = usable(s);
    let gpu_opts = |filter: &dyn Fn(&Gpu) -> bool| -> Vec<Value> {
        gs.iter().filter(|g| filter(g)).map(|g| json!({"value": format!("gpu:{}", g.key), "label": format!("{}（{}，{} MiB）", g.name, kind_label(g.kind), g.dedicated_vram_mib)})).collect()
    };
    let has_i = gs.iter().any(|g| g.kind == Kind::Integrated);
    let has_d = gs.iter().any(|g| matches!(g.kind, Kind::Discrete | Kind::External));
    let mut ui = vec![json!({"value": "auto", "label": "自動（建議）"})];
    if has_i { ui.push(json!({"value": "integrated", "label": "內顯"})); }
    if has_d { ui.push(json!({"value": "discrete", "label": "獨顯"})); }
    ui.extend(gpu_opts(&|_| true));
    let mut render = ui.clone();
    render.push(json!({"value": "cpu", "label": "CPU 軟體渲染（很慢）"}));
    let mut ai = vec![json!({"value": "auto", "label": "自動（建議）"})];
    ai.extend(gpu_opts(&|g| g.cuda_index.is_some()));
    ai.push(json!({"value": "cpu", "label": "CPU（較慢）"}));
    let mut enc = vec![json!({"value": "auto", "label": "自動（依渲染 GPU，實測後降級）"})];
    let measured = measured(s);
    let mut fams: Vec<String> = gs.iter().filter_map(|g| g.encoder_family.clone()).collect();
    fams.sort();
    fams.dedup();
    for f in fams {
        let id = family_encoder(&f);
        let state = measured.as_ref().and_then(|m| m.iter().find(|(k, _)| k == id).map(|(_, w)| *w));
        if state == Some(false) {
            continue; // measured and not working: do not offer it
        }
        enc.push(json!({"value": id, "label": format!("{}{}", id, if state == Some(true) { "（實測可用）" } else { "（尚未實測）" })}));
    }
    enc.push(json!({"value": "libx264", "label": "CPU（libx264）"}));
    json!({"ui": ui, "render": render, "ai": ai, "encoder": enc})
}

pub fn kind_label(k: Kind) -> &'static str {
    match k {
        Kind::Integrated => "內顯",
        Kind::Discrete => "獨顯",
        Kind::External => "外接",
        Kind::Software => "軟體",
    }
}

#[cfg(test)]
mod tests {
    //! Mock hardware combinations (no real-machine claim): the selector's decisions for each.
    use super::super::manager::{build, mock::*};
    use super::*;

    fn snap(adapters: Vec<super::super::native::NativeAdapter>, cuda: Vec<(i32, usize, u64)>) -> Snapshot {
        let c: Vec<(i32, &super::super::native::NativeAdapter, u64)> = cuda.iter().map(|(i, k, m)| (*i, &adapters[*k], *m)).collect();
        let ci = cuda_for(&c);
        build(Ok(adapters.clone()), ci, vec![], &[], Value::Null)
    }
    fn names(a: &Assignment) -> (Option<String>, Option<String>, String, Option<String>) {
        (a.ui.gpu_name.clone(), a.render.gpu_name.clone(), a.ai.target.clone(), a.ai.gpu_name.clone())
    }
    const P: fn() -> HwPrefs = HwPrefs::default;

    #[test]
    fn intel_igpu_only() {
        let s = snap(vec![adapter(0, "Intel UHD 770", 0x8086, 0x4680, 128, Some(true), 1), warp(1)], vec![]);
        let a = select(&s, &P());
        assert_eq!(names(&a), (Some("Intel UHD 770".into()), Some("Intel UHD 770".into()), "cpu".into(), None));
        assert!(a.ui.reason.contains("只有一張"));
        assert_eq!(a.encoder["preferred"], "h264_qsv");
    }
    #[test]
    fn amd_igpu_only() {
        let s = snap(vec![adapter(0, "AMD Radeon 780M", 0x1002, 0x15bf, 512, Some(true), 1)], vec![]);
        let a = select(&s, &P());
        assert_eq!(a.render.gpu_name.as_deref(), Some("AMD Radeon 780M"));
        assert_eq!(a.ai.target, "cpu");
        assert_eq!(a.encoder["preferred"], "h264_amf");
    }
    #[test]
    fn nvidia_dgpu_only() {
        let g = adapter(0, "RTX 4070", 0x10de, 0x2786, 12282, Some(false), 1);
        let s = snap(vec![g], vec![(0, 0, 12282)]);
        let a = select(&s, &P());
        assert_eq!(names(&a), (Some("RTX 4070".into()), Some("RTX 4070".into()), "gpu".into(), Some("RTX 4070".into())));
        assert_eq!(a.ai.cuda_index, Some(0));
    }
    #[test]
    fn amd_dgpu_only_has_no_cuda() {
        let s = snap(vec![adapter(0, "RX 7800 XT", 0x1002, 0x747e, 16368, Some(false), 1)], vec![]);
        let a = select(&s, &P());
        assert_eq!(a.render.gpu_name.as_deref(), Some("RX 7800 XT"));
        assert_eq!(a.ai.target, "cpu");
    }
    #[test]
    fn intel_plus_nvidia() {
        let s = snap(vec![adapter(0, "Intel Iris Xe", 0x8086, 0x9a49, 128, Some(true), 1), adapter(1, "RTX 3060 Laptop", 0x10de, 0x2560, 6144, Some(false), 2)], vec![(0, 1, 6144)]);
        let a = select(&s, &P());
        assert_eq!(names(&a), (Some("Intel Iris Xe".into()), Some("RTX 3060 Laptop".into()), "gpu".into(), Some("RTX 3060 Laptop".into())));
    }
    #[test]
    fn amd_plus_nvidia_like_this_laptop_and_manual_overrides() {
        let s = snap(vec![adapter(0, "AMD Radeon 740M", 0x1002, 0x1901, 512, Some(true), 1), adapter(1, "RTX 4050 Laptop", 0x10de, 0x28e1, 6000, Some(false), 2)], vec![(0, 1, 6141)]);
        let a = select(&s, &P());
        assert_eq!(names(&a), (Some("AMD Radeon 740M".into()), Some("RTX 4050 Laptop".into()), "gpu".into(), Some("RTX 4050 Laptop".into())));
        assert_eq!(a.render_vram_cap_mib, Some(6000 * 85 / 100));
        // manual: UI on the discrete GPU, AI on CPU, render on the iGPU
        let p = HwPrefs { ui_gpu: "discrete".into(), render_gpu: "integrated".into(), ai_device: "cpu".into(), ..P() };
        let b = select(&s, &p);
        assert_eq!((b.ui.gpu_name.as_deref(), b.render.gpu_name.as_deref(), b.ai.target.as_str()), (Some("RTX 4050 Laptop"), Some("AMD Radeon 740M"), "cpu"));
        // a removed card chosen in settings falls back with a reason; never crashes
        let c = select(&s, &HwPrefs { render_gpu: "gpu:10de:9999:00001234#0".into(), ..P() });
        assert_eq!(c.render.gpu_name.as_deref(), Some("RTX 4050 Laptop"));
        assert!(c.render.fallback.as_deref().unwrap().contains("不存在"));
        // AI pinned to a non-CUDA GPU falls back
        let d = select(&s, &HwPrefs { ai_device: format!("gpu:{}", s.gpus[0].key), ..P() });
        assert!(d.ai.fallback.is_some() && d.ai.cuda_index == Some(0));
    }
    #[test]
    fn amd_plus_amd() {
        let s = snap(vec![adapter(0, "Radeon 680M", 0x1002, 0x1681, 512, Some(true), 1), adapter(1, "RX 6800M", 0x1002, 0x73df, 12272, Some(false), 2)], vec![]);
        let a = select(&s, &P());
        assert_eq!((a.ui.gpu_name.as_deref(), a.render.gpu_name.as_deref(), a.ai.target.as_str()), (Some("Radeon 680M"), Some("RX 6800M"), "cpu"));
    }
    #[test]
    fn two_nvidia_split_ai_and_render() {
        let s = snap(vec![adapter(0, "RTX 4090", 0x10de, 0x2684, 24564, Some(false), 1), adapter(1, "RTX 3060", 0x10de, 0x2504, 12288, Some(false), 2)], vec![(0, 0, 24564), (1, 1, 12288)]);
        let a = select(&s, &P());
        assert_eq!(a.ai.gpu_name.as_deref(), Some("RTX 4090"), "AI on the largest CUDA device");
        assert_eq!(a.render.gpu_name.as_deref(), Some("RTX 3060"), "render on the other card so both run at once");
        assert_eq!(a.ui.gpu_name.as_deref(), Some("RTX 4090"), "no iGPU: UI on the GPU the renderer does not use");
        // two identical cards get distinct keys
        let t = snap(vec![adapter(0, "RTX 3090", 0x10de, 0x2204, 24576, Some(false), 1), adapter(1, "RTX 3090", 0x10de, 0x2204, 24576, Some(false), 2)], vec![(0, 0, 24576), (1, 1, 24576)]);
        assert_ne!(t.gpus[0].key, t.gpus[1].key);
        let b = select(&t, &P());
        assert_ne!(b.ai.gpu_key, b.render.gpu_key);
    }
    #[test]
    fn intel_arc_discrete() {
        let s = snap(vec![adapter(0, "Intel UHD 770", 0x8086, 0x4680, 128, Some(true), 1), adapter(1, "Intel Arc A770", 0x8086, 0x56a0, 16032, Some(false), 2)], vec![]);
        let a = select(&s, &P());
        assert_eq!((a.ui.gpu_name.as_deref(), a.render.gpu_name.as_deref(), a.ai.target.as_str()), (Some("Intel UHD 770"), Some("Intel Arc A770"), "cpu"));
        assert_eq!(a.encoder["preferred"], "h264_qsv");
    }
    #[test]
    fn no_hardware_acceleration() {
        let s = snap(vec![warp(0)], vec![]);
        let a = select(&s, &P());
        assert_eq!((a.ui.target.as_str(), a.render.target.as_str(), a.ai.target.as_str()), ("software", "cpu", "cpu"));
        let o = options(&s);
        assert_eq!(o["ui"].as_array().unwrap().len(), 1, "only 自動 offered — no non-existent devices");
        // detection failure (driver hang) → same safe fallback
        let f = build(Err("GPU 偵測超過 15 秒沒有回應".into()), Default::default(), vec![], &[], Value::Null);
        assert_eq!(select(&f, &P()).render.target, "cpu");
    }
    #[test]
    fn options_only_list_detected_and_working_devices() {
        let mut s = snap(vec![adapter(0, "AMD Radeon 740M", 0x1002, 0x1901, 512, Some(true), 1), adapter(1, "RTX 4050 Laptop", 0x10de, 0x28e1, 6000, Some(false), 2)], vec![(0, 1, 6141)]);
        s.encoders = json!({"results": {"h264_nvenc": {"works": true}, "h264_amf": {"works": false}}});
        let o = options(&s);
        let enc: Vec<&str> = o["encoder"].as_array().unwrap().iter().map(|x| x["value"].as_str().unwrap()).collect();
        assert_eq!(enc, vec!["auto", "h264_nvenc", "libx264"], "AMF measured broken → not offered; no QSV on this machine");
        let ai: Vec<&str> = o["ai"].as_array().unwrap().iter().map(|x| x["value"].as_str().unwrap()).collect();
        assert_eq!(ai.len(), 3, "auto + the one CUDA GPU + cpu: {ai:?}");
        assert_eq!(select(&s, &P()).encoder["encoder"], "h264_nvenc");
        // disabled card: not usable
        s.gpus[1].available = false;
        assert_eq!(select(&s, &P()).render.gpu_name.as_deref(), Some("AMD Radeon 740M"));
    }
}

/// The assignment for the current settings (cached hardware snapshot).
pub fn current(s: &crate::db::Settings) -> Assignment {
    select(&super::manager::snapshot(), &s.hw)
}

/// Environment for job steps: how the scripts learn which devices to use.
/// render.mjs / gpu-check.mjs: PIKARA_RENDER_TARGET, PIKARA_RENDER_GPU_LUID (Chromium --use-adapter-luid), PIKARA_VRAM_CAP,
/// PIKARA_ENCODER. CosyVoice / Whisper (PyTorch): CUDA_VISIBLE_DEVICES (empty = no CUDA → the scripts' CPU path).
pub fn job_env(a: &Assignment) -> Vec<(String, String)> {
    let mut v = vec![("PIKARA_RENDER_TARGET".to_string(), a.render.target.clone()), ("PIKARA_AI_DEVICE".into(), a.ai.target.clone())];
    if let (Some(l), Some(n)) = (&a.render.luid, &a.render.gpu_name) {
        v.push(("PIKARA_RENDER_GPU_LUID".into(), l.clone()));
        v.push(("PIKARA_RENDER_GPU_NAME".into(), n.clone()));
    }
    if let Some(c) = a.render_vram_cap_mib {
        v.push(("PIKARA_VRAM_CAP".into(), c.to_string()));
    }
    if let Some(e) = a.encoder["encoder"].as_str().filter(|e| *e != "auto") {
        v.push(("PIKARA_ENCODER".into(), e.to_string()));
    }
    v.push(("CUDA_VISIBLE_DEVICES".into(), a.ai.cuda_index.map(|i| i.to_string()).unwrap_or_default()));
    v
}

/// Everything the settings / diagnostics pages show (one call).
pub fn info(s: &crate::db::Settings, project_root: Option<&std::path::Path>, fresh: bool) -> Value {
    let mut snap = if fresh { super::manager::redetect() } else { super::manager::snapshot() };
    if let Some(r) = project_root {
        snap.encoders = super::manager::encoder_cache(r);
    }
    let a = select(&snap, &s.hw);
    json!({"snapshot": snap, "assignment": a, "options": options(&snap), "prefs": s.hw, "uiLaunch": super::launch::ui_launch(),
           "lease": crate::gpulock::status()})
}

/// Measured GPU usage per role (UI = WebView2 under `ui_root`), with adapter names.
pub fn usage(ms: u64, ui_root: u32) -> Value {
    let snap = super::manager::snapshot();
    let names: serde_json::Map<String, Value> = snap.gpus.iter().map(|g| (g.luid.clone(), json!(g.name))).collect();
    match super::usage::sample(ms) {
        Ok(v) => {
            let mut per_adapter: std::collections::HashMap<String, (f64, f64)> = Default::default();
            for p in &v {
                let e = per_adapter.entry(p.luid.clone()).or_default();
                e.0 += p.engines.values().sum::<f64>();
                e.1 += p.dedicated_mib;
            }
            json!({"ok": true, "sampleMs": ms, "roles": super::usage::by_role(&v, ui_root), "adapters": names,
                   "perAdapter": per_adapter.into_iter().map(|(l, (u, d))| json!({"luid": l, "name": names.get(&l), "utilPct": (u * 10.0).round() / 10.0, "dedicatedMiB": d.round()})).collect::<Vec<_>>()})
        }
        Err(e) => json!({"ok": false, "error": e, "adapters": names}),
    }
}

/// Adapters a job kind uses (ResourceScheduler lease keys): render kinds → the render GPU, voice kinds → the AI GPU,
/// Bilibili (voice + render) → both. CPU targets add nothing (the job then takes the cpu-heavy lease).
pub fn job_adapters(kind: &str, a: &Assignment) -> Vec<String> {
    let render = || a.render.gpu_key.clone();
    let ai = || a.ai.gpu_key.clone();
    let mut v: Vec<String> = match kind {
        "voiceover_tw" | "voiceover_cn" | "revoice" => ai().into_iter().collect(),
        "bilibili" => ai().into_iter().chain(render()).collect(),
        _ => render().into_iter().collect(),
    };
    v.sort();
    v.dedup();
    v
}
