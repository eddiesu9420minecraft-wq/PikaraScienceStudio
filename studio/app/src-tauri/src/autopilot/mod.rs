//! Autonomous Production Mode: topic in → finished, checked episode out.
//!
//! A *production* is a persistent state machine (SQLite `productions`) that drives the existing job queue:
//! every heavy step is an ordinary queued job (so the GPU lock, heartbeats, crash recovery and logs all apply),
//! run inside an isolated git worktree `.studio/worktrees/<wid>` on branch `studio/auto/<wid>`.
//!
//! Stages: prepare → script (research + narration) → animate (optional, Claude writes React acts) → voice (CosyVoice,
//! Whisper pronunciation check) → timeline → visual (stills + AI review) → final (zh-TW 30fps + QA) → youtube (1.5×)
//! → bilibili (zh-CN) → thumbnail → publish (metadata text) → deliver (move outputs, merge, clean up).
//!
//! Every finished stage is a git checkpoint in the worktree. A failed check sends the error to a Claude *fix* job and
//! the stage runs again, at most `maxAttempts` times. Soft checks (pronunciation, visual review, QA, thumbnail,
//! metadata) continue with a warning when attempts run out; hard failures stop the production and leave the project
//! untouched (the worktree stays for inspection or is discarded = rollback). Nothing is ever published or uploaded.
//!
//! Claude Code billing: subscription (default) removes API-key variables from the child so the signed-in login is used
//! and sets no USD cap; costs Claude Code reports are shown as *model-equivalent estimates*, not charges. API mode
//! requires the user's own key in the environment and passes `--max-budget-usd`. A usage/credit limit pauses the
//! production (progress kept); Studio never switches billing, never retries around a limit, never stores credentials.

#![allow(non_snake_case)]

use crate::content;
use crate::db::{self, Db};
use crate::gitops::{self, git};
use crate::jobs::worktree_dir;
use crate::queue::Queue;
use crate::util::{clean_path, now_iso, now_ms};
use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// Responsibilities are split into child modules; everything is re-exported here so
// `crate::autopilot::X` paths keep working.
mod config;
mod plan;
mod prompts;
mod store;
mod monitor;
mod inline;
mod quality;
mod worktree;
mod watchdog;
pub use config::*;
pub use watchdog::*;
pub use plan::*;
use prompts::*; // crate-internal only
pub use store::*;
pub use monitor::*;
use inline::*; // crate-internal only
pub use quality::*;
pub use worktree::*;

// ------------------------------------------------------------------ public API

pub struct Autopilot {
    pub db: Db,
    pub queue: Arc<Queue>,
    pub notify: Arc<dyn Fn(&str, &str) + Send + Sync>,
    pub emit: Arc<dyn Fn(&str, Value) + Send + Sync>,
    busy: Mutex<()>,
}

/// 這段時間要不要算進製作時間上限：工作在佇列中等 GPU／VRAM（waiting_resource）時不算。
pub(crate) fn counts_toward_limit(job_status: Option<&str>) -> bool {
    job_status != Some("waiting_resource")
}

