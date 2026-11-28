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
//!   job-pause      --id <job>        job-resume --id <job>   suspend / continue the job's whole process tree
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
//!   auto-monitor   --id <p> [--brief]  live view: running job + log, render FPS / frames / ETA, AI output, sources,
//!                                      file changes, script, stills, voice files, error / fix history
//!   auto-preview   --id <p>            queue a low-resolution storyboard preview (12 key frames, 640×360)
//!   layout-migrate --project <dir> [--apply]   non-destructive move of legacy root outputs into projects/EPnn/
//!   env-venv       --project <dir> [--repair]  CosyVoice venv diagnosis (MSIX AppData redirection) / safe repair
//! v0.3:
//!   workspace      --root <dir> --episode <ep> [--locale zh-TW|zh-CN]   stages, files, status, versions
//!   line-set       --root <dir> --episode <ep> --line <id> [--subtitle <t>] [--speak <t>] [--locale …]
//!   voice-promote  --root <dir> --episode <ep> --batch <id> [--lines "a b"] [--force] [--review]
//!   voice-versions --root <dir> --episode <ep> [--line <id>]    voice-restore --line <id> --version <n>
//!   output-promote --root <dir> --episode <ep> --file <mp4>      rerender-plan --root … --params <json>
//!   db-backups     db-backup     db-restore --from <backup>  (Studio must be closed)
//!   hardware       read-only machine profile, GPU snapshot, device assignment, power-mode budgets (no DB access)
//!   build-info     version + SHA-256 of the embedded frontend (no database)
//! ```
//! auto-start config (v0.2.1): mode auto|guided|script, brief (Markdown), chapters [..], mustInclude, mustAvoid,
//! opening, ending, voiceTone, animationStyle, pacing, scriptText, language zh-TW|zh-CN|both|en, minSources,
//! assets [{source, kind?, note?}], sandbox (TEST number, delivered to sandbox/, never merged).
//! `--data` isolates the queue (PIKARA_STUDIO_DATA); default is the app's real data dir.
//! Prints JSON (one object per command) or, for run-queue, one line per status change. Exit 0 = success.

use studio_core::db::{self, Db};
use studio_core::queue::Queue;
use studio_core::{episodes, narration};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
    let pr = studio_core::register_project(db, &p)?;
    Ok((pr.id.clone(), PathBuf::from(pr.root_path)))
}

