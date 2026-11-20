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
//!   auto-start     --project <dir> --config <json>   (Autonomous Production Mode; topic, minutes, style …)
//!   auto-run       [--timeout <s>]   run queue + autopilot until no production is active; prints every event
//!   auto-list      auto-get --id <p>   auto-pause|auto-resume|auto-stop|auto-discard --id <p>
//!   auto-status    [--id <p>]          short status of one / all productions (next step, task, errors, outputs)
//!   agent-task     --id <p>            the AI task an external agent must do now (agent = external)
//!   agent-done     --id <p> [--failed] [--note <text>]
//!   agent-check    --provider claude|doubao [--deep]   connection / capability test
//!   job-log        --id <job> [--tail <n>]
//!   narration-get  --project <dir> --episode <ep> [--locale zh-TW|zh-CN]
//!   narration-set  --project <dir> --episode <ep> --file <seq.json> [--locale …]   validate + save + git commit
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
        "auto-start" => {
            let (pid, _) = project_id(db, args)?;
            // --config-file is the robust way from Windows PowerShell 5.1 (it strips quotes from native-command arguments)
            let text = match (arg(args, "--config-file"), arg(args, "--config")) {
                (Some(f), _) => read_text_file(&f)?,
                (None, Some(c)) => c,
                _ => return Err("缺少 --config-file <設定.json>（或 --config <json>）".into()),
            };
            let cfg: crate::autopilot::AutoConfig = serde_json::from_str(&text).map_err(|e| format!("設定不是有效 JSON：{e}"))?;
            let p = autopilot(db, q).start(&pid, cfg)?;
            out(&json!({"ok": true, "id": p.id, "episode": p.episode, "status": p.status, "config": p.config}));
            Ok(0)
        }
        "auto-list" => {
            let l = crate::autopilot::list(&db.lock().unwrap(), 50)?;
            out(&json!(l.iter().map(|p| json!({"id": p.id, "episode": p.episode, "topic": p.config.topic, "status": p.status, "stage": p.stage, "attempt": p.attempt, "message": p.message, "warnings": p.warnings, "outputs": p.outputs, "claudeCostUsdEstimate": p.claude_cost_usd})).collect::<Vec<_>>()));
            Ok(0)
        }
        "auto-get" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            out(&serde_json::to_value(crate::autopilot::get(&db.lock().unwrap(), &id)?).unwrap());
            Ok(0)
        }
        "auto-pause" | "auto-resume" | "auto-stop" | "auto-discard" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let ap = autopilot(db, q);
            let p = match cmd {
                "auto-pause" => ap.pause(&id)?,
                "auto-resume" => ap.resume(&id)?,
                "auto-stop" => ap.stop(&id)?,
                _ => ap.discard(&id)?,
            };
            out(&json!({"ok": true, "id": p.id, "status": p.status, "message": p.message}));
            Ok(0)
        }
        "auto-run" => auto_run(args, db, q),
        "auto-status" => {
            let list = crate::autopilot::list(&db.lock().unwrap(), 50)?;
            let want = arg(args, "--id");
            let sel: Vec<&crate::autopilot::Production> = list.iter().filter(|p| want.as_deref().map(|w| p.id == w || p.id.starts_with(w)).unwrap_or(true)).take(if want.is_some() { 1 } else { 10 }).collect();
            if sel.is_empty() {
                return Err("找不到這個製作（用 auto-status 不加 --id 列出全部）".into());
            }
            let mut rows = vec![];
            for p in sel {
                let root = p.project_id.as_deref().and_then(|pid| db::project_get(&db.lock().unwrap(), pid).ok()).map(|x| PathBuf::from(x.root_path));
                let next = match p.status.as_str() {
                    "waiting_agent" => format!("執行 agent-task --id {} 取得任務，完成後 agent-done --id {}", p.id, p.id),
                    "queued" | "running" => "製作進行中：Studio 視窗開著時會自動執行；沒有開 Studio 時執行 auto-run".to_string(),
                    "paused" | "paused_limit" | "failed" | "needs_merge" => format!("看 message；處理後執行 auto-resume --id {}", p.id),
                    "succeeded" => "完成：成品在 outputs（請人工審閱後手動發布）".to_string(),
                    _ => String::new(),
                };
                let job = p.job_id.as_deref().and_then(|j| db::job_get(&db.lock().unwrap(), j).ok());
                rows.push(json!({
                    "id": p.id, "episode": p.episode, "topic": p.config.topic, "agent": p.config.agent, "status": p.status,
                    "stage": p.stage, "stageLabel": crate::autopilot::STAGES.iter().find(|s| s.0 == p.stage).map(|s| s.1), "attempt": p.attempt,
                    "job": job.map(|j| json!({"id": j.id, "label": j.label, "status": j.status, "progress": j.progress, "text": j.progress_text})),
                    "message": p.message, "warnings": p.warnings,
                    "agentTask": p.data.get("agentTask").map(|t| json!({"title": t["title"], "file": t["file"]})),
                    "worktree": p.worktree.as_ref().zip(root.as_ref()).map(|(w, r)| crate::util::clean_path(&crate::jobs::worktree_dir(r, w))),
                    "outputs": p.outputs.iter().map(|o| root.as_ref().map(|r| crate::util::clean_path(&r.join(o))).unwrap_or(o.clone())).collect::<Vec<_>>(),
                    "next": next,
                }));
            }
            out(&json!(rows));
            Ok(0)
        }
        "agent-task" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let p = crate::autopilot::get(&db.lock().unwrap(), &id)?;
            if p.status != "waiting_agent" {
                out(&json!({"ok": false, "status": p.status, "message": format!("目前沒有給 Agent 的任務（狀態：{}）。用 auto-status 查看。", p.status)}));
                return Ok(1);
            }
            let t = &p.data["agentTask"];
            out(&json!({"ok": true, "id": p.id, "episode": p.episode, "stage": p.stage, "mode": p.mode, "title": t["title"], "taskFile": t["file"],
                "workdir": p.worktree.as_ref().and_then(|w| p.project_id.as_deref().and_then(|pid| db::project_get(&db.lock().unwrap(), pid).ok()).map(|x| crate::util::clean_path(&crate::jobs::worktree_dir(std::path::Path::new(&x.root_path), w)))),
                "prompt": t["prompt"], "whenDone": format!("--cli agent-done --id {}", p.id)}));
            Ok(0)
        }
        "agent-done" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let p = autopilot(db, q).agent_done(&id, flag(args, "--failed"), arg(args, "--note").as_deref())?;
            out(&json!({"ok": true, "id": p.id, "status": p.status, "stage": p.stage, "next": "Studio 會接著執行檢查與後續步驟；用 auto-status 追蹤"}));
            Ok(0)
        }
        "agent-check" => {
            let prov = arg(args, "--provider").unwrap_or_else(|| "claude".into());
            let r = crate::agents::check(&prov, flag(args, "--deep"));
            let ok = r["ok"].as_bool().unwrap_or(false);
            out(&r);
            Ok(if ok { 0 } else { 1 })
        }
        "job-log" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let tail: usize = arg(args, "--tail").and_then(|s| s.parse().ok()).unwrap_or(80);
            let j = db::job_get(&db.lock().unwrap(), &id)?;
            let evs = db::events_list(&db.lock().unwrap(), &id, 0, 1_000_000)?;
            let lines: Vec<String> = evs.iter().rev().take(tail).map(|e| format!("[{}|{}] {}", e.stream, e.level, e.line)).collect::<Vec<_>>().into_iter().rev().collect();
            out(&json!({"id": j.id, "label": j.label, "status": j.status, "error": j.error, "logPath": j.log_path, "lines": lines}));
            Ok(0)
        }
        "narration-get" => {
            let (_, root) = project_id(db, args)?;
            let ep = arg(args, "--episode").ok_or("缺少 --episode")?;
            let loc = arg(args, "--locale").unwrap_or_else(|| "zh-TW".into());
            let r = narration::read(&root, &loc)?;
            let seq = r["doc"]["sequences"].get(&ep).cloned().ok_or(format!("{loc} 旁白裡沒有 {ep}"))?;
            out(&seq);
            Ok(0)
        }
        "narration-set" => {
            let (_, root) = project_id(db, args)?;
            let ep = arg(args, "--episode").ok_or("缺少 --episode")?;
            if !episodes::valid_id(&ep) {
                return Err(format!("集數 id 不正確：{ep}"));
            }
            let loc = arg(args, "--locale").unwrap_or_else(|| "zh-TW".into());
            let file = arg(args, "--file").ok_or("缺少 --file <這一集的 JSON>")?;
            let seq: Value = serde_json::from_str(&read_text_file(&file)?).map_err(|e| format!("{file} 不是有效 JSON：{e}"))?;
            let r = narration::read(&root, &loc)?;
            let mut doc = r["doc"].clone();
            doc["sequences"][&ep] = seq;
            let v = narration::validate(&doc);
            let errs: Vec<_> = v.errors.iter().filter(|e| e.seq_key == ep).collect();
            if !errs.is_empty() {
                out(&json!({"ok": false, "errors": errs}));
                return Ok(1);
            }
            let sha = r["sha256"].as_str().unwrap_or("").to_string();
            let saved = narration::save(&root, &loc, &doc, &sha, Some(&format!("narration {ep} ({loc}) via Studio CLI")))?;
            out(&json!({"ok": true, "saved": saved, "warnings": v.warnings.iter().filter(|w| w.seq_key == ep).count()}));
            Ok(0)
        }
        "" => Err("缺少指令。可用：episode-list、episode-new、validate、project-new、doctor、enqueue、run-queue、jobs、job-retry、job-cancel、recover".into()),
        c => Err(format!("未知的指令：{c}")),
    }
}

