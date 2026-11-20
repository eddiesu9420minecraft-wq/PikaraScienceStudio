//! Pikara Science Studio — Rust core. Tauri commands are listed in studio/app/API.md.

pub mod agents;
pub mod autopilot;
pub mod claude;
pub mod cli;
pub mod db;
pub mod doctor;
pub mod episodes;
pub mod gitops;
pub mod i18n;
pub mod gpu;
pub mod jobs;
pub mod monitor;
pub mod narration;
pub mod project;
pub mod prompt;
pub mod queue;
pub mod scaffold;
pub mod selftest;
pub mod util;

use db::Db;
use queue::Queue;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

pub struct AppState {
    pub db: Db,
    pub queue: Arc<Queue>,
    pub monitor: Arc<monitor::Monitor>,
    pub autopilot: Arc<autopilot::Autopilot>,
}

type R<T> = Result<T, String>;

/// false when another process holds the scheduler lock for this data dir (queue / autopilot not running here).
static SCHEDULER_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn root_of(db: &Db, project_id: &str) -> R<PathBuf> {
    let p = db::project_get(&db.lock().unwrap(), project_id)?;
    Ok(PathBuf::from(p.root_path))
}

// ------------------------------------------------------------------ app & settings

#[tauri::command]
async fn app_info() -> R<Value> {
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": util::data_dir(),
        "dbPath": util::data_dir().join("studio.db"),
        "logsDir": util::logs_dir(),
        "exePath": std::env::current_exe().ok(),
        "schedulerActive": SCHEDULER_ON.load(std::sync::atomic::Ordering::Relaxed),
    }))
}

#[tauri::command]
async fn settings_get(st: State<'_, AppState>) -> R<db::Settings> {
    Ok(db::settings_get(&st.db.lock().unwrap()))
}

#[tauri::command]
async fn settings_set(st: State<'_, AppState>, settings: Value) -> R<db::Settings> {
    db::settings_merge(&st.db.lock().unwrap(), &settings)
}

// ------------------------------------------------------------------ projects

#[tauri::command]
async fn project_list(st: State<'_, AppState>) -> R<Vec<db::Project>> {
    db::project_list(&st.db.lock().unwrap())
}

pub fn register_project(db: &Db, path: &str) -> R<db::Project> {
    let p = Path::new(path.trim());
    if !p.is_dir() {
        return Err(format!("資料夾不存在：{path}"));
    }
    let canon = util::clean_path(&std::fs::canonicalize(p).map_err(|e| e.to_string())?);
    let name = Path::new(&canon).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or(canon.clone());
    db::project_upsert(&db.lock().unwrap(), &canon, &name)
}

#[tauri::command]
async fn project_register(app: tauri::AppHandle, st: State<'_, AppState>, path: String) -> R<db::Project> {
    let p = register_project(&st.db, &path)?;
    let _ = app.asset_protocol_scope().allow_directory(&p.root_path, true);
    Ok(p)
}

#[tauri::command]
async fn project_remove(st: State<'_, AppState>, project_id: String) -> R<()> {
    db::project_remove(&st.db.lock().unwrap(), &project_id)
}

#[tauri::command]
async fn project_info(st: State<'_, AppState>, project_id: String) -> R<Value> {
    let p = db::project_get(&st.db.lock().unwrap(), &project_id)?;
    blocking(move || Ok(project::info(&p))).await
}

// ------------------------------------------------------------------ episodes & new project (API v1.2)

#[tauri::command]
async fn episode_list(st: State<'_, AppState>, project_id: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || Ok(episodes::list(&root))).await
}

pub fn create_episode(root: &Path, title: &str, episode_id: Option<&str>, scene_title: Option<&str>, first_line: Option<&str>, locales: Option<Vec<String>>) -> R<Value> {
    let locales = locales.unwrap_or_else(|| vec!["zh-TW".into()]);
    for l in &locales {
        narration::rel_path(l)?;
    }
    episodes::create(root, &episodes::NewEpisode { id: episode_id, title, scene_title, first_line, locales })
}

#[tauri::command]
async fn episode_create(
    st: State<'_, AppState>,
    project_id: String,
    title: String,
    episode_id: Option<String>,
    scene_title: Option<String>,
    first_line: Option<String>,
    locales: Option<Vec<String>>,
) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || create_episode(&root, &title, episode_id.as_deref(), scene_title.as_deref(), first_line.as_deref(), locales)).await
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

