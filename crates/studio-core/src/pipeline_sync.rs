//! Keep a project's pipeline scripts (`scripts/`) in step with the Studio build that runs them.
//!
//! Studio runs every job with the *project's* copy of the pipeline (`scripts/render.mjs`,
//! `scripts/generate_voiceover_cosy.py`, …), but an installed Studio is a single exe: nothing used to copy newer
//! scripts into existing projects. Projects therefore kept the scripts they were created with, and fixes made after
//! that (voice-rate calibration, pronunciation dictionary, the 「什幺」 guard in make_cn.py, TTS watchdog, hardware
//! encoder selection …) never ran in real productions.
//!
//! This build embeds `pipeline/scripts` and syncs them into a project:
//! - file missing → added;
//! - file equal to what Studio wrote last time (`.studio/pipeline.json`) → updated;
//! - no record yet (projects from before this module): updated only if git tracks the file and it has no
//!   uncommitted changes, so the old version stays in git history (plus a copy in `.studio/pipeline-backup/`);
//! - file the user changed (differs from Studio's record, or uncommitted changes) → kept and reported
//!   (`--force` overwrites, with backup).
//!
//! Changed files are committed with a message that names the Studio version; `git revert` undoes it.
//! Line endings are ignored when comparing (git `core.autocrlf` rewrites them on checkout).

use crate::gitops::{git, git_commit};
use crate::util::now_iso;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

macro_rules! embedded {
    ($($f:literal),* $(,)?) => {
        &[$((concat!("scripts/", $f), include_bytes!(concat!("../../../pipeline/scripts/", $f)) as &[u8])),*]
    };
}

/// Pipeline files this Studio build manages. Tests, benchmarks and experiments are not shipped.
/// `embedded_list_matches_pipeline_dir` (test) fails when a script is added to pipeline/scripts but not here.
pub const FILES: &[(&str, &[u8])] = embedded![
    "accel_probe.py",
    "asr_norm.py",
    "audio_integrity.py",
    "benchmark.mjs",
    "build_timeline.py",
    "export_voiceover_md.py",
    "generate_voiceover.py",
    "generate_voiceover_cosy.py",
    "gpu-check.mjs",
    "gpu_lock.py",
    "hw_encoders.json",
    "hwenc.mjs",
    "lib.mjs",
    "make_cn.py",
    "mix_audio.py",
    "music.py",
    "pronunciation.json",
    "pronunciation.py",
    "qa_video.py",
    "render.mjs",
    "scale_srt.py",
    "stills.mjs",
    "tts_watchdog.py",
    "verify_devices.py",
    "verify_encoder.py",
    "voice_speed_check.py",
    "voice_tempo.py",
];

/// pipeline/scripts entries deliberately not shipped (development tools).
pub const NOT_SHIPPED_PREFIXES: &[&str] = &["test_", "bench_", "exp_"];
pub const NOT_SHIPPED: &[&str] = &["cosy_ab_report.py", "cosy_variants.py", "voice_speed_ab.py", "voice_ab.py", "voice_ab_texts.json", "tts_profile.py", "finalize.sh", "ui_tour_capture.ps1"];

const MANIFEST: &str = ".studio/pipeline.json";

fn sha(bytes: &[u8]) -> String {
    // CRLF → LF so a checkout with core.autocrlf compares equal to the embedded copy
    let mut h = Sha256::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            i += 1;
            continue;
        }
        h.update([bytes[i]]);
        i += 1;
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Hash of all embedded files (shown by `build-info` and recorded in the manifest).
pub fn bundle_sha() -> String {
    let mut h = Sha256::new();
    for (rel, bytes) in FILES {
        h.update(rel.as_bytes());
        h.update([0u8]);
        h.update(sha(bytes).as_bytes());
    }
    h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Action {
    Current,
    Add,
    Update,
    /// user's version kept
    KeepModified,
    KeepUncommitted,
}

impl Action {
    fn label(self) -> &'static str {
        match self {
            Action::Current => "current",
            Action::Add => "add",
            Action::Update => "update",
            Action::KeepModified => "keep-modified",
            Action::KeepUncommitted => "keep-uncommitted",
        }
    }
}

/// Pure decision for one file. `recorded` = hash Studio wrote last time; `tracked_clean` = git tracks the file and
/// it has no uncommitted changes.
pub fn decide(current: Option<&str>, want: &str, recorded: Option<&str>, tracked_clean: bool, force: bool) -> Action {
    match current {
        None => Action::Add,
        Some(c) if c == want => Action::Current,
        Some(_) if force => Action::Update,
        Some(c) => match recorded {
            Some(r) if r == c => Action::Update,
            Some(_) => Action::KeepModified,
            None if tracked_clean => Action::Update,
            None => Action::KeepUncommitted,
        },
    }
}

