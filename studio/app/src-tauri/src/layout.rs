//! v0.2.1 project folder layout and episode numbering.
//!
//! A project (the Remotion pipeline folder = the shared production engine: `src/`, `scripts/`, `public/`) keeps
//! every video in its own folder:
//!
//! ```text
//! projects/EP07/   formal videos (EP numbers)            sandbox/TEST001/   development tests (TEST numbers)
//!   BRIEF.md  production.json                              (same layout; never merged into the project, never
//!   assets/      imported material (user files)             takes a formal EP number)
//!   script/      narration (JSON + readable Markdown)
//!   scenes/      key frames / storyboard stills
//!   voice/       narration audio
//!   subtitles/   .srt
//!   thumbnail/   .png
//!   output/      finished .mp4
//!   docs/        sources, upload text, QA reports
//! cache/ logs/ dist/   (shared, git-ignored)
//! ```
//!
//! `migrate` copies the legacy root files (EP01_Final.mp4, EP04_SOURCES.md …) into this layout — hard links for
//! videos (no extra disk space), copies for small files — and never moves or deletes anything.

use crate::util::clean_path;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const SUBDIRS: [&str; 8] = ["assets", "script", "scenes", "voice", "subtitles", "thumbnail", "output", "docs"];
pub const SHARED: [&str; 5] = ["projects", "sandbox", "cache", "logs", "dist"];

static RE_TEST: Lazy<Regex> = Lazy::new(|| Regex::new(r"^test\d{3}$").unwrap());

pub fn is_test(ep: &str) -> bool {
    RE_TEST.is_match(ep)
}

pub fn test_number(id: &str) -> Option<u32> {
    is_test(id).then(|| id[4..].parse().ok()).flatten()
}

/// `projects/EP07` or `sandbox/TEST001` (relative to the project root).
pub fn video_rel(ep: &str) -> String {
    format!("{}/{}", if is_test(ep) { "sandbox" } else { "projects" }, ep.to_ascii_uppercase())
}

pub fn video_dir(root: &Path, ep: &str) -> PathBuf {
    root.join(video_rel(ep).replace('/', crate::platform::SEP))
}

pub fn ensure_video_dir(root: &Path, ep: &str) -> Result<PathBuf, String> {
    let d = video_dir(root, ep);
    for s in SUBDIRS {
        std::fs::create_dir_all(d.join(s)).map_err(|e| format!("無法建立 {}：{e}", clean_path(&d.join(s))))?;
    }
    Ok(d)
}

/// Sub-folder an output file belongs in.
pub fn subdir_for(name: &str) -> &'static str {
    let l = name.to_ascii_lowercase();
    if l.ends_with(".mp4") {
        "output"
    } else if l.ends_with(".srt") {
        "subtitles"
    } else if l.ends_with(".png") || l.ends_with(".jpg") || l.ends_with(".jpeg") {
        if l.contains("thumbnail") { "thumbnail" } else { "scenes" }
    } else {
        "docs"
    }
}

/// Lines for the project's .gitignore so per-video binaries and shared caches stay out of git.
pub const GITIGNORE: [&str; 9] = [
    "public/user/",
    "projects/*/assets/",
    "projects/*/voice/",
    "projects/*/scenes/",
    "projects/*/output/",
    "sandbox/",
    "cache/",
    "logs/",
    "dist/",
];

/// Next free TEST number: sandbox folders, narration keys and productions.
pub fn next_test(root: &Path, used_eps: &[String]) -> String {
    let mut used: Vec<u32> = used_eps.iter().filter_map(|e| test_number(e)).collect();
    if let Ok(rd) = std::fs::read_dir(root.join("sandbox")) {
        for e in rd.flatten() {
            used.extend(test_number(&e.file_name().to_string_lossy().to_ascii_lowercase()));
        }
    }
    for loc in ["zh-TW", "zh-CN"] {
        if let Ok(r) = crate::narration::read(root, loc) {
            if let Some(m) = r["doc"]["sequences"].as_object() {
                used.extend(m.keys().filter_map(|k| test_number(k)));
            }
        }
    }
    format!("test{:03}", used.into_iter().max().unwrap_or(0) + 1)
}

// ------------------------------------------------------------------ legacy migration

static RE_LEGACY: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^(EP\d{2,3})(_.*)?\.(mp4|srt|png|md|jpg)$").unwrap());
/// Root files that were Studio tests, not episodes (v0.1 queue tests).
static RE_TESTFILE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)_(killtest|retrytest|test)\.mp4$").unwrap());

