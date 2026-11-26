//! v0.3 re-voice / re-render planning and single-line script edits.
//!
//! `plan` answers, before anything runs: which stages will run, which caches are reused (voice, frames, timeline),
//! the estimated time / VRAM (from the last real render report of the same output), and which files will be
//! created or kept. It never changes project files: the timeline is computed with `build_timeline.py --out`
//! into `.studio/plan/` and the frame reuse with `render.mjs --plan` (no bundle, no render, no encode).

use crate::db::Settings;
use crate::pipeline::{self, Ep};
use crate::util::{clean_path, run_env};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

fn read_json(p: &Path) -> Option<Value> {
    let t = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()
}

fn node(s: &Settings) -> String {
    let n = Path::new(&s.node_dir).join("node.exe");
    if n.exists() { n.to_string_lossy().into() } else { "node".into() }
}

/// Timeline of an episode without the fields that do not affect pixels (mix path, warnings, tempo report).
fn tl_core(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(o) = v.as_object_mut() {
        for k in ["mix", "warnings", "voiceTempo"] {
            o.remove(k);
        }
    }
    v
}

pub fn plan(c: &Connection, ep: &Ep, p: &Value, s: &Settings) -> Result<Value, String> {
    let mode = p["mode"].as_str().unwrap_or("affected");
    let fps = p["fps"].as_u64().unwrap_or(30);
    let res = p["res"].as_str().unwrap_or("1080p");
    let quality = p["quality"].as_str().unwrap_or("standard");
    let ws = pipeline::workspace(c, ep, s)?;
    let stage = |id: &str| ws["stages"].as_array().and_then(|a| a.iter().find(|x| x["id"] == id).cloned()).unwrap_or(Value::Null);
    let voice = stage("voice");
    let pending_voice: Vec<String> = voice["lines"].as_array().map(|a| a.iter().filter(|l| l["state"] != "ok").filter_map(|l| l["id"].as_str().map(String::from)).collect()).unwrap_or_default();

    // 1) dry-run timeline (does not touch timeline.generated.json / SRT)
    let plan_dir = ep.root.join(".studio").join("plan");
    let _ = std::fs::create_dir_all(&plan_dir);
    let dry = plan_dir.join(format!("{}-{}.timeline.json", ep.id, ep.locale));
    let tempo = crate::jobs::voice_tempo_preset(s.voice_tempo).to_string();
    let mut ta: Vec<String> = vec!["-3.11".into(), "-u".into(), "scripts/build_timeline.py".into(), "--seq".into(), ep.id.clone(), "--out".into(), clean_path(&dry)];
    if ep.cn() {
        ta.extend(["--src".into(), "src_cn".into(), "--voice-dir".into(), "public/assets/audio/voiceover_cosy_cn".into()]);
    }
    let tr: Vec<&str> = ta.iter().map(|s| s.as_str()).collect();
    let mut warnings: Vec<String> = vec![];
    let dry_ok = match run_env("py", &tr, Some(&ep.root), &[("PYTHONUTF8", "1"), ("PIKARA_VOICE_TEMPO", &tempo)], Duration::from_secs(180)) {
        Ok(o) if o.ok() => true,
        Ok(o) => {
            warnings.push(format!("試算時間軸失敗：{}", crate::util::tail_lines(&o.combined(), 3)));
            false
        }
        Err(e) => {
            warnings.push(format!("試算時間軸失敗：{e}"));
            false
        }
    };
    let cur_tl = read_json(&ep.timeline_path()).and_then(|t| t.get(&ep.id).cloned());
    let new_tl = if dry_ok { read_json(&dry).and_then(|t| t.get(&ep.id).cloned()) } else { None };
    let timeline_changes = match (&cur_tl, &new_tl) {
        (Some(a), Some(b)) => tl_core(a) != tl_core(b),
        (None, _) => true,
        _ => false,
    };

    // 2) frame reuse from render.mjs --plan (against the timeline the render will actually use)
    let comp = if fps == 60 { ep.upper() } else { format!("{}-30fps", ep.upper()) };
    let mut ra: Vec<String> = vec!["scripts/render.mjs".into(), if res == "720p" { "preview".into() } else { "gpu".into() }, "--comp".into(), comp.clone(), "--quality".into(), quality.into(), "--plan".into()];
    if ep.cn() {
        ra.extend(["--src".into(), "src_cn".into()]);
    }
    if mode != "remux" && dry_ok {
        ra.extend(["--timeline".into(), clean_path(&dry)]);
    }
    let rr: Vec<&str> = ra.iter().map(|s| s.as_str()).collect();
    let mut frames = Value::Null;
    match run_env(&node(s), &rr, Some(&ep.root), &[], Duration::from_secs(120)) {
        Ok(o) => {
            if let Some(l) = o.stdout.lines().find(|l| l.starts_with("PLAN_JSON ")) {
                frames = serde_json::from_str(&l["PLAN_JSON ".len()..]).unwrap_or(Value::Null);
            } else {
                warnings.push(format!("無法試算畫面沿用：{}", crate::util::tail_lines(&o.combined(), 3)));
            }
        }
        Err(e) => warnings.push(format!("無法試算畫面沿用：{e}")),
    }
    let total = frames["totalFrames"].as_u64().unwrap_or(0);
    let cached = if mode == "full" { 0 } else { frames["cachedFrames"].as_u64().unwrap_or(0) };
    let to_render = total.saturating_sub(cached);

    // 3) estimate from the last real render of the same output (out/reports/<tag>.json)
    let tag = frames["tag"].as_str().unwrap_or("").to_string();
    let rep = read_json(&ep.root.join("out").join("reports").join(format!("{tag}.json")));
    let (rfps, enc_fps, vram) = match &rep {
        Some(r) => {
            let rendered: f64 = r["chunks"].as_array().map(|a| a.iter().map(|c| c["z"].as_f64().unwrap_or(0.0) - c["a"].as_f64().unwrap_or(0.0) + 1.0).sum()).unwrap_or(0.0);
            let rs = r["seconds"]["render"].as_f64().unwrap_or(0.0);
            let es = r["seconds"]["encode"].as_f64().unwrap_or(0.0);
            let fr = r["frames"].as_f64().unwrap_or(0.0);
            (if rs > 1.0 && rendered > 0.0 { rendered / rs } else { 8.0 }, if es > 0.5 && fr > 0.0 { fr / es } else { 150.0 }, r["render"]["vramPeakMiB"].as_f64())
        }
        None => (8.0, 150.0, None),
    };
    let est_render = to_render as f64 / rfps.max(0.5);
    let est_encode = total as f64 / enc_fps.max(1.0);
    let est_mix = 20.0 + total as f64 / fps as f64 * 0.15;
    let est_tl = if mode == "remux" { 0.0 } else { 15.0 };
    let est = est_render + est_encode + est_mix + est_tl + 30.0;

    // 4) what runs / what is reused
    let mut run = vec![];
    if mode != "remux" {
        run.push(json!({"stage": "timeline", "title": "字幕與時間軸", "why": if timeline_changes { "配音或腳本改變，時間軸會更新" } else { "重新建立（內容不變）" }}));
    }
    run.push(json!({"stage": "mix", "title": "音訊混合", "why": "依目前時間軸與配音重新混音"}));
    run.push(json!({"stage": "render", "title": "畫面渲染", "why": match mode { "full" => format!("完整重新渲染 {total} 幀"), _ if to_render == 0 => "全部畫面沿用".to_string(), _ => format!("渲染 {to_render} 幀（沿用 {cached} 幀）") }}));
    run.push(json!({"stage": "encode", "title": "影片編碼", "why": format!("{} · {} · {} fps · 品質 {}", p["encoder"].as_str().unwrap_or("auto"), res, fps, quality)}));
    if p["qa"].as_bool().unwrap_or(true) {
        run.push(json!({"stage": "qa", "title": "品質檢查", "why": "切換前檢查新影片"}));
    }
    let reuse = vec![
        json!({"what": "研究資料與腳本", "detail": "不重新研究、不重寫腳本"}),
        json!({"what": "配音", "detail": format!("{} 句全部沿用（不重新合成）", voice["lines"].as_array().map(|a| a.len()).unwrap_or(0))}),
        json!({"what": "已渲染畫面", "detail": if mode == "full" { "不沿用（完整重新渲染）".to_string() } else { format!("{cached}/{total} 幀") }}),
    ];
    let mut blockers = vec![];
    if mode == "remux" && timeline_changes {
        blockers.push("配音或腳本改變後時間軸會變動：「僅重新混音和封裝」會讓畫面與聲音不同步，請改用「重新渲染受影響片段」".to_string());
    }
    if !pending_voice.is_empty() {
        warnings.push(format!("{} 句配音缺少或文字已改（{}），請先重新配音；否則新影片仍會用舊的聲音", pending_voice.len(), pending_voice.iter().take(6).cloned().collect::<Vec<_>>().join("、")));
    }
    let target = ep.output_target();
    Ok(json!({
        "episode": ep.id, "locale": ep.locale, "mode": mode, "comp": comp,
        "run": run, "reuse": reuse, "frames": frames, "timelineChanges": timeline_changes,
        "estimate": {"seconds": est.round(), "renderFps": (rfps * 10.0).round() / 10.0, "vramPeakMiB": vram, "basedOn": if rep.is_some() { format!("上次渲染報告 out/reports/{tag}.json") } else { "沒有渲染報告，使用保守預設值".into() }},
        "newFiles": [
            {"path": clean_path(&target), "note": "新影片（取代目前的成品）"},
            {"path": clean_path(&ep.video_dir().join("output").join("versions")), "note": "舊影片保留在這裡（硬連結，不佔額外空間）"},
            {"path": clean_path(&ep.mix_path()), "note": "混音（覆寫，可重建）"},
        ],
        "blockers": blockers, "warnings": warnings, "pendingVoice": pending_voice,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Project lifecycle through the backend the UI uses: register (open) → create an episode → workspace →
    /// edit one line (validated, committed) → close (unregister: files stay).
    #[test]
    fn project_create_open_edit_close() {
        let d = std::env::temp_dir().join(format!("pss-v03 專案 {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("src").join("data")).unwrap();
        std::fs::write(d.join("src").join("data").join("narration.json"), "{\n  \"fps\": 60,\n  \"defaults\": {\"leadIn\": 0.5, \"pauseAfter\": 0.35, \"sceneGap\": 1.2, \"tail\": 1.5},\n  \"sequences\": {}\n}\n").unwrap();
        crate::gitops::git(&d, &["init", "-q"]).unwrap();
        crate::gitops::git(&d, &["add", "."]).unwrap();
        crate::gitops::git_commit(&d, &["commit", "-qm", "init"]).unwrap();
        let db: crate::db::Db = Arc::new(Mutex::new(crate::db::open_memory().unwrap()));
        let p = crate::register_project(&db, &d.to_string_lossy()).unwrap();
        let root = std::path::PathBuf::from(&p.root_path);
        let r = crate::create_episode(&root, "測試集", None, Some("開場"), Some("第一句旁白。"), None).unwrap();
        assert_eq!(r["episodeId"], "ep01");
        let ep = Ep::new(&root, "ep01", "zh-TW").unwrap();
        let c = db.lock().unwrap();
        let s = crate::db::settings_get(&c);
        let ws = pipeline::workspace(&c, &ep, &s).unwrap();
        let ids: Vec<&str> = ws["stages"].as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["research", "script", "storyboard", "voice", "timeline", "animation", "mix", "video", "qa"]);
        let voice = ws["stages"].as_array().unwrap().iter().find(|x| x["id"] == "voice").unwrap();
        assert_eq!(voice["status"], "missing");
        drop(c);
        let e = line_set(&root, "zh-TW", "ep01", "ep01-01", Some("改過的第一句。"), None).unwrap();
        assert_eq!(e["changed"], true);
        assert!(e["commit"].is_string(), "{e}");
        assert!(line_set(&root, "zh-TW", "ep01", "ep01-99", Some("x"), None).is_err());
        assert!(line_set(&root, "zh-TW", "ep01", "ep01-01", Some("  "), None).is_err(), "empty subtitle refused");
        crate::db::project_remove(&db.lock().unwrap(), &p.id).unwrap();
        assert!(crate::db::project_list(&db.lock().unwrap()).unwrap().is_empty());
        assert!(root.join("src").join("data").join("narration.json").exists(), "closing a project never deletes files");
        let _ = std::fs::remove_dir_all(&d);
    }
}

/// Change one line's text (subtitle and/or the spoken text) in narration.json: validated, atomic write, git commit
/// of that file only. Other lines, other episodes and the other language are untouched.
pub fn line_set(root: &Path, locale: &str, ep: &str, line: &str, subtitle: Option<&str>, speak: Option<&str>) -> Result<Value, String> {
    let r = crate::narration::read(root, locale)?;
    let mut doc = r["doc"].clone();
    let mut found = None;
    if let Some(scenes) = doc["sequences"].get_mut(ep).and_then(|s| s.get_mut("scenes")).and_then(|s| s.as_array_mut()) {
        'outer: for sc in scenes {
            if let Some(ls) = sc.get_mut("lines").and_then(|l| l.as_array_mut()) {
                for l in ls {
                    if l["id"] == line {
                        let before = l.clone();
                        if let Some(t) = subtitle {
                            let t = t.trim();
                            if t.is_empty() {
                                return Err("字幕不可空白".into());
                            }
                            l["subtitle"] = json!(t);
                        }
                        if let Some(t) = speak {
                            let t = t.trim();
                            if t.is_empty() {
                                if let Some(o) = l.as_object_mut() {
                                    o.remove("speak");
                                }
                            } else {
                                l["speak"] = json!(t);
                            }
                        }
                        found = Some((before, l.clone()));
                        break 'outer;
                    }
                }
            }
        }
    }
    let (before, after) = found.ok_or_else(|| format!("{locale} {ep} 沒有句子 {line}"))?;
    if before == after {
        return Ok(json!({"changed": false, "line": after}));
    }
    let saved = crate::narration::save(root, locale, &doc, r["sha256"].as_str().unwrap_or(""), Some(&format!("Studio: edit {ep} {line}（{locale}）")))?;
    Ok(json!({"changed": true, "line": after, "before": before, "commit": saved["commit"], "commitError": saved["commitError"]}))
}