fn read_manifest(root: &Path) -> Map<String, Value> {
    std::fs::read_to_string(root.join(MANIFEST))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["files"].as_object().cloned())
        .unwrap_or_default()
}

/// Is `dir` a pipeline project (Studio would run scripts from it)?
pub fn is_pipeline_project(dir: &Path) -> bool {
    dir.join("scripts").join("render.mjs").is_file() && dir.join("package.json").is_file()
}

/// Plan (apply = false) or apply the sync for one project folder (main project or production worktree).
/// `commit`: commit the changed files (only those paths) when the folder is a git repository.
pub fn sync(root: &Path, apply: bool, force: bool, commit: bool) -> Result<Value, String> {
    if !is_pipeline_project(root) {
        return Ok(json!({"ok": true, "skipped": "not a pipeline project", "root": crate::util::clean_path(root)}));
    }
    let manifest = read_manifest(root);
    let is_repo = git(root, &["rev-parse", "--is-inside-work-tree"]).map(|o| o.ok()).unwrap_or(false);
    if is_repo && apply {
        // manifest and backups live in .studio/ — never committed
        crate::claude::ensure_excluded(root)?;
    }
    // one git call for the whole folder instead of one per file
    let (tracked, dirty): (Vec<String>, Vec<String>) = if is_repo {
        let t = git(root, &["ls-files", "--", "scripts"]).map(|o| o.stdout.lines().map(|l| l.trim().to_string()).collect()).unwrap_or_default();
        let d = git(root, &["status", "--porcelain", "--", "scripts"])
            .map(|o| o.stdout.lines().filter(|l| l.len() > 3).map(|l| l[3..].trim().trim_matches('"').to_string()).collect())
            .unwrap_or_default();
        (t, d)
    } else {
        (vec![], vec![])
    };
    let mut files = vec![];
    let mut changed: Vec<&str> = vec![];
    let mut kept = vec![];
    let mut new_manifest = manifest.clone();
    let stamp = now_iso().replace([':', '.'], "-");
    for (rel, bytes) in FILES {
        let want = sha(bytes);
        let path = root.join(rel);
        let current = std::fs::read(&path).ok().map(|b| sha(&b));
        let tracked_clean = tracked.iter().any(|t| t == rel) && !dirty.iter().any(|d| d == rel);
        let act = decide(current.as_deref(), &want, manifest.get(*rel).and_then(|v| v.as_str()), tracked_clean, force);
        files.push(json!({"file": rel, "action": act.label()}));
        match act {
            Action::Current => {
                new_manifest.insert(rel.to_string(), json!(want));
            }
            Action::Add | Action::Update => {
                if apply {
                    if act == Action::Update {
                        let bk = root.join(".studio/pipeline-backup").join(&stamp).join(rel);
                        std::fs::create_dir_all(bk.parent().unwrap()).map_err(|e| e.to_string())?;
                        std::fs::copy(&path, &bk).map_err(|e| format!("無法備份 {rel}：{e}"))?;
                    }
                    if let Some(par) = path.parent() {
                        std::fs::create_dir_all(par).map_err(|e| e.to_string())?;
                    }
                    // write to a temp file first: a crash never leaves a half-written script
                    let tmp = path.with_extension("studio-tmp");
                    std::fs::write(&tmp, bytes).map_err(|e| format!("無法寫入 {rel}：{e}"))?;
                    std::fs::rename(&tmp, &path).map_err(|e| format!("無法更新 {rel}：{e}"))?;
                    new_manifest.insert(rel.to_string(), json!(want));
                }
                changed.push(rel);
            }
            Action::KeepModified | Action::KeepUncommitted => kept.push(rel.to_string()),
        }
    }
    let mut committed = None;
    if apply {
        if !changed.is_empty() || new_manifest != manifest {
            let m = json!({"studioVersion": env!("CARGO_PKG_VERSION"), "bundle": bundle_sha(), "updatedAt": now_iso(), "files": new_manifest});
            std::fs::create_dir_all(root.join(".studio")).map_err(|e| e.to_string())?;
            std::fs::write(root.join(MANIFEST), serde_json::to_string_pretty(&m).unwrap()).map_err(|e| e.to_string())?;
        }
        if commit && is_repo && !changed.is_empty() {
            let mut add = vec!["add", "--"];
            add.extend(changed.iter().copied());
            let _ = git(root, &add);
            let msg = format!("Studio v{}：更新管線腳本（{} 個檔案）", env!("CARGO_PKG_VERSION"), changed.len());
            let mut c = vec!["commit", "--quiet", "--no-verify", "-m", &msg, "--"];
            c.extend(changed.iter().copied());
            let o = git_commit(root, &c)?;
            committed = Some(if o.ok() { json!(true) } else { json!(o.combined().trim().chars().take(300).collect::<String>()) });
        }
    }
    Ok(json!({
        "ok": true,
        "root": crate::util::clean_path(root),
        "studioVersion": env!("CARGO_PKG_VERSION"),
        "bundle": bundle_sha(),
        "applied": apply,
        "changed": changed,
        "kept": kept,
        "committed": committed,
        "files": files,
    }))
}

