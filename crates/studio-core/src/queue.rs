//! Persistent job queue + scheduler: one GPU job at a time (GPU lock that also respects external GPU jobs),
//! parallel CPU jobs, heartbeat, crash/sleep recovery, process-tree cancel, Windows keep-awake.

use crate::db::{self, Db, Job};
use crate::gpu::{self, ExternalGpu};
use crate::jobs::{self, Ctx, ParseState, Step};
use crate::util::{kill_tree, logs_dir, now_ms};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub const HEARTBEAT_SECS: u64 = 5;
pub const STALE_MS: i64 = 20_000;
const MAX_AUTO_REQUEUE: i64 = 5;

struct Running {
    resource: String,
    pid: Arc<Mutex<Option<u32>>>,
    cancel: Arc<AtomicBool>,
    /// ResourceScheduler leases, held for the whole job; dropped (released) when the job leaves `running`
    _gpu_lease: Vec<crate::gpulock::GpuLease>,
    /// adapters this GPU job uses (empty = CPU devices only → "cpu-heavy")
    gpu_keys: Vec<String>,
}

/// Paused jobs are marked by a file `<data>/paused/<job id>`: the process that runs the job (window or --cli
/// run-queue) and a controlling process (the window, `--cli job-pause`) see the same state. A paused job keeps its
/// processes (and loaded models) in memory; the stall watchdog and the next step wait while the marker exists.
fn pause_marker(id: &str) -> std::path::PathBuf {
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    crate::util::data_dir().join("paused").join(safe)
}

/// Jobs paused by this process (exact, no file system or environment involved); the marker file adds the
/// cross-process view.
static PAUSED_HERE: once_cell::sync::Lazy<Mutex<HashSet<String>>> = once_cell::sync::Lazy::new(|| Mutex::new(HashSet::new()));

pub fn is_paused(id: &str) -> bool {
    PAUSED_HERE.lock().unwrap_or_else(|e| e.into_inner()).contains(id) || pause_marker(id).exists()
}

fn clear_pause(id: &str) {
    PAUSED_HERE.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    let _ = std::fs::remove_file(pause_marker(id));
}

fn lease_keys(k: &[String]) -> Vec<String> {
    if k.is_empty() { vec!["cpu-heavy".into()] } else { k.to_vec() }
}

pub struct Queue {
    pub db: Db,
    emit: Emit,
    running: Mutex<HashMap<String, Running>>,
    hb_count: std::sync::atomic::AtomicU32,
    external: Mutex<ExternalGpu>,
    keep_awake_on: AtomicBool,
    /// Test hook: pretend an external GPU job is running.
    pub force_external_busy: AtomicBool,
}

impl Queue {
    pub fn new(db: Db, emit: Emit) -> Arc<Queue> {
        Arc::new(Queue {
            db,
            emit,
            running: Mutex::new(HashMap::new()),
            hb_count: std::sync::atomic::AtomicU32::new(0),
            external: Mutex::new(ExternalGpu::default()),
            keep_awake_on: AtomicBool::new(false),
            force_external_busy: AtomicBool::new(false),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn own_pids(&self) -> HashSet<u32> {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).values().filter_map(|r| *r.pid.lock().unwrap_or_else(|e| e.into_inner())).collect()
    }

    pub fn gpu_holder(&self) -> Option<String> {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(_, r)| r.resource == "gpu").map(|(k, _)| k.clone())
    }

    /// A running GPU job that uses any of these adapters (jobs on different GPUs may run together).
    pub fn gpu_holder_for(&self, keys: &[String]) -> Option<String> {
        let want = lease_keys(keys);
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(_, r)| r.resource == "gpu" && lease_keys(&r.gpu_keys).iter().any(|k| want.contains(k)))
            .map(|(k, _)| k.clone())
    }

    /// Fresh external-GPU check (process list + nvidia-smi).
    pub fn check_external(&self, sample: Option<&gpu::GpuSample>) -> ExternalGpu {
        let vram = db::settings_get(&self.conn()).gpu_vram_busy_mib;
        let fetched;
        let s = match sample {
            Some(s) => Some(s),
            None => {
                fetched = gpu::latest(Duration::from_secs(10));
                fetched.as_ref()
            }
        };
        let mut e = gpu::external_status(&self.own_pids(), vram, self.gpu_holder().is_some(), s);
        if self.force_external_busy.load(Ordering::Relaxed) {
            e.busy = true;
            e.reasons.push("測試旗標：模擬外部 GPU 佔用".into());
        }
        *self.external.lock().unwrap_or_else(|e| e.into_inner()) = e.clone();
        e
    }