#[tauri::command]
async fn project_create(
    app: tauri::AppHandle,
    st: State<'_, AppState>,
    dest: String,
    title: String,
    template_project_id: Option<String>,
    template_path: Option<String>,
    link_tools: Option<bool>,
) -> R<Value> {
    let tpl: Option<PathBuf> = match (template_path, template_project_id) {
        (Some(t), _) if !t.trim().is_empty() => Some(PathBuf::from(t)),
        (_, Some(id)) => Some(root_of(&st.db, &id)?),
        _ => None,
    };
    let db = st.db.clone();
    let r = blocking(move || create_project(&db, &dest, &title, tpl.as_deref(), link_tools.unwrap_or(true))).await?;
    if let Some(root) = r["project"]["rootPath"].as_str() {
        let _ = app.asset_protocol_scope().allow_directory(root, true);
    }
    Ok(r)
}

// ------------------------------------------------------------------ narration

#[tauri::command]
async fn narration_read(st: State<'_, AppState>, project_id: String, locale: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || narration::read(&root, &locale)).await
}

#[tauri::command]
async fn narration_validate(doc: Value) -> R<narration::Validation> {
    Ok(narration::validate(&doc))
}

#[tauri::command]
async fn narration_save(st: State<'_, AppState>, project_id: String, locale: String, doc: Value, expected_sha256: String, message: Option<String>) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || narration::save(&root, &locale, &doc, &expected_sha256, message.as_deref())).await
}

// ------------------------------------------------------------------ prompts & claude

#[tauri::command]
async fn prompt_tasks() -> R<Value> {
    Ok(prompt::tasks())
}

