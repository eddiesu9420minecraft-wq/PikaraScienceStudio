//! Pikara Science Studio command line.
//!
//! The same binary code serves three front ends:
//! - Linux: the `PikaraScienceStudio` executable is this CLI only (no WebView, X11, Wayland or desktop needed).
//! - Windows / macOS: the GUI executable runs this CLI when its first argument is a command
//!   (`PikaraScienceStudio status`, `PikaraScienceStudio nogui run`, …) and opens the window otherwise.
//! - `--cli <command>`: the older automation commands (see [`legacy`]), unchanged, for existing scripts and agents.
//!
//! Every command works on the same database, queue, scheduler, settings and validation code as the GUI
//! (`studio_core`). Output is readable zh-TW text, or one JSON object (`--json`; NDJSON for `--follow` and `run`).
//! Exit codes are fixed and documented in [`exit`] and `docs/CLI.md`.

pub mod legacy;

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use studio_core::autopilot::{self, Autopilot, Production};
use studio_core::db::{self, Db};
use studio_core::queue::Queue;

/// What the running executable is (filled in by the binary that links this crate).
#[derive(Clone, Copy, Debug)]
pub struct BuildInfo {
    pub version: &'static str,
    pub git_commit: &'static str,
    /// SHA-256 of the embedded web frontend (GUI builds only).
    pub frontend_sha256: Option<&'static str>,
    pub frontend_files: u64,
    /// true when this executable can also open the GUI window.
    pub gui: bool,
}

/// Exit codes (stable; scripts and AI agents rely on them).
pub mod exit {
    pub const OK: i32 = 0;
    /// The command ran but failed (invalid state for the action, a check failed, a job could not be queued …).
    pub const FAILED: i32 = 1;
    /// Bad command line (unknown command, missing or invalid argument).
    pub const USAGE: i32 = 2;
    /// The production, job or project does not exist.
    pub const NOT_FOUND: i32 = 3;
    /// `doctor`: at least one required tool or check is in error.
    pub const ENV: i32 = 4;
    /// Another Studio (window or `run`) already runs the queue for this data folder.
    pub const BUSY: i32 = 5;
    /// `--timeout` reached before the work finished.
    pub const TIMEOUT: i32 = 6;
    /// The production / job that was waited for ended failed or canceled.
    pub const PRODUCTION_FAILED: i32 = 7;
    /// The Studio database cannot be opened.
    pub const DB: i32 = 10;
    /// Interrupted (Ctrl-C / SIGTERM); running jobs are left resumable (`run` recovers them).
    pub const INTERRUPTED: i32 = 130;
}

/// Commands this front end understands (anything else falls through to the legacy `--cli` dispatcher).
const VERBS: &[&str] = &[
    "help", "version", "doctor", "hardware", "create", "start", "run", "status", "list", "pause", "resume", "cancel", "retry", "logs",
    "render", "revoice", "config", "agent", "project", "build-info", "jobs",
];

/// Should this argument list run the CLI instead of opening a window?
pub fn wants_cli(args: &[String]) -> bool {
    let first = args.iter().skip(1).find(|a| !a.starts_with("-psn_")); // macOS Finder adds -psn_…
    match first.map(String::as_str) {
        None => false,
        Some("--cli" | "--help" | "-h" | "--version" | "-V" | "nogui" | "--nogui") => true,
        Some(a) if a.starts_with("--data") || a == "--json" => true,
        Some(a) => VERBS.contains(&a),
    }
}

struct Ctx {
    json: bool,
    quiet: bool,
    info: BuildInfo,
    /// positional words after the verb
    pos: Vec<String>,
    /// all remaining arguments (flags included), for `opt` / `flag`
    rest: Vec<String>,
}

impl Ctx {
    fn opt(&self, k: &str) -> Option<String> {
        self.rest.iter().position(|a| a == k).and_then(|i| self.rest.get(i + 1)).cloned()
    }
    fn flag(&self, k: &str) -> bool {
        self.rest.iter().any(|a| a == k)
    }
    fn id(&self) -> Result<String, Fail> {
        self.pos.first().cloned().or_else(|| self.opt("--id")).ok_or_else(|| Fail::usage("缺少製作 ID（例：status 1a2b3c4d；用 list 查看）"))
    }
    fn say(&self, s: impl AsRef<str>) {
        if !self.json && !self.quiet {
            println!("{}", s.as_ref());
        }
    }
    fn emit(&self, v: &Value) {
        if self.json {
            println!("{}", serde_json::to_string(v).unwrap_or_default());
        }
    }
}

struct Fail {
    code: i32,
    msg: String,
}
impl Fail {
    fn new(code: i32, msg: impl Into<String>) -> Self {
        Fail { code, msg: msg.into() }
    }
    fn usage(msg: impl Into<String>) -> Self {
        Fail::new(exit::USAGE, msg)
    }
}
impl From<String> for Fail {
    fn from(e: String) -> Self {
        let code = if e.contains("找不到") || e.contains("not found") || e.contains("no rows") { exit::NOT_FOUND } else { exit::FAILED };
        Fail::new(code, e)
    }
}
type R<T> = Result<T, Fail>;

