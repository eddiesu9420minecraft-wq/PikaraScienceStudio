//! Headless command line for the real Studio backend (same DB, queue, scheduler, job commands as the app):
//!
//! ```text
//! PikaraScienceStudio.exe --cli <command> [--data <studio data dir>] ...
//!   episode-list   --project <dir>
//!   episode-new    --project <dir> --title <t> [--id ep02] [--scene-title <t>] [--first-line <t>] [--locale zh-TW|zh-CN|both]
//!   validate       --project <dir> [--locale zh-TW|zh-CN]
//!   project-new    --dest <dir> --title <t> [--template <dir>] [--no-link-tools]
//!   doctor         --project <dir>
//!   enqueue        --project <dir> --kind <kind> [--params <json>]
//!   run-queue      [--timeout <s>] [--verbose]      run the scheduler until nothing is queued/running
//!   jobs           [--project <dir>] [--limit n]
//!   job-retry      --id <job>        job-cancel --id <job>        recover
//! ```
//! `--data` isolates the queue (PIKARA_STUDIO_DATA); default is the app's real data dir.
//! Prints JSON (one object per command) or, for run-queue, one line per status change. Exit 0 = success.

use crate::db::{self, Db};
use crate::queue::Queue;
use crate::{episodes, narration};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn arg(args: &[String], k: &str) -> Option<String> {
    args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned()
}
fn flag(args: &[String], k: &str) -> bool {
    args.iter().any(|a| a == k)
}

fn out(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap());
}

fn project_id(db: &Db, args: &[String]) -> Result<(String, PathBuf), String> {
    let p = arg(args, "--project").ok_or("缺少 --project <專案資料夾>")?;
    let pr = crate::register_project(db, &p)?;
    Ok((pr.id.clone(), PathBuf::from(pr.root_path)))
}

pub fn run(args: &[String]) -> i32 {
    if let Some(d) = arg(args, "--data") {
        std::env::set_var("PIKARA_STUDIO_DATA", d);
    }
    let cmd = args.iter().position(|a| a == "--cli").and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
    let db: Db = match crate::open_db() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("無法開啟 Studio 資料庫：{e}");
            return 2;
        }
    };
    let q = Queue::new(db.clone(), Arc::new(|_, _| {}));
    let r = dispatch(&cmd, args, &db, &q);
    match r {
        Ok(code) => code,
        Err(e) => {
            out(&json!({"ok": false, "command": cmd, "error": e}));
            1
        }
    }
}

