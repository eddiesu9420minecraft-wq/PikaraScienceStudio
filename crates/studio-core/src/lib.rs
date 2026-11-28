//! Pikara Science Studio engine: database, job queue and scheduler, autonomous production (autopilot), pipeline
//! steps, voice / render orchestration, hardware detection and validation. No GUI code: the Tauri app
//! (studio/app/src-tauri) and the command line (crates/studio-cli) both drive exactly this crate, so a video made from
//! the terminal and one made in the window go through the same code.

pub mod activity;
pub mod agents;
pub mod assets;
pub mod autopilot;
pub mod content;
pub mod envfix;
pub mod layout;
pub mod claude;
pub mod db;
pub mod doctor;
pub mod episodes;
pub mod gitops;
pub mod gpulock;
pub mod i18n;
pub mod hardware;
pub mod jobs;
pub mod monitor;
pub mod narration;
pub mod pipeline;
pub mod pipeline_sync;
pub mod rerender;
pub mod project;
pub mod prompt;
pub mod queue;
pub mod scaffold;
pub mod selftest;
pub mod util;
pub mod watchdog;

/// OS-specific code (paths, processes, locks, links, power) — crates/studio-platform.
pub use studio_platform as platform;
pub use hardware::telemetry as gpu;

use db::Db;
use queue::Queue;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub type R<T> = Result<T, String>;

/// Everything a front end holds while Studio runs.
pub struct AppState {
    pub db: Db,
    pub queue: Arc<Queue>,
    pub monitor: Arc<monitor::Monitor>,
    pub autopilot: Arc<autopilot::Autopilot>,
}

pub fn root_of(db: &Db, project_id: &str) -> R<PathBuf> {
    let p = db::project_get(&db.lock().unwrap_or_else(|e| e.into_inner()), project_id)?;
    Ok(PathBuf::from(p.root_path))
}

pub fn register_project(db: &Db, path: &str) -> R<db::Project> {
    let p = Path::new(path.trim());
    if !p.is_dir() {
        return Err(format!("資料夾不存在：{path}"));
    }
    let canon = util::clean_path(&std::fs::canonicalize(p).map_err(|e| e.to_string())?);
    let name = Path::new(&canon).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or(canon.clone());
    db::project_upsert(&db.lock().unwrap_or_else(|e| e.into_inner()), &canon, &name)
}

pub fn create_episode(root: &Path, title: &str, episode_id: Option<&str>, scene_title: Option<&str>, first_line: Option<&str>, locales: Option<Vec<String>>) -> R<Value> {
    let locales = locales.unwrap_or_else(|| vec!["zh-TW".into()]);
    for l in &locales {
        narration::rel_path(l)?;
    }
    episodes::create(root, &episodes::NewEpisode { id: episode_id, title, scene_title, first_line, locales })
}

pub fn create_project(db: &Db, dest: &str, title: &str, template: Option<&Path>, link_tools: bool) -> R<Value> {
    let dest = PathBuf::from(dest.trim());
    if dest.as_os_str().is_empty() || !dest.is_absolute() {
        return Err("請提供新專案資料夾的完整路徑（例如 D:\\影片\\我的 科普）".into());
    }
    let tpl = scaffold::find_template(template, None)?;
    let r = scaffold::create(&scaffold::NewProject { dest: &dest, title, template: &tpl, link_tools })?;
    let p = register_project(db, &dest.to_string_lossy())?;
    Ok(json!({"project": p, "scaffold": r}))
}

pub fn job_extra(db: &Db, job_id: Option<&str>) -> R<prompt::Extra> {
    let Some(id) = job_id else { return Ok(prompt::Extra { job_summary: None, job_log_tail: None }) };
    let c = db.lock().unwrap_or_else(|e| e.into_inner());
    let j = db::job_get(&c, id)?;
    let ev = db::events_list(&c, id, 0, 1_000_000)?;
    let tail: Vec<String> = ev.iter().rev().take(150).rev().map(|e| format!("[{}] {}", e.stream, e.line)).collect();
    Ok(prompt::Extra {
        job_summary: Some(format!(
            "- 種類：{}（{}）\n- 參數：{}\n- 狀態：{}，結束碼 {:?}，第 {}/{} 步\n- 錯誤：{}\n- 完整 log：{}",
            j.kind, j.label, j.params, j.status, j.exit_code, j.step + 1, j.steps.len().max(1),
            j.error.clone().unwrap_or_default(), j.log_path.clone().unwrap_or_default()
        )),
        job_log_tail: Some(tail.join("\n")),
    })
}

pub fn enqueue_claude(st: &AppState, project_id: &str, prompt_text: &str, allow_edits: bool, title: &str) -> R<db::Job> {
    let root = root_of(&st.db, project_id)?;
    if prompt_text.trim().is_empty() {
        return Err("prompt is empty".into());
    }
    claude::ensure_excluded(&root)?;
    let wid = uuid::Uuid::new_v4().to_string()[..8].to_string();
    let params = json!({"prompt": prompt_text, "allowEdits": allow_edits, "worktreeId": wid, "title": title});
    st.queue.enqueue(Some(project_id), "claude", &params, &root)
}

pub fn doctor_report(st_db: &Db, q: &Queue, project_id: Option<&str>, gpu_tests: bool) -> R<Value> {
    let root = match project_id {
        Some(p) => Some(root_of(st_db, p)?),
        None => None,
    };
    let s = db::settings_get(&st_db.lock().unwrap_or_else(|e| e.into_inner()));
    let gpu_free = gpu_tests && q.gpu_holder().is_none() && !q.check_external(None).busy;
    let checks = doctor::run_all(root.as_deref(), &s, gpu_tests, gpu_free);
    let c = st_db.lock().unwrap_or_else(|e| e.into_inner());
    for ch in &checks {
        let _ = db::env_check_add(&c, ch.id, ch.status, &ch.to_json());
    }
    Ok(json!({"ts": util::now_iso(), "checks": checks.iter().map(|c| c.to_json()).collect::<Vec<_>>()}))
}

pub fn ep_ref(db: &Db, project_id: &str, episode: &str, locale: &str) -> R<pipeline::Ep> {
    pipeline::Ep::new(&root_of(db, project_id)?, episode, locale)
}

pub fn open_db() -> R<Db> {
    let p = util::data_dir().join("studio.db");
    Ok(Arc::new(Mutex::new(db::open(&p)?)))
}

#[cfg(test)]
mod version_tests {
    /// The shared crates, the Tauri app and the frontend must report one version (CLI `--version`, `build-info`,
    /// pipeline_sync manifests and the GUI all use their own crate's CARGO_PKG_VERSION).
    #[test]
    fn one_version_everywhere() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let pkg: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("studio/app/package.json")).unwrap()).unwrap();
        assert_eq!(pkg["version"].as_str(), Some(env!("CARGO_PKG_VERSION")), "studio/app/package.json");
        let tauri_toml = std::fs::read_to_string(root.join("studio/app/src-tauri/Cargo.toml")).unwrap();
        assert!(tauri_toml.contains(&format!("version = \"{}\"", env!("CARGO_PKG_VERSION"))), "src-tauri/Cargo.toml");
        let conf: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("studio/app/src-tauri/tauri.conf.json")).unwrap()).unwrap();
        assert_eq!(conf["version"].as_str(), Some(env!("CARGO_PKG_VERSION")), "tauri.conf.json");
    }
}