/// Entry point. `args[0]` is the executable.
pub fn run(args: &[String], info: BuildInfo) -> i32 {
    if args.iter().any(|a| a == "--cli") {
        return legacy::run(args, &info);
    }
    // global flags may appear anywhere
    let mut json = false;
    let mut quiet = false;
    let mut words: Vec<String> = vec![];
    let mut it = args.iter().skip(1).filter(|a| !a.starts_with("-psn_")).peekable();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--json" => json = true,
            "--quiet" | "-q" => quiet = true,
            "nogui" | "--nogui" => {}
            "--data" => match it.next() {
                Some(d) => std::env::set_var("PIKARA_STUDIO_DATA", d),
                None => return usage_error(json, "--data 需要資料夾路徑"),
            },
            "--help" | "-h" if words.is_empty() => words.push("help".into()),
            "--version" | "-V" if words.is_empty() => words.push("version".into()),
            _ => words.push(a.clone()),
        }
    }
    let verb = if words.is_empty() { "help".to_string() } else { words.remove(0) };
    let pos: Vec<String> = {
        // positional words: those before the first flag, skipping flag values
        let mut v = vec![];
        for w in &words {
            if w.starts_with("--") {
                break;
            }
            v.push(w.clone());
        }
        v
    };
    let ctx = Ctx { json, quiet, info, pos, rest: words.clone() };
    if words.iter().any(|w| w == "--help" || w == "-h") {
        print_help(Some(&verb));
        return exit::OK;
    }
    let r = match verb.as_str() {
        "help" => {
            print_help(ctx.pos.first().map(String::as_str));
            Ok(exit::OK)
        }
        "version" => cmd_version(&ctx),
        "build-info" => {
            let mut a = vec![args[0].clone(), "--cli".into(), "build-info".into()];
            a.extend(words);
            return legacy::run(&a, &info);
        }
        "hardware" => {
            let a = vec![args[0].clone(), "--cli".into(), "hardware".into()];
            return legacy::run(&a, &info);
        }
        v if VERBS.contains(&v) => with_db(&ctx, &verb),
        // older command names (episode-list, auto-board, voice-promote …) keep working without --cli
        _ => {
            let mut a = vec![args[0].clone(), "--cli".into(), verb.clone()];
            a.extend(words);
            if !legacy::knows(&verb) {
                return usage_error(json, &format!("未知的指令「{verb}」。執行 PikaraScienceStudio --help 查看可用指令"));
            }
            return legacy::run(&a, &info);
        }
    };
    match r {
        Ok(c) => c,
        Err(f) => {
            if json {
                println!("{}", json!({"ok": false, "command": verb, "error": f.msg, "exitCode": f.code}));
            } else {
                eprintln!("錯誤：{}", f.msg);
            }
            f.code
        }
    }
}

fn usage_error(json: bool, msg: &str) -> i32 {
    if json {
        println!("{}", json!({"ok": false, "error": msg, "exitCode": exit::USAGE}));
    } else {
        eprintln!("錯誤：{msg}");
    }
    exit::USAGE
}

fn cmd_version(ctx: &Ctx) -> R<i32> {
    let v = json!({"name": "PikaraScienceStudio", "version": ctx.info.version, "gitCommit": ctx.info.git_commit,
        "os": studio_core::platform::OS, "arch": studio_core::platform::ARCH, "gui": ctx.info.gui});
    if ctx.json {
        ctx.emit(&v);
    } else {
        println!("Pikara Science Studio {} ({}，{}/{}，{})", ctx.info.version, short(ctx.info.git_commit), studio_core::platform::OS, studio_core::platform::ARCH, if ctx.info.gui { "GUI＋CLI" } else { "CLI" });
    }
    Ok(exit::OK)
}

fn short(s: &str) -> &str {
    &s[..s.len().min(12)]
}

// ------------------------------------------------------------------ commands that need the database

struct Env {
    db: Db,
    q: Arc<Queue>,
}