fn dispatch(cmd: &str, args: &[String], db: &Db, q: &Arc<Queue>) -> Result<i32, String> {
    match cmd {
        "episode-list" => {
            let (_, root) = project_id(db, args)?;
            out(&json!({"ok": true, "episodes": episodes::list(&root)}));
            Ok(0)
        }
        "episode-new" => {
            let (_, root) = project_id(db, args)?;
            let title = arg(args, "--title").ok_or("缺少 --title")?;
            let locales = match arg(args, "--locale").as_deref() {
                None | Some("zh-TW") => vec!["zh-TW".to_string()],
                Some("zh-CN") => vec!["zh-CN".to_string()],
                Some("both") => vec!["zh-TW".to_string(), "zh-CN".to_string()],
                Some(x) => return Err(format!("--locale 必須是 zh-TW、zh-CN 或 both（收到 {x}）")),
            };
            let r = crate::create_episode(&root, &title, arg(args, "--id").as_deref(), arg(args, "--scene-title").as_deref(), arg(args, "--first-line").as_deref(), Some(locales))?;
            out(&json!({"ok": true, "result": r}));
            Ok(0)
        }
        "validate" => {
            let (_, root) = project_id(db, args)?;
            let locs: Vec<String> = arg(args, "--locale").map(|l| vec![l]).unwrap_or_else(|| vec!["zh-TW".into(), "zh-CN".into()]);
            let mut res = json!({});
            let mut ok = true;
            for l in locs {
                match narration::read(&root, &l) {
                    Ok(r) => {
                        let v = narration::validate(&r["doc"]);
                        ok &= v.ok;
                        res[&l] = json!({"ok": v.ok, "errors": v.errors, "warnings": v.warnings.len(), "sequences": r["sequences"].as_array().map(|a| a.iter().map(|s| s["key"].clone()).collect::<Vec<_>>())});
                    }
                    Err(e) => res[&l] = json!({"ok": false, "error": e}),
                }
            }
            out(&json!({"ok": ok, "validation": res}));
            Ok(if ok { 0 } else { 1 })
        }
        "project-new" => {
            let dest = arg(args, "--dest").ok_or("缺少 --dest <新專案資料夾>")?;
            let title = arg(args, "--title").ok_or("缺少 --title")?;
            let tpl = arg(args, "--template").map(PathBuf::from).or_else(|| std::env::current_dir().ok());
            let r = crate::create_project(db, &dest, &title, tpl.as_deref(), !flag(args, "--no-link-tools"))?;
            out(&json!({"ok": true, "result": r}));
            Ok(0)
        }
        "doctor" => {
            let (pid, _) = project_id(db, args)?;
            let r = crate::doctor_report(db, q, Some(&pid), false)?;
            let lines: Vec<String> = r["checks"].as_array().unwrap().iter().map(|c| format!("{:<6} {:<16} {}", c["status"].as_str().unwrap_or(""), c["id"].as_str().unwrap_or(""), c["detail"].as_str().unwrap_or(""))).collect();
            for l in &lines {
                println!("{l}");
            }
            let errors = r["checks"].as_array().unwrap().iter().filter(|c| c["status"] == "error").count();
            out(&json!({"ok": true, "errors": errors, "checks": r["checks"].as_array().map(|a| a.len())}));
            Ok(0)
        }
        "enqueue" => {
            let (pid, root) = project_id(db, args)?;
            let kind = arg(args, "--kind").ok_or("缺少 --kind")?;
            let params: Value = match arg(args, "--params") {
                Some(p) => serde_json::from_str(&p).map_err(|e| format!("--params 不是有效 JSON：{e}"))?,
                None => json!({}),
            };
            if kind == "claude" || kind == "doctor_fix" {
                return Err(format!("{kind} 不能從 CLI 排入"));
            }
            let j = q.enqueue(Some(&pid), &kind, &params, &root)?;
            out(&json!({"ok": true, "job": {"id": j.id, "kind": j.kind, "label": j.label, "resource": j.resource, "steps": j.steps, "params": j.params}}));
            Ok(0)
        }
        "jobs" => {
            let pid = match arg(args, "--project") {
                Some(_) => Some(project_id(db, args)?.0),
                None => None,
            };
            let limit = arg(args, "--limit").and_then(|s| s.parse().ok()).unwrap_or(50);
            let list = db::job_list(&db.lock().unwrap(), pid.as_deref(), None, limit)?;
            out(&json!(list.iter().map(|j| json!({"id": j.id, "kind": j.kind, "label": j.label, "status": j.status, "step": j.step, "steps": j.steps.len(), "attempt": j.attempt, "progress": j.progress, "exitCode": j.exit_code, "error": j.error, "logPath": j.log_path})).collect::<Vec<_>>()));
            Ok(0)
        }
        "job-retry" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let j = db::job_requeue(&db.lock().unwrap(), &id)?;
            out(&json!({"ok": true, "id": j.id, "status": j.status, "step": j.step, "attempt": j.attempt}));
            Ok(0)
        }
        "job-cancel" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let j = q.cancel(&id)?;
            out(&json!({"ok": true, "id": j.id, "status": j.status}));
            Ok(0)
        }
        "recover" => {
            let ids = q.recover();
            out(&json!({"ok": true, "recovered": ids}));
            Ok(0)
        }
        "run-queue" => run_queue(args, db, q),
        "" => Err("缺少指令。可用：episode-list、episode-new、validate、project-new、doctor、enqueue、run-queue、jobs、job-retry、job-cancel、recover".into()),
        c => Err(format!("未知的指令：{c}")),
    }
}

fn now() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

