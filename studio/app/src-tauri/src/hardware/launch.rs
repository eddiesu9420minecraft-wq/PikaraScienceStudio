//! UI GPU at launch. WebView2 (Chromium) chooses its adapter when its browser process starts, so the choice is made
//! before the window is created: DXGI only (fast, time-limited), then the DeviceSelector's `ui` rule, then
//! `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` for *this process's* WebView2 only.
//!
//! Nothing system-wide is changed: no registry GPU preference, no driver setting, no disabled adapter. Hardware
//! acceleration stays on — the UI is moved to another GPU, not to software rendering. If anything fails the UI starts
//! with Chromium's own default adapter and the reason is shown in Diagnostics.

use super::manager;
use super::selector;
use once_cell::sync::OnceCell;
use serde_json::{json, Value};

/// Tauri / wry's own default WebView2 arguments (kept when we add ours).
const TAURI_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

static UI_LAUNCH: OnceCell<Value> = OnceCell::new();

/// The UI GPU decision of this launch (for Diagnostics).
pub fn ui_launch() -> Value {
    UI_LAUNCH.get().cloned().unwrap_or(json!({"applied": false, "reason": "尚未決定"}))
}

/// Chromium `--use-adapter-luid` value. Measured on this project's hybrid laptop (HARDWARE.md §驗證).
pub fn luid_arg(luid: &str) -> Option<String> {
    let mut it = luid.split(',');
    let hi: i64 = it.next()?.trim().parse().ok()?;
    let lo: i64 = it.next()?.trim().parse().ok()?;
    Some(match std::env::var("PIKARA_ADAPTER_LUID_FORMAT").as_deref() {
        Ok("hex") => format!("0x{:x},0x{:x}", hi as u32, lo as u32),
        _ => format!("{hi},{lo}"),
    })
}

pub fn prepare_ui(settings: &crate::db::Settings) -> Value {
    // escape hatch for diagnostics / A-B measurements: start WebView2 with Chromium's own adapter choice
    if std::env::var("PIKARA_UI_GPU_SELECT").as_deref() == Ok("0") {
        let v = json!({"applied": false, "reason": "PIKARA_UI_GPU_SELECT=0：使用 WebView2 預設 GPU"});
        let _ = UI_LAUNCH.set(v.clone());
        return v;
    }
    let r = std::panic::catch_unwind(|| {
        let adapters = manager::quick_adapters();
        let snap = manager::build(Ok(adapters), Default::default(), vec![], &[], Value::Null);
        let a = selector::select(&snap, &settings.hw);
        let ui = a.ui.clone();
        let user_args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok();
        let mut applied = false;
        if let (Some(l), "gpu") = (ui.luid.as_deref(), ui.target.as_str()) {
            if let Some(v) = luid_arg(l) {
                let mut args = user_args.clone().unwrap_or_else(|| TAURI_DEFAULT_ARGS.to_string());
                if !args.contains("--use-adapter-luid") {
                    args.push_str(&format!(" --use-adapter-luid={v}"));
                    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", &args);
                    applied = true;
                }
            }
        }
        json!({"applied": applied, "choice": ui, "adapters": snap.gpus.iter().map(|g| json!({"name": g.name, "luid": g.luid, "kind": g.kind})).collect::<Vec<_>>(),
               "args": std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok()})
    });
    let v = r.unwrap_or_else(|_| json!({"applied": false, "reason": "介面 GPU 選擇時發生內部錯誤（已攔截），使用 WebView2 預設 GPU"}));
    let _ = UI_LAUNCH.set(v.clone());
    v
}