/// Plan (and with `apply`, perform) the non-destructive migration of legacy root outputs. Returns
/// `{items: [{from, to, action, bytes}], applied, report}`.
pub fn migrate(root: &Path, apply: bool) -> Result<Value, String> {
    if !root.join("src").join("data").join("narration.json").exists() {
        return Err(format!("{} 不是 Pikara 影片專案（找不到 src/data/narration.json）", clean_path(root)));
    }
    let mut items = vec![];
    let mut rd: Vec<_> = std::fs::read_dir(root).map_err(|e| e.to_string())?.flatten().collect();
    rd.sort_by_key(|e| e.file_name());
    for e in rd {
        let name = e.file_name().to_string_lossy().to_string();
        if !e.path().is_file() {
            continue;
        }
        let Some(c) = RE_LEGACY.captures(&name) else { continue };
        let ep = c[1].to_ascii_uppercase();
        let to_rel = if RE_TESTFILE.is_match(&name) {
            format!("sandbox/legacy-tests/{name}")
        } else {
            format!("projects/{ep}/{}/{name}", subdir_for(&name))
        };
        let to = root.join(to_rel.replace('/', crate::platform::SEP));
        let bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
        let action = if to.exists() {
            let same = std::fs::metadata(&to).map(|m| m.len() == bytes).unwrap_or(false);
            if same { "已存在（略過）" } else { "目的地已有不同檔案（略過，不覆寫）" }
        } else if name.to_ascii_lowercase().ends_with(".mp4") {
            "硬連結（不佔額外空間）"
        } else {
            "複製"
        };
        items.push(json!({"from": name, "to": to_rel, "action": action, "bytes": bytes}));
    }
    let mut done = 0;
    let mut errors = vec![];
    if apply {
        for it in &items {
            let action = it["action"].as_str().unwrap_or("");
            if action.starts_with("已存在") || action.starts_with("目的地") {
                continue;
            }
            let from = root.join(it["from"].as_str().unwrap());
            let to = root.join(it["to"].as_str().unwrap().replace('/', crate::platform::SEP));
            if let Some(p) = to.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let r = if action.starts_with("硬連結") {
                std::fs::hard_link(&from, &to).or_else(|_| std::fs::copy(&from, &to).map(|_| ()))
            } else {
                std::fs::copy(&from, &to).map(|_| ())
            };
            match r {
                Ok(()) => done += 1,
                Err(e) => errors.push(format!("{} → {}：{e}", it["from"].as_str().unwrap_or(""), it["to"].as_str().unwrap_or(""))),
            }
        }
        for d in SHARED {
            let _ = std::fs::create_dir_all(root.join(d));
        }
        ensure_gitignore(root)?;
    }
    let total: u64 = items.iter().map(|i| i["bytes"].as_u64().unwrap_or(0)).sum();
    let report = format!(
        "# 目錄遷移{}\n\n專案：{}\n\n原始檔案全部保留在原位（只複製或建立硬連結，不移動、不刪除）。\n\n| 原檔 | 新位置 | 動作 |\n|---|---|---|\n{}\n\n共 {} 個檔案，{:.1} MB{}\n",
        if apply { "結果" } else { "預覽（尚未執行）" },
        clean_path(root),
        items.iter().map(|i| format!("| {} | {} | {} |", i["from"].as_str().unwrap_or(""), i["to"].as_str().unwrap_or(""), i["action"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n"),
        items.len(),
        total as f64 / 1_048_576.0,
        if apply { format!("；完成 {done} 個{}", if errors.is_empty() { String::new() } else { format!("，失敗 {} 個：\n{}", errors.len(), errors.join("\n")) }) } else { String::new() }
    );
    if apply {
        let _ = std::fs::write(root.join("projects").join("MIGRATION.md"), &report);
    }
    Ok(json!({"items": items, "applied": apply, "done": done, "errors": errors, "report": report}))
}

/// Append the per-video ignore rules to the project's .gitignore (once).
pub fn ensure_gitignore(root: &Path) -> Result<(), String> {
    let p = root.join(".gitignore");
    let cur = std::fs::read_to_string(&p).unwrap_or_default();
    let missing: Vec<&str> = GITIGNORE.iter().copied().filter(|l| !cur.lines().any(|x| x.trim() == *l)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    let nl = if cur.contains("\r\n") { "\r\n" } else { "\n" };
    let mut s = cur.clone();
    if !s.is_empty() && !s.ends_with('\n') {
        s.push_str(nl);
    }
    s.push_str(&format!("# Pikara Studio v0.2.1：每部影片的素材、配音與成品、Sandbox、快取{nl}"));
    for l in missing {
        s.push_str(l);
        s.push_str(nl);
    }
    std::fs::write(&p, s).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbering_and_folders() {
        assert!(is_test("test001") && !is_test("ep01") && !is_test("test01"));
        assert_eq!(video_rel("ep07"), "projects/EP07");
        assert_eq!(video_rel("test002"), "sandbox/TEST002");
        assert_eq!(subdir_for("EP07_Final.mp4"), "output");
        assert_eq!(subdir_for("EP07_YouTube_zh-TW_Thumbnail.png"), "thumbnail");
        assert_eq!(subdir_for("EP07.srt"), "subtitles");
        assert_eq!(subdir_for("EP07_SOURCES.md"), "docs");
    }

    #[test]
    fn migration_is_non_destructive() {
        let d = std::env::temp_dir().join(format!("pikara-layout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("src/data")).unwrap();
        std::fs::write(d.join("src/data/narration.json"), r#"{"sequences":{"test003":{"scenes":[]}}}"#).unwrap();
        std::fs::write(d.join("EP01_Final.mp4"), b"video").unwrap();
        std::fs::write(d.join("EP01.srt"), b"1").unwrap();
        std::fs::write(d.join("EP03_killtest.mp4"), b"t").unwrap();
        std::fs::write(d.join("README.md"), b"x").unwrap();
        let plan = migrate(&d, false).unwrap();
        assert_eq!(plan["items"].as_array().unwrap().len(), 3);
        assert!(!d.join("projects").exists(), "dry run must not write");
        let r = migrate(&d, true).unwrap();
        assert_eq!(r["done"], 3, "{r}");
        assert!(d.join("projects/EP01/output/EP01_Final.mp4").exists());
        assert!(d.join("projects/EP01/subtitles/EP01.srt").exists());
        assert!(d.join("sandbox/legacy-tests/EP03_killtest.mp4").exists());
        assert!(d.join("EP01_Final.mp4").exists() && d.join("EP03_killtest.mp4").exists(), "originals stay");
        let again = migrate(&d, true).unwrap();
        assert_eq!(again["done"], 0);
        assert!(std::fs::read_to_string(d.join(".gitignore")).unwrap().contains("sandbox/"));
        assert_eq!(next_test(&d, &["test001".into()]), "test004");
        let _ = std::fs::remove_dir_all(&d);
    }
}