/// Run the real scheduler (recover → tick/heartbeat loop) until no job is queued, waiting or running.
fn run_queue(args: &[String], db: &Db, q: &Arc<Queue>) -> Result<i32, String> {
    let timeout = Duration::from_secs(arg(args, "--timeout").and_then(|s| s.parse().ok()).unwrap_or(4 * 3600));
    let verbose = flag(args, "--verbose");
    let rec = q.recover();
    if !rec.is_empty() {
        println!("[{}] 復原 {} 個中斷的工作：{}", now(), rec.len(), rec.iter().map(|i| &i[..8]).collect::<Vec<_>>().join(", "));
    }
    let t0 = Instant::now();
    let mut seen: HashMap<String, (String, i64, Option<String>)> = HashMap::new();
    let mut last_ev: HashMap<String, i64> = HashMap::new();
    // every job that is pending when we start belongs to this run (some fail in the very first tick, e.g. preflight)
    let mut touched: Vec<String> = db::jobs_pending(&db.lock().unwrap())?.into_iter().map(|j| j.id).collect();
    touched.extend(rec.iter().cloned());
    let mut last_hb = Instant::now();
    let shown = Mutex::new(());
    loop {
        q.tick();
        if last_hb.elapsed() >= Duration::from_secs(crate::queue::HEARTBEAT_SECS) {
            q.heartbeat();
            last_hb = Instant::now();
        }
        let jobs = db::job_list(&db.lock().unwrap(), None, None, 500)?;
        let active: Vec<&db::Job> = jobs.iter().filter(|j| ["queued", "waiting_resource", "running"].contains(&j.status.as_str())).collect();
        let watch: Vec<&db::Job> = jobs.iter().filter(|j| active.iter().any(|a| a.id == j.id) || touched.contains(&j.id)).collect();
        for j in watch {
            if !touched.contains(&j.id) {
                touched.push(j.id.clone());
            }
            let key = (j.status.clone(), j.step, j.progress_text.clone());
            if seen.get(&j.id) != Some(&key) {
                let _g = shown.lock();
                let st = if j.status == "waiting_resource" { format!("waiting（{}）", j.wait_reason.clone().unwrap_or_default()) } else { j.status.clone() };
                println!(
                    "[{}] {} {:<10} 步驟 {}/{} {:>5.1}%  {}  {}{}",
                    now(),
                    &j.id[..8],
                    st,
                    (j.step + 1).min(j.steps.len().max(1) as i64),
                    j.steps.len().max(1),
                    j.progress * 100.0,
                    j.label,
                    j.progress_text.clone().unwrap_or_default(),
                    j.error.as_ref().map(|e| format!("\n            錯誤：{e}")).unwrap_or_default()
                );
                seen.insert(j.id.clone(), key);
            }
            // stream log lines (system + warn/error, or everything with --verbose)
            let after = *last_ev.get(&j.id).unwrap_or(&0);
            if let Ok(evs) = db::events_list(&db.lock().unwrap(), &j.id, after, 2000) {
                for e in &evs {
                    if verbose || e.stream == "system" || e.level != "info" {
                        println!("            [{}|{}] {}", e.stream, e.level, e.line.chars().take(400).collect::<String>());
                    }
                }
                if let Some(l) = evs.last() {
                    last_ev.insert(j.id.clone(), l.id);
                }
            }
        }
        if active.is_empty() {
            break;
        }
        if t0.elapsed() > timeout {
            println!("[{}] 逾時（{} 秒），仍有 {} 個工作未完成", now(), timeout.as_secs(), active.len());
            return Ok(3);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let jobs = db::job_list(&db.lock().unwrap(), None, None, 500)?;
    let mine: Vec<&db::Job> = jobs.iter().filter(|j| touched.contains(&j.id)).collect();
    let failed = mine.iter().filter(|j| j.status != "succeeded").count();
    out(&json!({
        "ok": failed == 0,
        "seconds": t0.elapsed().as_secs(),
        "jobs": mine.iter().map(|j| json!({"id": j.id, "kind": j.kind, "label": j.label, "status": j.status, "attempt": j.attempt, "error": j.error})).collect::<Vec<_>>()
    }));
    Ok(if failed == 0 { 0 } else { 1 })
}
