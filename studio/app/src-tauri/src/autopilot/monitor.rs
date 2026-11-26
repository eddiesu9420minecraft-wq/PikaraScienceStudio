//! Live monitor and preview for the UI, plus render progress parsed from render.mjs logs.

use super::*;

impl Autopilot {
    // -------------------------------------------------------------- live monitor (v0.2.1)

    /// Real-time view of a production for the UI: the running job with its log, render FPS / frames / ETA, the latest
    /// AI run's output and tool calls, research sources, file changes, script, key frames, voice files and the
    /// error / fix history. Everything is read from the database, the job logs and the worktree — nothing estimated
    /// except the ETA (remaining frames ÷ measured FPS of the last segment).
    pub fn monitor(&self, id: &str) -> Result<Value, String> {
        let p = get(&self.conn(), id)?;
        let root = self.root(&p)?;
        let wt = p.worktree.as_deref().map(|w| worktree_dir(&root, w)).filter(|d| d.exists());
        let base = wt.clone().unwrap_or_else(|| root.clone());
        let jid = p.job_id.clone().or_else(|| p.data["lastJob"].as_str().map(String::from));
        let job = jid.as_deref().and_then(|j| db::job_get(&self.conn(), j).ok());
        let job_lines: Vec<db::JobEvent> = jid.as_deref().map(|j| tail_events(&self.conn(), j, 300)).unwrap_or_default();
        let render = render_stats(&job_lines);
        // the latest AI run of this production (its job params carry the worktree id)
        let ai_job: Option<String> = p.worktree.as_deref().and_then(|w| {
            self.conn()
                .query_row(
                    "SELECT id FROM jobs WHERE kind IN ('claude_in','agent_cli') AND params_json LIKE ?1 ORDER BY created_at DESC LIMIT 1",
                    [format!("%\"workdir\":\"{w}\"%")],
                    |r| r.get(0),
                )
                .ok()
        });
        let ai_lines: Vec<Value> = ai_job
            .as_deref()
            .map(|j| tail_events(&self.conn(), j, 400))
            .unwrap_or_default()
            .into_iter()
            .filter(|e| e.stream != "system" || e.level == "error")
            .map(|e| {
                let kind = if e.line.starts_with("[tool]") { "tool" } else if e.line.starts_with("[result") { if e.line.starts_with("[result ERROR]") { "toolError" } else { "result" } } else if e.line.starts_with("Claude:") { "text" } else if e.line.starts_with("[done]") { "done" } else { "log" };
                json!({"ts": e.ts, "kind": kind, "level": e.level, "line": e.line})
            })
            .collect();
        let ai_status = ai_job.as_deref().and_then(|j| db::job_get(&self.conn(), j).ok()).map(|j| json!({"id": j.id, "label": j.label, "status": j.status, "progressText": j.progress_text}));
        // research sources
        let E = ep_upper(&p.episode);
        let src_file = [base.join(format!("{E}_SOURCES.md")), crate::layout::video_dir(&root, &p.episode).join("docs").join(format!("{E}_SOURCES.md"))].into_iter().find(|f| f.exists());
        let sources: Vec<Value> = src_file
            .and_then(|f| std::fs::read_to_string(f).ok())
            .map(|s| {
                static RE_MDLINK: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[([^\]]{1,200})\]\((https?://[^\s)]+)\)").unwrap());
                static RE_URL: Lazy<Regex> = Lazy::new(|| Regex::new(r"https?://[^\s)>\]]+").unwrap());
                let mut v: Vec<Value> = vec![];
                // the title is on the URL's line ("[title](url)", "title — url") or on the nearest line above it
                // (a heading / numbered item / "標題：…" line) when the URL line only says "網址：" / "URL:"
                let mut last_title = String::new();
                let strip = |l: &str| l.trim().trim_start_matches(|c: char| c == '#' || c == '-' || c == '*' || c == '>' || c.is_ascii_digit() || c == '.' || c == '、' || c.is_whitespace()).trim().to_string();
                let label = |t: &str| {
                    let t = t.trim_matches(|c: char| c.is_whitespace() || "-*：:|#()（）".contains(c));
                    let lower = t.to_lowercase();
                    let generic = ["網址", "网址", "url", "link", "連結", "链接", "來源", "来源", "source"];
                    if t.chars().count() < 2 || generic.iter().any(|g| lower == *g || lower.ends_with(g) && t.chars().count() <= 4) { String::new() } else { t.to_string() }
                };
                for l in s.lines() {
                    if let Some(c) = RE_MDLINK.captures(l) {
                        let t = label(&c[1]);
                        v.push(json!({"title": if t.is_empty() { last_title.clone() } else { t }, "url": c[2].to_string()}));
                    } else if let Some(m) = RE_URL.find(l) {
                        let own = label(&strip(&l.replace(m.as_str(), "")).replace("<>", ""));
                        let t = if own.is_empty() { last_title.clone() } else { own };
                        v.push(json!({"title": t.chars().take(160).collect::<String>(), "url": m.as_str()}));
                    } else {
                        let t = strip(l);
                        let t = t.trim_start_matches("標題").trim_start_matches("标题").trim_start_matches("Title").trim_start_matches(|c: char| c == '：' || c == ':' || c.is_whitespace()).replace("**", "");
                        if !t.is_empty() && !t.starts_with("支持") && !t.starts_with("支援") && t.chars().count() <= 160 {
                            last_title = t;
                        }
                    }
                }
                v
            })
            .unwrap_or_default();
        // file changes in the worktree since the production started
        let mut changes: Vec<Value> = vec![];
        if let Some(w) = &wt {
            if let Ok(o) = git(w, &["status", "--porcelain", "--untracked-files=normal"]) {
                for l in o.stdout.lines().take(200) {
                    if l.len() > 3 {
                        changes.push(json!({"status": l[..2].trim(), "path": l[3..].trim(), "committed": false}));
                    }
                }
            }
            // diff against the commit the worktree started from (recorded at prepare; older productions: the
            // prepare checkpoint, which is that same commit because preparing commits nothing)
            let base = p.data["baseSha"].as_str().map(String::from).or_else(|| p.stages.iter().find(|s| s.id == "prepare").and_then(|s| s.checkpoint.clone()));
            if let Some(cp) = base {
                if let Ok(o) = git(w, &["diff", "--numstat", &cp, "HEAD"]) {
                    for l in o.stdout.lines().take(200) {
                        let f: Vec<&str> = l.split('\t').collect();
                        if f.len() == 3 {
                            changes.push(json!({"status": "C", "path": f[2], "added": f[0], "removed": f[1], "committed": true}));
                        }
                    }
                }
            }
        }
        // script preview (master narration; zh-CN copy when there is one)
        let script = crate::narration::read(&base, "zh-TW").ok().map(|r| r["doc"]["sequences"][&p.episode].clone()).filter(|v| !v.is_null());
        // storyboard: key frames (review stills, low-res previews, thumbnails)
        let mut stills = vec![];
        for (d, kind) in [("out/stills", "still"), ("out/preview", "preview")] {
            if let Ok(rd) = std::fs::read_dir(base.join(d)) {
                let mut v: Vec<_> = rd.flatten().filter(|e| e.file_name().to_string_lossy().starts_with(&E)).collect();
                v.sort_by_key(|e| e.file_name());
                for e in v.into_iter().take(40) {
                    stills.push(json!({"kind": kind, "name": e.file_name().to_string_lossy(), "path": e.path().to_string_lossy()}));
                }
            }
        }
        // voice audition: generated narration audio with its Whisper result
        let mut voice = vec![];
        for d in ["public/assets/audio/voiceover_cosy", "public/assets/audio/voiceover_cosy_cn"] {
            let dir = base.join(d).join(&p.episode);
            if let Ok(rd) = std::fs::read_dir(&dir) {
                let mut v: Vec<_> = rd.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".mp3")).collect();
                v.sort_by_key(|e| e.file_name());
                for e in v.into_iter().take(80) {
                    let name = e.file_name().to_string_lossy().to_string();
                    let meta: Value = std::fs::read_to_string(dir.join(name.replace(".mp3", ".json"))).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
                    voice.push(json!({
                        "id": name.trim_end_matches(".mp3"), "lang": if d.ends_with("_cn") { "zh-CN" } else { "main" }, "path": e.path().to_string_lossy(),
                        "speak": meta["speak"], "duration": meta["duration"], "cer": meta["alignment"]["cer"], "asr": meta["alignment"]["asr"],
                    }));
                }
            }
        }
        // finished / preview videos
        let mut videos = vec![];
        for d in [base.clone(), crate::layout::video_dir(&root, &p.episode).join("output")] {
            if let Ok(rd) = std::fs::read_dir(&d) {
                for e in rd.flatten() {
                    let n = e.file_name().to_string_lossy().to_string();
                    if n.starts_with(&E) && n.ends_with(".mp4") {
                        videos.push(json!({"name": n, "path": e.path().to_string_lossy(), "bytes": e.metadata().map(|m| m.len()).unwrap_or(0)}));
                    }
                }
            }
        }
        // errors, fixes and environment repairs
        let history: Vec<Value> = events(&self.conn(), id, 0, 5000)
            .unwrap_or_default()
            .into_iter()
            .filter(|e| e.level != "info" || e.line.contains("修正") || e.line.contains("🛠") || e.line.starts_with('▶') && e.line.contains("修正"))
            .map(|e| json!({"ts": e.ts, "level": e.level, "stage": e.stage, "line": e.line}))
            .collect();
        Ok(json!({
            "id": p.id, "status": p.status, "stage": p.stage, "attempt": p.attempt, "mode": p.mode,
            "worktree": wt.as_ref().map(|w| w.to_string_lossy().to_string()),
            "job": job.map(|j| json!({"id": j.id, "kind": j.kind, "label": j.label, "status": j.status, "progress": j.progress, "progressText": j.progress_text, "step": j.step, "steps": j.steps, "startedAt": j.started_at, "error": j.error})),
            "jobLines": job_lines.iter().map(|e| json!({"ts": e.ts, "stream": e.stream, "level": e.level, "line": e.line})).collect::<Vec<_>>(),
            "render": render,
            "ai": {"job": ai_status, "lines": ai_lines},
            "sources": sources, "changes": changes, "script": script, "stills": stills, "voice": voice, "videos": videos, "history": history,
        }))
    }

    /// Queue a low-resolution storyboard preview (12 key frames at 640×360, out/preview/) of the production's
    /// current code and timeline. Uses the GPU queue like any other job (waits while a render holds the GPU).
    pub fn preview(&self, id: &str) -> Result<db::Job, String> {
        let p = get(&self.conn(), id)?;
        let root = self.root(&p)?;
        let w = p.worktree.clone().ok_or("這次製作沒有工作樹（已完成或已捨棄），無法預覽")?;
        let wt = worktree_dir(&root, &w);
        let src = if content::cn_only(&p.config) { "src_cn" } else { "src" };
        let tl: Value = std::fs::read_to_string(wt.join(src).join("data/timeline.generated.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .ok_or("還沒有時間軸（配音與時間軸完成後才能預覽）")?;
        let total = tl[&p.episode]["totalFrames"].as_u64().ok_or("時間軸裡還沒有這一集")? / 2;
        let n = 12u64.min(total.max(1));
        let frames: Vec<String> = (0..n).map(|i| ((total.saturating_sub(1)) * (2 * i + 1) / (2 * n)).to_string()).collect();
        let _ = std::fs::remove_dir_all(wt.join("out/preview"));
        let params = json!({"workdir": w, "episode": p.episode, "comp": format!("{}-30fps", ep_upper(&p.episode)), "frames": frames.join(","), "src": src, "scale": 0.3333});
        let j = self.queue.enqueue(p.project_id.as_deref(), "stills", &params, &crate::jobs::job_root(&root, &params)?)?;
        self.log(&p, "info", &format!("▶ 低解析度預覽（{} 張關鍵幀，640×360）", frames.len()));
        Ok(j)
    }
}

/// The last `n` events of a job (oldest first).
pub(crate) fn tail_events(conn: &rusqlite::Connection, job_id: &str, n: i64) -> Vec<db::JobEvent> {
    let max: i64 = conn.query_row("SELECT COALESCE(MAX(id),0) FROM job_events WHERE job_id=?1", [job_id], |r| r.get(0)).unwrap_or(0);
    let after: i64 = conn
        .query_row("SELECT COALESCE(MIN(id),0) FROM (SELECT id FROM job_events WHERE job_id=?1 ORDER BY id DESC LIMIT ?2)", params![job_id, n], |r| r.get(0))
        .unwrap_or(0);
    let _ = max;
    db::events_list(conn, job_id, (after - 1).max(0), n).unwrap_or_default()
}

/// Render progress from render.mjs's own log lines: frames done / total (cached segments included), measured FPS
/// of the last segment and on average, concurrency, ETA (remaining frames ÷ last FPS), encode phase.
pub fn render_stats(lines: &[db::JobEvent]) -> Value {
    static RE_TOTAL: Lazy<Regex> = Lazy::new(|| Regex::new(r"渲染 (\S+)：(\d+) 幀，(\d+) 段").unwrap());
    static RE_DONE: Lazy<Regex> = Lazy::new(|| Regex::new(r"區段 (\d+)[–-](\d+)：(\d+)s，([\d.]+) fps，並行 (\d+)(?:，GPU 平均 (\d+)%)?(?:，VRAM 峰值 (\d+) MiB)?(?:，最高 ([\d.]+)°C)?").unwrap());
    static RE_SKIP: Lazy<Regex> = Lazy::new(|| Regex::new(r"區段 (\d+)[–-](\d+)：已完成，略過").unwrap());
    static RE_REUSE: Lazy<Regex> = Lazy::new(|| Regex::new(r"↻ (\d+)[–-](\d+) 這一段沿用 (\d+) 幀").unwrap());
    let start = lines.iter().rposition(|e| RE_TOTAL.is_match(&e.line));
    let Some(start) = start else { return Value::Null };
    let c = RE_TOTAL.captures(&lines[start].line).unwrap();
    let total: u64 = c[2].parse().unwrap_or(0);
    let (mut done, mut cached, mut chunks_done, mut secs_sum, mut rendered) = (0u64, 0u64, 0u64, 0f64, 0u64);
    let (mut fps, mut conc, mut gpu, mut vram, mut temp) = (None, None, None, None, None);
    let mut phase = "render";
    let mut last_ts = lines[start].ts;
    let mut scene_note = None;
    for e in &lines[start + 1..] {
        let l = e.line.as_str();
        if let Some(c) = RE_SKIP.captures(l) {
            let n = c[2].parse::<u64>().unwrap_or(0).saturating_sub(c[1].parse().unwrap_or(0)) + 1;
            done += n;
            cached += n;
            chunks_done += 1;
        } else if let Some(c) = RE_DONE.captures(l) {
            let n = c[2].parse::<u64>().unwrap_or(0).saturating_sub(c[1].parse().unwrap_or(0)) + 1;
            done += n;
            chunks_done += 1;
            let s: f64 = c[3].parse().unwrap_or(0.0);
            let f: f64 = c[4].parse().unwrap_or(0.0);
            secs_sum += s;
            rendered += (f * s).round() as u64;
            fps = Some(f);
            conc = c[5].parse::<u64>().ok();
            gpu = c.get(6).and_then(|m| m.as_str().parse::<u64>().ok());
            vram = c.get(7).and_then(|m| m.as_str().parse::<u64>().ok());
            temp = c.get(8).and_then(|m| m.as_str().parse::<f64>().ok());
            last_ts = e.ts;
        } else if let Some(c) = RE_REUSE.captures(l) {
            cached += c[3].parse::<u64>().unwrap_or(0);
        } else if l.contains("場景級增量渲染") {
            scene_note = Some(l.trim().to_string());
        } else if l.contains("開始編碼") || l.contains("編碼中") {
            phase = "encode";
        } else if l.trim_start().starts_with("完成：") {
            phase = "done";
        }
    }
    let remaining = total.saturating_sub(done);
    let eta = if phase == "render" { fps.filter(|f| *f > 0.0).map(|f| (remaining as f64 / f).round()) } else { None };
    json!({
        "comp": c[1].to_string(), "totalFrames": total, "doneFrames": done.min(total), "cachedFrames": cached, "chunks": c[3].parse::<u64>().unwrap_or(0), "chunksDone": chunks_done,
        "fps": fps, "avgFps": if secs_sum > 0.0 { Some((rendered as f64 / secs_sum * 10.0).round() / 10.0) } else { None }, "concurrency": conc,
        "gpuAvg": gpu, "vramPeakMiB": vram, "maxTempC": temp, "etaSec": eta, "phase": phase, "lastSegmentTs": last_ts, "sceneCache": scene_note,
    })
}