/// Read a UTF-8 text file, tolerating the BOM Windows PowerShell 5.1 writes (`Set-Content -Encoding utf8`).
fn read_text_file(f: &str) -> Result<String, String> {
    let s = std::fs::read_to_string(f).map_err(|e| format!("讀不到 {f}：{e}"))?;
    Ok(s.trim_start_matches('\u{feff}').to_string())
}

fn autopilot(db: &Db, q: &Arc<Queue>) -> Arc<crate::autopilot::Autopilot> {
    let notify: Arc<dyn Fn(&str, &str) + Send + Sync> = Arc::new(|t: &str, b: &str| println!("[{}] 🔔 {t}：{b}", now()));
    crate::autopilot::Autopilot::new(db.clone(), q.clone(), notify, Arc::new(|_, _| {}))
}

/// The app's two background loops (queue scheduler + autopilot) in the foreground, until no production is active.
fn auto_run(args: &[String], db: &Db, q: &Arc<Queue>) -> Result<i32, String> {
    let _lock = crate::util::scheduler_lock()?;
    let timeout = Duration::from_secs(arg(args, "--timeout").and_then(|s| s.parse().ok()).unwrap_or(24 * 3600));
    let ap = autopilot(db, q);
    let rec = q.recover();
    if !rec.is_empty() {
        println!("[{}] 復原 {} 個中斷的工作", now(), rec.len());
    }
    let t0 = Instant::now();
    let mut last_hb = Instant::now();
    let mut last_pev: HashMap<String, i64> = HashMap::new();
    let mut last_job: HashMap<String, (String, i64, Option<String>)> = HashMap::new();
    let mut last_jev: HashMap<String, i64> = HashMap::new();
    loop {
        q.tick();
        ap.tick();
        if last_hb.elapsed() >= Duration::from_secs(crate::queue::HEARTBEAT_SECS) {
            q.heartbeat();
            last_hb = Instant::now();
        }
        let prods = crate::autopilot::list(&db.lock().unwrap(), 50)?;
        for p in &prods {
            let after = *last_pev.get(&p.id).unwrap_or(&0);
            let evs = crate::autopilot::events(&db.lock().unwrap(), &p.id, after, 1000)?;
            for e in &evs {
                println!("[{}] {} {:<9} {:<5} {}", now(), p.episode.to_uppercase(), e.stage, e.level, e.line.chars().take(600).collect::<String>());
            }
            if let Some(e) = evs.last() {
                last_pev.insert(p.id.clone(), e.id);
            }
            if let Some(jid) = &p.job_id {
                let j = db::job_get(&db.lock().unwrap(), jid);
                if let Ok(j) = j {
                    let key = (j.status.clone(), j.step, j.progress_text.clone());
                    if last_job.get(jid) != Some(&key) {
                        println!("[{}]     job {} {:<10} {:>5.1}%  {}  {}", now(), &j.id[..8], j.status, j.progress * 100.0, j.label, j.progress_text.clone().unwrap_or_default());
                        last_job.insert(jid.clone(), key);
                    }
                    let a = *last_jev.get(jid).unwrap_or(&0);
                    let evs = db::events_list(&db.lock().unwrap(), jid, a, 2000).unwrap_or_default();
                    for e in &evs {
                        if e.level != "info" || e.line.starts_with("Claude:") || e.line.starts_with("[tool]") || e.line.starts_with("[done]") {
                            println!("            [{}|{}] {}", e.stream, e.level, e.line.chars().take(300).collect::<String>());
                        }
                    }
                    if let Some(l) = evs.last() {
                        last_jev.insert(jid.clone(), l.id);
                    }
                }
            }
        }
        // keep going while a production is active or a job it started is still running (paused productions finish their job)
        let n_running = db::job_list(&db.lock().unwrap(), None, Some("running"), 10)?.len();
        let n_pending = db::jobs_pending(&db.lock().unwrap())?.len(); // separate statements: one DB lock at a time
        let jobs_running = n_running + n_pending;
        let active = prods.iter().filter(|p| ["queued", "running"].contains(&p.status.as_str())).count() + jobs_running;
        if active == 0 {
            break;
        }
        if t0.elapsed() > timeout {
            println!("[{}] 逾時（{} 秒）", now(), timeout.as_secs());
            return Ok(3);
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
    let prods = crate::autopilot::list(&db.lock().unwrap(), 50)?;
    out(&json!(prods.iter().take(5).map(|p| json!({"id": p.id, "episode": p.episode, "status": p.status, "message": p.message, "warnings": p.warnings, "outputs": p.outputs, "activeMinutes": p.active_ms / 60000, "claudeRuns": p.claude_runs, "claudeCostUsdEstimate": p.claude_cost_usd, "stages": p.stages.iter().map(|s| json!({"id": s.id, "status": s.status, "attempts": s.attempts, "note": s.note})).collect::<Vec<_>>()})).collect::<Vec<_>>()));
    Ok(if prods.first().map(|p| p.status == "succeeded").unwrap_or(false) { 0 } else { 1 })
}

fn now() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

/// Run the real scheduler (recover → tick/heartbeat loop) until no job is queued, waiting or running.
fn run_queue(args: &[String], db: &Db, q: &Arc<Queue>) -> Result<i32, String> {
    let _lock = crate::util::scheduler_lock()?;
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