impl Env {
    fn conn(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn ap(&self, verbose: bool) -> Arc<Autopilot> {
        let notify: Arc<dyn Fn(&str, &str) + Send + Sync> =
            if verbose { Arc::new(|t: &str, b: &str| eprintln!("[通知] {t}：{b}")) } else { Arc::new(|_: &str, _: &str| {}) };
        Autopilot::new(self.db.clone(), self.q.clone(), notify, Arc::new(|_, _| {}))
    }
    /// Production by full id or unique prefix.
    fn production(&self, id: &str) -> R<Production> {
        if let Ok(p) = autopilot::get(&self.conn(), id) {
            return Ok(p);
        }
        let all = autopilot::list(&self.conn(), 100_000)?;
        let m: Vec<Production> = all.into_iter().filter(|p| p.id.starts_with(id)).collect();
        match m.len() {
            1 => Ok(m.into_iter().next().unwrap()),
            0 => Err(Fail::new(exit::NOT_FOUND, format!("找不到製作「{id}」（用 list 查看）"))),
            n => Err(Fail::usage(format!("「{id}」符合 {n} 個製作，請多打幾個字元"))),
        }
    }
    fn project_root(&self, p: &Production) -> R<PathBuf> {
        let pid = p.project_id.as_deref().ok_or_else(|| Fail::new(exit::NOT_FOUND, "這個製作沒有對應的專案"))?;
        Ok(PathBuf::from(db::project_get(&self.conn(), pid)?.root_path))
    }
}

fn with_db(ctx: &Ctx, verb: &str) -> R<i32> {
    let db = studio_core::open_db().map_err(|e| Fail::new(exit::DB, format!("無法開啟 Studio 資料庫：{e}")))?;
    let q = Queue::new(db.clone(), Arc::new(|_, _| {}));
    let env = Env { db, q };
    match verb {
        "doctor" => cmd_doctor(ctx, &env),
        "create" => cmd_create(ctx, &env),
        "start" => control(ctx, &env, "start"),
        "pause" => control(ctx, &env, "pause"),
        "resume" => control(ctx, &env, "resume"),
        "cancel" => control(ctx, &env, "cancel"),
        "retry" => control(ctx, &env, "retry"),
        "list" => cmd_list(ctx, &env),
        "status" => cmd_status(ctx, &env),
        "logs" => cmd_logs(ctx, &env),
        "run" => cmd_run(ctx, &env, None),
        "render" | "revoice" => cmd_redo(ctx, &env, verb),
        "config" => cmd_config(ctx, &env),
        "agent" => cmd_agent(ctx, &env),
        "project" => cmd_project(ctx, &env),
        "jobs" => cmd_jobs(ctx, &env),
        _ => Err(Fail::usage(format!("未知的指令 {verb}"))),
    }
}

fn cmd_doctor(ctx: &Ctx, env: &Env) -> R<i32> {
    let pid = match ctx.opt("--project") {
        Some(p) => Some(studio_core::register_project(&env.db, &p)?.id),
        None => None,
    };
    let r = studio_core::doctor_report(&env.db, &env.q, pid.as_deref(), ctx.flag("--gpu-tests"))?;
    let checks = r["checks"].as_array().cloned().unwrap_or_default();
    let errors = checks.iter().filter(|c| c["status"] == "error").count();
    let warns = checks.iter().filter(|c| c["status"] == "warn").count();
    if ctx.json {
        ctx.emit(&json!({"ok": errors == 0, "errors": errors, "warnings": warns, "checks": checks,
            "platform": {"os": studio_core::platform::OS, "arch": studio_core::platform::ARCH}}));
    } else {
        for c in &checks {
            let mark = match c["status"].as_str() {
                Some("ok") => "✓",
                Some("warn") => "!",
                _ => "✗",
            };
            println!("{mark} {:<22} {}", c["label"].as_str().unwrap_or(""), c["detail"].as_str().unwrap_or("").lines().next().unwrap_or(""));
        }
        println!("\n{} 項錯誤、{} 項警告（{}/{}）", errors, warns, studio_core::platform::OS, studio_core::platform::ARCH);
    }
    Ok(if errors > 0 { exit::ENV } else { exit::OK })
}

/// `create --project <dir> --topic <t> [...]` — the same production configuration as the GUI's 新影片 page.
fn cmd_create(ctx: &Ctx, env: &Env) -> R<i32> {
    let project = ctx.opt("--project").ok_or_else(|| Fail::usage("缺少 --project <專案資料夾>"))?;
    let mut cfg: Value = match ctx.opt("--config") {
        Some(f) => serde_json::from_str(&read_text(&f)?).map_err(|e| Fail::usage(format!("--config 不是有效 JSON：{e}")))?,
        None => json!({}),
    };
    let set = |cfg: &mut Value, k: &str, v: Value| cfg[k] = v;
    if let Some(t) = ctx.opt("--topic") {
        set(&mut cfg, "topic", json!(t));
    }
    if let Some(m) = ctx.opt("--minutes") {
        set(&mut cfg, "minutes", json!(m.parse::<f64>().map_err(|_| Fail::usage("--minutes 必須是數字"))?));
    }
    for (flag, key) in [("--style", "style"), ("--language", "language"), ("--agent", "agent"), ("--mode", "mode"), ("--narrative", "narrative"), ("--brief", "brief")] {
        if let Some(v) = ctx.opt(flag) {
            set(&mut cfg, key, json!(v));
        }
    }
    if let Some(f) = ctx.opt("--script-file") {
        set(&mut cfg, "scriptText", json!(read_text(&f)?));
        if cfg.get("mode").is_none() {
            set(&mut cfg, "mode", json!("script"));
        }
    }
    for (flag, key, val) in [("--no-youtube", "youtube", false), ("--no-thumbnail", "thumbnail", false), ("--no-publish-info", "publishInfo", false), ("--no-visual-review", "visualReview", false), ("--sandbox", "sandbox", true)] {
        if ctx.flag(flag) {
            set(&mut cfg, key, json!(val));
        }
    }
    if cfg["topic"].as_str().map(str::trim).unwrap_or("").is_empty() {
        return Err(Fail::usage("缺少 --topic <主題>（或在 --config 檔案裡設定 topic）"));
    }
    let cfg: autopilot::AutoConfig = serde_json::from_value(cfg).map_err(|e| Fail::usage(format!("製作設定無效：{e}")))?;
    let pr = studio_core::register_project(&env.db, &project)?;
    let draft = ctx.flag("--draft");
    let p = env.ap(false).create(&pr.id, cfg, draft)?;
    if ctx.json {
        ctx.emit(&json!({"ok": true, "id": p.id, "episode": p.episode, "status": p.status, "project": pr.root_path}));
    } else {
        println!("已建立製作 {}（{}，{}）", short(&p.id), p.episode.to_uppercase(), p.status);
        if draft {
            println!("草稿：執行 PikaraScienceStudio start {} 開始製作", short(&p.id));
        } else if !ctx.flag("--wait") {
            println!("Studio 視窗或 `PikaraScienceStudio run` 會執行它；用 `status {} --follow` 追蹤", short(&p.id));
        }
    }
    if ctx.flag("--wait") && !draft {
        return cmd_run(ctx, env, Some(Target::Production(p.id)));
    }
    Ok(exit::OK)
}

fn control(ctx: &Ctx, env: &Env, action: &str) -> R<i32> {
    let p = env.production(&ctx.id()?)?;
    let ap = env.ap(false);
    let r = match action {
        "start" => ap.start_draft(&p.id)?,
        "pause" => ap.pause(&p.id)?,
        "resume" => ap.resume(&p.id)?,
        "cancel" => ap.stop(&p.id)?,
        // failed / needs merge → a fresh set of attempts; running / paused with a job → restart the current step
        _ => match p.status.as_str() {
            "failed" | "needs_merge" | "canceled" | "paused" | "paused_limit" => ap.resume(&p.id)?,
            "running" => ap.recover(&p.id)?,
            s => return Err(Fail::new(exit::FAILED, format!("目前狀態「{s}」不能重試"))),
        },
    };
    if ctx.json {
        ctx.emit(&json!({"ok": true, "id": r.id, "status": r.status, "message": r.message}));
    } else {
        println!("{} {}：{}{}", short(&r.id), r.episode.to_uppercase(), r.status, r.message.as_deref().map(|m| format!("（{m}）")).unwrap_or_default());
    }
    if ctx.flag("--wait") {
        return cmd_run(ctx, env, Some(Target::Production(r.id)));
    }
    Ok(exit::OK)
}

fn cmd_list(ctx: &Ctx, env: &Env) -> R<i32> {
    let limit = ctx.opt("--limit").and_then(|s| s.parse().ok()).unwrap_or(20);
    let ap = env.ap(false);
    let items = ap.board(None, limit)?;
    if ctx.json {
        let rows: Vec<Value> = items
            .iter()
            .map(|x| json!({"id": x["id"], "episode": x["episode"], "title": x["title"], "status": x["status"], "progress": x["progress"], "currentStep": x["currentStep"], "createdAt": x["createdAt"]}))
            .collect();
        ctx.emit(&json!({"ok": true, "productions": rows}));
    } else if items.is_empty() {
        println!("還沒有任何製作。用 PikaraScienceStudio create --project <資料夾> --topic <主題> 建立");
    } else {
        println!("{:<10} {:<6} {:<12} {:>5}  標題", "ID", "集數", "狀態", "進度");
        for x in &items {
            println!(
                "{:<10} {:<6} {:<12} {:>4.0}%  {}",
                short(x["id"].as_str().unwrap_or("")).get(..8).unwrap_or(""),
                x["episode"].as_str().unwrap_or("").to_uppercase(),
                x["status"].as_str().unwrap_or(""),
                x["progress"].as_f64().unwrap_or(0.0) * 100.0,
                x["title"].as_str().unwrap_or("")
            );
        }
    }
    Ok(exit::OK)
}

fn print_board(x: &Value) {
    println!(
        "{} {} — {}（{}）  整體 {:.0}%{}",
        x["id"].as_str().unwrap_or("").get(..8).unwrap_or(""),
        x["episode"].as_str().unwrap_or("").to_uppercase(),
        x["title"].as_str().unwrap_or(""),
        x["status"].as_str().unwrap_or(""),
        x["progress"].as_f64().unwrap_or(0.0) * 100.0,
        x["etaSecs"].as_f64().map(|s| format!("，剩餘約 {} 分", (s / 60.0).ceil())).unwrap_or_default()
    );
    for (i, s) in x["steps"].as_array().cloned().unwrap_or_default().iter().enumerate() {
        let st = s["status"].as_str().unwrap_or("");
        let mark = match st {
            "done" => "✓",
            "warned" => "!",
            "running" => "▶",
            "paused" => "Ⅱ",
            "failed" => "✗",
            "canceled" => "■",
            "skipped" => "-",
            _ => "·",
        };
        let prog = s["progress"].as_f64().filter(|_| st == "running").map(|p| format!(" {:.0}%", p * 100.0)).unwrap_or_default();
        let detail = s["detail"].as_str().map(|d| format!("  {d}")).unwrap_or_default();
        println!("  {mark} {:>2}. {}{prog}{detail}", i + 1, s["label"].as_str().unwrap_or(""));
    }
    if let Some(j) = x["job"].as_object() {
        if j.get("status").and_then(|s| s.as_str()) == Some("running") {
            println!("  目前工作：{} {:.0}% {}", j["label"].as_str().unwrap_or(""), j["progress"].as_f64().unwrap_or(0.0) * 100.0, j["progressText"].as_str().unwrap_or(""));
        }
    }
    for e in x["errors"].as_array().cloned().unwrap_or_default() {
        println!("  錯誤：{}", e.as_str().unwrap_or(""));
    }
    for o in x["outputs"].as_array().cloned().unwrap_or_default() {
        println!("  成品：{}", o.as_str().unwrap_or(""));
    }
}

const TERMINAL: &[&str] = &["succeeded", "failed", "canceled", "discarded", "needs_merge"];

fn cmd_status(ctx: &Ctx, env: &Env) -> R<i32> {
    let ap = env.ap(false);
    let Some(id) = ctx.pos.first().cloned().or_else(|| ctx.opt("--id")) else {
        // no id: queue + short list
        let qs = env.q.status();
        if ctx.json {
            ctx.emit(&json!({"ok": true, "queue": qs, "productions": ap.board(None, 10)?}));
            return Ok(exit::OK);
        }
        println!("佇列：{}", serde_json::to_string(&qs).unwrap_or_default());
        return cmd_list(ctx, env);
    };
    let p = env.production(&id)?;
    let follow = ctx.flag("--follow") || ctx.flag("-f");
    let mut last = String::new();
    loop {
        let p = autopilot::get(&env.conn(), &p.id)?;
        let x = ap.board_item(&p);
        let key = format!("{}|{}|{}|{}", x["status"], x["progress"], x["job"]["progress"], x["currentStep"]);
        if key != last {
            if ctx.json {
                ctx.emit(&json!({"ok": true, "type": "status", "production": x}));
            } else {
                if follow && !last.is_empty() {
                    println!();
                }
                print_board(&x);
            }
            last = key;
        }
        if !follow || TERMINAL.contains(&p.status.as_str()) {
            return Ok(match p.status.as_str() {
                "failed" | "canceled" if follow => exit::PRODUCTION_FAILED,
                _ => exit::OK,
            });
        }
        if interrupted() {
            return Ok(exit::INTERRUPTED);
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn cmd_logs(ctx: &Ctx, env: &Env) -> R<i32> {
    let p = env.production(&ctx.id()?)?;
    let tail: usize = ctx.opt("--tail").and_then(|s| s.parse().ok()).unwrap_or(100);
    let follow = ctx.flag("--follow") || ctx.flag("-f");
    let jobs_too = !ctx.flag("--production-only");
    let all = autopilot::events(&env.conn(), &p.id, 0, 1_000_000)?;
    let mut after = all.iter().rev().nth(tail).map(|e| e.id).unwrap_or(0);
    let mut job_after: std::collections::HashMap<String, i64> = Default::default();
    loop {
        let evs = autopilot::events(&env.conn(), &p.id, after, 10_000)?; // bind first: a guard in a `for` header lives for the whole loop
        for e in evs {
            if ctx.json {
                ctx.emit(&json!({"type": "event", "production": p.id, "ts": e.ts, "level": e.level, "stage": e.stage, "line": e.line}));
            } else {
                println!("{} {:<9} {:<5} {}", ts(e.ts), e.stage, e.level, e.line);
            }
            after = e.id;
        }
        let cur = autopilot::get(&env.conn(), &p.id)?;
        if jobs_too {
            if let Some(j) = cur.job_id.as_deref() {
                let a = *job_after.entry(j.to_string()).or_insert_with(|| {
                    // first look at this job: start from its last `tail` lines
                    let evs = db::events_list(&env.conn(), j, 0, 1_000_000).unwrap_or_default();
                    evs.iter().rev().nth(tail).map(|e| e.id).unwrap_or(0)
                });
                let evs = db::events_list(&env.conn(), j, a, 10_000).unwrap_or_default();
                for e in &evs {
                    if ctx.json {
                        ctx.emit(&json!({"type": "job_event", "job": j, "ts": e.ts, "stream": e.stream, "level": e.level, "line": e.line}));
                    } else {
                        println!("{}   [{}] {}", ts(e.ts), e.stream, e.line);
                    }
                }
                if let Some(l) = evs.last() {
                    job_after.insert(j.to_string(), l.id);
                }
            }
        }
        if !follow || TERMINAL.contains(&cur.status.as_str()) || interrupted() {
            return Ok(if interrupted() { exit::INTERRUPTED } else { exit::OK });
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn ts(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.with_timezone(&chrono::Local).format("%H:%M:%S").to_string()).unwrap_or_default()
}

fn cmd_jobs(ctx: &Ctx, env: &Env) -> R<i32> {
    let limit = ctx.opt("--limit").and_then(|s| s.parse().ok()).unwrap_or(20);
    let l = db::job_list(&env.conn(), None, ctx.opt("--status").as_deref(), limit)?;
    if ctx.json {
        ctx.emit(&json!({"ok": true, "jobs": l}));
    } else {
        for j in &l {
            println!("{:<9} {:<10} {:>5.1}%  {}", &j.id[..8.min(j.id.len())], j.status, j.progress * 100.0, j.label);
        }
    }
    Ok(exit::OK)
}

/// `render <id>` / `revoice <id> [--lines "a b"]`: re-render or re-voice a finished video (same jobs as 單集編輯).
fn cmd_redo(ctx: &Ctx, env: &Env, verb: &str) -> R<i32> {
    let (pid, root, episode) = if let Some(project) = ctx.opt("--project") {
        let pr = studio_core::register_project(&env.db, &project)?;
        let ep = ctx.opt("--episode").ok_or_else(|| Fail::usage("用 --project 時也要 --episode <集數>"))?;
        (pr.id, PathBuf::from(pr.root_path), ep)
    } else {
        let p = env.production(&ctx.id()?)?;
        let root = env.project_root(&p)?;
        (p.project_id.clone().unwrap_or_default(), root, p.episode.clone())
    };
    let locale = ctx.opt("--locale").unwrap_or_else(|| "zh-TW".into());
    let mut params: Value = match ctx.opt("--params") {
        Some(s) => serde_json::from_str(&s).map_err(|e| Fail::usage(format!("--params 不是有效 JSON：{e}")))?,
        None => json!({}),
    };
    params["episode"] = json!(episode);
    params["locale"] = json!(locale);
    let kind = if verb == "render" { "rerender" } else { "revoice" };
    if kind == "revoice" {
        params["lines"] = json!(ctx.opt("--lines").unwrap_or_default());
    }
    let j = env.q.enqueue(Some(&pid), kind, &params, &root)?;
    if ctx.json {
        ctx.emit(&json!({"ok": true, "job": j.id, "kind": kind, "episode": episode, "locale": locale}));
    } else {
        println!("已排入{}工作 {}（{} {}）", if kind == "rerender" { "重新渲染" } else { "重新配音" }, &j.id[..8], episode.to_uppercase(), locale);
    }
    if ctx.flag("--wait") {
        return cmd_run(ctx, env, Some(Target::Job(j.id)));
    }
    Ok(exit::OK)
}

fn cmd_config(ctx: &Ctx, env: &Env) -> R<i32> {
    let sub = ctx.pos.first().map(String::as_str).unwrap_or("get");
    let cur = serde_json::to_value(db::settings_get(&env.conn())).unwrap_or(Value::Null);
    let pointer = |k: &str| format!("/{}", k.replace('.', "/"));
    match sub {
        "get" => {
            let v = match ctx.pos.get(1) {
                Some(k) => cur.pointer(&pointer(k)).cloned().ok_or_else(|| Fail::new(exit::NOT_FOUND, format!("沒有設定項目 {k}")))?,
                None => cur,
            };
            if ctx.json {
                ctx.emit(&json!({"ok": true, "value": v}));
            } else {
                println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            }
            Ok(exit::OK)
        }
        "set" => {
            let patch = if let Some(j) = ctx.opt("--json") {
                serde_json::from_str::<Value>(&j).map_err(|e| Fail::usage(format!("--json：{e}")))?
            } else {
                let k = ctx.pos.get(1).ok_or_else(|| Fail::usage("用法：config set <項目> <值>（例：config set perfMode eco）或 config set --json '{…}'"))?;
                let raw = ctx.pos.get(2).ok_or_else(|| Fail::usage("缺少值"))?;
                if cur.pointer(&pointer(k)).is_none() {
                    return Err(Fail::new(exit::NOT_FOUND, format!("沒有設定項目 {k}（config get 列出全部）")));
                }
                let val: Value = serde_json::from_str(raw).unwrap_or_else(|_| json!(raw));
                let mut patch = json!({});
                let parts: Vec<&str> = k.split('.').collect();
                let mut node = &mut patch;
                for (i, part) in parts.iter().enumerate() {
                    if i + 1 == parts.len() {
                        node[*part] = val.clone();
                    } else {
                        node[*part] = json!({});
                        node = &mut node[*part];
                    }
                }
                patch
            };
            let s = db::settings_merge(&env.conn(), &patch)?;
            if ctx.json {
                ctx.emit(&json!({"ok": true, "settings": s}));
            } else {
                println!("已更新設定");
            }
            Ok(exit::OK)
        }
        "path" => {
            let d = studio_core::util::data_dir();
            if ctx.json {
                ctx.emit(&json!({"ok": true, "dataDir": d, "database": d.join("studio.db")}));
            } else {
                println!("{}", d.display());
            }
            Ok(exit::OK)
        }
        s => Err(Fail::usage(format!("config {s}：可用 get、set、path"))),
    }
}

fn cmd_agent(ctx: &Ctx, env: &Env) -> R<i32> {
    let sub = ctx.pos.first().cloned().unwrap_or_default();
    let id = ctx.pos.get(1).cloned().or_else(|| ctx.opt("--id")).ok_or_else(|| Fail::usage("用法：agent task <製作ID> | agent done <製作ID> [--failed] [--note <文字>]"))?;
    let p = env.production(&id)?;
    match sub.as_str() {
        "task" => {
            if p.status != "waiting_agent" {
                ctx.emit(&json!({"ok": false, "status": p.status, "error": "目前沒有給 Agent 的任務"}));
                ctx.say(format!("目前沒有給 Agent 的任務（狀態：{}）", p.status));
                return Ok(exit::FAILED);
            }
            let t = &p.data["agentTask"];
            let root = env.project_root(&p)?;
            let wd = p.worktree.as_deref().map(|w| studio_core::util::clean_path(&studio_core::jobs::worktree_dir(&root, w)));
            if ctx.json {
                ctx.emit(&json!({"ok": true, "id": p.id, "stage": p.stage, "title": t["title"], "taskFile": t["file"], "workdir": wd, "prompt": t["prompt"]}));
            } else {
                println!("{}\n工作資料夾：{}\n\n{}", t["title"].as_str().unwrap_or(""), wd.unwrap_or_default(), t["prompt"].as_str().unwrap_or(""));
            }
            Ok(exit::OK)
        }
        "done" => {
            let r = env.ap(false).agent_done(&p.id, ctx.flag("--failed"), ctx.opt("--note").as_deref())?;
            ctx.emit(&json!({"ok": true, "id": r.id, "status": r.status, "stage": r.stage}));
            ctx.say(format!("已回報：{}（{}）", r.status, r.stage));
            Ok(exit::OK)
        }
        s => Err(Fail::usage(format!("agent {s}：可用 task、done"))),
    }
}

fn cmd_project(ctx: &Ctx, env: &Env) -> R<i32> {
    match ctx.pos.first().map(String::as_str).unwrap_or("list") {
        "list" => {
            let l = db::project_list(&env.conn())?;
            if ctx.json {
                ctx.emit(&json!({"ok": true, "projects": l}));
            } else {
                for p in &l {
                    println!("{:<10} {}  {}", &p.id[..8.min(p.id.len())], p.name, p.root_path);
                }
            }
            Ok(exit::OK)
        }
        "add" => {
            let dir = ctx.pos.get(1).cloned().or_else(|| ctx.opt("--project")).ok_or_else(|| Fail::usage("用法：project add <資料夾>"))?;
            let p = studio_core::register_project(&env.db, &dir)?;
            ctx.emit(&json!({"ok": true, "project": p}));
            ctx.say(format!("已登記專案 {}", p.root_path));
            Ok(exit::OK)
        }
        "new" => {
            let dest = ctx.opt("--dest").ok_or_else(|| Fail::usage("用法：project new --dest <新資料夾> --title <名稱> [--template <範本>]"))?;
            let title = ctx.opt("--title").unwrap_or_else(|| "Pikara Science".into());
            let tpl = ctx.opt("--template").map(PathBuf::from);
            let r = studio_core::create_project(&env.db, &dest, &title, tpl.as_deref(), !ctx.flag("--no-link-tools"))?;
            ctx.emit(&json!({"ok": true, "result": r}));
            ctx.say(format!("已建立專案 {}", dest));
            Ok(exit::OK)
        }
        s => Err(Fail::usage(format!("project {s}：可用 list、add、new"))),
    }
}

// ------------------------------------------------------------------ worker (queue + autopilot in the foreground)

enum Target {
    Production(String),
    Job(String),
}

static STOP: AtomicBool = AtomicBool::new(false);
fn interrupted() -> bool {
    STOP.load(Ordering::Relaxed)
}
fn install_ctrlc() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = ctrlc::set_handler(|| STOP.store(true, Ordering::Relaxed));
    });
}

/// Run the scheduler and autopilot in this process (what the GUI does in the background) and report progress.
/// Without a target it runs until nothing is queued or running (`--stay`: until Ctrl-C / `--timeout`).
/// With a target it runs until that production / job ends; if another Studio already runs the queue for this data
/// folder, it only follows the target (that Studio does the work).
fn cmd_run(ctx: &Ctx, env: &Env, target: Option<Target>) -> R<i32> {
    install_ctrlc();
    let timeout = ctx.opt("--timeout").and_then(|s| s.parse::<u64>().ok()).map(Duration::from_secs);
    let lock = studio_core::util::scheduler_lock();
    let worker = lock.is_ok();
    if !worker {
        if target.is_none() {
            return Err(Fail::new(exit::BUSY, "另一個 Studio（視窗或 run）正在執行這個資料夾的佇列；用 status --follow 追蹤進度"));
        }
        ctx.say("另一個 Studio 正在執行佇列：只追蹤進度，不在這裡執行工作");
    }
    let ap = env.ap(!ctx.json);
    if worker {
        let rec = env.q.recover();
        if !rec.is_empty() {
            ctx.say(format!("恢復 {} 個中斷的工作（配音與渲染會跳過已完成的部分）", rec.len()));
            ctx.emit(&json!({"type": "recovered", "jobs": rec}));
        }
    }
    let t0 = Instant::now();
    let mut last_hb = Instant::now();
    let mut seen_ev: std::collections::HashMap<String, i64> = Default::default();
    let mut seen_job: std::collections::HashMap<String, String> = Default::default();
    // only report events from now on (older ones: `logs`)
    let prods = autopilot::list(&env.conn(), 200)?; // bind first: the DB guard must not live through the loop
    for p in prods {
        let last = autopilot::events(&env.conn(), &p.id, 0, 1_000_000)?.last().map(|e| e.id).unwrap_or(0);
        seen_ev.insert(p.id, last);
    }
    loop {
        if worker {
            env.q.tick();
            ap.tick();
            if last_hb.elapsed() >= Duration::from_secs(studio_core::queue::HEARTBEAT_SECS) {
                env.q.heartbeat();
                last_hb = Instant::now();
            }
        }
        let prods = autopilot::list(&env.conn(), 200)?;
        for p in &prods {
            let after = *seen_ev.get(&p.id).unwrap_or(&0);
            let evs = autopilot::events(&env.conn(), &p.id, after, 1000)?;
            for e in &evs {
                if ctx.json {
                    ctx.emit(&json!({"type": "event", "production": p.id, "episode": p.episode, "stage": e.stage, "level": e.level, "line": e.line, "ts": e.ts}));
                } else if !ctx.quiet {
                    println!("{} {} {:<9} {}", ts(e.ts), p.episode.to_uppercase(), e.stage, e.line.chars().take(400).collect::<String>());
                }
            }
            if let Some(e) = evs.last() {
                seen_ev.insert(p.id.clone(), e.id);
            }
        }
        let running = db::job_list(&env.conn(), None, Some("running"), 50).unwrap_or_default();
        for j in running {
            let key = format!("{}|{:.3}|{}", j.step, j.progress, j.progress_text.clone().unwrap_or_default());
            if seen_job.get(&j.id) != Some(&key) {
                if ctx.json {
                    ctx.emit(&json!({"type": "progress", "job": j.id, "kind": j.kind, "label": j.label, "progress": j.progress, "text": j.progress_text, "step": j.steps.get(j.step.max(0) as usize)}));
                } else if !ctx.quiet {
                    println!("         ▶ {} {:>5.1}%  {}", j.label, j.progress * 100.0, j.progress_text.clone().unwrap_or_default());
                }
                seen_job.insert(j.id.clone(), key);
            }
        }
        // finished?
        let done: Option<i32> = match &target {
            Some(Target::Production(id)) => {
                let p = autopilot::get(&env.conn(), id)?;
                match p.status.as_str() {
                    "succeeded" => Some(exit::OK),
                    "failed" | "canceled" | "discarded" | "needs_merge" => Some(exit::PRODUCTION_FAILED),
                    // waiting for an external agent: the caller must act (agent task / agent done)
                    "waiting_agent" if ctx.flag("--until-agent") => Some(exit::OK),
                    _ => None,
                }
            }
            Some(Target::Job(id)) => {
                let j = db::job_get(&env.conn(), id)?;
                match j.status.as_str() {
                    "succeeded" | "warned" => Some(exit::OK),
                    "failed" | "canceled" | "interrupted" => Some(exit::PRODUCTION_FAILED),
                    _ => None,
                }
            }
            None => {
                let running = db::job_list(&env.conn(), None, Some("running"), 10)?.len();
                let pending = db::jobs_pending(&env.conn())?.len();
                let active = prods.iter().filter(|p| ["queued", "running"].contains(&p.status.as_str())).count();
                (running + pending + active == 0 && !ctx.flag("--stay")).then_some(exit::OK)
            }
        };
        if let Some(code) = done {
            if let Some(Target::Production(id)) = &target {
                let p = autopilot::get(&env.conn(), id)?;
                let x = ap.board_item(&p);
                if ctx.json {
                    ctx.emit(&json!({"type": "done", "ok": code == exit::OK, "production": x}));
                } else {
                    println!();
                    print_board(&x);
                }
            } else {
                ctx.emit(&json!({"type": "done", "ok": code == exit::OK}));
            }
            return Ok(code);
        }
        if interrupted() {
            // leave the work resumable: stop the running process trees; the next `run` (or the GUI) recovers the
            // jobs (voice and render skip finished lines / chunks)
            if worker {
                for pid in env.q.own_pids() {
                    let _ = studio_core::util::kill_tree(pid);
                }
            }
            ctx.say("已中斷；再次執行 PikaraScienceStudio run 會從中斷處繼續");
            ctx.emit(&json!({"type": "interrupted"}));
            return Ok(exit::INTERRUPTED);
        }
        if timeout.is_some_and(|t| t0.elapsed() > t) {
            ctx.say(format!("逾時（{} 秒）", timeout.unwrap().as_secs()));
            ctx.emit(&json!({"type": "timeout"}));
            return Ok(exit::TIMEOUT);
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
}

fn read_text(f: &str) -> R<String> {
    let s = std::fs::read_to_string(Path::new(f)).map_err(|e| Fail::new(exit::NOT_FOUND, format!("讀不到 {f}：{e}")))?;
    Ok(s.trim_start_matches('\u{feff}').to_string())
}

// ------------------------------------------------------------------ help

fn print_help(topic: Option<&str>) {
    let detail = match topic {
        Some("create") => Some(
            "create --project <資料夾> --topic <主題> [選項]\n\
             \x20 --minutes <n>          目標長度（分鐘）\n\
             \x20 --style ai|generic     ai＝AI 撰寫動畫程式；generic＝旁白範本（不需要 AI 寫程式）\n\
             \x20 --language zh-TW|zh-CN|both|en\n\
             \x20 --agent claude|doubao|external   誰做 AI 工作；external＝外部 Agent 透過 agent task/done\n\
             \x20 --mode auto|guided|script        --script-file <劇本.md>（自訂腳本，自動設為 script）\n\
             \x20 --narrative auto|personified|plain\n\
             \x20 --config <設定.json>   與「新影片」頁相同的完整設定（JSON，camelCase）\n\
             \x20 --no-youtube --no-thumbnail --no-publish-info --no-visual-review --sandbox\n\
             \x20 --draft                建立草稿，稍後用 start 開始\n\
             \x20 --wait [--timeout <秒>] 在這個程序裡執行並顯示進度，直到完成（結束碼 0＝成功、7＝失敗）",
        ),
        Some("run") => Some(
            "run [--timeout <秒>] [--stay]\n\
             \x20 在前景執行佇列與自動製作（與 Studio 視窗在背景做的事相同），直到沒有工作；--stay 持續等待新工作。\n\
             \x20 Ctrl-C 會停止正在執行的程序並保留進度；再次執行 run 從中斷處繼續。\n\
             \x20 同一個資料夾只能有一個執行者：視窗開著時 run 會回傳 5，請改用 status --follow。",
        ),
        Some("config") => Some("config get [項目]   config set <項目> <值>   config set --json '<patch>'   config path\n  項目以點分隔，例：perfMode、hw.uiGpu"),
        Some("render" | "revoice") => Some(
            "render <製作ID> [--locale zh-TW|zh-CN] [--params <json>] [--wait]\n\
             revoice <製作ID> [--lines \"L01 L02\"] [--locale …] [--wait]\n\
             \x20 也可用 --project <資料夾> --episode <集數> 指定已完成的影片",
        ),
        _ => None,
    };
    if let Some(d) = detail {
        println!("{d}");
        return;
    }
    println!(
        "Pikara Science Studio — 指令列\n\n\
用法：PikaraScienceStudio [--data <資料夾>] [--json] [--quiet] <指令> [選項]\n\n\
製作\n\
  create   --project <資料夾> --topic <主題> [...]   建立影片（create --help 查看全部選項）\n\
  start    <ID>          開始草稿\n\
  run      [--stay]      在前景執行佇列與自動製作（伺服器／SSH 使用）\n\
  status   [<ID>] [--follow]   11 個步驟、進度、目前工作、錯誤、成品\n\
  list     [--limit n]   全部製作\n\
  logs     <ID> [--follow] [--tail n]\n\
  pause | resume | cancel | retry  <ID> [--wait]\n\
  revoice  <ID> [--lines \"L01 L02\"]    單獨重新配音\n\
  render   <ID>                       單獨重新渲染\n\
  agent    task <ID> | done <ID>      外部 AI Agent 介面\n\n\
環境\n\
  doctor   [--project <資料夾>] [--gpu-tests]   環境檢查（有錯誤時結束碼 4）\n\
  hardware               硬體、GPU 後端、裝置分配（唯讀）\n\
  config   get|set|path  設定\n\
  project  list|add|new  專案\n\
  version  --version     版本\n\n\
結束碼：0 成功・1 失敗・2 用法錯誤・3 找不到・4 環境錯誤・5 佇列已由其他 Studio 執行・6 逾時・7 製作失敗・10 資料庫・130 中斷\n\
--json：每個指令輸出一個 JSON 物件；status --follow、logs --follow、run、create --wait 輸出 NDJSON（每行一個事件）。\n\
舊的自動化指令仍可用：PikaraScienceStudio --cli <指令>（auto-start、auto-run、auto-status、job-log …）。\n\
Windows／macOS：不加指令時開啟視窗；加 nogui 或任何指令時只用指令列。Linux：只有指令列。"
    );
}
