//! Inactivity monitor, stall detection and stage-level recovery for productions.
//!
//! The queue already stops a step that goes silent (`Step::stall_secs`, agents included: output *or* file changes
//! in the worktree count as activity). This layer covers what the queue cannot see:
//! - a running job that stays quiet past the watchdog limit anyway (a worker that hung outside the step loop);
//! - an `interrupted` job that will never be re-queued (auto-requeue limit reached), which used to leave the
//!   production showing 製作中 forever;
//! - the user pressing 「恢復目前階段」 on a production that looks stuck.
//!
//! Recovery is stage-level: the current step of the current stage runs again; earlier steps, earlier stages,
//! research, the script and every file in the worktree are kept. An AI step gets a note telling it to continue
//! from the files already there instead of starting over.

use super::*;

/// Seconds without output and without file changes before the production watchdog stops a running job
/// (`PIKARA_STALL_WATCHDOG_SECS` overrides). Longer than every step's own limit, so normally the step limit fires first.
pub const WATCHDOG_SECS: u64 = 2700;
/// An `interrupted` job not re-queued within this time is treated as stopped.
pub const INTERRUPTED_GRACE_MS: i64 = 120_000;
/// Automatic stage-level recoveries per stage before the normal failure handling takes over.
pub const MAX_STEP_RECOVERIES: u64 = 2;