impl Autopilot {
    pub fn new(db: Db, queue: Arc<Queue>, notify: Arc<dyn Fn(&str, &str) + Send + Sync>, emit: Arc<dyn Fn(&str, Value) + Send + Sync>) -> Arc<Self> {
        Arc::new(Autopilot { db, queue, notify, emit, busy: Mutex::new(()) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn root(&self, p: &Production) -> Result<PathBuf, String> {
        let pid = p.project_id.as_deref().ok_or("製作沒有專案")?;
        Ok(PathBuf::from(db::project_get(&self.conn(), pid)?.root_path))
    }

    fn store(&self, p: &Production) {
        let _ = save(&self.conn(), p);
        (self.emit)("production://update", serde_json::to_value(p).unwrap_or(Value::Null));
    }

    fn log(&self, p: &Production, level: &str, line: &str) {
        event(&self.conn(), p, level, line);
        (self.emit)("production://event", json!({"id": p.id, "level": level, "stage": p.stage, "line": line}));
    }

    /// Create a production (status queued). The episode id is reserved immediately.
    pub fn start(&self, project_id: &str, mut cfg: AutoConfig) -> Result<Production, String> {
        cfg.validate()?;
        let root = PathBuf::from(db::project_get(&self.conn(), project_id)?.root_path);
        if !root.join(".git").exists() {
            return Err("專案資料夾不是 git 倉庫，無法建立隔離工作樹".into());
        }
        match cfg.agent.as_str() {
            "claude" if crate::claude::claude_path().is_none() => {
                return Err("找不到 Claude Code CLI。請先安裝 Claude Code，並在終端機執行 claude 完成登入。".into());
            }
            "doubao" if crate::agents::doubao_path().is_none() => {
                return Err("找不到豆包 CLI（doubao）。請依豆包工作官方說明安裝：npm install -g @bytedance/doubao-cli，再執行 doubao login 掃碼登入。".into());
            }
            _ => {}
        }
        let c = self.conn();
        let episode = if cfg.sandbox { allocate_test(&c, &root)? } else { allocate_episode(&c, &root)? };
        // the video's own folder: brief, imported material (copied, the user's originals stay where they are)
        let vdir = crate::layout::ensure_video_dir(&root, &episode)?;
        crate::assets::import(&vdir.join("assets"), &mut cfg.assets)?;
        if cfg.mode == "script" && cfg.script_text.trim().is_empty() {
            if let Some(t) = crate::assets::script_text(&vdir.join("assets"), &cfg.assets) {
                cfg.script_text = t.chars().take(60000).collect();
            }
        }
        cfg.require_script()?;
        let _ = std::fs::write(vdir.join("BRIEF.md"), content::brief_markdown(&cfg, &episode));
        let id = uuid::Uuid::new_v4().to_string();
        let stages = STAGES
            .iter()
            .map(|(sid, _)| StageInfo {
                id: sid.to_string(),
                label: stage_label_for(sid, &cfg),
                status: if stage_enabled(sid, &cfg) { "pending".into() } else { "skipped".into() },
                ..Default::default()
            })
            .collect();
        let p = Production {
            id,
            project_id: Some(project_id.into()),
            episode,
            config: cfg,
            status: "queued".into(),
            stage: "prepare".into(),
            action: 0,
            attempt: 1,
            mode: "main".into(),
            data: json!({}),
            stages,
            created_at: now_iso(),
            ..Default::default()
        };
        save(&c, &p)?;
        event(
            &c,
            &p,
            "info",
            &format!(
                "建立{}：{}（{}，約 {} 分鐘，{}，{}{}）；製作要求與素材在 {}",
                if p.config.sandbox { " Sandbox 測試" } else { "自動製作" },
                p.episode.to_uppercase(),
                p.config.topic,
                p.config.minutes,
                content::mode_label(content::mode(&p.config)),
                content::lang_label(content::lang(&p.config)),
                if p.config.assets.is_empty() { String::new() } else { format!("，{} 個素材", p.config.assets.len()) },
                crate::layout::video_rel(&p.episode)
            ),
        );
        drop(c);
        (self.emit)("production://update", serde_json::to_value(&p).unwrap());
        Ok(p)
    }

    /// The worktree already holds this episode's script (scenes with lines) and, when sources are required,
    /// its <EP>_SOURCES.md, e.g. a production that failed only the requirement check before
    /// `data.requirements` existed.
    fn script_written(&self, p: &Production) -> bool {
        let (Ok(root), Some(w)) = (self.root(p), p.worktree.as_deref()) else { return false };
        let wt = worktree_dir(&root, w);
        let has_scenes = crate::narration::read(&wt, "zh-TW")
            .ok()
            .and_then(|r| r["doc"]["sequences"][&p.episode]["scenes"].as_array().map(|s| s.iter().any(|x| x["lines"].as_array().is_some_and(|l| !l.is_empty()))))
            .unwrap_or(false);
        has_scenes && (p.config.min_sources() == 0 || wt.join(format!("{}_SOURCES.md", ep_upper(&p.episode))).exists())
    }

    /// Stop at an AI step for an external agent: write the task file into the worktree and wait.
    fn wait_for_agent(&self, mut p: Production, title: &str, prompt: &str) {
        let file = match (self.root(&p), p.worktree.clone()) {
            (Ok(root), Some(w)) => {
                let wt = worktree_dir(&root, &w);
                let f = wt.join("out").join("auto").join("AGENT_TASK.md");
                let _ = std::fs::create_dir_all(f.parent().unwrap());
                let body = format!(
                    "# {title}\n\n工作目錄（所有檔案操作都在這裡）：{}\n\n{prompt}\n\n---\n完成後執行：PikaraScienceStudio.exe --cli agent-done --id {}\n無法完成時執行：PikaraScienceStudio.exe --cli agent-done --id {} --failed --note \"原因\"\n",
                    clean_path(&wt),
                    p.id,
                    p.id
                );
                let _ = std::fs::write(&f, body);
                Some(clean_path(&f))
            }
            _ => None,
        };
        p.status = "waiting_agent".into();
        p.data["agentTask"] = json!({"title": title, "prompt": prompt, "file": file, "since": now_iso(), "mode": p.mode});
        p.message = Some(format!("等待外部 Agent 完成：{title}（任務說明：{}）", file.clone().unwrap_or_default()));
        self.mark_stage(&mut p, "running", None);
        self.log(&p, "info", &format!("⏸ 等待外部 Agent：{title}"));
        (self.notify)(&format!("Pikara Science Studio：{} 等待 Agent", ep_upper(&p.episode)), title);
        self.store(&p);
    }

    /// The external agent finished (or gave up on) the current AI step. Studio continues with the stage's checks.
    pub fn agent_done(&self, id: &str, failed: bool, note: Option<&str>) -> Result<Production, String> {
        let mut p = get(&self.conn(), id)?;
        if p.status != "waiting_agent" {
            return Err(format!("這次製作目前不是在等待 Agent（狀態：{}）", p.status));
        }
        let title = p.data["agentTask"]["title"].as_str().unwrap_or("").to_string();
        p.data.as_object_mut().map(|m| m.remove("agentTask"));
        p.status = "running".into();
        p.message = None;
        p.last_tick_ms = now_ms();
        if let Some(n) = note.filter(|n| !n.trim().is_empty()) {
            self.log(&p, "info", &format!("Agent 回報：{}", n.chars().take(1000).collect::<String>()));
        }
        if failed {
            self.log(&p, "warn", &format!("Agent 無法完成：{title}"));
            let mode_fix = p.mode == "fix";
            p.mode = "main".into();
            self.store(&p);
            let reason = format!("外部 Agent 回報無法完成「{title}」：{}", note.unwrap_or(""));
            self.stage_failed(p.clone(), &reason, !mode_fix, false);
            return get(&self.conn(), id);
        }
        self.log(&p, "info", &format!("✓ Agent 完成：{title}"));
        if p.mode == "fix" {
            p.mode = "main".into();
            p.action = 0;
            p.data["fresh"] = json!(true);
        } else {
            p.action += 1;
        }
        self.store(&p);
        Ok(p)
    }

    pub fn pause(&self, id: &str) -> Result<Production, String> {
        let mut p = get(&self.conn(), id)?;
        if !["queued", "running", "waiting_agent"].contains(&p.status.as_str()) {
            return Err(format!("目前狀態「{}」不能暫停", p.status));
        }
        p.status = "paused".into();
        p.message = Some("已暫停：正在執行的工作會做完，之後不會開始新的步驟。按「繼續」恢復。".into());
        self.log(&p, "info", "使用者暫停");
        self.store(&p);
        Ok(p)
    }

    /// Resume a paused / limit-paused / failed production. A failed stage gets a fresh set of attempts.
    pub fn resume(&self, id: &str) -> Result<Production, String> {
        let mut p = get(&self.conn(), id)?;
        match p.status.as_str() {
            "paused" | "paused_limit" => {}
            "failed" => {
                p.attempt = 1;
                p.mode = "main".into();
                p.action = 0;
                p.job_id = None;
                if let Some(m) = p.data.as_object_mut() {
                    m.remove("prevFailKeys");
                    m.remove("resumeAt");
                }
                // research + script already written and only the requirement check failed: check the existing work
                // again (with the current checker) instead of researching and writing from scratch
                if p.stage == "script" && (p.data["requirements"].is_object() || self.script_written(&p)) {
                    if let Some(i) = actions(&p).iter().position(|a| matches!(a, Action::Inline(n) if *n == "check_script")) {
                        p.action = i;
                        self.log(&p, "info", "沿用工作樹中已完成的研究與劇本，重新檢查製作要求（不重新研究）");
                    }
                }
            }
            "needs_merge" => return self.retry_deliver(p),
            s => return Err(format!("目前狀態「{s}」不能繼續")),
        }
        let root = self.root(&p)?;
        if p.worktree.as_deref().map(|w| !worktree_dir(&root, w).exists()).unwrap_or(false) {
            return Err("這次製作的工作樹已被刪除，無法繼續。".into());
        }
        p.status = "running".into();
        p.message = None;
        p.not_before_ms = 0;
        p.last_tick_ms = now_ms();
        self.log(&p, "info", "繼續製作");
        self.store(&p);
        Ok(p)
    }

    /// Stop: cancel the running job; keep the worktree (inspect or discard later). The project is untouched.
    pub fn stop(&self, id: &str) -> Result<Production, String> {
        let mut p = get(&self.conn(), id)?;
        if !ACTIVE.contains(&p.status.as_str()) && p.status != "needs_merge" {
            return Err(format!("目前狀態「{}」不能停止", p.status));
        }
        if let Some(j) = p.job_id.take() {
            let _ = self.queue.cancel(&j);
        }
        p.status = "canceled".into();
        p.finished_at = Some(now_iso());
        p.message = Some("已停止。專案本身沒有任何改變；工作樹保留，可檢視或按「捨棄」刪除。".into());
        self.log(&p, "warn", "使用者停止");
        self.store(&p);
        Ok(p)
    }

    /// Discard = rollback: remove the worktree and its branch. Only for finished / stopped productions.
    pub fn discard(&self, id: &str) -> Result<Production, String> {
        let mut p = get(&self.conn(), id)?;
        if ACTIVE.contains(&p.status.as_str()) {
            return Err("請先停止這次製作".into());
        }
        let root = self.root(&p)?;
        if let Some(w) = p.worktree.clone() {
            remove_worktree(&root, &w, true)?;
        }
        p.message = Some(format!("{}（工作樹與分支已刪除）", p.message.clone().unwrap_or_default()));
        p.worktree = None;
        self.log(&p, "info", "已捨棄工作樹與分支");
        self.store(&p);
        Ok(p)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let p = get(&self.conn(), id)?;
        if ACTIVE.contains(&p.status.as_str()) || p.worktree.is_some() {
            return Err("請先停止並捨棄工作樹，再從清單移除".into());
        }
        self.conn().execute("DELETE FROM productions WHERE id=?1", [&p.id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    // -------------------------------------------------------------- scheduler

    /// One orchestration pass over all productions. At most one production runs at a time (they share the GPU).
    pub fn tick(&self) {
        let Ok(_g) = self.busy.try_lock() else { return };
        let all = list(&self.conn(), 200).unwrap_or_default();
        let mut running = all.iter().filter(|p| ["running", "paused", "paused_limit"].contains(&p.status.as_str()) && p.job_id.is_some() || ["running", "waiting_agent"].contains(&p.status.as_str())).count();
        for mut p in all.into_iter().rev() {
            match p.status.as_str() {
                "queued" if running == 0 => {
                    p.status = "running".into();
                    p.started_at = Some(now_iso());
                    p.last_tick_ms = now_ms();
                    self.store(&p);
                    running += 1;
                    self.advance(p);
                }
                "running" => self.advance(p),
                "paused" | "paused_limit" => {
                    // a job that was already running keeps going; record its result without starting anything new
                    if let Some(j) = p.job_id.clone() {
                        let job = db::job_get(&self.conn(), &j);
                        if let Ok(job) = job {
                            if !["queued", "waiting_resource", "running", "interrupted"].contains(&job.status.as_str()) {
                                self.log(&p, "info", &format!("暫停期間完成的工作：{}（{}）", job.label, job.status));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn advance(&self, mut p: Production) {
        let now = now_ms();
        // 佇列因 GPU／VRAM 忙碌讓工作排隊（waiting_resource）的時間不算進時間上限：上限是限制「製作工作量」，
        // 不是限制使用者開遊戲／OBS 的時間（沙盒 TEST003 就是排隊 2 小時後被判逾時）。
        let job_status = p.job_id.as_deref().and_then(|j| db::job_get(&self.conn(), j).ok()).map(|j| j.status);
        if p.last_tick_ms > 0 && counts_toward_limit(job_status.as_deref()) {
            p.active_ms += (now - p.last_tick_ms).clamp(0, 60_000);
        }
        p.last_tick_ms = now;
        if p.active_ms > p.config.max_minutes as i64 * 60_000 {
            if let Some(j) = p.job_id.take() {
                let _ = self.queue.cancel(&j);
            }
            let m = format!("超過時間上限 {} 分鐘，已停止。完成的部分保留在工作樹中，可調整上限後按「繼續」。", p.config.max_minutes);
            return self.fail(p, &m);
        }
        // 1. a job is in flight
        if let Some(jid) = p.job_id.clone() {
            let job = match db::job_get(&self.conn(), &jid) {
                Ok(j) => j,
                Err(_) => {
                    p.job_id = None;
                    return self.store(&p);
                }
            };
            match job.status.as_str() {
                "queued" | "waiting_resource" | "running" | "interrupted" => {
                    // inactivity / stall detection (stops the job and recovers the step when it took over)
                    let Some(mut p) = self.watch(p, &job) else { return };
                    // keep the UI's view fresh (active time) at most every 5 s
                    if now - p.data["lastSave"].as_i64().unwrap_or(0) > 5000 {
                        p.data["lastSave"] = json!(now);
                        self.store(&p);
                    }
                    return;
                }
                "succeeded" => {
                    p.job_id = None;
                    self.account_claude(&mut p, &job);
                    p.data["lastJob"] = json!(jid);
                    if p.mode == "fix" {
                        p.mode = "main".into();
                        // a check failed on text the fix edits directly (script): re-run only that check, not the
                        // whole stage — research and the script job are not repeated
                        match p.data.as_object_mut().and_then(|m| m.remove("resumeAt")).and_then(|v| v.as_u64()) {
                            Some(at) => {
                                self.log(&p, "info", "修正完成，只重新檢查不合格的項目（不重新研究、不重寫劇本）");
                                p.action = at as usize;
                            }
                            None => {
                                self.log(&p, "info", "修正完成，重新執行這個階段");
                                p.action = 0;
                                p.data["fresh"] = json!(true);
                            }
                        }
                    } else {
                        p.action += 1;
                    }
                    self.store(&p);
                }
                "canceled" => {
                    p.job_id = None;
                    // stopped by the watchdog because it looked stuck: recover the step, don't end the production
                    if p.data["watchdogCancel"].as_str() == Some(jid.as_str()) {
                        let why = p.data["watchdogReason"].as_str().unwrap_or("偵測到卡住").to_string();
                        return self.recover_step(p, &why);
                    }
                    return self.fail(p, "工作被取消");
                }
                _ => {
                    // failed
                    p.job_id = None;
                    self.account_claude(&mut p, &job);
                    let text = self.job_failure_text(&job);
                    if let Some(limit) = (job.kind == "claude_in" || job.kind == "agent_cli").then(|| usage_limit(&text)).flatten() {
                        p.status = "paused_limit".into();
                        p.message = Some(limit);
                        self.log(&p, "warn", p.message.as_deref().unwrap_or(""));
                        (self.notify)("Pikara Science Studio：已暫停", p.message.as_deref().unwrap_or(""));
                        // the same action re-runs after the user resumes (not counted as an attempt)
                        if p.mode == "fix" {
                            p.data["pendingFix"] = json!(text);
                        }
                        return self.store(&p);
                    }
                    if (job.kind == "claude_in" || job.kind == "agent_cli") && is_transient(&text) && p.data["transient"].as_u64().unwrap_or(0) < 6 {
                        p.data["transient"] = json!(p.data["transient"].as_u64().unwrap_or(0) + 1);
                        p.not_before_ms = now + 5 * 60_000;
                        self.log(&p, "warn", "Claude 服務暫時忙碌，5 分鐘後重試（不計入嘗試次數）");
                        if p.mode == "fix" {
                            p.mode = "main".into();
                            p.data["pendingFix"] = json!(text);
                        }
                        return self.store(&p);
                    }
                    // stopped by the queue's no-activity guard: run the same step again from where it stopped
                    // (not a fix: nothing was wrong with the work, it just stopped making progress)
                    if text.starts_with("停滯：") || job.error.as_deref().is_some_and(|e| e.starts_with("停滯：")) {
                        p.data.as_object_mut().map(|m| m.remove("watch"));
                        return self.recover_step(p, &first_line(&text));
                    }
                    let Some(mut p) = self.try_env_repair(p, &job, &text) else { return };
                    if p.mode == "fix" {
                        p.mode = "main".into();
                        return self.stage_failed(p, &format!("修正工作失敗：{text}"), true, false);
                    }
                    return self.stage_failed(p, &text, true, false);
                }
            }
        }
        if now < p.not_before_ms {
            return;
        }
        if let Some(text) = p.data.get("pendingFix").and_then(|v| v.as_str()).map(String::from) {
            p.data.as_object_mut().map(|m| m.remove("pendingFix"));
            return self.start_fix(p, &text);
        }
        // 2. next action of the current stage, or the next stage
        let acts = actions(&p);
        if p.action >= acts.len() {
            return self.next_stage(p);
        }
        // after a stall / interruption / manual recovery: an AI step continues from the files already written
        let resume_note = p.data.as_object_mut().and_then(|m| m.remove("resumeNote")).and_then(|v| v.as_str().map(String::from));
        let mut act = acts[p.action].clone();
        if let Some(why) = &resume_note {
            match &mut act {
                Action::Job { kind, params } if ["claude_in", "agent_cli"].contains(kind) => {
                    let prompt = format!("{}{}", params["prompt"].as_str().unwrap_or(""), continuation_note(why));
                    params["prompt"] = json!(prompt);
                }
                Action::Agent { prompt, .. } => prompt.push_str(&continuation_note(why)),
                _ => {}
            }
        }
        match act {
            Action::Job { kind, params } => {
                let root = match self.root(&p).and_then(|r| crate::jobs::job_root(&r, &params)) {
                    Ok(r) => r,
                    Err(e) => return self.stage_failed(p, &e, false, false),
                };
                match self.queue.enqueue(p.project_id.as_deref(), kind, &params, &root) {
                    Ok(j) => {
                        self.log(&p, "info", &format!("▶ {}", j.label));
                        p.job_id = Some(j.id);
                        self.mark_stage(&mut p, "running", None);
                        self.store(&p);
                    }
                    Err(e) => self.stage_failed(p, &e, false, false),
                }
            }
            Action::Agent { title, prompt } => self.wait_for_agent(p, &title, &prompt),
            Action::Inline(name) => {
                self.mark_stage(&mut p, "running", None);
                match self.inline(&mut p, name) {
                    Ok(()) => {
                        p.action += 1;
                        self.store(&p);
                    }
                    Err(Check::Fail(e)) => self.stage_failed(p, &e, true, true),
                    Err(Check::Hard(e)) => self.stage_failed(p, &e, false, false),
                    Err(Check::Retry(e)) => {
                        // revised by the reviewer itself: run the stage again (counts as an attempt, no fix job)
                        self.log(&p, "info", &e);
                        self.retry_or_give_up(p, &e, false, true)
                    }
                    Err(Check::Done(merged)) => self.finish(p, merged),
                }
            }
        }
    }

    fn account_claude(&self, p: &mut Production, job: &db::Job) {
        if job.kind != "claude_in" && job.kind != "agent_cli" {
            return;
        }
        p.claude_runs += 1;
        static RE_COST: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\[done\].*cost=\$([0-9.]+)").unwrap());
        if let Ok(evs) = db::events_list(&self.conn(), &job.id, 0, 1_000_000) {
            for e in evs.iter().rev() {
                if let Some(c) = RE_COST.captures(&e.line) {
                    p.claude_cost_usd += c[1].parse::<f64>().unwrap_or(0.0);
                    break;
                }
            }
        }
    }

    fn job_failure_text(&self, job: &db::Job) -> String {
        let evs = db::events_list(&self.conn(), &job.id, 0, 1_000_000).unwrap_or_default();
        let tail: Vec<String> = evs.iter().filter(|e| e.stream != "system" || e.level == "error").rev().take(60).map(|e| e.line.clone()).collect::<Vec<_>>().into_iter().rev().collect();
        format!("{}\n--- 日誌最後 {} 行 ---\n{}", job.error.clone().unwrap_or_default(), tail.len(), tail.join("\n"))
    }

    fn mark_stage(&self, p: &mut Production, status: &str, note: Option<String>) {
        let stage = p.stage.clone();
        let attempt = p.attempt;
        if let Some(s) = p.stages.iter_mut().find(|s| s.id == stage) {
            if s.status != status {
                if status == "running" && s.started_at.is_none() {
                    s.started_at = Some(now_iso());
                }
                if ["done", "warned", "failed"].contains(&status) {
                    s.finished_at = Some(now_iso());
                }
                s.status = status.into();
            }
            s.attempts = attempt;
            if note.is_some() {
                s.note = note;
            }
        }
    }

    fn next_stage(&self, mut p: Production) {
        // checkpoint
        if let (Ok(root), Some(w)) = (self.root(&p), p.worktree.clone()) {
            let wt = worktree_dir(&root, &w);
            if wt.exists() && p.stage != "deliver" {
                if let Some(sha) = checkpoint(&wt, &format!("auto({}): {} ✓", ep_upper(&p.episode), stage_label(&p.stage))) {
                    let st = p.stage.clone();
                    if let Some(s) = p.stages.iter_mut().find(|s| s.id == st) {
                        s.checkpoint = Some(sha);
                    }
                }
            }
        }
        let warned = p.stages.iter().find(|s| s.id == p.stage).map(|s| s.status == "warned").unwrap_or(false);
        if !warned {
            self.mark_stage(&mut p, "done", None);
        }
        self.log(&p, "info", &format!("✓ {}", stage_label(&p.stage)));
        let idx = STAGES.iter().position(|s| s.0 == p.stage).unwrap_or(0);
        let next = STAGES.iter().skip(idx + 1).find(|s| stage_enabled(s.0, &p.config)).map(|s| s.0);
        match next {
            Some(n) => {
                p.stage = n.into();
                p.action = 0;
                p.attempt = 1;
                p.mode = "main".into();
                p.data["fresh"] = json!(false);
                p.data["transient"] = json!(0);
                p.data.as_object_mut().map(|m| { m.remove("voiceOnly"); m.remove("prevFailKeys"); m.remove("resumeAt"); });
                self.store(&p);
            }
            None => self.finish(p, true),
        }
    }

    /// A stage failed: fix job (when the stage has a fixer and `fixable`), else re-run; give up after max attempts.
    fn stage_failed(&self, mut p: Production, err: &str, fixable: bool, from_check: bool) {
        self.log(&p, "error", &format!("✗ {}（第 {}/{} 次）：{}", stage_label(&p.stage), p.attempt, p.config.max_attempts, first_line(err)));
        let detail: String = err.lines().skip(1).filter(|l| !l.trim().is_empty()).take(40).collect::<Vec<_>>().join("\n");
        if !detail.is_empty() {
            self.log(&p, "info", &detail.chars().take(3000).collect::<String>());
        }
        if from_check {
            // what failed now (requirement keys for the script check, else the error text itself)
            let now: Vec<String> = if p.stage == "script" && p.data["requirements"].is_object() {
                p.data["requirements"]["items"].as_array().map(|a| a.iter().filter(|i| i["status"] == "fail").filter_map(|i| i["key"].as_str().map(String::from)).collect()).unwrap_or_default()
            } else {
                vec![crate::narration::norm(&first_line(err))]
            };
            let prev: Vec<String> = p.data["prevFailKeys"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            // a fix ran and not a single failing item improved → stop calling the AI again, explain instead
            if !prev.is_empty() && !now.is_empty() && prev.iter().all(|k| now.contains(k)) {
                let shown: Vec<String> = now.iter().take(8).cloned().collect();
                let msg = format!(
                    "「{}」修正後同樣的 {} 項仍未通過，已停止重複呼叫 {}（避免浪費額度）。未通過：{}。\n可能原因：要求與影片語言或用語不一致、要求無法只靠旁白滿足、或檢查規則需要調整。\
                     每一項的預期與實際內容見製作頁「製作要求檢查」與工作樹 out/auto/REQUIREMENTS_CHECK.json；調整製作要求或手動修改劇本後按「繼續」，已完成的研究與劇本都會保留。",
                    stage_label(&p.stage), now.len(), agent_name(&p.config.agent), shown.join("、")
                );
                p.data.as_object_mut().map(|m| m.remove("prevFailKeys"));
                return self.fail(p, &msg);
            }
            p.data["prevFailKeys"] = json!(now);
            // script check: the fix edits narration / sources directly, so only the check needs to run again
            if p.stage == "script" {
                p.data["resumeAt"] = json!(p.action);
            }
        }
        self.retry_or_give_up(p, err, fixable, from_check)
    }

    /// `from_check`: the stage's own work succeeded but a quality check did not (QA, pronunciation, review).
    fn retry_or_give_up(&self, mut p: Production, err: &str, fixable: bool, from_check: bool) {
        let (fixer, soft) = stage_meta(&p.stage);
        // checks may end with a warning; a crashed render / TTS stops the production (there would be no output)
        let soft_here = soft && (from_check || ["animate", "visual", "thumbnail", "publish"].contains(&p.stage.as_str()));
        if p.attempt >= p.config.max_attempts {
            if soft_here {
                return self.give_up_soft(p, err);
            }
            let m = format!("「{}」重試 {} 次仍失敗：{}", stage_label(&p.stage), p.config.max_attempts, first_line(err));
            return self.fail(p, &m);
        }
        p.attempt += 1;
        if fixable && fixer != Fixer::None {
            return self.start_fix(p, err);
        }
        p.action = 0;
        p.mode = "main".into();
        p.data["fresh"] = json!(true);
        self.mark_stage(&mut p, "running", None);
        self.store(&p);
    }

    fn start_fix(&self, mut p: Production, err: &str) {
        let (fixer, _) = stage_meta(&p.stage);
        if p.stage == "voice" {
            // re-voice only the lines that were flagged
            if let Some(ids) = p.data["badLines"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" ")) {
                p.data["voiceOnly"] = json!(ids);
            }
        }
        let action = with_base(ai(&p, &format!("修正：{}", stage_label(&p.stage)), &prompt_fix(&p, fixer, err), TOOLS_CODE), &p);
        let (kind, params) = match action {
            Action::Job { kind, params } => (kind, params),
            Action::Agent { title, prompt } => {
                p.mode = "fix".into();
                return self.wait_for_agent(p, &title, &prompt);
            }
            Action::Inline(_) => unreachable!(),
        };
        let root = match self.root(&p).and_then(|r| crate::jobs::job_root(&r, &params)) {
            Ok(r) => r,
            Err(e) => return self.fail(p, &e),
        };
        match self.queue.enqueue(p.project_id.as_deref(), kind, &params, &root) {
            Ok(j) => {
                self.log(&p, "info", &format!("▶ 交給 {} 修正（{}）", agent_name(&p.config.agent), j.label));
                p.mode = "fix".into();
                p.job_id = Some(j.id);
                self.store(&p);
            }
            Err(e) => self.fail(p, &e),
        }
    }

    fn give_up_soft(&self, mut p: Production, err: &str) {
        let msg = format!("「{}」在 {} 次嘗試後仍未完全通過，繼續製作：{}", stage_label(&p.stage), p.config.max_attempts, first_line(err));
        self.log(&p, "warn", &msg);
        if ["animate", "visual"].contains(&p.stage.as_str()) {
            // code changed by this stage may be broken: go back to the previous checkpoint
            // (animate → generic narration template; visual → the code as it was before the review)
            if let (Ok(root), Some(w)) = (self.root(&p), p.worktree.clone()) {
                let wt = worktree_dir(&root, &w);
                let idx = p.stages.iter().position(|s| s.id == p.stage).unwrap_or(0);
                let cp = p.stages[..idx].iter().rev().find_map(|s| s.checkpoint.clone());
                if let Some(cp) = cp {
                    let _ = git(&wt, &["reset", "--hard", "-q", &cp]);
                    let _ = git(&wt, &["clean", "-fdq", "--", "src"]);
                    self.log(&p, "warn", &format!("已還原到上一個檢查點 {cp}{}", if p.stage == "animate" { "，改用通用旁白樣板" } else { "" }));
                }
            }
        }
        p.warnings.push(msg.clone());
        self.mark_stage(&mut p, "warned", Some(first_line(err)));
        p.action = usize::MAX; // stage over → next_stage
        self.store(&p);
    }

    fn fail(&self, mut p: Production, msg: &str) {
        p.status = "failed".into();
        p.finished_at = Some(now_iso());
        p.message = Some(format!("{msg}\n專案本身沒有任何改變（所有修改都在隔離工作樹 {}）。可按「繼續」重試這個階段，或按「捨棄」回復。", p.worktree.clone().unwrap_or_default()));
        self.mark_stage(&mut p, "failed", Some(first_line(msg)));
        self.log(&p, "error", msg);
        (self.notify)(&format!("Pikara Science Studio：{} 製作失敗", ep_upper(&p.episode)), &first_line(msg));
        self.store(&p);
    }

    fn finish(&self, mut p: Production, merged: bool) {
        p.finished_at = Some(now_iso());
        if merged {
            p.status = "succeeded".into();
            self.mark_stage(&mut p, "done", None);
            let w = if p.warnings.is_empty() { String::new() } else { format!("（{} 項警告，請檢視）", p.warnings.len()) };
            p.message = Some(format!("完成{w}。成品：{}。發布請自行到各平台手動上傳。", p.outputs.join("、")));
            (self.notify)(&format!("Pikara Science Studio：{} 製作完成", ep_upper(&p.episode)), &format!("{}{w}", p.config.topic));
        } else {
            p.status = "needs_merge".into();
            (self.notify)(&format!("Pikara Science Studio：{} 需要手動合併", ep_upper(&p.episode)), "成品已移到專案資料夾；原始碼合併時發生衝突。");
        }
        self.log(&p, "info", p.message.clone().unwrap_or_default().as_str());
        self.store(&p);
    }

    fn retry_deliver(&self, mut p: Production) -> Result<Production, String> {
        p.status = "running".into();
        p.stage = "deliver".into();
        p.action = 0;
        p.message = None;
        p.last_tick_ms = now_ms();
        self.store(&p);
        Ok(p)
    }

    // -------------------------------------------------------------- environment repair (v0.2.1)

    /// A TTS job failed because of a broken Python environment: diagnose, repair safely (no download, no package
    /// changes), verify, and re-run the same action without counting an attempt. Returns None when it handled `p`.
    fn try_env_repair(&self, mut p: Production, job: &db::Job, text: &str) -> Option<Production> {
        if !["voiceover_tw", "voiceover_cn", "bilibili"].contains(&job.kind.as_str()) {
            return Some(p);
        }
        if let Some(m) = crate::envfix::missing_module(text) {
            self.fail(p, &format!("CosyVoice 的 Python 環境缺少套件「{m}」。Studio 不會自動安裝或更改套件（避免破壞 PyTorch／CUDA 依賴）；請在「環境醫生」查看建議的安裝指令，安裝後按「繼續」從這一步重試。"));
            return None;
        }
        if !crate::envfix::looks_like_env_failure(text) {
            return Some(p);
        }
        let n = p.data["envRepairs"].as_u64().unwrap_or(0);
        let Ok(root) = self.root(&p) else { return Some(p) };
        let venv = root.join("tools").join("CosyVoice").join(".venv");
        if n >= 2 {
            self.fail(p, "Python 環境已自動修復 2 次仍然失敗，請在「環境醫生」檢查 CosyVoice。");
            return None;
        }
        p.data["envRepairs"] = json!(n + 1);
        let diag = crate::envfix::diagnose(&venv);
        self.log(&p, "warn", &format!("環境診斷：{}", diag.problem.clone().unwrap_or_else(|| format!("虛擬環境 {} 看起來正常（{}）", diag.venv, diag.python_output))));
        match crate::envfix::repair(&venv) {
            Ok(r) => {
                self.log(&p, "info", &format!("🛠 環境自動修復：{r}。從失敗的步驟重試（不計入嘗試次數）。"));
                p.data["envLog"] = json!(format!("{}\n{r}", p.data["envLog"].as_str().unwrap_or("")));
                self.store(&p);
                None
            }
            Err(e) => {
                self.fail(p, &format!("Python 環境錯誤，無法自動修復：{e}"));
                None
            }
        }
    }
}

// ------------------------------------------------------------------ background thread

pub fn spawn(ap: Arc<Autopilot>) {
    std::thread::Builder::new()
        .name("studio-autopilot".into())
        .spawn(move || loop {
            crate::watchdog::run_loop("autopilot", || ap.tick());
            std::thread::sleep(Duration::from_secs(2));
        })
        .expect("autopilot thread");
}

#[cfg(test)]
mod tests;
