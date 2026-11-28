//! Pikara Science Studio — Rust core. Tauri commands are listed in studio/app/API.md.

pub mod picker;

// Backend engine (database, queue, autopilot, pipeline, hardware, platform) lives in crates/studio-core and is
// shared with the command line (crates/studio-cli). This crate is only the Tauri window and its commands.
pub use studio_core::*;

use queue::Queue;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};



/// false when another process holds the scheduler lock for this data dir (queue / autopilot not running here).
static SCHEDULER_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}


// ------------------------------------------------------------------ app & settings

#[tauri::command]
async fn app_info() -> R<Value> {
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "gitCommit": env!("PIKARA_GIT_COMMIT"),
        "frontendSha256": env!("PIKARA_FRONTEND_SHA256"),
        "pipelineBundle": pipeline_sync::bundle_sha(),
        "pipelineFiles": pipeline_sync::FILES.len(),
        "dataDir": util::data_dir(),
        "dbPath": util::data_dir().join("studio.db"),
        "logsDir": util::logs_dir(),
        "exePath": std::env::current_exe().ok(),
        "schedulerActive": SCHEDULER_ON.load(std::sync::atomic::Ordering::Relaxed),
        "schemaVersion": db::schema_version(),
        // screenshot / layout tour (debug harness only): PIKARA_UI_TOUR=1 [PIKARA_UI_TOUR_STEP_MS=2500]
        "uiTour": std::env::var("PIKARA_UI_TOUR").ok().filter(|v| v == "1").is_some(),
        "uiTourStepMs": std::env::var("PIKARA_UI_TOUR_STEP_MS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(2500),
        "uiTourEpisode": std::env::var("PIKARA_UI_TOUR_EPISODE").ok(),
        "uiTourLang": std::env::var("PIKARA_UI_TOUR_LANG").ok(),
        "frontendSha256": env!("PIKARA_FRONTEND_SHA256"),
        "uiTourThemes": std::env::var("PIKARA_UI_TOUR_THEMES").ok(),
        "uiTourOnly": std::env::var("PIKARA_UI_TOUR_ONLY").ok(),
        "uiTourActions": std::env::var("PIKARA_UI_TOUR_ACTIONS").ok(),
    }))
}

#[tauri::command]
async fn settings_get(st: State<'_, AppState>) -> R<db::Settings> {
    Ok(db::settings_get(&st.db.lock().unwrap_or_else(|e| e.into_inner())))
}

#[tauri::command]
async fn settings_set(st: State<'_, AppState>, settings: Value) -> R<db::Settings> {
    db::settings_merge(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &settings)
}

// ------------------------------------------------------------------ projects

#[tauri::command]
async fn project_list(st: State<'_, AppState>) -> R<Vec<db::Project>> {
    db::project_list(&st.db.lock().unwrap_or_else(|e| e.into_inner()))
}


#[tauri::command]
async fn project_register(app: tauri::AppHandle, st: State<'_, AppState>, path: String) -> R<db::Project> {
    let p = register_project(&st.db, &path)?;
    let _ = app.asset_protocol_scope().allow_directory(&p.root_path, true);
    Ok(p)
}

#[tauri::command]
async fn project_remove(st: State<'_, AppState>, project_id: String) -> R<()> {
    db::project_remove(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &project_id)
}

#[tauri::command]
async fn project_info(st: State<'_, AppState>, project_id: String) -> R<Value> {
    let p = db::project_get(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &project_id)?;
    blocking(move || Ok(project::info(&p))).await
}

// ------------------------------------------------------------------ episodes & new project (API v1.2)