    pub fn cached_external(&self) -> ExternalGpu {
        self.external.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn status(&self) -> Value {
        let c = self.conn();
        let s = db::settings_get(&c);
        let running: Vec<Job> = db::job_list(&c, None, Some("running"), 100).unwrap_or_default();
        let queued: i64 = c
            .query_row("SELECT count(*) FROM jobs WHERE status IN ('queued','waiting_resource')", [], |r| r.get(0))
            .unwrap_or(0);
        drop(c);
        json!({
            "enabled": s.queue_enabled,
            "inWindow": in_window(&s, chrono::Local::now().time()),
            "running": running,
            "queued": queued,
            "gpuHolder": self.gpu_holder(),
            "external": self.cached_external(),
            "keepAwake": self.keep_awake_on.load(Ordering::Relaxed),
        })
    }

    fn emit_job(&self, id: &str) {
        if let Ok(j) = db::job_get(&self.conn(), id) {
            (self.emit)("job://update", serde_json::to_value(j).unwrap());
        }
    }

    pub fn enqueue(&self, project_id: Option<&str>, kind: &str, params: &Value, root: &Path) -> Result<Job, String> {
        let resource = jobs::resource_for(kind, params)?;
        let s = db::settings_get(&self.conn());
        // Validate params now (fail fast in the UI rather than at run time) — except claude which
        // resolves the CLI at run time.
        let steps = jobs::build_steps(kind, params, &Ctx { root, settings: &s, job_id: "validate" })?;
        let labels: Vec<String> = steps.iter().map(|s| s.label.clone()).collect();
        let j = db::job_insert(&self.conn(), project_id, kind, &jobs::label_for(kind, params), params, resource, &labels)?;
        (self.emit)("job://update", serde_json::to_value(&j).unwrap());
        Ok(j)
    }

    /// Pause a running job: the whole process tree is suspended (NtSuspendProcess / SIGSTOP). Nothing is killed,
    /// written or deleted; resume continues exactly where it stopped. Queued jobs cannot be paused (use the queue
    /// window / cancel); a job between two steps waits before starting the next step.
    pub fn pause(&self, id: &str) -> Result<Value, String> {
        let j = db::job_get(&self.conn(), id)?;
        if j.status != "running" {
            return Err(format!("只能暫停執行中的工作（目前狀態：{}）", j.status));
        }
        if is_paused(id) {
            return Ok(json!({"paused": true, "already": true}));
        }
        let m = pause_marker(id);
        let _ = std::fs::create_dir_all(m.parent().unwrap());
        std::fs::write(&m, crate::util::now_iso()).map_err(|e| format!("無法寫入暫停標記：{e}"))?;
        PAUSED_HERE.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string());
        let pid = self.running.lock().unwrap_or_else(|e| e.into_inner()).get(id).and_then(|r| *r.pid.lock().unwrap_or_else(|e| e.into_inner())).or(j.pid.map(|p| p as u32));
        let n = pid.map(crate::platform::process::suspend_tree).unwrap_or(0);
        self.event(id, "system", "warn", &format!("已暫停（{n} 個程序；模型與已完成的檔案保留在原處，繼續後從暫停處接著做）"));
        let _ = db::job_set_progress(&self.conn(), id, j.progress, Some(&format!("已暫停｜{}", j.progress_text.clone().unwrap_or_default())));
        self.emit_job(id);
        Ok(json!({"paused": true, "processes": n}))
    }

    pub fn resume(&self, id: &str) -> Result<Value, String> {
        let j = db::job_get(&self.conn(), id)?;
        let pid = self.running.lock().unwrap_or_else(|e| e.into_inner()).get(id).and_then(|r| *r.pid.lock().unwrap_or_else(|e| e.into_inner())).or(j.pid.map(|p| p as u32));
        let n = pid.map(crate::platform::process::resume_tree).unwrap_or(0);
        clear_pause(id);
        self.event(id, "system", "info", &format!("繼續執行（{n} 個程序）"));
        let text = j.progress_text.clone().unwrap_or_default();
        let _ = db::job_set_progress(&self.conn(), id, j.progress, Some(text.strip_prefix("已暫停｜").unwrap_or(&text)));
        self.emit_job(id);
        Ok(json!({"paused": false, "processes": n}))
    }

    pub fn cancel(&self, id: &str) -> Result<Job, String> {
        let pid = {
            let r = self.running.lock().unwrap_or_else(|e| e.into_inner());
            r.get(id).map(|x| {
                x.cancel.store(true, Ordering::SeqCst);
                *x.pid.lock().unwrap_or_else(|e| e.into_inner())
            })
        };
        // 在跑的工作：殺掉程序樹後立刻把狀態寫成 canceled，不等執行緒收尾。否則程序（例如 CLI auto-run 逾時）
        // 在執行緒寫入前就結束時，資料庫留著 running，下次啟動的復原會把已取消的工作重新排入佇列
        // （沙盒 TEST003：製作已因逾時失敗，它的配音工作卻在下一次啟動時被復原並重跑）。
        clear_pause(id);
        match pid {
            Some(p) => {
                if let Some(p) = p {
                    let out = kill_tree(p);
                    self.event(id, "system", "warn", &format!("取消：taskkill /T /F /PID {p} → {}", out.trim()));
                }
                db::job_finish(&self.conn(), id, "canceled", None, Some("使用者取消"))?;
            }
            None => {
                let c = self.conn();
                let j = db::job_get(&c, id)?;
                if ["queued", "waiting_resource", "interrupted"].contains(&j.status.as_str()) {
                    db::job_finish(&c, id, "canceled", None, Some("使用者取消"))?;
                } else if j.status == "running" {
                    // running in another Studio process (CLI run-queue / second window) or an orphan of a previous
                    // session. Write "canceled" BEFORE killing the tree: the other process's runner sees its child die,
                    // checks the database and must find "canceled" — killing first let it record "failed" (v0.3 R1).
                    db::job_finish(&c, id, "canceled", None, Some("使用者取消"))?;
                    drop(c);
                    if let Some(p) = j.pid {
                        kill_tree(p as u32);
                    }
                }
            }
        }
        self.emit_job(id);
        db::job_get(&self.conn(), id)
    }

    fn event(&self, job_id: &str, stream: &str, level: &str, line: &str) {
        if let Ok(ev) = db::event_add(&self.conn(), job_id, stream, level, line) {
            (self.emit)("job://log", serde_json::to_value(ev).unwrap());
        }
    }

    /// Startup recovery: stale running jobs → interrupted → re-queued (pipeline scripts resume finished work).
    pub fn recover(&self) -> Vec<String> {
        let c = self.conn();
        let stale: Vec<Job> = db::job_list(&c, None, Some("running"), 1000).unwrap_or_default();
        // 自己正在執行的工作不算（心跳偶爾延遲也不會被誤判）；其他 running 但心跳過期的＝上一個 Studio 留下的
        let own: Vec<String> = self.running.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect();
        let ids = db::recover_stale(&c, STALE_MS, now_ms(), &own).unwrap_or_default();
        drop(c);
        for id in &ids {
            // kill an orphaned process tree left behind by a crashed Studio, so the requeued job doesn't double-run
            if let Some(j) = stale.iter().find(|j| &j.id == id) {
                if let Some(pid) = j.pid {
                    let snap = gpu::snapshot();
                    if let Some((_, name, _)) = snap.procs.get(&(pid as u32)) {
                        if is_job_process_name(name) {
                            let o = kill_tree(pid as u32);
                            self.event(id, "system", "warn", &format!("結束上次遺留的程序樹 PID {pid}：{}", o.trim()));
                        }
                    }
                }
            }
            self.event(id, "system", "warn", "Studio 重新啟動：工作被標記為 interrupted（heartbeat 過期）");
            let attempt = db::job_get(&self.conn(), id).map(|j| j.attempt).unwrap_or(0);
            if attempt < MAX_AUTO_REQUEUE {
                if db::job_requeue(&self.conn(), id).is_ok() {
                    self.event(id, "system", "info", "自動重新排入佇列（render.mjs／TTS 會跳過已完成的部分）");
                }
            }
            self.emit_job(id);
        }
        ids
    }
}