fn job_extra(db: &Db, job_id: Option<&str>) -> R<prompt::Extra> {
    let Some(id) = job_id else { return Ok(prompt::Extra { job_summary: None, job_log_tail: None }) };
    let c = db.lock().unwrap();
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

#[tauri::command]
async fn prompt_build(st: State<'_, AppState>, project_id: String, task: String, options: Value) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    let extra = job_extra(&st.db, options["jobId"].as_str())?;
    blocking(move || {
        let text = prompt::build(&root, &task, &options, &extra)?;
        Ok(json!({"task": task, "chars": text.chars().count(), "text": text}))
    })
    .await
}

#[tauri::command]
async fn claude_detect() -> R<Value> {
    blocking(|| Ok(claude::detect())).await
}

#[tauri::command]
async fn claude_install_skill(st: State<'_, AppState>, project_id: String, overwrite: Option<bool>) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    claude::install_skill(&root, overwrite.unwrap_or(false))
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

#[tauri::command]
async fn claude_run(st: State<'_, AppState>, project_id: String, prompt: String, allow_edits: Option<bool>) -> R<db::Job> {
    let title: String = prompt.lines().find(|l| !l.trim().is_empty() && !l.starts_with("你是")).unwrap_or("headless run").chars().take(40).collect();
    enqueue_claude(&st, &project_id, &prompt, allow_edits.unwrap_or(true), &title)
}

#[tauri::command]
async fn claude_worktrees(st: State<'_, AppState>, project_id: String) -> R<Vec<Value>> {
    let root = root_of(&st.db, &project_id)?;
    let jobs = db::job_list(&st.db.lock().unwrap(), Some(&project_id), None, 1000)?;
    blocking(move || {
        Ok(claude::list(&root, |wid| jobs.iter().find(|j| j.kind == "claude" && j.params["worktreeId"] == wid).map(|j| j.id.clone())))
    })
    .await
}

#[tauri::command]
async fn claude_worktree_diff(st: State<'_, AppState>, project_id: String, worktree_id: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || claude::diff(&root, &worktree_id)).await
}

#[tauri::command]
async fn claude_worktree_merge(st: State<'_, AppState>, project_id: String, worktree_id: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || claude::merge(&root, &worktree_id)).await
}

#[tauri::command]
async fn claude_worktree_discard(st: State<'_, AppState>, project_id: String, worktree_id: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || claude::discard(&root, &worktree_id)).await
}

#[tauri::command]
async fn job_analyse_with_claude(st: State<'_, AppState>, job_id: String) -> R<db::Job> {
    let j = db::job_get(&st.db.lock().unwrap(), &job_id)?;
    let pid = j.project_id.clone().ok_or("job has no project")?;
    let root = root_of(&st.db, &pid)?;
    let extra = job_extra(&st.db, Some(&job_id))?;
    let text = prompt::build(&root, "fix_failed_job", &json!({"jobId": job_id}), &extra)?;
    enqueue_claude(&st, &pid, &text, true, &format!("分析失敗工作 {}", j.label))
}

// ------------------------------------------------------------------ doctor

pub fn doctor_report(st_db: &Db, q: &Queue, project_id: Option<&str>, gpu_tests: bool) -> R<Value> {
    let root = match project_id {
        Some(p) => Some(root_of(st_db, p)?),
        None => None,
    };
    let s = db::settings_get(&st_db.lock().unwrap());
    let gpu_free = gpu_tests && q.gpu_holder().is_none() && !q.check_external(None).busy;
    let checks = doctor::run_all(root.as_deref(), &s, gpu_tests, gpu_free);
    let c = st_db.lock().unwrap();
    for ch in &checks {
        let _ = db::env_check_add(&c, ch.id, ch.status, &ch.to_json());
    }
    Ok(json!({"ts": util::now_iso(), "checks": checks.iter().map(|c| c.to_json()).collect::<Vec<_>>()}))
}

#[tauri::command]
async fn doctor_run(st: State<'_, AppState>, project_id: Option<String>, gpu_tests: Option<bool>) -> R<Value> {
    let db = st.db.clone();
    let q = st.queue.clone();
    blocking(move || doctor_report(&db, &q, project_id.as_deref(), gpu_tests.unwrap_or(false))).await
}

#[tauri::command]
async fn doctor_fix(st: State<'_, AppState>, project_id: String, fix_id: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    if let Some(t) = doctor::instructions(&fix_id) {
        return Ok(json!({"kind": "instructions", "text": t}));
    }
    match fix_id.as_str() {
        "create_folders" => Ok(json!({"kind": "done", "message": doctor::create_folders(&root)?})),
        "npm_install" | "remotion_browser_ensure" => {
            let j = st.queue.enqueue(Some(&project_id), "doctor_fix", &json!({"fixId": fix_id}), &root)?;
            Ok(json!({"kind": "job", "job": j}))
        }
        f if f.starts_with("pip_install:") => {
            let j = st.queue.enqueue(Some(&project_id), "doctor_fix", &json!({"fixId": fix_id}), &root)?;
            Ok(json!({"kind": "job", "job": j}))
        }
        f => Err(format!("unknown fix {f}")),
    }
}

// ------------------------------------------------------------------ jobs

#[tauri::command]
async fn job_kinds() -> R<Value> {
    Ok(Value::Array(jobs::kinds().into_iter().map(|k| json!({"kind": k.kind, "label": k.label, "labelKey": k.kind, "labelCn": i18n::cn_label(k.kind), "resource": k.resource, "params": k.params})).collect()))
}

#[tauri::command]
async fn job_enqueue(st: State<'_, AppState>, project_id: String, kind: String, params: Option<Value>) -> R<db::Job> {
    if kind == "claude" || kind == "doctor_fix" {
        return Err(format!("use claude_run / doctor_fix for {kind}"));
    }
    let root = root_of(&st.db, &project_id)?;
    st.queue.enqueue(Some(&project_id), &kind, &params.unwrap_or(json!({})), &root)
}

#[tauri::command]
async fn job_list(st: State<'_, AppState>, project_id: Option<String>, status: Option<String>, limit: Option<i64>) -> R<Vec<db::Job>> {
    db::job_list(&st.db.lock().unwrap(), project_id.as_deref(), status.as_deref(), limit.unwrap_or(200))
}

#[tauri::command]
async fn job_get(st: State<'_, AppState>, job_id: String) -> R<db::Job> {
    db::job_get(&st.db.lock().unwrap(), &job_id)
}

#[tauri::command]
async fn job_events(st: State<'_, AppState>, job_id: String, after_id: Option<i64>, limit: Option<i64>) -> R<Vec<db::JobEvent>> {
    db::events_list(&st.db.lock().unwrap(), &job_id, after_id.unwrap_or(0), limit.unwrap_or(1000))
}

#[tauri::command]
async fn job_cancel(st: State<'_, AppState>, job_id: String) -> R<db::Job> {
    let q = st.queue.clone();
    blocking(move || q.cancel(&job_id)).await
}

#[tauri::command]
async fn job_retry(st: State<'_, AppState>, job_id: String) -> R<db::Job> {
    db::job_requeue(&st.db.lock().unwrap(), &job_id)
}

#[tauri::command]
async fn job_remove(st: State<'_, AppState>, job_id: String) -> R<()> {
    db::job_remove(&st.db.lock().unwrap(), &job_id)
}

#[tauri::command]
async fn queue_status(st: State<'_, AppState>) -> R<Value> {
    Ok(st.queue.status())
}

#[tauri::command]
async fn gpu_external_status(st: State<'_, AppState>) -> R<gpu::ExternalGpu> {
    let q = st.queue.clone();
    blocking(move || Ok(q.check_external(None))).await
}

#[tauri::command]
async fn monitor_sample(st: State<'_, AppState>) -> R<monitor::MonitorSample> {
    let m = st.monitor.clone();
    let q = st.queue.clone();
    blocking(move || Ok(m.sample(|g| q.check_external(g)))).await
}

// ------------------------------------------------------------------ git rollback

#[tauri::command]
async fn git_log(st: State<'_, AppState>, project_id: String, limit: Option<usize>) -> R<Vec<Value>> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || gitops::log(&root, limit.unwrap_or(50))).await
}

#[tauri::command]
async fn git_status(st: State<'_, AppState>, project_id: String) -> R<gitops::GitStatus> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || Ok(gitops::status(&root))).await
}

#[tauri::command]
async fn git_revert(st: State<'_, AppState>, project_id: String, commit: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || gitops::revert(&root, &commit)).await
}

#[tauri::command]
async fn git_branch_from(st: State<'_, AppState>, project_id: String, commit: String, branch: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || gitops::branch_from(&root, &commit, &branch)).await
}

#[tauri::command]
async fn git_reset_hard(st: State<'_, AppState>, project_id: String, commit: String, confirm: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || gitops::reset_hard(&root, &commit, &confirm)).await
}

// ------------------------------------------------------------------ outputs & publish

#[tauri::command]
async fn outputs_list(st: State<'_, AppState>, project_id: String, probe: Option<bool>) -> R<Vec<Value>> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || Ok(project::outputs(&root, probe.unwrap_or(true)))).await
}

#[tauri::command]
async fn publish_metadata(st: State<'_, AppState>, project_id: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    Ok(project::publish_metadata(&root))
}

#[tauri::command]
async fn open_path(st: State<'_, AppState>, project_id: String, path: String, reveal: Option<bool>) -> R<()> {
    let root = root_of(&st.db, &project_id)?;
    project::open_path(&root, Path::new(&path), reveal.unwrap_or(false))
}

#[tauri::command]
async fn asset_url_allowed(app: tauri::AppHandle, st: State<'_, AppState>, project_id: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    let ok = app.asset_protocol_scope().allow_directory(&root, true).is_ok();
    Ok(json!({"allowed": ok}))
}

// ------------------------------------------------------------------ autonomous production

#[tauri::command]
async fn auto_defaults() -> R<Value> {
    Ok(json!({
        "config": autopilot::AutoConfig::default(),
        "stages": autopilot::STAGES.iter().map(|(id, label)| json!({"id": id, "label": label})).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
async fn auto_start(st: State<'_, AppState>, project_id: String, config: Value) -> R<autopilot::Production> {
    let ap = st.autopilot.clone();
    blocking(move || {
        let cfg: autopilot::AutoConfig = serde_json::from_value(config).map_err(|e| format!("設定格式錯誤：{e}"))?;
        ap.start(&project_id, cfg)
    })
    .await
}

#[tauri::command]
async fn auto_list(st: State<'_, AppState>, limit: Option<i64>) -> R<Vec<autopilot::Production>> {
    autopilot::list(&st.db.lock().unwrap(), limit.unwrap_or(50))
}

#[tauri::command]
async fn auto_get(st: State<'_, AppState>, id: String) -> R<autopilot::Production> {
    autopilot::get(&st.db.lock().unwrap(), &id)
}

#[tauri::command]
async fn auto_events(st: State<'_, AppState>, id: String, after_id: Option<i64>, limit: Option<i64>) -> R<Vec<autopilot::PEvent>> {
    autopilot::events(&st.db.lock().unwrap(), &id, after_id.unwrap_or(0), limit.unwrap_or(500))
}

#[tauri::command]
async fn auto_control(st: State<'_, AppState>, id: String, action: String) -> R<Value> {
    let ap = st.autopilot.clone();
    blocking(move || {
        let p = match action.as_str() {
            "pause" => ap.pause(&id)?,
            "resume" => ap.resume(&id)?,
            "stop" => ap.stop(&id)?,
            "discard" => ap.discard(&id)?,
            "remove" => {
                ap.remove(&id)?;
                return Ok(json!({"removed": true}));
            }
            a => return Err(format!("未知的操作 {a}")),
        };
        Ok(serde_json::to_value(p).unwrap())
    })
    .await
}

#[tauri::command]
async fn agent_check(provider: String, deep: Option<bool>) -> R<Value> {
    blocking(move || Ok(agents::check(&provider, deep.unwrap_or(false)))).await
}

#[tauri::command]
async fn agent_done(st: State<'_, AppState>, id: String, failed: Option<bool>, note: Option<String>) -> R<autopilot::Production> {
    let ap = st.autopilot.clone();
    blocking(move || ap.agent_done(&id, failed.unwrap_or(false), note.as_deref())).await
}

// ------------------------------------------------------------------ startup

pub fn open_db() -> R<Db> {
    let p = util::data_dir().join("studio.db");
    Ok(Arc::new(Mutex::new(db::open(&p)?)))
}

pub fn run() {
    let db = open_db().expect("open studio.db");
    tauri::Builder::default()
        // A second launch focuses the running window instead of failing on the locked WebView2 profile.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let emit: queue::Emit = Arc::new(move |name: &str, payload: Value| {
                let _ = handle.emit(name, payload);
            });
            let q = Queue::new(db.clone(), emit.clone());
            // only one process may run the queue / autopilot for a data dir (else every job would run twice)
            let lock = util::scheduler_lock();
            let scheduler_on = lock.is_ok();
            SCHEDULER_ON.store(scheduler_on, std::sync::atomic::Ordering::Relaxed);
            if let Ok(f) = lock {
                std::mem::forget(f); // held for the life of the app
                let recovered = q.recover();
                if !recovered.is_empty() {
                    eprintln!("recovered {} interrupted job(s)", recovered.len());
                }
                queue::spawn_scheduler(q.clone());
            } else if let Err(e) = &lock {
                eprintln!("{e}");
            }
            let mon = Arc::new(monitor::Monitor::new());
            // monitor thread: every 2 s → monitor://sample, metrics table every 10 s
            {
                let (mon, q, db, emit) = (mon.clone(), q.clone(), db.clone(), emit.clone());
                std::thread::Builder::new()
                    .name("studio-monitor".into())
                    .spawn(move || {
                        let mut n = 0u64;
                        loop {
                            let s = mon.sample(|g| q.check_external(g));
                            let v = serde_json::to_value(&s).unwrap_or(Value::Null);
                            if n % 5 == 0 {
                                let _ = db::metric_add(&db.lock().unwrap(), &v);
                            }
                            emit("monitor://sample", v);
                            n += 1;
                            std::thread::sleep(std::time::Duration::from_secs(2));
                        }
                    })
                    .ok();
            }
            // allow <video src=convertFileSrc(...)> for registered projects
            for p in db::project_list(&db.lock().unwrap()).unwrap_or_default() {
                let _ = app.asset_protocol_scope().allow_directory(&p.root_path, true);
            }
            let notify_handle = app.handle().clone();
            let notify: Arc<dyn Fn(&str, &str) + Send + Sync> = Arc::new(move |title: &str, body: &str| {
                use tauri_plugin_notification::NotificationExt;
                let _ = notify_handle.notification().builder().title(title).body(body).show();
            });
            let ap = autopilot::Autopilot::new(db.clone(), q.clone(), notify, emit.clone());
            if scheduler_on {
                autopilot::spawn(ap.clone());
            }
            app.manage(AppState { db: db.clone(), queue: q, monitor: mon, autopilot: ap });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info, settings_get, settings_set,
            project_list, project_register, project_remove, project_info, project_create, episode_list, episode_create,
            narration_read, narration_validate, narration_save,
            prompt_tasks, prompt_build,
            claude_detect, claude_install_skill, claude_run, claude_worktrees, claude_worktree_diff, claude_worktree_merge, claude_worktree_discard,
            doctor_run, doctor_fix,
            job_kinds, job_enqueue, job_list, job_get, job_events, job_cancel, job_retry, job_remove, queue_status, gpu_external_status,
            monitor_sample, job_analyse_with_claude,
            git_log, git_status, git_revert, git_branch_from, git_reset_hard,
            outputs_list, publish_metadata, open_path, asset_url_allowed,
            auto_defaults, auto_start, auto_list, auto_get, auto_events, auto_control, agent_check, agent_done
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pikara Science Studio");
}