/// One-line summary for the splash / production log.
pub fn summary(v: &Value) -> String {
    let n = v["changed"].as_array().map(|a| a.len()).unwrap_or(0);
    let kept = v["kept"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("、")).unwrap_or_default();
    let mut s = if n == 0 { "管線腳本已是最新".to_string() } else { format!("已更新 {n} 個管線腳本（v{}）", env!("CARGO_PKG_VERSION")) };
    if !kept.is_empty() {
        s.push_str(&format!("；保留你修改過的：{kept}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decisions() {
        use Action::*;
        assert_eq!(decide(None, "w", None, false, false), Add);
        assert_eq!(decide(Some("w"), "w", None, false, false), Current);
        // written by Studio before, untouched → update
        assert_eq!(decide(Some("old"), "w", Some("old"), false, false), Update);
        // user edited Studio's copy → keep
        assert_eq!(decide(Some("mine"), "w", Some("old"), true, false), KeepModified);
        // legacy project: committed, clean → update (old version stays in git)
        assert_eq!(decide(Some("old"), "w", None, true, false), Update);
        // legacy project with uncommitted edits → keep
        assert_eq!(decide(Some("old"), "w", None, false, false), KeepUncommitted);
        assert_eq!(decide(Some("mine"), "w", Some("old"), false, true), Update);
    }

    #[test]
    fn crlf_is_ignored() {
        assert_eq!(sha(b"a\r\nb\r\n"), sha(b"a\nb\n"));
        assert_ne!(sha(b"a\nb"), sha(b"a\nc"));
    }

    #[test]
    fn embedded_list_matches_pipeline_dir() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../pipeline/scripts");
        let mut missing = vec![];
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().is_dir() || NOT_SHIPPED.contains(&name.as_str()) || NOT_SHIPPED_PREFIXES.iter().any(|p| name.starts_with(p)) {
                continue;
            }
            if !FILES.iter().any(|(rel, _)| *rel == format!("scripts/{name}")) {
                missing.push(name);
            }
        }
        assert!(missing.is_empty(), "pipeline/scripts files not embedded in pipeline_sync::FILES (add them, or to NOT_SHIPPED): {missing:?}");
        // the guard that keeps 「什么」 from becoming 「什幺」 must be in the shipped make_cn.py
        let make_cn = FILES.iter().find(|(r, _)| *r == "scripts/make_cn.py").unwrap().1;
        assert!(String::from_utf8_lossy(make_cn).contains("BROKEN"));
    }

    #[test]
    fn sync_legacy_project_updates_committed_and_keeps_dirty() {
        let d = std::env::temp_dir().join(format!("pikara-psync-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("scripts")).unwrap();
        std::fs::write(d.join("package.json"), "{}").unwrap();
        std::fs::write(d.join("scripts/render.mjs"), "old render").unwrap();
        std::fs::write(d.join("scripts/make_cn.py"), "old make_cn").unwrap();
        std::fs::write(d.join("scripts/export_release.py"), "project-only").unwrap();
        let g = |a: &[&str]| git(&d, a).unwrap();
        g(&["init", "-q"]);
        g(&["add", "-A"]);
        git_commit(&d, &["commit", "-q", "-m", "init"]).unwrap();
        // uncommitted user edit
        std::fs::write(d.join("scripts/make_cn.py"), "my edit").unwrap();

        let plan = sync(&d, false, false, true).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("scripts/render.mjs")).unwrap(), "old render", "check mode must not write");
        assert!(plan["kept"].as_array().unwrap().iter().any(|k| k == "scripts/make_cn.py"));

        let r = sync(&d, true, false, true).unwrap();
        assert_ne!(std::fs::read_to_string(d.join("scripts/render.mjs")).unwrap(), "old render");
        assert_eq!(std::fs::read_to_string(d.join("scripts/make_cn.py")).unwrap(), "my edit");
        assert_eq!(std::fs::read_to_string(d.join("scripts/export_release.py")).unwrap(), "project-only");
        assert_eq!(r["committed"], json!(true));
        assert!(d.join(".studio/pipeline-backup").is_dir());
        // second run: nothing to do; Studio's own files are now recorded
        let again = sync(&d, true, false, true).unwrap();
        assert!(again["changed"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }
}
