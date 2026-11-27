//! 製作狀態（v0.3.2）：把一次製作的真實後端狀態（productions 的階段與步驟、目前工作在 jobs 表的步驟與進度、
//! 工作樹中已寫出的檔案）整理成畫面用的 11 個步驟、整體進度、預估剩餘時間、最新日誌與封面。
//! 只讀取既有資料，不另外保存任何狀態；沒有可靠數據的欄位（例如 AI 步驟的剩餘時間）就不提供。

use super::*;

/// 畫面上的 11 個步驟（依實際執行順序），以及每一步對應的後端階段。
/// 「分鏡設計」是關鍵幀＋畫面審查（visual 階段），需要時間軸決定關鍵幀，所以在字幕對齊之後執行。
pub const BOARD_STEPS: [(&str, &str); 11] = [
    ("research", "資料研究"),
    ("script", "腳本生成"),
    ("validate", "內容驗證"),
    ("animate", "動畫生成"),
    ("voice", "語音生成"),
    ("subtitle", "字幕對齊"),
    ("storyboard", "分鏡設計"),
    ("mix", "音訊混合"),
    ("render", "影片渲染"),
    ("qa", "品質檢查"),
    ("output", "成品輸出"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardStep {
    pub id: &'static str,
    pub label: &'static str,
    /// pending | running | done | warned | paused | failed | canceled | skipped
    pub status: String,
    /// 這一步自己的進度 0–1（只有正在執行、且工作有回報進度時）
    pub progress: Option<f64>,
    pub detail: Option<String>,
}

fn step(id: &'static str, status: &str, detail: Option<String>) -> BoardStep {
    let label = BOARD_STEPS.iter().find(|s| s.0 == id).map(|s| s.1).unwrap_or(id);
    BoardStep { id, label, status: status.into(), progress: None, detail }
}

/// 後端階段狀態 → 畫面狀態（目前階段依製作狀態變成 running／paused／failed／canceled）。
fn stage_state(p: &Production, sid: &str) -> String {
    let st = p.stages.iter().find(|s| s.id == sid).map(|s| s.status.clone()).unwrap_or_else(|| "pending".into());
    if p.stage == sid && st != "done" && st != "warned" && st != "skipped" {
        return current_state(p).to_string();
    }
    st
}

fn current_state(p: &Production) -> &'static str {
    match p.status.as_str() {
        "paused" | "paused_limit" => "paused",
        "failed" => "failed",
        "canceled" => "canceled",
        "succeeded" => "done",
        "draft" | "queued" => "pending",
        _ => "running",
    }
}

/// 幾個步驟合成一個（例：成品輸出＝YouTube、Bilibili、封面、上架資訊、交付）：有失敗就失敗，有執行中就執行中……
fn combine(states: &[String]) -> String {
    let live: Vec<&String> = states.iter().filter(|s| s.as_str() != "skipped").collect();
    if live.is_empty() {
        return "skipped".into();
    }
    for k in ["failed", "canceled", "paused", "running"] {
        if live.iter().any(|s| s.as_str() == k) {
            return k.into();
        }
    }
    if live.iter().all(|s| s.as_str() == "pending") {
        return "pending".into();
    }
    if live.iter().all(|s| ["done", "warned"].contains(&s.as_str())) {
        return if live.iter().any(|s| s.as_str() == "warned") { "warned".into() } else { "done".into() };
    }
    "running".into() // 部分完成、其餘等待中：這一步還在進行
}

/// 目前工作（job）中第幾步在跑、它的標籤與那一步自己的進度。
fn job_step(job: &db::Job) -> (usize, String, f64) {
    let n = job.steps.len().max(1);
    let i = (job.step.max(0) as usize).min(n - 1);
    let label = job.steps.get(i).cloned().unwrap_or_default();
    let local = (job.progress * n as f64 - i as f64).clamp(0.0, 1.0);
    (i, label, local)
}

fn is_live(job: &db::Job) -> bool {
    ["queued", "waiting_resource", "running"].contains(&job.status.as_str())
}

impl Autopilot {
    /// 一次製作的完整狀態檢視（製作狀態頁）。
    pub fn board_item(&self, p: &Production) -> Value {
        // 取消／失敗後 job_id 已清空：用最後一個工作判斷停在哪一步（只用來顯示）
        let jid = p.job_id.clone().or_else(|| ["canceled", "failed"].contains(&p.status.as_str()).then(|| p.data["lastJob"].as_str().map(String::from)).flatten());
        let job = jid.as_deref().and_then(|j| db::job_get(&self.conn(), j).ok());
        let root = self.root(p).ok();
        let wt = match (&root, p.worktree.as_deref()) {
            (Some(r), Some(w)) => Some(worktree_dir(r, w)),
            _ => None,
        };
        let steps = self.board_steps(p, job.as_ref(), wt.as_deref());
        let live: Vec<&BoardStep> = steps.iter().filter(|s| s.status != "skipped").collect();
        let done: f64 = live
            .iter()
            .map(|s| match s.status.as_str() {
                "done" | "warned" => 1.0,
                _ => s.progress.unwrap_or(0.0),
            })
            .sum();
        let overall = if live.is_empty() { 0.0 } else { done / live.len() as f64 };
        let overall = if p.status == "succeeded" { 1.0 } else { overall.min(0.99) };
        let current = steps.iter().find(|s| ["running", "paused", "failed", "canceled"].contains(&s.status.as_str())).map(|s| s.id);
        // 預估剩餘：只對有可靠進度的工作（配音逐句、渲染逐幀、品質檢查）且已執行 30 秒、進度 ≥ 5% 時提供；
        // AI（Claude／豆包）步驟的「第 N 步」不是進度，不估算。
        let eta = job.as_ref().filter(|j| j.status == "running" && !["claude_in", "agent_cli", "claude"].contains(&j.kind.as_str())).and_then(|j| {
            let started = j.started_at.as_deref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())?;
            let el = (chrono::Utc::now() - started.with_timezone(&chrono::Utc)).num_seconds() as f64;
            (el >= 30.0 && j.progress >= 0.05 && j.progress < 1.0).then(|| (el * (1.0 - j.progress) / j.progress).round())
        });
        let events = events(&self.conn(), &p.id, 0, 1_000_000).unwrap_or_default();
        let recent: Vec<&PEvent> = events.iter().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect();
        let job_line = job.as_ref().and_then(|j| {
            db::events_list(&self.conn(), &j.id, 0, 1_000_000).ok().and_then(|v| v.into_iter().rev().find(|e| e.stream != "system").map(|e| e.line))
        });
        let errors: Vec<String> = {
            let mut v = vec![];
            if ["failed", "canceled", "needs_merge", "paused_limit"].contains(&p.status.as_str()) {
                if let Some(m) = &p.message {
                    v.push(m.clone());
                }
            }
            if let Some(e) = job.as_ref().and_then(|j| j.error.clone()).filter(|_| p.status != "succeeded") {
                if !v.iter().any(|x| x.contains(&e)) {
                    v.push(e);
                }
            }
            v.extend(p.stages.iter().filter(|s| s.status == "failed").filter_map(|s| s.note.clone().map(|n| format!("{}：{n}", s.label))));
            v.dedup();
            v
        };
        let video_dir = root.as_ref().map(|r| crate::layout::video_dir(r, &p.episode));
        json!({
            "id": p.id,
            "projectId": p.project_id,
            "episode": p.episode,
            "title": self.board_title(p, wt.as_deref()),
            "topic": p.config.topic,
            "sandbox": p.config.sandbox,
            "status": p.status,
            "mode": p.mode,
            "attempt": p.attempt,
            "stage": p.stage,
            "stageLabel": stage_label_for(&p.stage, &p.config),
            "message": p.message,
            "warnings": p.warnings,
            "steps": steps,
            "currentStep": current,
            "progress": (overall * 1000.0).round() / 1000.0,
            "activeMs": p.active_ms,
            "createdAt": p.created_at,
            "startedAt": p.started_at,
            "finishedAt": p.finished_at,
            "etaSecs": eta,
            "job": job.as_ref().map(|j| json!({
                "id": j.id, "kind": j.kind, "label": j.label, "status": j.status, "progress": j.progress,
                "progressText": j.progress_text, "stepLabel": j.steps.get(j.step.max(0) as usize), "step": j.step, "steps": j.steps.len(),
                "waitReason": j.wait_reason, "error": j.error, "lastLine": job_line,
            })),
            // 暫停時目前的工作仍在執行，會在這一步完成後停下（安全檢查點）
            "pausing": (["paused", "paused_limit"].contains(&p.status.as_str()) && job.as_ref().is_some_and(is_live)),
            "events": recent.iter().map(|e| json!({"ts": e.ts, "level": e.level, "stage": e.stage, "line": e.line})).collect::<Vec<_>>(),
            "errors": errors,
            "outputs": p.outputs,
            "cover": self.board_cover(p, root.as_deref(), wt.as_deref()),
            "videoDir": video_dir.as_ref().map(|d| d.to_string_lossy().to_string()),
            "videoDirExists": video_dir.as_ref().is_some_and(|d| d.exists()),
            "worktree": p.worktree,
            "filesDeleted": p.data["filesDeleted"].as_str(),
            "narrative": p.config.narrative_mode(),
            "language": content::lang(&p.config),
            "agent": p.config.agent,
            "config": p.config,
            "can": self.board_actions(p, job.as_ref()),
        })
    }

    fn board_title(&self, p: &Production, wt: Option<&Path>) -> String {
        let from_wt = wt.and_then(|w| crate::narration::read(w, "zh-TW").ok()).and_then(|r| r["doc"]["sequences"][&p.episode]["title"].as_str().map(String::from));
        from_wt.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| p.config.topic.clone())
    }

    /// 封面：交付後的封面圖 → 工作樹中的封面 → 第一張關鍵幀；都沒有就不給（畫面顯示集數）。
    fn board_cover(&self, p: &Production, root: Option<&Path>, wt: Option<&Path>) -> Option<String> {
        let root = root?;
        if let Some(o) = p.outputs.iter().find(|o| o.to_ascii_lowercase().ends_with("thumbnail.png")) {
            let f = root.join(o.replace('/', "\\"));
            if f.exists() {
                return Some(f.to_string_lossy().to_string());
            }
        }
        let thumbs = crate::layout::video_dir(root, &p.episode).join("thumbnail");
        if let Some(f) = std::fs::read_dir(&thumbs).ok().and_then(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).find(|x| x.extension().is_some_and(|e| e == "png"))) {
            return Some(f.to_string_lossy().to_string());
        }
        let wt = wt?;
        let E = ep_upper(&p.episode);
        for name in [format!("{E}_YouTube_zh-TW_Thumbnail.png"), format!("{E}_Bilibili_zh-CN_Thumbnail.png")] {
            if wt.join(&name).exists() {
                return Some(wt.join(name).to_string_lossy().to_string());
            }
        }
        p.data["stillFiles"].as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).map(|s| {
            let f = PathBuf::from(s);
            if f.is_absolute() { f } else { wt.join(s.replace('/', "\\")) }
        }).filter(|f| f.exists()).map(|f| f.to_string_lossy().to_string())
    }

    /// 依狀態可用的操作（畫面只顯示這些；後端每個操作仍會再檢查一次）。
    fn board_actions(&self, p: &Production, job: Option<&db::Job>) -> Value {
        let s = p.status.as_str();
        let active = ACTIVE.contains(&s);
        let delivered = s == "succeeded" && !p.config.sandbox && p.worktree.is_none();
        json!({
            "start": s == "draft",
            "pause": (["queued", "running", "waiting_agent"].contains(&s)),
            "resume": (["paused", "paused_limit"].contains(&s) || (s == "canceled" && p.worktree.is_some() && p.stage != "deliver")),
            "retry": s == "failed" || s == "needs_merge",
            "recover": (["running", "paused", "failed"].contains(&s) && p.stage != "deliver" && (job.is_some() || s == "failed")),
            "cancel": active || s == "needs_merge" || s == "draft",
            "agentDone": s == "waiting_agent",
            "revoice": delivered,
            "rerender": delivered,
            "edit": (["draft", "paused", "paused_limit", "failed", "canceled"].contains(&s)),
            "editAll": s == "draft",
            "deleteTask": true,
            "deleteFiles": !active && p.data["filesDeleted"].is_null(),
        })
    }

    fn board_steps(&self, p: &Production, job: Option<&db::Job>, wt: Option<&Path>) -> Vec<BoardStep> {
        let acts = actions(p);
        let cur_action = acts.get(p.action);
        let inline_is = |n: &str| matches!(cur_action, Some(Action::Inline(x)) if *x == n);
        let live_job = job.filter(|j| is_live(j));
        let fix = p.mode == "fix";
        let mut out = vec![];

        // ---- 資料研究／腳本生成／內容驗證（script 階段：AI 一次完成研究與劇本，以工作樹中的檔案判斷寫到哪裡）
        let sst = stage_state(p, "script");
        let script_mode = content::mode(&p.config) == "script";
        let need_src = p.config.min_sources() > 0;
        let has_sources = wt.is_some_and(|w| w.join(format!("{}_SOURCES.md", ep_upper(&p.episode))).exists());
        let has_script = wt
            .and_then(|w| crate::narration::read(w, "zh-TW").ok())
            .and_then(|r| r["doc"]["sequences"][&p.episode]["scenes"].as_array().map(|s| s.iter().any(|x| x["lines"].as_array().is_some_and(|l| !l.is_empty()))))
            .unwrap_or(false);
        let req = &p.data["requirements"];
        let req_detail = req.is_object().then(|| format!("通過 {}・警告 {}・失敗 {}", req["passed"], req["warned"], req["failed"]));
        let (r, s, v) = match sst.as_str() {
            "done" | "warned" => (if !need_src && script_mode { "skipped" } else { "done" }.to_string(), "done".to_string(), sst.clone()),
            "pending" => ("pending".into(), "pending".into(), "pending".into()),
            st => {
                // 目前在 script 階段（執行中／暫停／失敗／停止）
                let checking = inline_is("check_script") || fix || (st == "failed" && req.is_object());
                let research = if !need_src && script_mode {
                    "skipped".to_string()
                } else if has_sources || checking {
                    "done".to_string()
                } else {
                    st.to_string()
                };
                let script = if checking || (has_script && has_sources && st != "running") {
                    "done".to_string()
                } else if research == "done" || research == "skipped" || has_script {
                    st.to_string()
                } else {
                    "pending".to_string()
                };
                let validate = if checking { st.to_string() } else { "pending".to_string() };
                (research, script, validate)
            }
        };
        let ai_detail = |what: &str| -> Option<String> {
            if p.status == "waiting_agent" {
                Some(format!("等待外部 Agent：{what}"))
            } else {
                live_job.map(|j| j.progress_text.clone().unwrap_or_else(|| j.label.clone()))
            }
        };
        out.push(step("research", &r, if r == "skipped" { Some("自訂腳本模式：不需要資料來源".into()) } else if r == "running" { ai_detail("資料研究") } else if has_sources { Some(format!("{}_SOURCES.md", ep_upper(&p.episode))) } else { None }));
        out.push(step("script", &s, if s == "running" { ai_detail("劇本") } else { None }));
        out.push(step(
            "validate",
            &v,
            if fix && sst != "done" { Some(format!("AI 修正未通過的項目（第 {} 次）", p.attempt)) } else { req_detail.clone() },
        ));

        // ---- 動畫生成、語音生成、字幕對齊、分鏡設計：一個後端階段對一個步驟
        let single = |id: &'static str, sid: &str, skipped_why: &str| -> BoardStep {
            let st = stage_state(p, sid);
            let mut b = step(id, &st, None);
            if st == "skipped" {
                b.detail = Some(skipped_why.to_string());
            } else if p.stage == sid && st == "running" {
                if fix {
                    b.detail = Some(format!("AI 修正中（第 {} 次）", p.attempt));
                } else if p.status == "waiting_agent" {
                    b.detail = Some("等待外部 Agent".into());
                } else if let Some(j) = live_job {
                    b.progress = (!["claude_in", "agent_cli"].contains(&j.kind.as_str())).then_some(j.progress);
                    b.detail = Some(j.progress_text.clone().unwrap_or_else(|| j.label.clone()));
                }
            } else if let Some(n) = p.stages.iter().find(|x| x.id == sid).and_then(|x| x.note.clone()) {
                b.detail = Some(n);
            }
            b
        };
        out.push(single("animate", "animate", "通用樣板（不撰寫自訂動畫）"));
        out.push(single("voice", "voice", "略過"));
        out.push(single("subtitle", "timeline", "略過"));
        out.push(single("storyboard", "visual", "已關閉畫面 AI 審查"));

        // ---- 音訊混合／影片渲染／品質檢查（final 階段的同一個工作：時間軸→混音→渲染→品質檢查）
        let fst = stage_state(p, "final");
        let (m, rd, q, mut mp, mut rp, mut qp) = match fst.as_str() {
            "done" | "warned" => ("done".to_string(), "done".to_string(), fst.clone(), None, None, None),
            "pending" | "skipped" => (fst.clone(), fst.clone(), fst.clone(), None, None, None),
            st => {
                if fix || inline_is("check_qa") {
                    ("done".into(), "done".into(), st.to_string(), None, None, None)
                } else if let Some(j) = job.filter(|j| ["final_tw", "bilibili"].contains(&j.kind.as_str())) {
                    let (_, label, local) = job_step(j);
                    let jst = if is_live(j) { st.to_string() } else if j.status == "succeeded" { "done".into() } else { st.to_string() };
                    if label.contains("品質檢查") {
                        ("done".into(), "done".into(), jst, None, None, Some(local))
                    } else if label.contains("渲染") {
                        ("done".into(), jst, "pending".into(), None, Some(local), None)
                    } else {
                        (jst, "pending".into(), "pending".into(), Some(local), None, None)
                    }
                } else {
                    // 型別檢查等前置工作
                    (st.to_string(), "pending".into(), "pending".into(), None, None, None)
                }
            }
        };
        if p.status != "running" {
            mp = None;
            rp = None;
            qp = None;
        }
        let jt = job.filter(|j| ["final_tw", "bilibili"].contains(&j.kind.as_str()) && is_live(j)).map(|j| j.progress_text.clone().unwrap_or_default());
        let mut b = step("mix", &m, if m == "running" { jt.clone() } else { None });
        b.progress = mp;
        out.push(b);
        let mut b = step("render", &rd, if rd == "running" { jt.clone() } else { None });
        b.progress = rp;
        out.push(b);
        let mut b = step("qa", &q, if q == "running" && fix { Some(format!("AI 修正 QA 問題（第 {} 次）", p.attempt)) } else if q == "running" { jt } else { p.stages.iter().find(|x| x.id == "final").and_then(|x| x.note.clone()) });
        b.progress = qp;
        out.push(b);

        // ---- 成品輸出：其他版本（YouTube 1.5×、Bilibili）、封面、上架資訊、交付
        let parts = ["youtube", "bilibili", "thumbnail", "publish", "deliver"];
        let sts: Vec<String> = parts.iter().map(|s| stage_state(p, s)).collect();
        let st = combine(&sts);
        let detail = if parts.contains(&p.stage.as_str()) && st != "done" {
            Some(stage_label_for(&p.stage, &p.config))
        } else if st == "done" || st == "warned" {
            Some(format!("{} 個成品", p.outputs.len()))
        } else {
            None
        };
        let mut b = step("output", &st, detail);
        if st == "running" {
            if let Some(j) = live_job.filter(|j| !["claude_in", "agent_cli"].contains(&j.kind.as_str())) {
                b.progress = Some(j.progress);
            }
        }
        out.push(b);
        // 停止／失敗的製作：目前步驟之後的都還沒開始
        out
    }

    /// 製作狀態頁的清單：同一個專案（或全部）的製作，最新的在前。
    pub fn board(&self, project_id: Option<&str>, limit: i64) -> Result<Vec<Value>, String> {
        let all = list(&self.conn(), limit)?;
        Ok(all.iter().filter(|p| project_id.is_none_or(|id| p.project_id.as_deref() == Some(id))).map(|p| self.board_item(p)).collect())
    }

    // -------------------------------------------------------------- 開始、編輯與刪除

    /// 草稿（建立時選「稍後開始」）→ 排隊；同一時間只會有一部影片在製作（排程器保證）。
    pub fn start_draft(&self, id: &str) -> Result<Production, String> {
        let _g = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let mut p = get(&self.conn(), id)?;
        if p.status != "draft" {
            return Err(format!("目前狀態「{}」不能開始（只有尚未開始的影片可以）", p.status));
        }
        p.status = "queued".into();
        p.message = None;
        self.log(&p, "info", "開始製作");
        self.store(&p);
        Ok(p)
    }

    /// 編輯影片設定。草稿可以改全部；已開始的製作（暫停、失敗、停止）只能改不影響已完成成果的項目：
    /// 嘗試次數、時間上限、AI 回合、尚未執行的封面／上架資訊／畫面審查／發音檢查／YouTube 版。
    pub fn update_config(&self, id: &str, patch: Value) -> Result<Production, String> {
        let _g = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let mut p = get(&self.conn(), id)?;
        let s = p.status.clone();
        if s == "draft" {
            let mut merged = serde_json::to_value(&p.config).map_err(|e| e.to_string())?;
            if let (Some(m), Some(pa)) = (merged.as_object_mut(), patch.as_object()) {
                for (k, v) in pa {
                    if k != "assets" && k != "sandbox" {
                        m.insert(k.clone(), v.clone());
                    }
                }
            }
            let mut cfg: AutoConfig = serde_json::from_value(merged).map_err(|e| format!("設定格式錯誤：{e}"))?;
            cfg.validate()?;
            cfg.require_script()?;
            p.config = cfg;
        } else if ["paused", "paused_limit", "failed", "canceled"].contains(&s.as_str()) {
            let done = |sid: &str| p.stages.iter().any(|x| x.id == sid && ["done", "warned", "running", "failed"].contains(&x.status.as_str()));
            let c = &mut p.config;
            let num = |k: &str| patch.get(k).and_then(|v| v.as_u64()).map(|v| v as u32);
            if let Some(v) = num("maxAttempts") {
                c.max_attempts = v.clamp(1, 10);
            }
            if let Some(v) = num("maxMinutes") {
                c.max_minutes = v.clamp(10, 24 * 60);
            }
            if let Some(v) = num("maxTurns") {
                c.max_turns = v.clamp(10, 400);
            }
            let later = |k: &str, sid: &str, field: &mut bool| -> Result<(), String> {
                if let Some(v) = patch.get(k).and_then(|v| v.as_bool()) {
                    if v != *field && done(sid) {
                        return Err(format!("「{}」已經執行過，不能再變更這個選項", stage_label(sid)));
                    }
                    *field = v;
                }
                Ok(())
            };
            later("thumbnail", "thumbnail", &mut c.thumbnail)?;
            later("publishInfo", "publish", &mut c.publish_info)?;
            later("visualReview", "visual", &mut c.visual_review)?;
            later("pronunciationCheck", "voice", &mut c.pronunciation_check)?;
            later("youtube", "youtube", &mut c.youtube)?;
            let cfg = p.config.clone();
            for st in p.stages.iter_mut().filter(|x| ["pending", "skipped"].contains(&x.status.as_str())) {
                st.status = if stage_enabled(&st.id, &cfg) { "pending".into() } else { "skipped".into() };
            }
        } else {
            return Err(format!("目前狀態「{s}」不能編輯設定（請先暫停）"));
        }
        if let Ok(root) = self.root(&p) {
            let vdir = crate::layout::video_dir(&root, &p.episode);
            if vdir.exists() {
                let _ = std::fs::write(vdir.join("BRIEF.md"), content::brief_markdown(&p.config, &p.episode));
            }
        }
        self.log(&p, "info", "已更新影片設定");
        self.store(&p);
        Ok(p)
    }

    /// 刪除影片任務（只刪除製作紀錄）：進行中的會先停止（結束程序樹），隔離工作樹與分支一併刪除（尚未合併的中間檔會消失）；
    /// 專案中已交付的影片、配音與素材都不動。
    pub fn delete_task(&self, id: &str) -> Result<Value, String> {
        let _g = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let mut p = get(&self.conn(), id)?;
        let mut killed = None;
        if let Some(j) = p.job_id.take() {
            if db::job_get(&self.conn(), &j).is_ok_and(|x| is_live(&x)) {
                let _ = self.queue.cancel(&j);
                killed = Some(j);
            }
        }
        if let (Ok(root), Some(w)) = (self.root(&p), p.worktree.clone()) {
            remove_worktree(&root, &w, true)?;
            p.worktree = None;
        }
        // Sandbox 交付後工作樹已移除但分支保留（供檢視）；刪除任務時一併刪除這次製作自己的分支
        if let (Ok(root), Some(br)) = (self.root(&p), p.branch.clone()) {
            if br.starts_with("studio/auto/") && git(&root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{br}")]).is_ok_and(|o| o.ok()) {
                let _ = git(&root, &["branch", "-D", &br]);
            }
        }
        {
            let c = self.conn();
            c.execute("DELETE FROM production_events WHERE production_id=?1", [&p.id]).map_err(|e| e.to_string())?;
            c.execute("DELETE FROM productions WHERE id=?1", [&p.id]).map_err(|e| e.to_string())?;
        }
        (self.emit)("production://removed", json!({"id": p.id}));
        Ok(json!({"removed": true, "id": p.id, "canceledJob": killed, "episode": p.episode}))
    }

    /// 刪除實體影片與素材：把這部影片的資料夾（projects/EPxx 或 sandbox/TESTxxx：成品、配音、字幕、封面、素材）
    /// 移到專案的 .studio/trash/ 底下（可以手動搬回）。製作中的影片不能刪除；製作紀錄保留。
    /// 已合併到專案的旁白與動畫程式（src/）是共用檔案，不在這裡刪除。
    pub fn delete_files(&self, id: &str) -> Result<Value, String> {
        let _g = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let mut p = get(&self.conn(), id)?;
        if ACTIVE.contains(&p.status.as_str()) {
            return Err("製作進行中，請先取消製作再刪除影片檔案".into());
        }
        let root = self.root(&p)?;
        let vdir = crate::layout::video_dir(&root, &p.episode);
        if !vdir.exists() {
            return Err(format!("影片資料夾不存在：{}", crate::layout::video_rel(&p.episode)));
        }
        let trash = root.join(".studio").join("trash");
        std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
        let dst = trash.join(format!("{}-{}", ep_upper(&p.episode), chrono::Local::now().format("%Y%m%d-%H%M%S")));
        std::fs::rename(&vdir, &dst).map_err(|e| format!("無法移動影片資料夾（檔案可能正在使用中）：{e}"))?;
        let rel = format!(".studio/trash/{}", dst.file_name().unwrap_or_default().to_string_lossy());
        p.data["filesDeleted"] = json!(rel);
        self.log(&p, "warn", &format!("已刪除影片檔案：{} 移到 {rel}", crate::layout::video_rel(&p.episode)));
        self.store(&p);
        Ok(json!({"moved": rel, "from": crate::layout::video_rel(&p.episode)}))
    }
}