/// Can this be the root process of a job's step (so a leftover tree may be killed after a crash)? A recycled PID can
/// belong to anything, so only the launchers jobs use are accepted. Windows names end in `.exe`; macOS / Linux
/// names don't (`python3.11`, `node`, `sh` — job steps start through `/bin/sh -c` there).
pub fn is_job_process_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let base = n.strip_suffix(".exe").unwrap_or(&n);
    ["cmd", "node", "python", "py", "claude", "git", "sh", "bash", "zsh", "doubao"].contains(&base)
        || base.strip_prefix("python3").is_some_and(|v| v.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

#[cfg(test)]
#[test]
fn job_process_names_on_every_os() {
    for ok in ["node.exe", "PYTHON.EXE", "cmd.exe", "node", "python3", "python3.11", "sh", "bash", "claude"] {
        assert!(is_job_process_name(ok), "{ok}");
    }
    for no in ["explorer.exe", "chrome", "python3x", "launchd", "systemd", "Finder"] {
        assert!(!is_job_process_name(no), "{no}");
    }
}

/// Failure text for a step that exited non-zero: only this step's output is used. Lines the scripts mark as
/// errors (`[錯誤]`, `[QA 錯誤]`, level=error) are preferred; a step that died without any error output
/// (killed from outside, crash) gets a plain zh-TW explanation instead of unrelated log lines.
pub fn step_failure_message(label: &str, code: i32, evs: &[db::JobEvent]) -> String {
    let out: Vec<&db::JobEvent> = evs.iter().filter(|e| e.stream != "system").collect();
    let errs: Vec<String> = out.iter().filter(|e| e.level == "error" || e.line.contains("錯誤")).map(|e| e.line.trim().to_string()).collect();
    if !errs.is_empty() {
        let tail = errs[errs.len().saturating_sub(2)..].join(" | ");
        return format!("步驟「{label}」失敗（結束碼 {code}）：{}", tail.chars().take(400).collect::<String>());
    }
    let last = out.last().map(|e| e.line.trim().chars().take(160).collect::<String>()).unwrap_or_default();
    format!(
        "步驟「{label}」意外結束（結束碼 {code}），沒有留下錯誤訊息：程式可能被外部結束或當機。已完成的部分會保留，按「重試」會從這一步繼續。{}",
        if last.is_empty() { String::new() } else { format!("最後輸出：{last}") }
    )
}

impl Queue {
    /// One scheduler pass. Returns ids of jobs started.
    pub fn tick(self: &Arc<Self>) -> Vec<String> {
        let (s, pending) = {
            let c = self.conn();
            (db::settings_get(&c), db::jobs_pending(&c).unwrap_or_default())
        };
        let mut started = vec![];
        let window_ok = in_window(&s, chrono::Local::now().time());
        let mut ext_checked: Option<ExternalGpu> = None;
        // DeviceSelector assignment for this pass (cached hardware snapshot): which adapters each GPU job needs
        let assign = if pending.iter().any(|j| j.resource == "gpu") { Some(crate::hardware::selector::current(&s)) } else { None };
        for j in pending {
            let keys: Vec<String> = assign.as_ref().filter(|_| j.resource == "gpu").map(|a| crate::hardware::selector::job_adapters(&j.kind, a)).unwrap_or_default();
            let reason: Option<String> = if !s.queue_enabled {
                Some("佇列已暫停".into())
            } else if j.resource == "gpu" {
                if let Some(h) = self.gpu_holder_for(&keys) {
                    Some(format!("等待 GPU（Studio 工作 {} 使用同一張 GPU）", &h[..8.min(h.len())]))
                } else if !window_ok {
                    Some(format!(
                        "排程時段外（{}–{}）",
                        s.window_start.clone().unwrap_or_default(),
                        s.window_end.clone().unwrap_or_default()
                    ))
                } else {
                    let e = ext_checked.get_or_insert_with(|| self.check_external(None)).clone();
                    if e.busy { Some(e.reasons.join("；")) } else { None }
                }
            } else {
                let n = self.running.lock().unwrap_or_else(|e| e.into_inner()).values().filter(|r| r.resource != "gpu").count();
                if n as u32 >= s.max_cpu_jobs.max(1) { Some(format!("CPU 工作已達上限 {}", s.max_cpu_jobs)) } else { None }
            };
            // ResourceScheduler: machine-wide adapter leases (scripts holding the whole machine, other Studio processes)
            let mut lease = vec![];
            let reason = match reason {
                None if j.resource == "gpu" => match crate::gpulock::try_acquire_job(&format!("Studio 工作：{}", j.label), &keys) {
                    Ok(l) => {
                        lease = l;
                        None
                    }
                    Err(why) => Some(why),
                },
                r => r,
            };
            match reason {
                Some(r) => {
                    if db::job_set_waiting(&self.conn(), &j.id, Some(&r)).unwrap_or(false) {
                        self.emit_job(&j.id);
                    }
                }
                None => {
                    let id = j.id.clone();
                    if self.start(j, lease, keys).is_ok() {
                        started.push(id);
                    }
                }
            }
        }
        self.update_keep_awake(&s);
        started
    }

    fn update_keep_awake(&self, s: &db::Settings) {
        let want = s.keep_awake && !self.running.lock().unwrap_or_else(|e| e.into_inner()).is_empty();
        set_keep_awake(want);
        self.keep_awake_on.store(want, Ordering::Relaxed);
    }

    pub fn heartbeat(&self) {
        let ids: Vec<String> = self.running.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect();
        {
            let c = self.conn();
            for id in ids {
                let _ = db::job_heartbeat(&c, &id);
            }
        }
        // 每 30 秒檢查一次孤兒工作：Studio 當機後 20 秒內重新啟動時，啟動當下上一個程序的心跳還沒過期，
        // 那些工作會一直停在 running（控制驗收 E 發現）。由持有佇列鎖的程序定期復原。
        if self.hb_count.fetch_add(1, Ordering::Relaxed) % 6 == 5 {
            let rec = self.recover();
            if !rec.is_empty() {
                crate::watchdog::log_line(&format!("recovered {} orphaned job(s) whose heartbeat expired", rec.len()));
            }
        }
    }

    fn start(self: &Arc<Self>, job: Job, gpu_lease: Vec<crate::gpulock::GpuLease>, gpu_keys: Vec<String>) -> Result<(), String> {
        let project_root = {
            let c = self.conn();
            match job.project_id.as_deref().map(|p| db::project_get(&c, p)) {
                Some(Ok(p)) => match jobs::job_root(Path::new(&p.root_path), &job.params) {
                    Ok(r) => r,
                    Err(e) => {
                        db::job_finish(&c, &job.id, "failed", None, Some(&e))?;
                        drop(c);
                        self.emit_job(&job.id);
                        return Err(e);
                    }
                },
                _ => {
                    db::job_finish(&c, &job.id, "failed", None, Some("找不到專案"))?;
                    return Err("no project".into());
                }
            }
        };
        let settings = db::settings_get(&self.conn());
        let steps = match jobs::build_steps(&job.kind, &job.params, &Ctx { root: &project_root, settings: &settings, job_id: &job.id }) {
            Ok(s) => s,
            Err(e) => {
                db::job_finish(&self.conn(), &job.id, "failed", None, Some(&e))?;
                self.emit_job(&job.id);
                return Err(e);
            }
        };
        if let Err(e) = jobs::preflight(&job.kind, &job.params, &project_root, &settings) {
            db::job_finish(&self.conn(), &job.id, "failed", None, Some(&e))?;
            self.event(&job.id, "system", "error", &format!("工作未開始：{e}"));
            self.emit_job(&job.id);
            return Err(e);
        }
        let _ = std::fs::create_dir_all(logs_dir());
        let log_path = logs_dir().join(format!("{}.log", job.id));
        db::job_mark_started(&self.conn(), &job.id, &log_path.to_string_lossy())?;
        let pid = Arc::new(Mutex::new(None));
        let cancel = Arc::new(AtomicBool::new(false));
        self.running.lock().unwrap_or_else(|e| e.into_inner()).insert(
            job.id.clone(),
            Running { resource: job.resource.clone(), pid: pid.clone(), cancel: cancel.clone(), _gpu_lease: gpu_lease, gpu_keys },
        );
        self.emit_job(&job.id);
        let me = self.clone();
        std::thread::spawn(move || {
            let res = me.run_job(&job, &steps, &log_path, pid, cancel.clone());
            // canceled from another Studio process (CLI job-cancel / a second window): that process already killed the
            // tree and wrote "canceled"; don't overwrite it with "failed" when the child exits here
            let canceled_elsewhere = db::job_get(&me.conn(), &job.id).map(|j| j.status == "canceled").unwrap_or(false);
            let (status, code, err) = match res {
                _ if cancel.load(Ordering::SeqCst) || canceled_elsewhere => ("canceled", None, Some("使用者取消".to_string())),
                Ok(()) => ("succeeded", Some(0), None),
                Err((code, e)) => ("failed", code, Some(e)),
            };
            me.running.lock().unwrap_or_else(|e| e.into_inner()).remove(&job.id);
            clear_pause(&job.id);
            let _ = db::job_finish(&me.conn(), &job.id, status, code, err.as_deref());
            if status == "succeeded" {
                // v0.3: remember what the finished stages consumed (input fingerprints). Best effort — never affects the job's state.
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| crate::pipeline::on_job_succeeded(&me.conn(), &project_root, &job.kind, &job.params, &job.id)));
                match r {
                    Ok(Ok(st)) if !st.is_empty() => me.event(&job.id, "system", "info", &format!("已記錄階段指紋：{}", st.join("、"))),
                    Ok(Err(e)) => me.event(&job.id, "system", "warn", &format!("記錄階段指紋失敗（不影響結果）：{e}")),
                    Err(_) => me.event(&job.id, "system", "warn", "記錄階段指紋時發生內部錯誤（不影響結果）"),
                    _ => {}
                }
            }
            me.event(&job.id, "system", if status == "succeeded" { "info" } else { "error" }, &format!("工作結束：{status}{}", err.map(|e| format!("（{e}）")).unwrap_or_default()));
            me.emit_job(&job.id);
            (me.emit)("queue://status", me.status());
        });
        Ok(())
    }

    fn run_job(
        &self,
        job: &Job,
        steps: &[Step],
        log_path: &Path,
        pid_slot: Arc<Mutex<Option<u32>>>,
        cancel: Arc<AtomicBool>,
    ) -> Result<(), (Option<i32>, String)> {
        let mut log = std::fs::OpenOptions::new().create(true).append(true).open(log_path).ok();
        let n = steps.len().max(1);
        let first = (job.step.max(0) as usize).min(steps.len());
        if first > 0 {
            self.event(&job.id, "system", "info", &format!("從第 {} 步續跑（前 {first} 步已完成）", first + 1));
        }
        for (i, step) in steps.iter().enumerate().skip(first) {
            while is_paused(&job.id) && !cancel.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(500));
            }
            if cancel.load(Ordering::SeqCst) {
                return Err((None, "canceled".into()));
            }
            let _ = db::job_set_step(&self.conn(), &job.id, i as i64);
            let _ = db::job_set_progress(&self.conn(), &job.id, i as f64 / n as f64, Some(&step.label));
            let cmdline = format!("{} {}", step.program, step.args.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() }).collect::<Vec<_>>().join(" "));
            let head = format!("▶ 步驟 {}/{}：{}　$ {}　(cwd {})", i + 1, n, step.label, cmdline, step.cwd.display());
            self.event(&job.id, "system", "info", &head);
            if let Some(f) = log.as_mut() {
                let _ = writeln!(f, "{head}");
            }
            let first_ev = db::events_list(&self.conn(), &job.id, 0, 1_000_000).ok().and_then(|v| v.last().map(|e| e.id)).unwrap_or(0);
            let code = self.run_step(job, step, i, n, &mut log, &pid_slot)?;
            *pid_slot.lock().unwrap_or_else(|e| e.into_inner()) = None;
            if cancel.load(Ordering::SeqCst) {
                return Err((Some(code), "canceled".into()));
            }
            if code != 0 {
                return Err((Some(code), step_failure_message(&step.label, code, &db::events_list(&self.conn(), &job.id, first_ev, 1_000_000).unwrap_or_default())));
            }
            // persist step completion so an interrupted multi-step job resumes from the next step
            let _ = db::job_set_step(&self.conn(), &job.id, i as i64 + 1);
        }
        Ok(())
    }

    fn run_step(
        &self,
        job: &Job,
        step: &Step,
        idx: usize,
        n: usize,
        log: &mut Option<std::fs::File>,
        pid_slot: &Arc<Mutex<Option<u32>>>,
    ) -> Result<i32, (Option<i32>, String)> {
        let mut c = std::process::Command::new(&step.program);
        c.args(&step.args).current_dir(&step.cwd).stdout(Stdio::piped()).stderr(Stdio::piped());
        c.stdin(if step.stdin_text.is_some() { Stdio::piped() } else { Stdio::null() });
        for (k, v) in &step.env {
            c.env(k, v);
        }
        for k in &step.env_remove {
            c.env_remove(k);
        }
        crate::platform::process::configure(&mut c);
        let mut child: Child = c.spawn().map_err(|e| (None, format!("無法啟動 {}：{e}", step.program)))?;
        *pid_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(child.id());
        let _ = db::job_set_pid(&self.conn(), &job.id, Some(child.id()));
        if let (Some(text), Some(mut stdin)) = (step.stdin_text.clone(), child.stdin.take()) {
            std::thread::spawn(move || {
                let _ = stdin.write_all(text.as_bytes());
            });
        }
        let (tx, rx) = mpsc::channel::<(&'static str, String)>();
        let readers: Vec<_> = [("stdout", child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>)), ("stderr", child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>))]
            .into_iter()
            .filter_map(|(name, r)| r.map(|r| (name, r)))
            .map(|(name, r)| {
                let tx = tx.clone();
                std::thread::spawn(move || read_lines(r, |l| {
                    let _ = tx.send((name, l));
                }))
            })
            .collect();
        drop(tx);
        let mut st = ParseState::default();
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let mut pending_progress: Option<(f64, Option<String>)> = None;
        let mut last_output = Instant::now();
        let mut last_files_check = Instant::now() - Duration::from_secs(3600);
        let mut noted_files = false;
        let mut last_line = String::new();
        let mut exited_at: Option<Instant> = None;
        loop {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok((stream, line)) => {
                    last_output = Instant::now();
                    if line.trim().is_empty() {
                        continue;
                    }
                    last_line = line.chars().take(200).collect();
                    if let Some(f) = log.as_mut() {
                        let _ = writeln!(f, "[{stream}] {line}");
                    }
                    let out = jobs::parse_line(step.parser, &mut st, &line);
                    let level = out.level.unwrap_or(if stream == "stderr" && step.parser == jobs::Parser::Plain && line.to_ascii_lowercase().contains("error") { "error" } else { "info" });
                    match &out.display {
                        Some(lines) => {
                            for l in lines {
                                self.event(&job.id, stream, level, l);
                            }
                        }
                        None => self.event(&job.id, stream, level, &line),
                    }
                    if out.progress.is_some() || out.text.is_some() {
                        let overall = out.progress.map(|p| (idx as f64 + p) / n as f64);
                        let prev = pending_progress.take();
                        pending_progress = Some((
                            overall.or(prev.as_ref().map(|p| p.0)).unwrap_or(idx as f64 / n as f64),
                            out.text.or(prev.and_then(|p| p.1)),
                        ));
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // the child exited but something it started still holds our pipes open: don't wait forever
                    if exited_at.is_none() && matches!(child.try_wait(), Ok(Some(_))) {
                        exited_at = Some(Instant::now());
                    }
                    if exited_at.map(|t| t.elapsed() > Duration::from_secs(10)).unwrap_or(false) {
                        self.event(&job.id, "system", "warn", "程序已結束，但輸出管線仍被它啟動的其他程序占用；不再等待");
                        break;
                    }
                    if is_paused(&job.id) {
                        // paused on purpose: silence is expected, restart the stall clock when it resumes
                        last_output = Instant::now();
                        continue;
                    }
                    if let Some(lim) = step.stall_secs {
                        let quiet = last_output.elapsed().as_secs();
                        // no output: a file the step is still writing counts as activity (checked at most once a minute)
                        if quiet >= lim && last_files_check.elapsed() >= Duration::from_secs((lim / 4).clamp(1, 60)) {
                            if let Some(dir) = &step.activity_dir {
                                last_files_check = Instant::now();
                                if let Some(fq) = crate::activity::files_quiet_secs(dir).filter(|f| *f < lim) {
                                    last_output = Instant::now() - Duration::from_secs(fq);
                                    if !noted_files {
                                        noted_files = true;
                                        self.event(&job.id, "system", "info", &format!("{quiet} 秒沒有輸出，但工作資料夾的檔案 {fq} 秒前仍有變動：繼續等待"));
                                    }
                                }
                            }
                        }
                        let quiet = last_output.elapsed().as_secs();
                        if quiet >= lim {
                            let files = step.activity_dir.as_ref().map(|_| "、工作資料夾也沒有檔案變動").unwrap_or("");
                            let msg = format!("停滯：{quiet} 秒沒有任何輸出{files}（上限 {lim} 秒），已結束程序樹。最後一行：{last_line}");
                            let k = crate::util::kill_tree(child.id());
                            self.event(&job.id, "system", "error", &format!("{msg}｜taskkill：{}", k.trim()));
                            crate::watchdog::log_line(&format!("job {} {}", &job.id[..8.min(job.id.len())], msg));
                            let _ = child.wait();
                            return Err((None, msg));
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if pending_progress.is_some() && last_emit.elapsed() >= Duration::from_millis(250) {
                let (p, t) = pending_progress.take().unwrap();
                let _ = db::job_set_progress(&self.conn(), &job.id, p, t.as_deref());
                self.emit_job(&job.id);
                last_emit = Instant::now();
            }
        }
        if let Some((p, t)) = pending_progress.take() {
            let _ = db::job_set_progress(&self.conn(), &job.id, p, t.as_deref());
            self.emit_job(&job.id);
        }
        if exited_at.is_none() {
            for r in readers {
                let _ = r.join();
            }
        } // else: readers stay blocked on pipes held by an orphan; they end when it does (not joined on purpose)
        let status = child.wait().map_err(|e| (None, e.to_string()))?;
        Ok(status.code().unwrap_or(-1))
    }
}

/// Read a pipe line by line, splitting on \n and \r (progress bars), decoding lossy UTF-8.
fn read_lines(mut r: Box<dyn Read + Send>, mut f: impl FnMut(String)) {
    let mut br = BufReader::new(&mut r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match br.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                for part in buf.split(|b| *b == b'\r' || *b == b'\n') {
                    if !part.is_empty() {
                        f(String::from_utf8_lossy(part).into_owned());
                    }
                }
            }
            Err(_) => break,
        }
    }
}