#[tauri::command]
async fn episode_list(st: State<'_, AppState>, project_id: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || Ok(episodes::list(&root))).await
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


#[tauri::command]
async fn claude_run(st: State<'_, AppState>, project_id: String, prompt: String, allow_edits: Option<bool>) -> R<db::Job> {
    let title: String = prompt.lines().find(|l| !l.trim().is_empty() && !l.starts_with("你是")).unwrap_or("headless run").chars().take(40).collect();
    enqueue_claude(&st, &project_id, &prompt, allow_edits.unwrap_or(true), &title)
}

#[tauri::command]
async fn claude_worktrees(st: State<'_, AppState>, project_id: String) -> R<Vec<Value>> {
    let root = root_of(&st.db, &project_id)?;
    let jobs = db::job_list(&st.db.lock().unwrap_or_else(|e| e.into_inner()), Some(&project_id), None, 1000)?;
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
    let j = db::job_get(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &job_id)?;
    let pid = j.project_id.clone().ok_or("job has no project")?;
    let root = root_of(&st.db, &pid)?;
    let extra = job_extra(&st.db, Some(&job_id))?;
    let text = prompt::build(&root, "fix_failed_job", &json!({"jobId": job_id}), &extra)?;
    enqueue_claude(&st, &pid, &text, true, &format!("分析失敗工作 {}", j.label))
}

// ------------------------------------------------------------------ doctor


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
        "venv_repair" => {
            let venv = root.join("tools").join("CosyVoice").join(".venv");
            Ok(json!({"kind": "done", "message": blocking(move || envfix::repair(&venv)).await?}))
        }
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

// ------------------------------------------------------------------ v0.3 workspace / re-voice / re-render


#[tauri::command]
async fn workspace_get(st: State<'_, AppState>, project_id: String, episode: String, locale: String) -> R<Value> {
    let ep = ep_ref(&st.db, &project_id, &episode, &locale)?;
    let db = st.db.clone();
    blocking(move || {
        let c = db.lock().unwrap_or_else(|e| e.into_inner());
        let s = db::settings_get(&c);
        pipeline::workspace(&c, &ep, &s)
    })
    .await
}

#[tauri::command]
async fn line_set(st: State<'_, AppState>, project_id: String, episode: String, locale: String, line: String, subtitle: Option<String>, speak: Option<String>) -> R<Value> {
    let ep = ep_ref(&st.db, &project_id, &episode, &locale)?;
    blocking(move || rerender::line_set(&ep.root, &ep.locale, &ep.id, &line, subtitle.as_deref(), speak.as_deref())).await
}

#[tauri::command]
async fn revoice_start(st: State<'_, AppState>, project_id: String, episode: String, locale: String, lines: Option<Vec<String>>, options: Option<Value>) -> R<db::Job> {
    let root = root_of(&st.db, &project_id)?;
    let mut p = options.unwrap_or(json!({}));
    p["episode"] = json!(episode);
    p["locale"] = json!(locale);
    p["lines"] = json!(lines.unwrap_or_default().join(" "));
    st.queue.enqueue(Some(&project_id), "revoice", &p, &root)
}

#[tauri::command]
async fn voice_versions(st: State<'_, AppState>, project_id: String, episode: String, locale: String, line: Option<String>) -> R<Vec<Value>> {
    let ep = ep_ref(&st.db, &project_id, &episode, &locale)?;
    Ok(pipeline::voice_versions(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &ep, line.as_deref()))
}

#[tauri::command]
async fn voice_restore(st: State<'_, AppState>, project_id: String, episode: String, locale: String, line: String, version: i64) -> R<Value> {
    let ep = ep_ref(&st.db, &project_id, &episode, &locale)?;
    pipeline::restore_voice(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &ep, &line, version, None)
}

#[tauri::command]
async fn voice_reject(st: State<'_, AppState>, project_id: String, episode: String, locale: String, line: String, version: i64) -> R<()> {
    let ep = ep_ref(&st.db, &project_id, &episode, &locale)?;
    pipeline::reject_candidate(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &ep, &line, version)
}

#[tauri::command]
async fn rerender_plan(st: State<'_, AppState>, project_id: String, episode: String, locale: String, params: Option<Value>) -> R<Value> {
    let ep = ep_ref(&st.db, &project_id, &episode, &locale)?;
    blocking(move || {
        // the plan runs two short scripts: use its own connection so the app's DB lock is not held meanwhile
        let c = db::open(&util::data_dir().join("studio.db"))?;
        let s = db::settings_get(&c);
        rerender::plan(&c, &ep, &params.unwrap_or(json!({})), &s)
    })
    .await
}

#[tauri::command]
async fn rerender_start(st: State<'_, AppState>, project_id: String, episode: String, locale: String, params: Option<Value>) -> R<db::Job> {
    let root = root_of(&st.db, &project_id)?;
    let mut p = params.unwrap_or(json!({}));
    p["episode"] = json!(episode);
    p["locale"] = json!(locale);
    st.queue.enqueue(Some(&project_id), "rerender", &p, &root)
}

#[tauri::command]
async fn db_info(st: State<'_, AppState>) -> R<Value> {
    let c = st.db.lock().unwrap_or_else(|e| e.into_inner());
    Ok(json!({"schemaVersion": db::user_version(&c), "latest": db::schema_version(), "path": util::data_dir().join("studio.db"),
              "backups": db::backups(&util::data_dir().join("studio.db"))}))
}

#[tauri::command]
async fn db_backup(st: State<'_, AppState>) -> R<Value> {
    let c = st.db.lock().unwrap_or_else(|e| e.into_inner());
    let v = db::user_version(&c);
    let b = db::backup_verified(&c, &util::data_dir().join("studio.db"), v, "manual")?;
    Ok(json!({"backup": b}))
}

/// Hardware & performance page / diagnostics: detected GPUs, assignment, options (only detected devices).
#[tauri::command]
async fn hw_info(st: State<'_, AppState>, project_id: Option<String>, redetect: Option<bool>) -> R<Value> {
    let s = db::settings_get(&st.db.lock().unwrap_or_else(|e| e.into_inner()));
    let root = project_id.and_then(|p| root_of(&st.db, &p).ok());
    blocking(move || Ok(hardware::selector::info(&s, root.as_deref(), redetect.unwrap_or(false)))).await
}

/// Measured GPU usage per role (UI = this window's WebView2 processes).
#[tauri::command]
async fn hw_usage(ms: Option<u64>) -> R<Value> {
    blocking(move || Ok(hardware::selector::usage(ms.unwrap_or(1500), std::process::id()))).await
}

/// Screenshot / layout tour (debug harness): the UI reports each step; the external capture script reads the file.
#[tauri::command]
async fn ui_tour_report(step: String, data: Value) -> R<()> {
    let d = util::data_dir().join("ui-tour");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let safe: String = step.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    std::fs::write(d.join(format!("{safe}.json")), serde_json::to_vec_pretty(&data).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::write(d.join("current.txt"), &safe).map_err(|e| e.to_string())
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
    db::job_list(&st.db.lock().unwrap_or_else(|e| e.into_inner()), project_id.as_deref(), status.as_deref(), limit.unwrap_or(200))
}

#[tauri::command]
async fn job_get(st: State<'_, AppState>, job_id: String) -> R<db::Job> {
    db::job_get(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &job_id)
}

#[tauri::command]
async fn job_events(st: State<'_, AppState>, job_id: String, after_id: Option<i64>, limit: Option<i64>) -> R<Vec<db::JobEvent>> {
    db::events_list(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &job_id, after_id.unwrap_or(0), limit.unwrap_or(1000))
}

#[tauri::command]
async fn job_cancel(st: State<'_, AppState>, job_id: String) -> R<db::Job> {
    let q = st.queue.clone();
    blocking(move || q.cancel(&job_id)).await
}

#[tauri::command]
async fn job_pause(st: State<'_, AppState>, job_id: String) -> R<Value> {
    let q = st.queue.clone();
    blocking(move || q.pause(&job_id)).await
}

#[tauri::command]
async fn job_resume(st: State<'_, AppState>, job_id: String) -> R<Value> {
    let q = st.queue.clone();
    blocking(move || q.resume(&job_id)).await
}

#[tauri::command]
async fn job_retry(st: State<'_, AppState>, job_id: String) -> R<db::Job> {
    db::job_requeue(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &job_id)
}

#[tauri::command]
async fn job_remove(st: State<'_, AppState>, job_id: String) -> R<()> {
    db::job_remove(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &job_id)
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
async fn publish_metadata(st: State<'_, AppState>, project_id: String, video: Option<String>) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    Ok(project::publish_metadata(&root, video.as_deref()))
}

#[tauri::command]
async fn open_path(st: State<'_, AppState>, project_id: String, path: String, reveal: Option<bool>) -> R<()> {
    let root = root_of(&st.db, &project_id)?;
    project::open_path(&root, &path, reveal.unwrap_or(false))
}

/// Pipeline scripts of a project vs. the ones this build carries (read-only plan; nothing is written).
#[tauri::command]
async fn pipeline_status(st: State<'_, AppState>, project_id: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || {
        let plan = pipeline_sync::sync(&root, false, false, false)?;
        let manifest = std::fs::read_to_string(root.join(".studio").join("pipeline.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        Ok(json!({
            "plan": plan,
            "projectBundle": manifest.as_ref().map(|m| m["bundle"].clone()),
            "projectStudioVersion": manifest.as_ref().map(|m| m["studioVersion"].clone()),
            "projectUpdatedAt": manifest.as_ref().map(|m| m["updatedAt"].clone()),
            "buildBundle": pipeline_sync::bundle_sha(),
        }))
    })
    .await
}