pub fn watchdog_secs() -> u64 {
    std::env::var("PIKARA_STALL_WATCHDOG_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(WATCHDOG_SECS)
}

/// No-activity limit of a job kind's main step (what the queue enforces), for display.
pub fn step_limit(kind: &str) -> u64 {
    let env = |k: &str, d: u64| std::env::var(format!("PIKARA_STALL_{k}_SECS")).ok().and_then(|s| s.parse().ok()).unwrap_or(d);
    match kind {
        "claude_in" | "agent_cli" | "claude" => env("AGENT", crate::jobs::AGENT_STALL_SECS),
        "voiceover_tw" | "voiceover_cn" | "revoice" => env("VOICE", 600),
        "render" | "final_tw" | "bilibili" | "stills" | "rerender" => env("RENDER", 1200),
        _ => 0,
    }
}

/// Text added to an AI step's prompt when it runs again after a stall / interruption / manual recovery.
pub fn continuation_note(reason: &str) -> String {
    format!(
        "\n\n## 接續上一次未完成的執行\n上一次執行在中途停止（{reason}）。工作樹中已經存在的檔案是之前完成的成果：\
         先用 Glob／Read 檢查哪些已經完成，**只補完缺少或寫到一半的部分**，不要刪除、不要從頭重寫已完成且正確的檔案，\
         不要重新做研究或改寫已通過檢查的劇本。完成後照原本的要求做最後檢查。"
    )
}

impl Autopilot {
    /// Milliseconds of the job's latest log line (None: no output yet).
    pub(crate) fn job_last_event_ms(&self, job_id: &str) -> Option<i64> {
        self.conn().query_row("SELECT MAX(ts) FROM job_events WHERE job_id=?1 AND stream<>'system'", [job_id], |r| r.get::<_, Option<i64>>(0)).ok().flatten()
    }

    /// Activity of the production's job in flight, for the UI and the watchdog.
    pub fn activity(&self, p: &Production, job: &db::Job) -> Value {
        let now = now_ms();
        if job.status != "running" {
            return json!({"state": if job.status == "interrupted" { "interrupted" } else { "waiting" }, "jobStatus": job.status});
        }
        let since = p.data["watch"]["since"].as_i64().filter(|_| p.data["watch"]["job"].as_str() == Some(job.id.as_str())).unwrap_or(now);
        let last = self.job_last_event_ms(&job.id).unwrap_or(since).max(since);
        let out_quiet = ((now - last).max(0) / 1000) as u64;
        // scanning the worktree is only worth it once the output has been quiet for a while
        let files_quiet = if out_quiet >= 120 {
            self.root(p).ok().and_then(|r| p.worktree.as_deref().map(|w| worktree_dir(&r, w))).and_then(|d| crate::activity::files_quiet_secs(&d))
        } else {
            None
        };
        let limit = step_limit(&job.kind);
        json!({
            "state": crate::activity::state(out_quiet, files_quiet, limit),
            "jobStatus": job.status,
            "lastOutputMs": last,
            "outputQuietSecs": out_quiet,
            "filesQuietSecs": files_quiet,
            "limitSecs": limit,
            "watchdogSecs": watchdog_secs(),
        })
    }

    /// Called by `advance` while a job is in flight. Returns the production back when nothing needs to happen;
    /// `None` when it took over (stopped the job / recovered the step).
    pub(crate) fn watch(&self, mut p: Production, job: &db::Job) -> Option<Production> {
        let now = now_ms();
        if p.data["watch"]["job"].as_str() != Some(job.id.as_str()) {
            p.data["watch"] = json!({"job": job.id, "since": now});
        }
        match job.status.as_str() {
            "interrupted" => {
                // recover() re-queues interrupted jobs at startup; one still interrupted after the grace period
                // reached the auto-requeue limit and would otherwise be waited on forever
                let first = *p.data["watch"].get("interruptedAt").and_then(|v| v.as_i64()).get_or_insert(now);
                p.data["watch"]["interruptedAt"] = json!(first);
                if now - first < INTERRUPTED_GRACE_MS {
                    return Some(p);
                }
                self.log(&p, "warn", &format!("工作「{}」中斷後沒有自動重新排入佇列（已達自動重試上限）", job.label));
                p.job_id = None;
                self.recover_step(p, "工作中斷（Studio 結束或電腦睡眠）");
                None
            }
            "running" => {
                // checked at most once a minute
                if now - p.data["watch"]["checked"].as_i64().unwrap_or(0) < 60_000 {
                    return Some(p);
                }
                p.data["watch"]["checked"] = json!(now);
                let a = self.activity(&p, job);
                let quiet = a["outputQuietSecs"].as_u64().unwrap_or(0).min(a["filesQuietSecs"].as_u64().unwrap_or(u64::MAX));
                let lim = watchdog_secs();
                if lim == 0 || quiet < lim {
                    return Some(p);
                }
                let msg = format!("{} 分鐘沒有任何輸出或檔案變動（監控上限 {} 分鐘）", quiet / 60, lim / 60);
                self.log(&p, "error", &format!("偵測到卡住：工作「{}」{msg}，停止並從目前步驟恢復", job.label));
                p.data["watchdogCancel"] = json!(job.id);
                p.data["watchdogReason"] = json!(msg);
                self.store(&p);
                let _ = self.queue.cancel(&job.id);
                // the `canceled` result is picked up by the next tick → recover_step
                None
            }
            _ => Some(p),
        }
    }

    /// Run the current step of the current stage again (stage-level recovery). Earlier steps, stages and every
    /// file in the worktree are kept; an AI step is told to continue from what is already there.
    /// Automatic recoveries are limited per stage; past the limit the normal failure handling decides.
    pub(crate) fn recover_step(&self, mut p: Production, reason: &str) {
        let n = p.data["stepRecoveries"][&p.stage].as_u64().unwrap_or(0);
        if n >= MAX_STEP_RECOVERIES {
            let m = format!("{reason}；這個階段已自動恢復 {n} 次仍未完成");
            return self.stage_failed(p, &m, false, false);
        }
        p.data["stepRecoveries"][&p.stage] = json!(n + 1);
        self.resume_here(&mut p, reason);
        self.store(&p);
    }

    /// Shared by automatic and manual recovery: same stage, same step, main mode, continuation note for AI steps.
    fn resume_here(&self, p: &mut Production, reason: &str) {
        p.job_id = None;
        if p.mode == "fix" {
            // the fix job itself stopped: run the stage's checks again (they produce a fresh fix if still needed)
            p.mode = "main".into();
        }
        p.data["resumeNote"] = json!(reason);
        if let Some(m) = p.data.as_object_mut() {
            m.remove("watch");
            m.remove("watchdogCancel");
            m.remove("watchdogReason");
        }
        p.status = "running".into();
        p.message = None;
        self.mark_stage(p, "running", None);
        self.log(p, "info", &format!("⟳ 從「{}」目前的步驟恢復（{reason}）：保留工作樹與已完成的成果，不重新研究、不重寫劇本", stage_label(&p.stage)));
    }

    /// 「恢復目前階段」: stop the job in flight (if any) and run the current step again, keeping everything done so far.
    pub fn recover(&self, id: &str) -> Result<Production, String> {
        let _g = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let mut p = get(&self.conn(), id)?;
        if !["running", "paused", "failed"].contains(&p.status.as_str()) {
            return Err(format!("目前狀態（{}）不需要恢復", p.status));
        }
        if p.stage == "deliver" {
            return Err("交付階段請用「繼續」".into());
        }
        if let Some(j) = p.job_id.take() {
            // canceled by the user on purpose: the `canceled` result must not stop the production
            let _ = self.queue.cancel(&j);
        }
        if p.status == "failed" {
            p.attempt = 1;
        }
        self.resume_here(&mut p, "使用者手動恢復");
        self.store(&p);
        Ok(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuation_note_keeps_existing_work() {
        let n = continuation_note("停滯");
        assert!(n.contains("只補完") && n.contains("不要刪除") && n.contains("不要重新做研究"));
    }

    #[test]
    fn agent_steps_have_a_limit_and_others_follow_their_step() {
        assert_eq!(step_limit("claude_in"), crate::jobs::AGENT_STALL_SECS);
        assert_eq!(step_limit("agent_cli"), crate::jobs::AGENT_STALL_SECS);
        assert_eq!(step_limit("typecheck"), 0);
        assert!(watchdog_secs() > step_limit("claude_in") && watchdog_secs() > step_limit("render"));
    }
}