/// GPU jobs may only start inside [start, end) local time (wraps past midnight). No window → always.
pub fn in_window(s: &db::Settings, now: chrono::NaiveTime) -> bool {
    let parse = |x: &Option<String>| x.as_deref().and_then(|t| chrono::NaiveTime::parse_from_str(t, "%H:%M").ok());
    match (parse(&s.window_start), parse(&s.window_end)) {
        (Some(a), Some(b)) if a < b => now >= a && now < b,
        (Some(a), Some(b)) if a > b => now >= a || now < b,
        _ => true,
    }
}

/// Keep the machine awake while jobs run (Windows: SetThreadExecutionState on the long-lived scheduler thread;
/// macOS: caffeinate; Linux: systemd-inhibit) — see platform::set_keep_awake.
pub fn set_keep_awake(on: bool) {
    crate::platform::set_keep_awake(on);
}

/// Background threads: scheduler (1 s), heartbeat (5 s), queue status (5 s).
pub fn spawn_scheduler(q: Arc<Queue>) {
    std::thread::Builder::new()
        .name("studio-scheduler".into())
        .spawn(move || {
            let mut last_hb = Instant::now();
            let mut last_status = Instant::now() - Duration::from_secs(10);
            loop {
                crate::watchdog::run_loop("scheduler", || {
                    q.tick();
                    if last_hb.elapsed() >= Duration::from_secs(HEARTBEAT_SECS) {
                        crate::watchdog::beat("scheduler", "heartbeat");
                        q.heartbeat();
                        last_hb = Instant::now();
                    }
                    if last_status.elapsed() >= Duration::from_secs(5) {
                        crate::watchdog::beat("scheduler", "status");
                        (q.emit)("queue://status", q.status());
                        last_status = Instant::now();
                    }
                });
                std::thread::sleep(Duration::from_secs(1));
            }
        })
        .expect("spawn scheduler");
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use super::*;
    use chrono::NaiveTime;

    fn q_with_project() -> (Arc<Queue>, String, PathBuf) {
        let conn = db::open_memory().unwrap();
        let dir = std::env::temp_dir().join(format!("pss-q-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = db::project_upsert(&conn, &dir.to_string_lossy(), "t").unwrap();
        let db: Db = Arc::new(Mutex::new(conn));
        std::env::set_var("PIKARA_STUDIO_DATA", dir.join("data"));
        let q = Queue::new(db, Arc::new(|_, _| {}));
        (q, p.id, dir)
    }

    /// The same test command for cmd.exe (Windows) and /bin/sh (macOS / Linux).
    fn sh(win: &'static str, unix: &'static str) -> &'static str {
        if cfg!(windows) { win } else { unix }
    }

    /// Is a process whose name contains `exe` (case-insensitive) and whose command line contains `arg` still alive?
    fn alive(exe: &str, arg: &str) -> bool {
        gpu::snapshot().procs.values().any(|(_, n, c)| n.to_ascii_lowercase().contains(exe) && c.contains(arg))
    }

    fn wait_status(q: &Arc<Queue>, id: &str, want: &[&str], secs: u64) -> Job {
        let t = Instant::now();
        loop {
            q.tick();
            let j = db::job_get(&q.conn(), id).unwrap();
            if want.contains(&j.status.as_str()) || t.elapsed() > Duration::from_secs(secs) {
                return j;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn window_logic() {
        let mut s = db::Settings::default();
        assert!(in_window(&s, NaiveTime::from_hms_opt(12, 0, 0).unwrap()));
        s.window_start = Some("01:00".into());
        s.window_end = Some("07:00".into());
        assert!(in_window(&s, NaiveTime::from_hms_opt(3, 0, 0).unwrap()));
        assert!(!in_window(&s, NaiveTime::from_hms_opt(12, 0, 0).unwrap()));
        s.window_start = Some("23:00".into());
        s.window_end = Some("02:00".into());
        assert!(in_window(&s, NaiveTime::from_hms_opt(1, 0, 0).unwrap()));
        assert!(!in_window(&s, NaiveTime::from_hms_opt(3, 0, 0).unwrap()));
    }

    #[test]
    fn runs_real_process_captures_output_and_exit_code() {
        let (q, pid, dir) = q_with_project();
        let ok = q.enqueue(Some(&pid), "custom", &json!({"command": "echo hello-studio && echo 中文輸出"}), &dir).unwrap();
        let bad = q.enqueue(Some(&pid), "custom", &json!({"command": "echo fail-line 1>&2 && exit 3"}), &dir).unwrap();
        let j = wait_status(&q, &ok.id, &["succeeded", "failed"], 20);
        assert_eq!(j.status, "succeeded");
        let ev = db::events_list(&q.conn(), &ok.id, 0, 100).unwrap();
        assert!(ev.iter().any(|e| e.line.trim() == "hello-studio"), "{ev:?}");
        let b = wait_status(&q, &bad.id, &["succeeded", "failed"], 20);
        assert_eq!(b.status, "failed");
        assert_eq!(b.exit_code, Some(3));
        assert!(b.error.unwrap().contains("fail-line"));
        assert!(Path::new(&j.log_path.unwrap()).exists());
    }

    #[test]
    fn gpu_lock_blocks_when_external_busy_and_one_gpu_job_at_a_time() {
        let (q, pid, dir) = q_with_project();
        q.force_external_busy.store(true, Ordering::Relaxed);
        let g = q.enqueue(Some(&pid), "custom", &json!({"command": sh("ping -n 2 127.0.0.1 >nul", "sleep 1"), "gpu": true}), &dir).unwrap();
        q.tick();
        let j = db::job_get(&q.conn(), &g.id).unwrap();
        assert_eq!(j.status, "waiting_resource");
        assert!(j.wait_reason.unwrap().contains("模擬外部"));
        q.force_external_busy.store(false, Ordering::Relaxed);
        // with external free, only VRAM/process rules apply; real GPU may be busy → skip if so
        if q.check_external(None).busy {
            eprintln!("real external GPU job detected; skipping lock-sequencing half of the test");
            return;
        }
        let g2 = q.enqueue(Some(&pid), "custom", &json!({"command": sh("ping -n 2 127.0.0.1 >nul", "sleep 1"), "gpu": true}), &dir).unwrap();
        q.tick();
        let a = db::job_get(&q.conn(), &g.id).unwrap();
        let b = db::job_get(&q.conn(), &g2.id).unwrap();
        assert_eq!(a.status, "running");
        assert_eq!(b.status, "waiting_resource");
        assert!(b.wait_reason.unwrap().contains("等待 GPU"));
        assert_eq!(wait_status(&q, &g2.id, &["succeeded"], 30).status, "succeeded");
    }

    #[test]
    fn silent_step_is_killed_as_stalled() {
        let (q, pid, dir) = q_with_project();
        // prints once, then hangs silently (ping to a blackhole address with output discarded)
        let j = q.enqueue(Some(&pid), "custom", &json!({"command": sh("echo start & ping -n 60 127.0.0.1 >nul", "echo start; sleep 60"), "stallSecs": 3}), &dir).unwrap();
        let t0 = Instant::now();
        let done = wait_status(&q, &j.id, &["failed"], 25);
        assert_eq!(done.status, "failed", "stalled job must fail, not hang");
        assert!(t0.elapsed() < Duration::from_secs(20));
        assert!(done.error.unwrap_or_default().contains("停滯"), "error names the stall");
        std::thread::sleep(Duration::from_millis(500));
        assert!(!alive(sh("ping.exe", "sleep"), sh("-n 60 127.0.0.1", "60")), "ping / sleep tree killed");
    }

    #[test]
    fn silent_step_that_keeps_writing_files_is_not_killed() {
        let (q, pid, dir) = q_with_project();
        // no output for ~7 s (limit 3 s), but a file in the working folder changes every second
        let cmd = sh("for /l %i in (1,1,7) do @(echo %i>>progress.txt & ping -n 2 127.0.0.1 >nul)", "for i in 1 2 3 4 5 6 7; do echo $i >> progress.txt; sleep 1; done");
        let j = q.enqueue(Some(&pid), "custom", &json!({"command": cmd, "stallSecs": 3, "watchFiles": true}), &dir).unwrap();
        let done = wait_status(&q, &j.id, &["succeeded", "failed"], 40);
        assert_eq!(done.status, "succeeded", "file activity counts: {:?}", done.error);
        let evs = db::events_list(&q.conn(), &j.id, 0, 1000).unwrap();
        assert!(evs.iter().any(|e| e.line.contains("檔案") && e.line.contains("繼續等待")), "noted once");
        // the same silence without file changes is a stall (wait until the folder has been quiet past the limit)
        std::thread::sleep(Duration::from_secs(4));
        let j2 = q.enqueue(Some(&pid), "custom", &json!({"command": sh("ping -n 8 127.0.0.1 >nul", "sleep 7"), "stallSecs": 3, "watchFiles": true}), &dir).unwrap();
        let done2 = wait_status(&q, &j2.id, &["succeeded", "failed"], 40);
        assert_eq!(done2.status, "failed");
        assert!(done2.error.unwrap_or_default().contains("工作資料夾也沒有檔案變動"));
    }

    #[test]
    fn exited_child_with_orphan_holding_pipes_does_not_hang() {
        let (q, pid, dir) = q_with_project();
        // cmd starts a detached grandchild that inherits stdout, then exits immediately
        let j = q.enqueue(Some(&pid), "custom", &json!({"command": sh("start /b ping -n 40 127.0.0.1 & echo parent-done", "sleep 40 & echo parent-done")}), &dir).unwrap();
        let t0 = Instant::now();
        let done = wait_status(&q, &j.id, &["succeeded", "failed"], 30);
        assert!(["succeeded", "failed"].contains(&done.status.as_str()), "status {}", done.status);
        assert!(t0.elapsed() < Duration::from_secs(25), "returned after the parent exited, took {:?}", t0.elapsed());
        // clean up the orphan ping
        for (p, (_, n, c)) in gpu::snapshot().procs {
            if n.to_ascii_lowercase().contains(sh("ping.exe", "sleep")) && c.contains(sh("-n 40 127.0.0.1", "40")) {
                crate::util::kill_tree(p);
            }
        }
    }

    /// Pause suspends the real process tree (no output, not killed as stalled even with a 2 s stall limit), resume
    /// continues it, and the job then finishes normally.
    #[test]
    fn pause_and_resume_a_running_job() {
        let (q, pid, dir) = q_with_project();
        let script = if cfg!(windows) {
            "for /L %i in (1,1,12) do @(echo tick %i & ping -n 2 127.0.0.1 >nul)"
        } else {
            "for i in $(seq 1 12); do echo tick $i; sleep 0.5; done"
        };
        let j = q.enqueue(Some(&pid), "custom", &json!({"command": script, "stallSecs": 2}), &dir).unwrap();

        wait_status(&q, &j.id, &["running"], 10);
        std::thread::sleep(Duration::from_millis(1500));
        q.pause(&j.id).unwrap();
        assert!(is_paused(&j.id));
        let evs = |q: &Arc<Queue>| db::events_list(&q.conn(), &j.id, 0, 100000).unwrap().iter().filter(|e| e.line.contains("tick")).count();
        std::thread::sleep(Duration::from_millis(700));
        let a = evs(&q);
        std::thread::sleep(Duration::from_millis(3000)); // longer than the 2 s stall limit
        assert_eq!(evs(&q), a, "no output while paused");
        assert_eq!(db::job_get(&q.conn(), &j.id).unwrap().status, "running", "a paused job is not killed as stalled");
        q.resume(&j.id).unwrap();
        assert!(!is_paused(&j.id));
        let done = wait_status(&q, &j.id, &["succeeded", "failed"], 60);
        assert_eq!(done.status, "succeeded", "{:?}", done.error);
        assert!(evs(&q) >= 12);
    }

    #[test]
    fn cancel_kills_process_tree() {
        let (q, pid, dir) = q_with_project();
        // cmd → ping child; tree-kill must take both down
        let j = q.enqueue(Some(&pid), "custom", &json!({"command": sh("ping -n 60 127.0.0.1", "sleep 60; true")}), &dir).unwrap();
        let r = wait_status(&q, &j.id, &["running"], 10);
        assert_eq!(r.status, "running");
        std::thread::sleep(Duration::from_millis(800));
        let root_pid = q.own_pids().into_iter().next().unwrap();
        let snap = gpu::snapshot();
        let kids: Vec<u32> = snap.procs.iter().filter(|(_, v)| v.0 == Some(root_pid)).map(|(k, _)| *k).collect();
        assert!(!kids.is_empty(), "ping child should exist");
        q.cancel(&j.id).unwrap();
        // 狀態必須在 cancel() 回傳時就已寫入（不依賴執行緒收尾；程序隨即結束也不會留下 running）
        assert_eq!(db::job_get(&q.conn(), &j.id).unwrap().status, "canceled");
        let done = wait_status(&q, &j.id, &["canceled"], 15);
        assert_eq!(done.status, "canceled");
        std::thread::sleep(Duration::from_millis(500));
        let snap = gpu::snapshot();
        for k in kids.iter().chain([root_pid].iter()) {
            assert!(!snap.procs.contains_key(k), "pid {k} survived cancel");
        }
    }

    #[test]
    fn multi_step_job_resumes_from_saved_step() {
        let (q, pid, dir) = q_with_project();
        let j = q.enqueue(Some(&pid), "youtube_15x", &json!({}), &dir).unwrap();
        assert_eq!(j.steps.len(), 2);
        // simulate: step 0 done, Studio died during step 1
        {
            let c = q.conn();
            db::job_mark_started(&c, &j.id, "x").unwrap();
            db::job_set_step(&c, &j.id, 1).unwrap();
            c.execute("UPDATE jobs SET heartbeat_ms=heartbeat_ms-60000 WHERE id=?1", [&j.id]).unwrap();
        }
        let ids = q.recover();
        assert_eq!(ids, vec![j.id.clone()]);
        let r = db::job_get(&q.conn(), &j.id).unwrap();
        assert_eq!(r.status, "queued");
        assert_eq!(r.step, 1, "resume must keep the step index");
        assert_eq!(r.attempt, 1);
        // don't actually run the GPU render: cancel it
        q.cancel(&j.id).unwrap();
        assert_eq!(db::job_get(&q.conn(), &j.id).unwrap().status, "canceled");
    }
}

#[cfg(test)]
mod failure_message_tests {
    use super::*;

    fn ev(stream: &str, level: &str, line: &str) -> db::JobEvent {
        db::JobEvent { id: 0, job_id: "j".into(), ts: 0, stream: stream.into(), level: level.into(), line: line.into() }
    }

    #[test]
    fn step_failure_messages_are_friendly() {
        // killed from outside: no error line → plain explanation, no unrelated log lines
        let m = step_failure_message("渲染 EP03-30fps", 1, &[ev("stdout", "info", "渲染 EP03-30fps：698 幀，1 段")]);
        assert!(m.contains("意外結束") && m.contains("重試") && m.contains("698 幀"), "{m}");
        // script printed a zh-TW error → that line is the message
        let m = step_failure_message("品質檢查", 2, &[ev("stdout", "info", "x"), ev("stderr", "info", "[QA 錯誤] 找不到影片檔：a.mp4")]);
        assert_eq!(m, "步驟「品質檢查」失敗（結束碼 2）：[QA 錯誤] 找不到影片檔：a.mp4");
    }
}