/// Studio's own folders (logs, data) — not part of any project, so open_path refuses them.
#[tauri::command]
async fn open_app_dir(which: String) -> R<()> {
    let d = match which.as_str() {
        "logs" => util::logs_dir(),
        "data" => util::data_dir(),
        _ => return Err(format!("unknown folder {which}")),
    };
    let _ = std::fs::create_dir_all(&d);
    #[cfg(windows)]
    let c = std::process::Command::new("explorer.exe").arg(&d).spawn();
    #[cfg(target_os = "macos")]
    let c = std::process::Command::new("open").arg(&d).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let c = std::process::Command::new("xdg-open").arg(&d).spawn();
    c.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn asset_url_allowed(app: tauri::AppHandle, st: State<'_, AppState>, project_id: String) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    let ok = app.asset_protocol_scope().allow_directory(&root, true).is_ok();
    Ok(json!({"allowed": ok}))
}

// ------------------------------------------------------------------ autonomous production

#[tauri::command]
async fn auto_defaults(st: State<'_, AppState>, project_id: Option<String>) -> R<Value> {
    // 擬人化角色可選的參考人聲（專案 tools/CosyVoice/reference 中實際存在的檔案）
    let voices = project_id
        .and_then(|id| db::project_get(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &id).ok())
        .map(|p| autopilot::voice_refs(std::path::Path::new(&p.root_path)))
        .unwrap_or_default();
    Ok(json!({
        "config": autopilot::AutoConfig::default(),
        "stages": autopilot::STAGES.iter().map(|(id, label)| json!({"id": id, "label": label})).collect::<Vec<_>>(),
        "boardSteps": autopilot::BOARD_STEPS.iter().map(|(id, label)| json!({"id": id, "label": label})).collect::<Vec<_>>(),
        "voices": voices,
    }))
}

#[tauri::command]
async fn auto_start(st: State<'_, AppState>, project_id: String, config: Value, hold: Option<bool>) -> R<autopilot::Production> {
    let ap = st.autopilot.clone();
    blocking(move || {
        let cfg: autopilot::AutoConfig = serde_json::from_value(config).map_err(|e| format!("設定格式錯誤：{e}"))?;
        ap.create(&project_id, cfg, hold.unwrap_or(false))
    })
    .await
}

/// 製作狀態頁：每部影片的 11 個步驟、整體進度、目前工作、最新日誌、錯誤、封面與可用操作（全部來自資料庫與工作樹）。
#[tauri::command]
async fn auto_board(app: tauri::AppHandle, st: State<'_, AppState>, project_id: Option<String>, id: Option<String>) -> R<Vec<Value>> {
    let ap = st.autopilot.clone();
    let v = blocking(move || match id {
        Some(id) => {
            let p = autopilot::get(&ap.db.lock().unwrap_or_else(|e| e.into_inner()), &id)?;
            Ok(vec![ap.board_item(&p)])
        }
        None => ap.board(project_id.as_deref(), 200),
    })
    .await?;
    // 封面（工作樹或影片資料夾中的圖片）讓介面可以顯示
    for x in &v {
        if let Some(c) = x["cover"].as_str() {
            if let Some(d) = std::path::Path::new(c).parent() {
                let _ = app.asset_protocol_scope().allow_directory(d, false);
            }
        }
    }
    Ok(v)
}

#[tauri::command]
async fn auto_update_config(st: State<'_, AppState>, id: String, patch: Value) -> R<autopilot::Production> {
    let ap = st.autopilot.clone();
    blocking(move || ap.update_config(&id, patch)).await
}

#[tauri::command]
async fn auto_list(st: State<'_, AppState>, limit: Option<i64>) -> R<Vec<autopilot::Production>> {
    autopilot::list(&st.db.lock().unwrap_or_else(|e| e.into_inner()), limit.unwrap_or(50))
}

#[tauri::command]
async fn auto_get(st: State<'_, AppState>, id: String) -> R<autopilot::Production> {
    autopilot::get(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &id)
}

#[tauri::command]
async fn auto_events(st: State<'_, AppState>, id: String, after_id: Option<i64>, limit: Option<i64>) -> R<Vec<autopilot::PEvent>> {
    autopilot::events(&st.db.lock().unwrap_or_else(|e| e.into_inner()), &id, after_id.unwrap_or(0), limit.unwrap_or(500))
}

#[tauri::command]
async fn auto_control(st: State<'_, AppState>, id: String, action: String) -> R<Value> {
    let ap = st.autopilot.clone();
    blocking(move || {
        let p = match action.as_str() {
            "pause" => ap.pause(&id)?,
            "resume" => ap.resume(&id)?,
            "recover" => ap.recover(&id)?,
            "stop" => ap.stop(&id)?,
            "discard" => ap.discard(&id)?,
            "remove" => {
                ap.remove(&id)?;
                return Ok(json!({"removed": true}));
            }
            "start" => ap.start_draft(&id)?,
            "delete_task" => return ap.delete_task(&id),
            "delete_files" => return ap.delete_files(&id),
            a => return Err(format!("未知的操作 {a}")),
        };
        Ok(serde_json::to_value(p).unwrap())
    })
    .await
}

/// Live monitor for one production (real job logs, render FPS / ETA, AI output, sources, changes, previews).
#[tauri::command]
async fn auto_monitor(app: tauri::AppHandle, st: State<'_, AppState>, id: String) -> R<Value> {
    let ap = st.autopilot.clone();
    let v = blocking(move || ap.monitor(&id)).await?;
    // stills / voice / previews live in the worktree or the project: let the webview load them (asset protocol)
    if let Some(w) = v["worktree"].as_str() {
        let _ = app.asset_protocol_scope().allow_directory(w, true);
    }
    Ok(v)
}

/// Low-resolution storyboard preview (640×360 JPEG key frames) of a production's current state.
#[tauri::command]
async fn auto_preview(st: State<'_, AppState>, id: String) -> R<db::Job> {
    let ap = st.autopilot.clone();
    blocking(move || ap.preview(&id)).await
}

#[tauri::command]
async fn pick_files(title: Option<String>, multi: Option<bool>) -> R<Vec<String>> {
    blocking(move || picker::pick_files(title.as_deref().unwrap_or("選擇素材"), multi.unwrap_or(true))).await
}

/// File facts for the import list (kind detection, size) before a production starts.
#[tauri::command]
async fn asset_probe(paths: Vec<String>) -> R<Vec<Value>> {
    Ok(paths
        .iter()
        .map(|p| {
            let m = std::fs::metadata(p);
            json!({"source": p, "kind": assets::detect_kind(p), "bytes": m.as_ref().map(|m| m.len()).unwrap_or(0), "exists": m.map(|m| m.is_file()).unwrap_or(false)})
        })
        .collect())
}

/// Non-destructive folder migration (dry run unless `apply`).
#[tauri::command]
async fn layout_migrate(st: State<'_, AppState>, project_id: String, apply: Option<bool>) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || layout::migrate(&root, apply.unwrap_or(false))).await
}

/// CosyVoice venv diagnosis (MSIX AppData redirection, missing interpreter) and safe repair.
#[tauri::command]
async fn env_venv(st: State<'_, AppState>, project_id: String, repair: Option<bool>) -> R<Value> {
    let root = root_of(&st.db, &project_id)?;
    blocking(move || {
        let venv = root.join("tools").join("CosyVoice").join(".venv");
        if repair.unwrap_or(false) {
            let r = envfix::repair(&venv);
            Ok(json!({"repair": r.as_ref().ok(), "error": r.err(), "diagnosis": envfix::diagnose(&venv)}))
        } else {
            Ok(json!({"diagnosis": envfix::diagnose(&venv), "studioPackage": envfix::current_package()}))
        }
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


/// Settings needed before any WebView exists (UI GPU choice). Read-only: no migration, no file is
/// created; defaults when the database is missing or unreadable (the splash then shows why).
fn settings_before_ui() -> db::Settings {
    let p = util::data_dir().join("studio.db");
    rusqlite::Connection::open_with_flags(&p, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map(|c| db::settings_get(&c))
        .unwrap_or_default()
}

fn open_data_dir() {
    let d = util::data_dir();
    let _ = std::fs::create_dir_all(&d);
    let _ = platform::open_in_file_manager(&d, false);
}

/// Startup steps shown on the shared Pikara splash (vendor/pikara-splash).
fn splash_config() -> pikara_splash::Config<tauri::Wry> {
    use pikara_splash::Action;
    pikara_splash::Config::new()
        .step("db", "資料庫")
        .step("recover", "工作佇列")
        .step("services", "背景服務")
        .step("projects", "專案")
        .step("env", "環境檢查")
        .slow_action_for("db", Action::new("open_data", "開啟資料夾"))
        .slow_action(Action::quit("結束"))
        .on_action(|_app, id| {
            if id == "open_data" {
                open_data_dir();
            }
        })
}

fn panic_text(p: Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_else(|| "未知的內部錯誤".into())
}

/// Real startup work, on its own thread while the splash shows each step. Nothing waits on purpose.
fn initialize(app: tauri::AppHandle, monitor_init: std::thread::JoinHandle<monitor::Monitor>) {
    use pikara_splash::{Action, Failure, SplashExt};
    let s = app.splash();

    // 1. database (schema migration + verified backup happen inside db::open)
    s.begin("db", "正在開啟資料庫…");
    let db = loop {
        let r = match s.injected_failure("db") {
            Some(e) => Err(e),
            None => open_db(),
        };
        match r {
            Ok(db) => break db,
            Err(e) => {
                let path = util::data_dir().join("studio.db");
                let detail = format!(
                    "{}\n{e}\n\nStudio 不會刪除或覆寫這個檔案；升級前的自動備份在同一資料夾的 backups 內。若另一個程式正在使用它，關閉後按「重試」。",
                    util::clean_path(&path)
                );
                s.fail_blocking(
                    Failure::new("db", "無法開啟 Studio 資料庫", detail)
                        .action(Action::new("open_data", "開啟資料夾"))
                        .action(Action::quit("結束"))
                        .action(Action::primary("retry", "重試")),
                );
                // retry (or re-check after the folder was opened)
            }
        }
    };
    let schema = db::user_version(&db.lock().unwrap_or_else(|e| e.into_inner()));
    s.done_with("db", format!("結構版本 v{schema}"));

    // 2. job queue: only one process may run the queue / autopilot for a data dir (else every job would run twice)
    s.begin("recover", "正在恢復中斷的工作…");
    let handle = app.clone();
    let emit: queue::Emit = Arc::new(move |name: &str, payload: Value| {
        let _ = handle.emit(name, payload);
    });
    let q = Queue::new(db.clone(), emit.clone());
    let mut scheduler_on = false;
    // 介面截圖導覽（PIKARA_UI_TOUR=1）只檢視：不取得佇列鎖，佇列與自動製作都不會啟動，
    // 即使資料庫裡有中斷或排隊中的工作也不會被接續執行。
    let ui_tour = std::env::var("PIKARA_UI_TOUR").ok().as_deref() == Some("1");
    match if ui_tour { Err("介面導覽模式：不執行佇列".to_string()) } else { util::scheduler_lock() } {
        Ok(f) => {
            std::mem::forget(f); // held for the life of the app
            scheduler_on = true;
            loop {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| q.recover())) {
                    Ok(ids) if ids.is_empty() => {
                        s.done_with("recover", "沒有中斷的工作");
                        break;
                    }
                    Ok(ids) => {
                        eprintln!("recovered {} interrupted job(s)", ids.len());
                        s.done_with("recover", format!("已恢復 {} 個中斷的工作", ids.len()));
                        break;
                    }
                    Err(p) => {
                        let f = Failure::new("recover", "無法恢復工作佇列", panic_text(p))
                            .action(Action::new("view_only", "略過，以檢視模式啟動"))
                            .action(Action::quit("結束"))
                            .action(Action::primary("retry", "重試"));
                        if s.fail_blocking(f) == "view_only" {
                            scheduler_on = false;
                            s.skip("recover", "檢視模式：這次不執行佇列");
                            break;
                        }
                    }
                }
            }
            if scheduler_on {
                queue::spawn_scheduler(q.clone());
            }
        }
        Err(e) => {
            eprintln!("{e}");
            s.skip("recover", "另一個 Studio 正在執行佇列，這個視窗只能檢視");
        }
    }
    SCHEDULER_ON.store(scheduler_on, std::sync::atomic::Ordering::Relaxed);

    // 3. background services
    s.begin("services", "正在啟動背景服務…");
    gpu::spawn_sampler();
    watchdog::spawn();
    // started at process start (sysinfo's CPU counters take ~1 s to initialize on Windows); usually done by now
    let mon = Arc::new(monitor_init.join().unwrap_or_else(|_| monitor::Monitor::new()));
    // monitor thread: every 2 s → monitor://sample, metrics table every 10 s
    {
        let (mon, q, db, emit) = (mon.clone(), q.clone(), db.clone(), emit.clone());
        std::thread::Builder::new()
            .name("studio-monitor".into())
            .spawn(move || {
                let mut n = 0u64;
                loop {
                    watchdog::run_loop("monitor", || {
                        watchdog::beat("monitor", "sample");
                        let s = mon.sample(|g| q.check_external(g));
                        let mut v = serde_json::to_value(&s).unwrap_or(Value::Null);
                        if n % 5 == 0 {
                            watchdog::beat("monitor", "metrics → db");
                            let _ = db::metric_add(&db.lock().unwrap_or_else(|e| e.into_inner()), &v);
                        }
                        v["threads"] = watchdog::status();
                        watchdog::beat("monitor", "emit");
                        emit("monitor://sample", v);
                    });
                    n += 1;
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
            })
            .ok();
    }
    let notify_handle = app.clone();
    let notify: Arc<dyn Fn(&str, &str) + Send + Sync> = Arc::new(move |title: &str, body: &str| {
        use tauri_plugin_notification::NotificationExt;
        let _ = notify_handle.notification().builder().title(title).body(body).show();
    });
    let ap = autopilot::Autopilot::new(db.clone(), q.clone(), notify, emit.clone());
    if scheduler_on {
        autopilot::spawn(ap.clone());
    }
    app.manage(AppState { db: db.clone(), queue: q, monitor: mon, autopilot: ap });
    s.done_with("services", if scheduler_on { "佇列與自動製作已啟動" } else { "檢視模式" });

    // 4. projects: allow <video src=convertFileSrc(...)> for registered projects, and check their folders
    s.begin("projects", "正在載入專案…");
    let projects = db::project_list(&db.lock().unwrap_or_else(|e| e.into_inner())).unwrap_or_default();
    let mut missing = vec![];
    let mut synced = vec![];
    for p in &projects {
        let _ = app.asset_protocol_scope().allow_directory(&p.root_path, true);
        if !Path::new(&p.root_path).is_dir() {
            missing.push(p.name.clone());
            continue;
        }
        // jobs run the project's own scripts/: bring them up to this build's pipeline (skipped while a job runs there)
        let busy = db::job_list(&db.lock().unwrap_or_else(|e| e.into_inner()), Some(&p.id), Some("running"), 1).map(|j| !j.is_empty()).unwrap_or(true);
        if !busy {
            match pipeline_sync::sync(Path::new(&p.root_path), true, false, true) {
                Ok(v) if v["changed"].as_array().map(|a| !a.is_empty()).unwrap_or(false) => synced.push(format!("{}：{}", p.name, pipeline_sync::summary(&v))),
                Ok(_) => {}
                Err(e) => synced.push(format!("{}：管線腳本更新失敗（{e}）", p.name)),
            }
        }
    }
    if missing.is_empty() {
        s.done_with("projects", if synced.is_empty() { format!("{} 個專案", projects.len()) } else { format!("{} 個專案；{}", projects.len(), synced.join("；")) });
    } else {
        s.warn("projects", format!("找不到 {} 個專案資料夾：{}", missing.len(), missing.join("、")));
    }

    // 5. quick environment check (the full check stays in 診斷 → 環境醫生). Also warms util::tool's cache.
    s.begin("env", "正在檢查環境…");
    let (ffmpeg, ffprobe, git) = std::thread::scope(|sc| {
        let a = sc.spawn(|| util::tool("ffmpeg").is_some());
        let b = sc.spawn(|| util::tool("ffprobe").is_some());
        let c = sc.spawn(|| util::which("git").is_some());
        (a.join().unwrap_or(false), b.join().unwrap_or(false), c.join().unwrap_or(false))
    });
    let lost: Vec<&str> = [("ffmpeg", ffmpeg), ("ffprobe", ffprobe), ("git", git)].iter().filter(|(_, ok)| !ok).map(|(n, _)| *n).collect();
    if lost.is_empty() {
        s.done_with("env", "ffmpeg・ffprobe・git");
    } else {
        s.warn("env", format!("找不到 {}，相關工作會失敗；可到「診斷 → 環境醫生」修復", lost.join("、")));
    }

    s.backend_done();
}

/// What this executable is (shown by `--version` / `build-info`, checked by scripts/check-ui.mjs).
pub fn build_info() -> studio_cli::BuildInfo {
    studio_cli::BuildInfo {
        version: env!("CARGO_PKG_VERSION"),
        git_commit: env!("PIKARA_GIT_COMMIT"),
        frontend_sha256: Some(env!("PIKARA_FRONTEND_SHA256")),
        frontend_files: match env!("PIKARA_FRONTEND_FILES").parse::<u64>() {
            Ok(n) => n,
            Err(_) => 0,
        },
        gui: true,
    }
}

pub fn run() {
    // v0.3: choose the UI GPU before WebView2 starts (this process only; nothing system-wide is changed)
    let _ = hardware::launch::prepare_ui(&settings_before_ui());
    // full detection (device manager, CUDA) in the background so the window is not delayed
    std::thread::spawn(|| { let _ = std::panic::catch_unwind(hardware::manager::snapshot); });
    // CPU/RAM monitor setup is slow (Windows PDH); overlap it with Tauri + WebView2 startup
    let monitor_init = std::thread::spawn(monitor::Monitor::new);
    // A separate data dir (PIKARA_STUDIO_DATA, tests) is a separate Studio: own WebView2 profile, no single-instance hand-off.
    // 介面截圖導覽（PIKARA_UI_TOUR=1）：與使用者正在使用的 Studio 完全分開——自己的 WebView2 設定檔、不走單一執行個體、
    // 不執行佇列（見 initialize）。
    let ui_tour = std::env::var("PIKARA_UI_TOUR").ok().as_deref() == Some("1");
    if ui_tour && std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", util::data_dir().join("webview2-tour"));
    }
    let separate = ui_tour || std::env::var_os("PIKARA_STUDIO_DATA").is_some();
    if separate && std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", util::data_dir().join("EBWebView"));
    }
    let mut builder = tauri::Builder::default();
    if !separate {
        // A second launch focuses the running window instead of failing on the locked WebView2 profile.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| pikara_splash::focus(app)));
    }
    builder
        .plugin(pikara_splash::init(splash_config()))
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let h = app.handle().clone();
            std::thread::Builder::new().name("studio-init".into()).spawn(move || {
                let h2 = h.clone();
                if let Err(p) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || initialize(h2, monitor_init))) {
                    use pikara_splash::{Action, Failure, SplashExt};
                    let f = Failure { step: None, title: "啟動時發生內部錯誤".into(), detail: panic_text(p), actions: vec![Action::primary(pikara_splash::ACTION_QUIT, "結束")] };
                    h.splash().fail_blocking(f);
                }
            })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info, settings_get, settings_set,
            project_list, project_register, project_remove, project_info, project_create, episode_list, episode_create,
            narration_read, narration_validate, narration_save,
            prompt_tasks, prompt_build,
            claude_detect, claude_install_skill, claude_run, claude_worktrees, claude_worktree_diff, claude_worktree_merge, claude_worktree_discard,
            doctor_run, doctor_fix,
            job_kinds, job_enqueue, job_list, job_get, job_events, job_cancel, job_pause, job_resume, job_retry, job_remove, queue_status, gpu_external_status,
            monitor_sample, job_analyse_with_claude,
            git_log, git_status, git_revert, git_branch_from, git_reset_hard,
            outputs_list, publish_metadata, open_path, open_app_dir, pipeline_status, asset_url_allowed,
            auto_defaults, auto_start, auto_list, auto_get, auto_events, auto_control, auto_board, auto_update_config, agent_check, agent_done,
            workspace_get, line_set, revoice_start, voice_versions, voice_restore, voice_reject, rerender_plan, rerender_start, db_info, db_backup, ui_tour_report, hw_info, hw_usage,
            auto_monitor, auto_preview, pick_files, asset_probe, layout_migrate, env_venv
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pikara Science Studio");
}