pub fn run(args: &[String], info: &crate::BuildInfo) -> i32 {
    if let Some(d) = arg(args, "--data") {
        std::env::set_var("PIKARA_STUDIO_DATA", d);
    }
    let cmd = args.iter().position(|a| a == "--cli").and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
    // hardware: read-only report — never opens (or migrates) any database, writes nothing; safe on CI runners
    if cmd == "hardware" {
        let snap = studio_core::hardware::manager::snapshot();
        let assign = studio_core::hardware::selector::select(&snap, &db::Settings::default().hw);
        out(&json!({"ok": true,
            "platform": {"os": studio_core::platform::OS, "arch": studio_core::platform::ARCH, "nodePlatform": studio_core::platform::NODE_PLATFORM,
                         "packagedContainer": studio_core::platform::packaged_container(), "dataDir": studio_core::util::data_dir(), "cacheDir": studio_core::util::cache_dir()},
            "machine": studio_core::hardware::profile::report(), "snapshot": snap, "assignment": assign}));
        return 0;
    }
    // build-info: which version and which embedded frontend this exe contains (release guard, scripts/check-ui.mjs);
    // read-only, no database
    if cmd == "build-info" {
        out(&json!({"version": info.version, "gitCommit": info.git_commit, "frontendSha256": info.frontend_sha256,
                    "frontendFiles": info.frontend_files, "gui": info.gui, "os": studio_core::platform::OS, "arch": studio_core::platform::ARCH,
                    "pipelineBundle": studio_core::pipeline_sync::bundle_sha(), "pipelineFiles": studio_core::pipeline_sync::FILES.len()}));
        return 0;
    }
    // pipeline-sync --project <dir> [--check] [--force]: bring a project's scripts/ up to this build (no database)
    if cmd == "pipeline-sync" {
        let Some(root) = arg(args, "--project").or_else(|| arg(args, "--root")) else {
            out(&json!({"ok": false, "command": cmd, "error": "缺少 --project <專案資料夾>"}));
            return 1;
        };
        let check = args.iter().any(|a| a == "--check");
        return match studio_core::pipeline_sync::sync(Path::new(&root), !check, args.iter().any(|a| a == "--force"), true) {
            Ok(v) => {
                let pending = check && v["changed"].as_array().map(|a| !a.is_empty()).unwrap_or(false);
                out(&v);
                i32::from(pending)
            }
            Err(e) => {
                out(&json!({"ok": false, "command": cmd, "error": e}));
                1
            }
        };
    }
    // restore must not open (and migrate) the database it is about to replace
    if cmd == "db-restore" {
        let r = arg(args, "--from").ok_or_else(|| "缺少 --from <備份檔>".to_string()).and_then(|b| db::restore(&studio_core::util::data_dir().join("studio.db"), Path::new(&b)));
        return match r {
            Ok(v) => {
                out(&json!({"ok": true, "result": v}));
                0
            }
            Err(e) => {
                out(&json!({"ok": false, "command": cmd, "error": e}));
                1
            }
        };
    }
    let db: Db = match studio_core::open_db() {
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

fn ep_of(args: &[String]) -> Result<studio_core::pipeline::Ep, String> {
    let root = arg(args, "--root").or_else(|| arg(args, "--project")).ok_or("缺少 --root <專案資料夾>")?;
    let root = std::fs::canonicalize(&root).map_err(|e| format!("{root}：{e}"))?;
    studio_core::pipeline::Ep::new(Path::new(&studio_core::util::clean_path(&root)), &arg(args, "--episode").ok_or("缺少 --episode")?, &arg(args, "--locale").unwrap_or_else(|| "zh-TW".into()))
}

/// v0.3 commands (workspace, re-voice, re-render, versions, database backup).
fn dispatch_v03(cmd: &str, args: &[String], db: &Db) -> Option<Result<i32, String>> {
    let conn = || db.lock().unwrap_or_else(|e| e.into_inner());
    let r = (|| -> Result<i32, String> {
        match cmd {
            "workspace" => {
                let ep = ep_of(args)?;
                let c = conn();
                let s = db::settings_get(&c);
                out(&json!({"ok": true, "workspace": studio_core::pipeline::workspace(&c, &ep, &s)?}));
            }
            "line-set" => {
                let ep = ep_of(args)?;
                let r = studio_core::rerender::line_set(&ep.root, &ep.locale, &ep.id, &arg(args, "--line").ok_or("缺少 --line")?, arg(args, "--subtitle").as_deref(), arg(args, "--speak").as_deref())?;
                out(&json!({"ok": true, "result": r}));
            }
            "voice-promote" => {
                // queue step after a re-voice: validate each candidate, switch the good ones (old audio archived first)
                let ep = ep_of(args)?;
                let batch = arg(args, "--batch").ok_or("缺少 --batch")?;
                let job = arg(args, "--job");
                let force = flag(args, "--force");
                let only: Option<Vec<String>> = arg(args, "--lines").map(|s| s.split_whitespace().map(String::from).collect());
                let c = conn();
                let r = if flag(args, "--review") {
                    // keep every candidate for listening in Voice Studio; current audio untouched
                    studio_core::pipeline::promote_batch(&c, &ep, &batch, Some(&[]), false, job.as_deref()).map(|_| json!({"review": true}))?;
                    let dir = ep.candidate_dir(&batch);
                    let n = std::fs::read_dir(&dir).map(|d| d.flatten().filter(|e| e.path().extension().map(|x| x == "mp3").unwrap_or(false)).count()).unwrap_or(0);
                    println!("已產生 {n} 個候選音檔，等待在語音工作室試聽後決定（目前的配音沒有改變）");
                    json!({"review": true, "candidates": n, "dir": studio_core::util::clean_path(&dir)})
                } else {
                    let r = studio_core::pipeline::promote_batch(&c, &ep, &batch, only.as_deref(), force, job.as_deref())?;
                    for x in r["results"].as_array().cloned().unwrap_or_default() {
                        if x["ok"] == true {
                            println!("  ✓ {} 已切換為新版本 v{}（舊版 v{} 保留）", x["line"].as_str().unwrap_or(""), x["version"], x["previousVersion"]);
                        } else {
                            println!("  ✗ {} 未切換：{}（目前的配音保留不變）", x["line"].as_str().unwrap_or(""), x["error"].as_str().unwrap_or(""));
                        }
                    }
                    r
                };
                let failed = r["failed"].as_u64().unwrap_or(0);
                let promoted = r["promoted"].as_u64().unwrap_or(0);
                out(&json!({"ok": failed == 0, "result": r}));
                if failed > 0 {
                    eprintln!("[錯誤] {failed} 句沒有通過驗證，維持舊版配音（已切換 {promoted} 句）。請到語音工作室試聽候選版本後決定。");
                    return Ok(3);
                }
            }
            "voice-restore" => {
                let ep = ep_of(args)?;
                let v: i64 = arg(args, "--version").ok_or("缺少 --version")?.trim_start_matches('v').parse().map_err(|_| "--version 必須是數字")?;
                let r = studio_core::pipeline::restore_voice(&conn(), &ep, &arg(args, "--line").ok_or("缺少 --line")?, v, None)?;
                out(&json!({"ok": true, "result": r}));
            }
            "voice-versions" => {
                let ep = ep_of(args)?;
                out(&json!({"ok": true, "versions": studio_core::pipeline::voice_versions(&conn(), &ep, arg(args, "--line").as_deref())}));
            }
            "output-promote" => {
                let ep = ep_of(args)?;
                let f = arg(args, "--file").ok_or("缺少 --file")?;
                let p = if Path::new(&f).is_absolute() { PathBuf::from(&f) } else { ep.root.join(&f) };
                let enc: Value = arg(args, "--encode").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
                let c = conn();
                let r = studio_core::pipeline::promote_output(&c, &ep, &p, arg(args, "--job").as_deref(), &json!({"encode": enc}))?;
                println!("新影片：{}（舊版保留為 v{}）", r["output"].as_str().unwrap_or(""), r["previousVersion"]);
                out(&json!({"ok": true, "result": r}));
            }
            "rerender-plan" => {
                let ep = ep_of(args)?;
                let p: Value = arg(args, "--params").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
                let c = conn();
                let s = db::settings_get(&c);
                out(&json!({"ok": true, "plan": studio_core::rerender::plan(&c, &ep, &p, &s)?}));
            }
            "hw-info" => {
                let c = conn();
                let s = db::settings_get(&c);
                drop(c);
                let root = arg(args, "--project").map(PathBuf::from);
                out(&json!({"ok": true, "hardware": studio_core::hardware::selector::info(&s, root.as_deref(), flag(args, "--redetect"))}));
            }
            "hw-usage" => {
                // which GPU each role really uses (GPU Engine counters); --ui-root <Studio PID> for a running window
                let ms = arg(args, "--ms").and_then(|v| v.parse().ok()).unwrap_or(1500);
                let root = arg(args, "--ui-root").and_then(|v| v.parse().ok()).unwrap_or(std::process::id());
                out(&json!({"ok": true, "usage": studio_core::hardware::selector::usage(ms, root)}));
            }
            "gpu-lease" => out(&json!({"ok": true, "lease": studio_core::gpulock::status()})),
            "auto-check" => {
                // read-only: check a production's current narration against its requirements with the current checker
                let p = studio_core::autopilot::get(&conn(), &arg(args, "--id").ok_or("缺少 --id")?)?;
                let pr = db::project_get(&conn(), p.project_id.as_deref().unwrap_or(""))?;
                let wt = studio_core::jobs::worktree_dir(Path::new(&pr.root_path), p.worktree.as_deref().ok_or("沒有工作樹")?);
                let doc = narration::read(&wt, "zh-TW")?;
                let seq = doc["doc"]["sequences"][&p.episode].clone();
                let rep = studio_core::content::requirements_report(&p.config, &seq);
                out(&json!({"ok": rep.failed == 0, "episode": p.episode, "worktree": studio_core::util::clean_path(&wt), "report": rep}));
            }
            "settings-set" => {
                // merge a JSON patch into the settings (same as the Settings page), e.g. {"hw":{"uiGpu":"discrete",…}}
                let patch: Value = serde_json::from_str(&arg(args, "--json").ok_or("缺少 --json")?).map_err(|e| format!("--json：{e}"))?;
                out(&json!({"ok": true, "settings": db::settings_merge(&conn(), &patch)?}));
            }
            "db-backups" => out(&json!({"ok": true, "schemaVersion": db::user_version(&conn()), "latest": db::schema_version(), "backups": db::backups(&studio_core::util::data_dir().join("studio.db"))})),
            "db-backup" => {
                let c = conn();
                let v = db::user_version(&c);
                let b = db::backup_verified(&c, &studio_core::util::data_dir().join("studio.db"), v, "manual")?;
                out(&json!({"ok": true, "backup": b}));
            }
            _ => return Err("__not_v03__".into()),
        }
        Ok(0)
    })();
    match r {
        Err(e) if e == "__not_v03__" => None,
        other => Some(other),
    }
}

fn dispatch(cmd: &str, args: &[String], db: &Db, q: &Arc<Queue>) -> Result<i32, String> {
    if let Some(r) = dispatch_v03(cmd, args, db) {
        return r;
    }
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
            let r = studio_core::create_episode(&root, &title, arg(args, "--id").as_deref(), arg(args, "--scene-title").as_deref(), arg(args, "--first-line").as_deref(), Some(locales))?;
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
            let r = studio_core::create_project(db, &dest, &title, tpl.as_deref(), !flag(args, "--no-link-tools"))?;
            out(&json!({"ok": true, "result": r}));
            Ok(0)
        }
        "doctor" => {
            let (pid, _) = project_id(db, args)?;
            let r = studio_core::doctor_report(db, q, Some(&pid), false)?;
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
            let list = db::job_list(&db.lock().unwrap_or_else(|e| e.into_inner()), pid.as_deref(), None, limit)?;
            out(&json!(list.iter().map(|j| json!({"id": j.id, "kind": j.kind, "label": j.label, "status": j.status, "step": j.step, "steps": j.steps.len(), "attempt": j.attempt, "pid": j.pid, "progress": j.progress, "exitCode": j.exit_code, "error": j.error, "logPath": j.log_path})).collect::<Vec<_>>()));
            Ok(0)
        }
        "job-retry" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let j = db::job_requeue(&db.lock().unwrap_or_else(|e| e.into_inner()), &id)?;
            out(&json!({"ok": true, "id": j.id, "status": j.status, "step": j.step, "attempt": j.attempt}));
            Ok(0)
        }
        "job-cancel" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let j = q.cancel(&id)?;
            out(&json!({"ok": true, "id": j.id, "status": j.status}));
            Ok(0)
        }
        "job-pause" | "job-resume" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let r = if cmd == "job-pause" { q.pause(&id)? } else { q.resume(&id)? };
            out(&json!({"ok": true, "id": id, "result": r}));
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
            let cfg: studio_core::autopilot::AutoConfig = serde_json::from_str(&text).map_err(|e| format!("設定不是有效 JSON：{e}"))?;
            let p = autopilot(db, q).create(&pid, cfg, args.iter().any(|a| a == "--hold"))?;
            out(&json!({"ok": true, "id": p.id, "episode": p.episode, "status": p.status, "config": p.config}));
            Ok(0)
        }
        // 製作狀態頁的資料（11 個步驟、進度、目前工作、日誌、錯誤、可用操作）；--id 只看一部
        "auto-board" => {
            let ap = autopilot(db, q);
            let v = match arg(args, "--id") {
                Some(id) => {
                    // 先放開資料庫鎖再組狀態（board_item 自己會讀資料庫）
                    let p = studio_core::autopilot::get(&db.lock().unwrap_or_else(|e| e.into_inner()), &id)?;
                    vec![ap.board_item(&p)]
                }
                None => ap.board(None, 50)?,
            };
            out(&json!(v));
            Ok(0)
        }
        "auto-start-draft" | "auto-delete-task" | "auto-delete-files" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let ap = autopilot(db, q);
            let v = match cmd {
                "auto-start-draft" => serde_json::to_value(ap.start_draft(&id)?).unwrap(),
                "auto-delete-task" => ap.delete_task(&id)?,
                _ => ap.delete_files(&id)?,
            };
            out(&json!({"ok": true, "result": v}));
            Ok(0)
        }
        "auto-update-config" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let text = match (arg(args, "--patch-file"), arg(args, "--patch")) {
                (Some(f), _) => read_text_file(&f)?,
                (None, Some(c)) => c,
                _ => return Err("缺少 --patch-file <patch.json>".into()),
            };
            let patch: Value = serde_json::from_str(&text).map_err(|e| format!("patch 不是有效 JSON：{e}"))?;
            let p = autopilot(db, q).update_config(&id, patch)?;
            out(&json!({"ok": true, "status": p.status, "config": p.config}));
            Ok(0)
        }
        "auto-list" => {
            let l = studio_core::autopilot::list(&db.lock().unwrap_or_else(|e| e.into_inner()), 50)?;
            out(&json!(l.iter().map(|p| json!({"id": p.id, "episode": p.episode, "topic": p.config.topic, "status": p.status, "stage": p.stage, "attempt": p.attempt, "message": p.message, "warnings": p.warnings, "outputs": p.outputs, "claudeCostUsdEstimate": p.claude_cost_usd})).collect::<Vec<_>>()));
            Ok(0)
        }
        "auto-get" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            out(&serde_json::to_value(studio_core::autopilot::get(&db.lock().unwrap_or_else(|e| e.into_inner()), &id)?).unwrap());
            Ok(0)
        }
        "auto-pause" | "auto-resume" | "auto-recover" | "auto-stop" | "auto-discard" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let ap = autopilot(db, q);
            let p = match cmd {
                "auto-pause" => ap.pause(&id)?,
                "auto-resume" => ap.resume(&id)?,
                "auto-recover" => ap.recover(&id)?,
                "auto-stop" => ap.stop(&id)?,
                _ => ap.discard(&id)?,
            };
            out(&json!({"ok": true, "id": p.id, "status": p.status, "message": p.message}));
            Ok(0)
        }
        "auto-run" => auto_run(args, db, q),
        "auto-status" => {
            let list = studio_core::autopilot::list(&db.lock().unwrap_or_else(|e| e.into_inner()), 50)?;
            let want = arg(args, "--id");
            let sel: Vec<&studio_core::autopilot::Production> = list.iter().filter(|p| want.as_deref().map(|w| p.id == w || p.id.starts_with(w)).unwrap_or(true)).take(if want.is_some() { 1 } else { 10 }).collect();
            if sel.is_empty() {
                return Err("找不到這個製作（用 auto-status 不加 --id 列出全部）".into());
            }
            let mut rows = vec![];
            for p in sel {
                let root = p.project_id.as_deref().and_then(|pid| db::project_get(&db.lock().unwrap_or_else(|e| e.into_inner()), pid).ok()).map(|x| PathBuf::from(x.root_path));
                let next = match p.status.as_str() {
                    "waiting_agent" => format!("執行 agent-task --id {} 取得任務，完成後 agent-done --id {}", p.id, p.id),
                    "queued" | "running" => "製作進行中：Studio 視窗開著時會自動執行；沒有開 Studio 時執行 auto-run".to_string(),
                    "paused" | "paused_limit" | "failed" | "needs_merge" => format!("看 message；處理後執行 auto-resume --id {}", p.id),
                    "succeeded" => "完成：成品在 outputs（請人工審閱後手動發布）".to_string(),
                    _ => String::new(),
                };
                let job = p.job_id.as_deref().and_then(|j| db::job_get(&db.lock().unwrap_or_else(|e| e.into_inner()), j).ok());
                let activity = job.as_ref().map(|j| autopilot(db, q).activity(p, j));
                rows.push(json!({
                    "activity": activity,
                    "id": p.id, "episode": p.episode, "topic": p.config.topic, "agent": p.config.agent, "status": p.status,
                    "stage": p.stage, "stageLabel": studio_core::autopilot::STAGES.iter().find(|s| s.0 == p.stage).map(|s| s.1), "attempt": p.attempt,
                    "job": job.map(|j| json!({"id": j.id, "label": j.label, "status": j.status, "progress": j.progress, "text": j.progress_text})),
                    "message": p.message, "warnings": p.warnings,
                    "agentTask": p.data.get("agentTask").map(|t| json!({"title": t["title"], "file": t["file"]})),
                    "worktree": p.worktree.as_ref().zip(root.as_ref()).map(|(w, r)| studio_core::util::clean_path(&studio_core::jobs::worktree_dir(r, w))),
                    "outputs": p.outputs.iter().map(|o| root.as_ref().map(|r| studio_core::util::clean_path(&r.join(o))).unwrap_or(o.clone())).collect::<Vec<_>>(),
                    "next": next,
                }));
            }
            out(&json!(rows));
            Ok(0)
        }
        "agent-task" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let p = studio_core::autopilot::get(&db.lock().unwrap_or_else(|e| e.into_inner()), &id)?;
            if p.status != "waiting_agent" {
                out(&json!({"ok": false, "status": p.status, "message": format!("目前沒有給 Agent 的任務（狀態：{}）。用 auto-status 查看。", p.status)}));
                return Ok(1);
            }
            let t = &p.data["agentTask"];
            out(&json!({"ok": true, "id": p.id, "episode": p.episode, "stage": p.stage, "mode": p.mode, "title": t["title"], "taskFile": t["file"],
                "workdir": p.worktree.as_ref().and_then(|w| p.project_id.as_deref().and_then(|pid| db::project_get(&db.lock().unwrap_or_else(|e| e.into_inner()), pid).ok()).map(|x| studio_core::util::clean_path(&studio_core::jobs::worktree_dir(std::path::Path::new(&x.root_path), w)))),
                "prompt": t["prompt"], "whenDone": format!("--cli agent-done --id {}", p.id)}));
            Ok(0)
        }
        "agent-done" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let p = autopilot(db, q).agent_done(&id, flag(args, "--failed"), arg(args, "--note").as_deref())?;
            out(&json!({"ok": true, "id": p.id, "status": p.status, "stage": p.stage, "next": "Studio 會接著執行檢查與後續步驟；用 auto-status 追蹤"}));
            Ok(0)
        }
        // UI test bridge: the same backend functions the Tauri commands call, read-only subset, for driving the real
        // web UI in a browser against real data (no second Studio window, no scheduler lock).
        "ui-invoke" => {
            let name = arg(args, "--cmd").ok_or("缺少 --cmd")?;
            let a: Value = match arg(args, "--args-file") {
                Some(f) => serde_json::from_str(&read_text_file(&f)?).map_err(|e| e.to_string())?,
                None => json!({}),
            };
            let s = |k: &str| a.get(k).and_then(|v| v.as_str()).map(String::from).unwrap_or_default();
            let root_of = |pid: &str| studio_core::db::project_get(&db.lock().unwrap_or_else(|e| e.into_inner()), pid).map(|p| PathBuf::from(p.root_path));
            let v: Value = match name.as_str() {
                "app_info" => json!({"version": env!("CARGO_PKG_VERSION"), "dataDir": studio_core::util::data_dir(), "schedulerActive": false, "uiBridge": true}),
                "project_list" => serde_json::to_value(studio_core::db::project_list(&db.lock().unwrap_or_else(|e| e.into_inner()))?).unwrap(),
                "project_info" => serde_json::to_value(studio_core::project::info(&studio_core::db::project_get(&db.lock().unwrap_or_else(|e| e.into_inner()), &s("projectId"))?)).unwrap(),
                "queue_status" => q.status(),
                "claude_detect" => studio_core::claude::detect(),
                "auto_defaults" => json!({"config": studio_core::autopilot::AutoConfig::default(), "stages": studio_core::autopilot::STAGES.iter().map(|(id, l)| json!({"id": id, "label": l})).collect::<Vec<_>>()}),
                "auto_list" => serde_json::to_value(studio_core::autopilot::list(&db.lock().unwrap_or_else(|e| e.into_inner()), a["limit"].as_i64().unwrap_or(50))?).unwrap(),
                "auto_get" => serde_json::to_value(studio_core::autopilot::get(&db.lock().unwrap_or_else(|e| e.into_inner()), &s("id"))?).unwrap(),
                "auto_events" => serde_json::to_value(studio_core::autopilot::events(&db.lock().unwrap_or_else(|e| e.into_inner()), &s("id"), a["afterId"].as_i64().unwrap_or(0), a["limit"].as_i64().unwrap_or(500))?).unwrap(),
                "auto_monitor" => autopilot(db, q).monitor(&s("id"))?,
                "asset_probe" => json!(a["paths"].as_array().cloned().unwrap_or_default().iter().filter_map(|p| p.as_str()).map(|p| {
                    let m = std::fs::metadata(p);
                    json!({"source": p, "kind": studio_core::assets::detect_kind(p), "bytes": m.as_ref().map(|m| m.len()).unwrap_or(0), "exists": m.map(|m| m.is_file()).unwrap_or(false)})
                }).collect::<Vec<_>>()),
                "layout_migrate" => studio_core::layout::migrate(&root_of(&s("projectId"))?, false)?, // dry run only through the bridge
                "asset_url_allowed" => json!({"allowed": true}),
                "episode_list" => studio_core::episodes::list(&root_of(&s("projectId"))?),
                other => return Err(format!("ui-invoke 不支援 {other}（只提供唯讀指令）")),
            };
            out(&v);
            Ok(0)
        }
        "auto-monitor" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let full = studio_core::autopilot::get(&db.lock().unwrap_or_else(|e| e.into_inner()), &id)?.id;
            let mut v = autopilot(db, q).monitor(&full)?;
            if flag(args, "--brief") {
                for k in ["jobLines", "script", "voice", "stills"] {
                    if let Some(a) = v[k].as_array() {
                        v[k] = json!(format!("（{} 項）", a.len()));
                    } else if !v[k].is_null() {
                        v[k] = json!("（省略）");
                    }
                }
                if let Some(a) = v["ai"]["lines"].as_array().cloned() {
                    v["ai"]["lines"] = json!(a.into_iter().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>());
                }
            }
            out(&v);
            Ok(0)
        }
        "auto-preview" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let full = studio_core::autopilot::get(&db.lock().unwrap_or_else(|e| e.into_inner()), &id)?.id;
            let j = autopilot(db, q).preview(&full)?;
            out(&json!({"ok": true, "job": j.id, "label": j.label, "next": "用 run-queue 或開著的 Studio 執行；完成後 out/preview/ 有 640×360 關鍵幀"}));
            Ok(0)
        }
        "layout-migrate" => {
            let (_, root) = project_id(&db, args)?;
            let r = studio_core::layout::migrate(&root, flag(args, "--apply"))?;
            println!("{}", r["report"].as_str().unwrap_or(""));
            Ok(if r["errors"].as_array().map(|a| a.is_empty()).unwrap_or(true) { 0 } else { 1 })
        }
        "env-venv" => {
            let (_, root) = project_id(&db, args)?;
            let venv = root.join("tools").join("CosyVoice").join(".venv");
            if flag(args, "--repair") {
                let r = studio_core::envfix::repair(&venv);
                out(&json!({"ok": r.is_ok(), "repair": r.as_ref().ok(), "error": r.as_ref().err(), "diagnosis": studio_core::envfix::diagnose(&venv)}));
                Ok(if r.is_ok() { 0 } else { 1 })
            } else {
                let d = studio_core::envfix::diagnose(&venv);
                let ok = d.problem.is_none();
                out(&json!({"ok": ok, "diagnosis": d, "studioPackage": studio_core::envfix::current_package()}));
                Ok(if ok { 0 } else { 1 })
            }
        }
        "agent-check" => {
            let prov = arg(args, "--provider").unwrap_or_else(|| "claude".into());
            let r = studio_core::agents::check(&prov, flag(args, "--deep"));
            let ok = r["ok"].as_bool().unwrap_or(false);
            out(&r);
            Ok(if ok { 0 } else { 1 })
        }
        "job-log" => {
            let id = arg(args, "--id").ok_or("缺少 --id")?;
            let tail: usize = arg(args, "--tail").and_then(|s| s.parse().ok()).unwrap_or(80);
            let j = db::job_get(&db.lock().unwrap_or_else(|e| e.into_inner()), &id)?;
            let evs = db::events_list(&db.lock().unwrap_or_else(|e| e.into_inner()), &id, 0, 1_000_000)?;
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

fn autopilot(db: &Db, q: &Arc<Queue>) -> Arc<studio_core::autopilot::Autopilot> {
    let notify: Arc<dyn Fn(&str, &str) + Send + Sync> = Arc::new(|t: &str, b: &str| println!("[{}] 🔔 {t}：{b}", now()));
    studio_core::autopilot::Autopilot::new(db.clone(), q.clone(), notify, Arc::new(|_, _| {}))
}

/// The app's two background loops (queue scheduler + autopilot) in the foreground, until no production is active.
fn auto_run(args: &[String], db: &Db, q: &Arc<Queue>) -> Result<i32, String> {
    let _lock = studio_core::util::scheduler_lock()?;
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
        if last_hb.elapsed() >= Duration::from_secs(studio_core::queue::HEARTBEAT_SECS) {
            q.heartbeat();
            last_hb = Instant::now();
        }
        let prods = studio_core::autopilot::list(&db.lock().unwrap_or_else(|e| e.into_inner()), 50)?;
        for p in &prods {
            let after = *last_pev.get(&p.id).unwrap_or(&0);
            let evs = studio_core::autopilot::events(&db.lock().unwrap_or_else(|e| e.into_inner()), &p.id, after, 1000)?;
            for e in &evs {
                println!("[{}] {} {:<9} {:<5} {}", now(), p.episode.to_uppercase(), e.stage, e.level, e.line.chars().take(600).collect::<String>());
            }
            if let Some(e) = evs.last() {
                last_pev.insert(p.id.clone(), e.id);
            }
            if let Some(jid) = &p.job_id {
                let j = db::job_get(&db.lock().unwrap_or_else(|e| e.into_inner()), jid);
                if let Ok(j) = j {
                    let key = (j.status.clone(), j.step, j.progress_text.clone());
                    if last_job.get(jid) != Some(&key) {
                        println!("[{}]     job {} {:<10} {:>5.1}%  {}  {}", now(), &j.id[..8], j.status, j.progress * 100.0, j.label, j.progress_text.clone().unwrap_or_default());
                        last_job.insert(jid.clone(), key);
                    }
                    let a = *last_jev.get(jid).unwrap_or(&0);
                    let evs = db::events_list(&db.lock().unwrap_or_else(|e| e.into_inner()), jid, a, 2000).unwrap_or_default();
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
        let n_running = db::job_list(&db.lock().unwrap_or_else(|e| e.into_inner()), None, Some("running"), 10)?.len();
        let n_pending = db::jobs_pending(&db.lock().unwrap_or_else(|e| e.into_inner()))?.len(); // separate statements: one DB lock at a time
        let jobs_running = n_running + n_pending;
        let active = prods.iter().filter(|p| ["queued", "running"].contains(&p.status.as_str())).count() + jobs_running;
        // --stay：像 Studio 視窗一樣持續執行（草稿、等待 Agent、暫停時也不結束），直到 --timeout
        if active == 0 && !flag(args, "--stay") {
            break;
        }
        if t0.elapsed() > timeout {
            println!("[{}] 逾時（{} 秒）", now(), timeout.as_secs());
            return Ok(3);
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
    let prods = studio_core::autopilot::list(&db.lock().unwrap_or_else(|e| e.into_inner()), 50)?;
    out(&json!(prods.iter().take(5).map(|p| json!({"id": p.id, "episode": p.episode, "status": p.status, "message": p.message, "warnings": p.warnings, "outputs": p.outputs, "activeMinutes": p.active_ms / 60000, "claudeRuns": p.claude_runs, "claudeCostUsdEstimate": p.claude_cost_usd, "stages": p.stages.iter().map(|s| json!({"id": s.id, "status": s.status, "attempts": s.attempts, "note": s.note})).collect::<Vec<_>>()})).collect::<Vec<_>>()));
    Ok(if prods.first().map(|p| p.status == "succeeded").unwrap_or(false) { 0 } else { 1 })
}

fn now() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

/// Run the real scheduler (recover → tick/heartbeat loop) until no job is queued, waiting or running.
fn run_queue(args: &[String], db: &Db, q: &Arc<Queue>) -> Result<i32, String> {
    let _lock = studio_core::util::scheduler_lock()?;
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
    let mut touched: Vec<String> = db::jobs_pending(&db.lock().unwrap_or_else(|e| e.into_inner()))?.into_iter().map(|j| j.id).collect();
    touched.extend(rec.iter().cloned());
    let mut last_hb = Instant::now();
    let shown = Mutex::new(());
    loop {
        q.tick();
        if last_hb.elapsed() >= Duration::from_secs(studio_core::queue::HEARTBEAT_SECS) {
            q.heartbeat();
            last_hb = Instant::now();
        }
        let jobs = db::job_list(&db.lock().unwrap_or_else(|e| e.into_inner()), None, None, 500)?;
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
            if let Ok(evs) = db::events_list(&db.lock().unwrap_or_else(|e| e.into_inner()), &j.id, after, 2000) {
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
    let jobs = db::job_list(&db.lock().unwrap_or_else(|e| e.into_inner()), None, None, 500)?;
    let mine: Vec<&db::Job> = jobs.iter().filter(|j| touched.contains(&j.id)).collect();
    let failed = mine.iter().filter(|j| j.status != "succeeded").count();
    out(&json!({
        "ok": failed == 0,
        "seconds": t0.elapsed().as_secs(),
        "jobs": mine.iter().map(|j| json!({"id": j.id, "kind": j.kind, "label": j.label, "status": j.status, "attempt": j.attempt, "error": j.error})).collect::<Vec<_>>()
    }));
    Ok(if failed == 0 { 0 } else { 1 })
}

/// Commands of this dispatcher (the new front end passes these through without `--cli`).
const COMMANDS: &[&str] = &[
    "agent-check", "agent-done", "agent-task", "auto-board", "auto-check", "auto-delete-files", "auto-delete-task", "auto-discard", "auto-get",
    "auto-list", "auto-monitor", "auto-pause", "auto-preview", "auto-recover", "auto-resume", "auto-run", "auto-start", "auto-start-draft",
    "auto-status", "auto-stop", "auto-update-config", "build-info", "db-backup", "db-backups", "db-restore", "enqueue", "env-venv", "episode-list",
    "episode-new", "gpu-lease", "hardware", "hw-info", "hw-usage", "job-cancel", "job-log", "job-pause", "job-resume", "job-retry", "layout-migrate",
    "line-set", "narration-get", "narration-set", "output-promote", "pipeline-sync", "project-new", "recover", "rerender-plan", "run-queue",
    "settings-set", "ui-invoke", "validate", "voice-promote", "voice-restore", "voice-versions", "workspace",
];

pub fn knows(cmd: &str) -> bool {
    COMMANDS.contains(&cmd)
}
