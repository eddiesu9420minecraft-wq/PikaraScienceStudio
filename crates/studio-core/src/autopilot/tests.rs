//! Unit tests for the autopilot modules.

use super::*;

#[test]
fn config_defaults_and_billing_rules() {
    let mut c = AutoConfig { topic: "什麼是量化".into(), ..Default::default() };
    c.validate().unwrap();
    assert_eq!(c.billing, "subscription");
    assert_eq!(c.budget_usd, None, "subscription mode has no USD cap by default");
    let mut c2 = AutoConfig { topic: "x".into(), ..Default::default() };
    assert!(c2.validate().is_err());
    let mut api = AutoConfig { topic: "量化".into(), billing: "api".into(), ..Default::default() };
    assert!(api.validate().unwrap_err().contains("美元上限"));
    api.budget_usd = Some(3.0);
    api.validate().unwrap();
    let mut sub = AutoConfig { topic: "量化".into(), budget_usd: Some(5.0), ..Default::default() };
    sub.validate().unwrap();
    assert_eq!(sub.budget_usd, None);
}

#[test]
fn limit_and_login_detection() {
    assert!(usage_limit("Claude AI usage limit reached|1763600000").unwrap().contains("額度"));
    assert!(usage_limit("You've hit your limit · resets 5pm (Asia/Taipei)").unwrap().contains("resets 5pm"));
    assert!(usage_limit("Invalid API key · Please run /login").unwrap().contains("登入"));
    assert!(usage_limit("步驟「渲染」失敗：區段 0–1799 失敗").is_none());
    assert!(is_transient("API Error: 529 {\"type\":\"overloaded_error\"}"));
}

#[test]
fn pronunciation_and_qa_parsing() {
    let l = ["  ≡ ep04-s01-01 對上 20/20 字  CER 0.000", "  ≡ ep04-s01-02 對上 14/20 字  CER 0.300", "  ≡ ep04-s02-01 對上 19/20 字  CER 0.050"];
    let b = bad_pronunciations(l.iter().copied(), 0.15);
    assert_eq!(b.len(), 1);
    assert_eq!(b[0].0, "ep04-s01-02");
    assert_eq!(qa_problems(["x", "自動檢出需注意的問題：**2**（長時間…）"].iter().copied()), Some(2));
    assert_eq!(qa_problems(["自動檢出需注意的問題：**0**（…）"].iter().copied()), Some(0));
    assert_eq!(qa_problems(["nothing"].iter().copied()), None);
}

#[test]
fn pronunciation_ignores_digits_and_homophones() {
    assert_eq!(cn_number(16), "十六");
    assert_eq!(cn_number(70), "七十");
    assert_eq!(cn_number(105), "一百零五");
    assert_eq!(cn_number(2026), "二千零二十六");
    assert_eq!(cn_number(7_000_000_000), "七十億");
    assert_eq!(cn_number(100_000), "十萬");
    assert_eq!(cn_number(10_005), "一萬零五");
    // real EP04 cases: Whisper wrote digits / homophones although the voice was right
    assert!(pron_error("用常見的十六位元格式存，每個參數大約占兩個位元組。", "用常見的16位元格式存每個參數大約佔兩個位元主") < MAX_PER);
    assert!(pron_error("一個七十億參數的模型，光是參數就要大約十四 G B。", "一個70億參數的模型光是參數這要大約14gb") < MAX_PER);
    assert_eq!(pron_error("對話越長，它占的空間就越大。", "對話越長他站的空間就越大"), 0.0);
    assert!(pron_error("改成四位元，參數占的空間大約只剩四分之一。", "改成四位原參數佔的空間大也只剩四分之一") < MAX_PER);
    // a real misreading is still caught
    assert!(pron_error("模型能不能整個放上工作桌", "模型能不能整個放上公主") > MAX_PER);
}

#[test]
fn stage_plan_follows_config() {
    let mut p = Production { episode: "ep04".into(), worktree: Some("auto-ep04-abcd1234".into()), attempt: 1, ..Default::default() };
    p.config = AutoConfig { topic: "量化".into(), style: "generic".into(), bilibili: false, ..Default::default() };
    assert!(!stage_enabled("animate", &p.config) && !stage_enabled("bilibili", &p.config));
    p.stage = "final".into();
    let a = actions(&p);
    assert!(matches!(&a[0], Action::Job { kind: "typecheck", .. }), "typecheck before every render");
    match &a[1] {
        Action::Job { kind, params } => {
            assert_eq!(*kind, "final_tw");
            assert_eq!(params["workdir"], "auto-ep04-abcd1234");
            assert_eq!(params["episode"], "ep04");
            assert_eq!(params["fresh"], false);
        }
        _ => panic!(),
    }
    p.attempt = 2;
    match &actions(&p)[1] {
        // v0.2.1: no full re-render after a fix — render.mjs's scene fingerprints re-render only changed scenes
        Action::Job { params, .. } => assert_eq!(params["fresh"], false, "scene-level incremental re-render"),
        _ => panic!(),
    }
    p.stage = "script".into();
    match &actions(&p)[0] {
        Action::Job { kind, params } => {
            assert_eq!(*kind, "claude_in");
            assert!(params["tools"].as_str().unwrap().contains("WebSearch"));
            assert_eq!(params["billing"], "subscription");
            assert!(params["prompt"].as_str().unwrap().contains("ep04"));
        }
        _ => panic!(),
    }
}

fn kinds(a: &[Action]) -> Vec<String> {
    a.iter()
        .map(|x| match x {
            Action::Job { kind, params } => format!("{kind}{}", params.get("src").and_then(|v| v.as_str()).map(|s| format!("@{s}")).unwrap_or_default()),
            Action::Inline(n) => format!("inline:{n}"),
            Action::Agent { .. } => "agent".into(),
        })
        .collect()
}

#[test]
fn zh_cn_only_never_renders_traditional() {
    let mut c = AutoConfig { topic: "互联网".into(), language: "zh-CN".into(), youtube: true, ..Default::default() };
    c.validate().unwrap();
    assert!(!c.youtube && c.bilibili);
    assert!(!stage_enabled("youtube", &c) && !stage_enabled("bilibili", &c), "the Simplified video is the final stage itself");
    let mut p = Production { episode: "ep07".into(), worktree: Some("auto-ep07-x".into()), attempt: 1, config: c, ..Default::default() };
    p.stage = "voice".into();
    assert_eq!(kinds(&actions(&p)), ["make_cn", "voiceover_cn", "inline:check_voice"]);
    p.stage = "timeline".into();
    assert_eq!(kinds(&actions(&p)), ["timeline@src_cn"]);
    p.stage = "visual".into();
    assert_eq!(kinds(&actions(&p)), ["make_cn", "inline:plan_stills", "stills@src_cn", "claude_in", "typecheck", "inline:check_visual"]);
    p.stage = "final".into();
    let a = actions(&p);
    assert_eq!(kinds(&a), ["typecheck", "bilibili", "inline:check_qa"]);
    match &a[1] {
        Action::Job { params, .. } => assert!(params["skipVoice"] == true && params["reconvert"] == true),
        _ => panic!(),
    }
    p.stage = "thumbnail".into();
    assert_eq!(kinds(&actions(&p)), ["make_cn", "stills@src_cn", "inline:copy_thumb_cn"]);
    p.stage = "script".into();
    let pr = match &actions(&p)[0] { Action::Job { params, .. } => params["prompt"].as_str().unwrap().to_string(), _ => panic!() };
    assert!(pr.contains("简体中文") && pr.contains("不会先做繁体版"), "{pr}");
}

#[test]
fn english_and_script_mode_plans() {
    let mut c = AutoConfig { topic: "How the internet works".into(), language: "en".into(), mode: "script".into(), script_text: "## Intro\nPackets travel.".into(), ..Default::default() };
    c.validate().unwrap();
    c.require_script().unwrap();
    assert_eq!(c.min_sources(), 0);
    let mut p = Production { episode: "test001".into(), worktree: Some("auto-test001-x".into()), attempt: 1, config: c, ..Default::default() };
    p.stage = "script".into();
    assert_eq!(kinds(&actions(&p)), ["inline:import_script", "claude_in", "inline:check_script"]);
    p.stage = "voice".into();
    match &actions(&p)[0] {
        Action::Job { kind, params } => assert!(*kind == "voiceover_tw" && params["lang"] == "en"),
        _ => panic!(),
    }
    p.stage = "final".into();
    match &actions(&p)[1] {
        Action::Job { kind, params } => assert!(*kind == "final_tw" && params["out"] == "TEST001_Final_en.mp4"),
        _ => panic!(),
    }
    assert!(!stage_enabled("bilibili", &p.config) && !stage_enabled("youtube", &p.config));
    let mut empty = AutoConfig { topic: "x 測試".into(), mode: "script".into(), ..Default::default() };
    empty.validate().unwrap();
    assert!(empty.require_script().is_err());
}

#[test]
fn requirements_reach_fix_prompts() {
    let mut p = Production { episode: "ep07".into(), attempt: 2, ..Default::default() };
    p.config = AutoConfig { topic: "網路".into(), mode: "guided".into(), must_avoid: "比特幣".into(), brief: "請用快遞比喻".into(), ..Default::default() };
    p.stage = "final".into();
    for f in [Fixer::Script, Fixer::Code, Fixer::Pronunciation, Fixer::Qa] {
        let s = prompt_fix(&p, f, "err");
        assert!(s.contains("比特幣") && s.contains("請用快遞比喻") && s.contains("指導模式"), "{f:?}");
    }
    assert!(prompt_publish(&p).contains("比特幣"));
    assert!(prompt_animate(&p).contains("請用快遞比喻"));
}

#[test]
fn render_stats_from_log() {
    let ev = |i: i64, l: &str| db::JobEvent { id: i, job_id: "j".into(), ts: i * 1000, stream: "stdout".into(), level: "info".into(), line: l.into() };
    let lines = vec![
        ev(1, "渲染 EP06-30fps：17313 幀，10 段（每段 1800 幀），GPU：ANGLE / D3D11；VRAM 基準 1120 MiB，上限 5300 MiB"),
        ev(2, "  區段 0–1799：已完成，略過"),
        ev(3, "  區段 1800–3599：50s，36.0 fps，並行 6，GPU 平均 22%，VRAM 峰值 2212 MiB，最高 44.34°C"),
    ];
    let r = render_stats(&lines);
    assert_eq!(r["totalFrames"], 17313);
    assert_eq!(r["doneFrames"], 3600);
    assert_eq!(r["cachedFrames"], 1800);
    assert_eq!(r["fps"], 36.0);
    assert_eq!(r["concurrency"], 6);
    assert_eq!(r["etaSec"], ((17313.0 - 3600.0) / 36.0_f64).round());
    assert_eq!(r["phase"], "render");
}

#[test]
fn episode_allocation_never_reuses() {
    let d = std::env::temp_dir().join(format!("pss-auto-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(d.join("src/data")).unwrap();
    std::fs::write(d.join("src/data/narration.json"), r#"{"sequences":{"ep01":{"scenes":[]},"ep02":{"scenes":[]}}}"#).unwrap();
    std::fs::write(d.join("EP05_Final.mp4"), b"x").unwrap();
    let c = db::open_memory().unwrap();
    assert_eq!(allocate_episode(&c, &d).unwrap(), "ep06");
    let p = Production { id: "p1".into(), episode: "ep06".into(), status: "queued".into(), created_at: now_iso(), ..Default::default() };
    save(&c, &p).unwrap();
    assert_eq!(allocate_episode(&c, &d).unwrap(), "ep07");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn script_check_messages() {
    let d = std::env::temp_dir().join(format!("pss-auto-s-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(d.join("src/data")).unwrap();
    let line = |i: usize| json!({"id": format!("ep04-{i}"), "subtitle": "這是一句長度大約二十個字的測試旁白內容喔"});
    let doc = json!({"sequences": {"ep04": {"title": "量化", "scenes": [
        {"id": "s01", "title": "a", "lines": (0..10).map(line).collect::<Vec<_>>()},
        {"id": "s02", "title": "b", "lines": (10..20).map(line).collect::<Vec<_>>()}]}}});
    std::fs::write(d.join("src/data/narration.json"), serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    // 20 lines × 20 chars = 400 chars ≈ 1.85 min
    let zr = |m: f64| ScriptRules { target_units: m * 60.0 * 3.6, words: false, check_length: true, min_sources: 3 };
    assert!(check_script(&d, "ep04", &zr(1.8)).unwrap_err().contains("SOURCES"));
    assert!(check_script(&d, "ep04", &ScriptRules { min_sources: 0, ..zr(1.8) }).is_ok(), "custom script: sources optional");
    std::fs::write(d.join("EP04_SOURCES.md"), "- https://a.example/1\n- https://b.example/2\n- https://c.example/3\n").unwrap();
    assert!(check_script(&d, "ep04", &zr(1.8)).unwrap().contains("劇本檢查通過"));
    assert!(check_script(&d, "ep04", &zr(5.0)).unwrap_err().contains("增加內容"));
    assert!(check_script(&d, "ep04", &ScriptRules { check_length: false, ..zr(5.0) }).is_ok(), "custom script: length not checked");
    assert!(check_script(&d, "ep09", &zr(1.8)).unwrap_err().contains("沒有 sequences.ep09"));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn resource_wait_does_not_count_toward_time_limit() {
    assert!(!counts_toward_limit(Some("waiting_resource")));
    for s in ["queued", "running", "interrupted", "succeeded", "failed"] {
        assert!(counts_toward_limit(Some(s)), "{s}");
    }
    assert!(counts_toward_limit(None)); // 沒有工作在跑（劇本／判斷階段）照常計時
}

#[test]
fn written_form_counts_as_correct_reading() {
    // TEST004: speak「C plus plus」, subtitle「C++」, Whisper heard「c++」
    let asr = "開發者能用c++或python來寫";
    assert!(pron_error("開發者能用 C plus plus 或 Python 來寫，", asr) > 0.12);
    assert!(pron_error("開發者能用 C++ 或 Python 來寫，", asr) <= 0.12);
}

/// v0.3 EP07 fix: a failing script check stores what failed, marks the check as the place to resume (no new research),
/// continues while fixes make progress, and stops calling the AI when a fix does not improve a single item.
fn test_autopilot() -> std::sync::Arc<Autopilot> {
    use std::sync::{Arc, Mutex};
    let db: crate::db::Db = Arc::new(Mutex::new(crate::db::open_memory().unwrap()));
    let q = crate::queue::Queue::new(db.clone(), Arc::new(|_, _| {}));
    Autopilot::new(db, q, Arc::new(|_, _| {}), Arc::new(|_, _| {}))
}

fn animate_production(id: &str) -> Production {
    let c = AutoConfig { topic: "t".into(), max_attempts: 6, max_minutes: 600, ..Default::default() };
    Production { id: id.into(), episode: "ep07".into(), stage: "animate".into(), status: "running".into(), attempt: 1, action: 2, mode: "main".into(), config: c, data: json!({}), ..Default::default() }
}

fn running_job(ap: &Autopilot) -> crate::db::Job {
    let c = ap.conn();
    let j = crate::db::job_insert(&c, None, "claude_in", "EP07 動畫程式", &json!({}), "cpu", &[]).unwrap();
    crate::db::job_mark_started(&c, &j.id, "x.log").unwrap();
    crate::db::job_get(&c, &j.id).unwrap()
}

#[test]
fn stalled_step_is_recovered_in_place_then_falls_back_to_normal_handling() {
    let ap = test_autopilot();
    ap.store(&animate_production("prod-stall"));
    // 1st and 2nd stall: same stage, same step, continuation note for the AI, nothing reset
    for n in 1..=2u64 {
        let p = get(&ap.conn(), "prod-stall").unwrap();
        ap.recover_step(p, "停滯：1200 秒沒有任何輸出");
        let s = get(&ap.conn(), "prod-stall").unwrap();
        assert_eq!((s.stage.as_str(), s.action, s.status.as_str(), s.attempt), ("animate", 2, "running", 1));
        assert_eq!(s.data["stepRecoveries"]["animate"], n);
        assert!(s.data["resumeNote"].as_str().unwrap().contains("停滯"));
        assert!(s.job_id.is_none());
    }
    // 3rd stall: the normal failure handling decides (counts as an attempt)
    let p = get(&ap.conn(), "prod-stall").unwrap();
    ap.recover_step(p, "停滯：1200 秒沒有任何輸出");
    let s = get(&ap.conn(), "prod-stall").unwrap();
    assert_eq!(s.data["stepRecoveries"]["animate"], 2);
    assert_eq!(s.attempt, 2);
}

#[test]
fn interrupted_job_that_is_never_requeued_does_not_hang_the_production() {
    let ap = test_autopilot();
    let j = running_job(&ap);
    ap.conn().execute("UPDATE jobs SET status='interrupted' WHERE id=?1", [&j.id]).unwrap();
    let j = crate::db::job_get(&ap.conn(), &j.id).unwrap();
    let mut p = animate_production("prod-int");
    p.job_id = Some(j.id.clone());
    // just interrupted: Studio's startup recovery may still re-queue it → wait
    let mut p = ap.watch(p, &j).expect("waits during the grace period");
    assert!(p.job_id.is_some());
    // still interrupted after the grace period → recover the step
    p.data["watch"]["interruptedAt"] = json!(now_ms() - INTERRUPTED_GRACE_MS - 1000);
    assert!(ap.watch(p, &j).is_none());
    let s = get(&ap.conn(), "prod-int").unwrap();
    assert!(s.job_id.is_none() && s.status == "running" && s.action == 2);
    assert!(s.data["resumeNote"].as_str().unwrap().contains("中斷"));
}

#[test]
fn quiet_running_job_is_stopped_by_the_watchdog_and_its_step_recovered() {
    let ap = test_autopilot();
    let j = running_job(&ap);
    let mut p = animate_production("prod-wd");
    p.job_id = Some(j.id.clone());
    // recent activity → nothing happens
    p.data["watch"] = json!({"job": j.id, "since": now_ms() - 60_000});
    let mut p = ap.watch(p, &j).expect("active job is left alone");
    // nothing at all for longer than the watchdog limit (no output, no worktree) → stop the job
    p.data["watch"] = json!({"job": j.id, "since": now_ms() - (watchdog_secs() as i64 + 60) * 1000});
    ap.store(&p);
    assert!(ap.watch(p, &j).is_none());
    assert_eq!(crate::db::job_get(&ap.conn(), &j.id).unwrap().status, "canceled");
    let s = get(&ap.conn(), "prod-wd").unwrap();
    assert_eq!(s.data["watchdogCancel"], json!(j.id));
    // the next tick sees the cancel it caused → recovers the step instead of ending the production
    ap.advance(s);
    let s = get(&ap.conn(), "prod-wd").unwrap();
    assert_eq!((s.status.as_str(), s.action, s.job_id.is_none()), ("running", 2, true));
    assert!(s.data["resumeNote"].as_str().unwrap().contains("沒有任何輸出"));
    assert!(s.data.get("watchdogCancel").is_none());
}

#[test]
fn manual_recover_keeps_the_stage_and_step() {
    let ap = test_autopilot();
    let mut p = animate_production("prod-man");
    p.status = "failed".into();
    p.attempt = 3;
    ap.store(&p);
    let r = ap.recover("prod-man").unwrap();
    assert_eq!((r.stage.as_str(), r.action, r.status.as_str(), r.attempt), ("animate", 2, "running", 1));
    assert!(r.data["resumeNote"].as_str().unwrap().contains("手動"));
    let mut done = animate_production("prod-done");
    done.status = "succeeded".into();
    ap.store(&done);
    assert!(ap.recover("prod-done").is_err());
}

#[test]
fn script_check_retries_are_targeted_and_stop_without_progress() {
    use std::sync::{Arc, Mutex};
    let db: crate::db::Db = Arc::new(Mutex::new(crate::db::open_memory().unwrap()));
    let q = crate::queue::Queue::new(db.clone(), Arc::new(|_, _| {}));
    let ap = Autopilot::new(db.clone(), q, Arc::new(|_, _| {}), Arc::new(|_, _| {}));
    let req = |keys: &[&str]| json!({"items": keys.iter().map(|k| json!({"key": k, "status": "fail"})).collect::<Vec<_>>()});
    let c = AutoConfig { topic: "t".into(), max_attempts: 6, ..Default::default() };
    let p = Production { id: "prod-test-1".into(), episode: "ep07".into(), stage: "script".into(), status: "running".into(), attempt: 1, action: 3, mode: "main".into(),
                         config: c, data: json!({"requirements": req(&["include:A", "include:B"])}), ..Default::default() };
    ap.stage_failed(p, "沒有符合使用者的製作要求", false, true);
    let s = get(&ap.conn(), "prod-test-1").unwrap();
    assert_eq!(s.data["resumeAt"], 3, "after the fix only the check runs again");
    assert_eq!(s.data["prevFailKeys"].as_array().unwrap().len(), 2);
    assert_ne!(s.status, "failed");
    // the fix repaired A → progress → keep going
    let mut p2 = s.clone();
    p2.data["requirements"] = req(&["include:B"]);
    ap.stage_failed(p2, "沒有符合使用者的製作要求", false, true);
    let s2 = get(&ap.conn(), "prod-test-1").unwrap();
    assert_ne!(s2.status, "failed");
    // the next fix changed nothing → stop with a diagnosis instead of another AI call
    let mut p3 = s2.clone();
    p3.data["requirements"] = req(&["include:B"]);
    ap.stage_failed(p3, "沒有符合使用者的製作要求", false, true);
    let s3 = get(&ap.conn(), "prod-test-1").unwrap();
    assert_eq!(s3.status, "failed");
    let m = s3.message.unwrap_or_default();
    assert!(m.contains("停止重複呼叫") && m.contains("include:B") && m.contains("REQUIREMENTS_CHECK.json"), "{m}");
}

// ------------------------------------------------------------------ v0.3.2 製作狀態頁、草稿、刪除、擬人化

fn board_status(v: &Value, id: &str) -> String {
    v["steps"].as_array().unwrap().iter().find(|s| s["id"] == id).unwrap()["status"].as_str().unwrap().to_string()
}

fn all_stages(done_until: &str, current: &str) -> Vec<StageInfo> {
    let mut seen = false;
    STAGES
        .iter()
        .map(|(id, _)| {
            let status = if *id == current {
                seen = true;
                "running"
            } else if seen || done_until.is_empty() {
                "pending"
            } else {
                "done"
            };
            StageInfo { id: id.to_string(), label: id.to_string(), status: status.into(), ..Default::default() }
        })
        .collect()
}

#[test]
fn board_maps_real_stage_state_to_eleven_steps() {
    let ap = test_autopilot();
    // 動畫階段執行中：研究、劇本、驗證已完成；動畫執行中；之後都在等待
    let mut p = animate_production("prod-board");
    p.stages = all_stages("script", "animate");
    p.stages.iter_mut().find(|s| s.id == "bilibili").unwrap().status = "skipped".into();
    ap.store(&p);
    let cur = get(&ap.conn(), "prod-board").unwrap();
    let v = ap.board_item(&cur);
    assert_eq!(v["steps"].as_array().unwrap().len(), 11);
    for (id, st) in [("research", "done"), ("script", "done"), ("validate", "done"), ("animate", "running"), ("voice", "pending"), ("render", "pending"), ("output", "pending")] {
        assert_eq!(board_status(&v, id), st, "{id}");
    }
    assert_eq!(v["currentStep"], "animate");
    let prog = v["progress"].as_f64().unwrap();
    assert!((prog - 3.0 / 11.0).abs() < 0.01, "progress {prog}");
    assert!(v["etaSecs"].is_null(), "AI 步驟沒有可靠的剩餘時間");
    // 暫停：目前步驟顯示已暫停；失敗：顯示失敗；可用操作跟著狀態改變
    let mut q = get(&ap.conn(), "prod-board").unwrap();
    q.status = "paused".into();
    ap.store(&q);
    let v = ap.board_item(&q);
    assert_eq!(board_status(&v, "animate"), "paused");
    assert_eq!((v["can"]["resume"].as_bool(), v["can"]["pause"].as_bool()), (Some(true), Some(false)));
    q.status = "failed".into();
    ap.store(&q);
    let v = ap.board_item(&q);
    assert_eq!(board_status(&v, "animate"), "failed");
    assert_eq!(v["can"]["retry"], true);
    assert_eq!(v["can"]["deleteFiles"], true);
}

#[test]
fn render_job_step_decides_mix_render_and_qa() {
    let ap = test_autopilot();
    let mut p = animate_production("prod-final");
    p.stage = "final".into();
    p.action = 1;
    p.stages = all_stages("visual", "final");
    let c = ap.conn();
    let labels = ["時間軸 EP07", "複製字幕", "混音 EP07", "渲染 EP07-30fps", "品質檢查 EP07"];
    let st: Vec<String> = labels.iter().map(|l| l.to_string()).collect();
    let j = crate::db::job_insert(&c, None, "final_tw", "EP07 正式版", &json!({}), "gpu", &st).unwrap();
    crate::db::job_mark_started(&c, &j.id, "x.log").unwrap();
    crate::db::job_set_step(&c, &j.id, 3).unwrap();
    crate::db::job_set_progress(&c, &j.id, (3.0 + 0.5) / 5.0, Some("幀 100/200")).unwrap();
    drop(c);
    p.job_id = Some(j.id.clone());
    ap.store(&p);
    let cur = get(&ap.conn(), "prod-final").unwrap();
    let v = ap.board_item(&cur);
    assert_eq!((board_status(&v, "mix"), board_status(&v, "render"), board_status(&v, "qa")), ("done".to_string(), "running".to_string(), "pending".to_string()));
    let render = v["steps"].as_array().unwrap().iter().find(|s| s["id"] == "render").unwrap().clone();
    assert!((render["progress"].as_f64().unwrap() - 0.5).abs() < 1e-6, "渲染這一步自己的進度");
}

#[test]
fn draft_waits_until_started_and_edit_rules_follow_the_state() {
    let ap = test_autopilot();
    let mut p = animate_production("prod-draft");
    p.status = "draft".into();
    p.stage = "prepare".into();
    p.action = 0;
    ap.store(&p);
    ap.tick();
    assert_eq!(get(&ap.conn(), "prod-draft").unwrap().status, "draft", "排程器不會執行草稿");
    // 草稿可以改主題與敘事方式
    let e = ap.update_config("prod-draft", json!({"topic": "CPU 與 GPU 的分工", "narrative": "personified"})).unwrap();
    assert_eq!((e.config.topic.as_str(), e.config.narrative.as_str()), ("CPU 與 GPU 的分工", "personified"));
    assert!(ap.update_config("prod-draft", json!({"narrative": "story"})).is_err());
    let s = ap.start_draft("prod-draft").unwrap();
    assert_eq!(s.status, "queued");
    assert!(ap.start_draft("prod-draft").is_err(), "不能重複開始");
    // 製作中不能編輯；暫停後只能改不影響已完成成果的項目
    let mut r = get(&ap.conn(), "prod-draft").unwrap();
    r.status = "running".into();
    ap.store(&r);
    assert!(ap.update_config("prod-draft", json!({"maxMinutes": 90})).is_err());
    r.status = "paused".into();
    r.stages = vec![
        StageInfo { id: "thumbnail".into(), status: "done".into(), ..Default::default() },
        StageInfo { id: "publish".into(), status: "pending".into(), ..Default::default() },
    ];
    ap.store(&r);
    let u = ap.update_config("prod-draft", json!({"maxMinutes": 90, "topic": "不能改", "publishInfo": false})).unwrap();
    assert_eq!((u.config.max_minutes, u.config.topic.as_str(), u.config.publish_info), (90, "CPU 與 GPU 的分工", false));
    assert_eq!(u.stages[1].status, "skipped");
    assert!(ap.update_config("prod-draft", json!({"thumbnail": false})).unwrap_err().contains("已經執行過"));
}

#[test]
fn delete_task_cancels_the_running_job_and_removes_only_the_record() {
    let ap = test_autopilot();
    let mut p = animate_production("prod-del");
    let j = running_job(&ap);
    p.job_id = Some(j.id.clone());
    ap.store(&p);
    let r = ap.delete_task("prod-del").unwrap();
    assert_eq!(r["removed"], true);
    assert_eq!(r["canceledJob"], json!(j.id));
    assert!(get(&ap.conn(), "prod-del").is_err());
    assert_eq!(crate::db::job_get(&ap.conn(), &j.id).unwrap().status, "canceled");
    // 刪除影片檔案：製作中不允許
    let mut q = animate_production("prod-del2");
    q.status = "running".into();
    ap.store(&q);
    assert!(ap.delete_files("prod-del2").unwrap_err().contains("取消製作"));
}

#[test]
fn narrative_and_characters_are_validated_and_reach_the_prompts() {
    let mut c = AutoConfig { topic: "GPU 為什麼不能取代 CPU".into(), ..Default::default() };
    c.characters = vec![
        Character { name: " CPU 大廚 ".into(), concept: "CPU".into(), look: "冰藍色方形晶片".into(), personality: "精明".into(), voice: "ref_S1".into(), pitch: -9.0 },
        Character::default(),
    ];
    c.validate().unwrap();
    assert_eq!(c.characters.len(), 1, "空白角色會被移除");
    assert_eq!((c.characters[0].name.as_str(), c.characters[0].pitch), ("CPU 大廚", -6.0));
    assert_eq!(c.narrative_mode(), "personified", "指定了角色就一定使用");
    let mut bad = c.clone();
    bad.characters[0].voice = "../x".into();
    assert!(bad.validate().is_err());
    let p = Production { episode: "ep20".into(), config: c.clone(), data: json!({"voiceRefs": ["ref_S1", "ref_S3"]}), ..Default::default() };
    let s = prompt_script(&p);
    assert!(s.contains("必須**使用擬人化角色") && s.contains("CPU 大廚") && s.contains("ref_S1、ref_S3") && s.contains("\"speaker\""), "{s}");
    let a = prompt_animate(&Production { stage: "animate".into(), ..p.clone() });
    assert!(a.contains("characters.tsx") && a.contains("表情"));
    // 預設：AI 自行判斷；一般旁白：提示詞不要求角色
    let auto = Production { episode: "ep20".into(), config: AutoConfig { topic: "x 主題".into(), ..Default::default() }, data: json!({}), ..Default::default() };
    assert!(prompt_script(&auto).contains("先判斷這個主題是否適合擬人化"));
    let plain = Production { config: AutoConfig { narrative: "plain".into(), ..auto.config.clone() }, ..auto.clone() };
    assert!(!prompt_script(&plain).contains("\"speaker\"") && !prompt_animate(&plain).contains("characters.tsx"));
    // 動畫風格留空 = EP01 經典黑黃科技風
    assert!(content::brief_block(&auto.config, "animate").contains("EP01 經典黑黃科技風"));
}

#[test]
fn canceled_render_still_shows_the_render_step_as_canceled() {
    // 控制驗收發現：取消後 job_id 被清空，製作狀態頁把「音訊混合」顯示為已取消（實際是在渲染時取消）
    let ap = test_autopilot();
    let mut p = animate_production("prod-cancel-render");
    p.stage = "final".into();
    p.action = 1;
    p.stages = all_stages("visual", "final");
    let c = ap.conn();
    let labels: Vec<String> = ["時間軸 EP07", "複製字幕", "混音 EP07", "渲染 EP07-30fps", "品質檢查 EP07"].iter().map(|l| l.to_string()).collect();
    let j = crate::db::job_insert(&c, None, "final_tw", "EP07 正式版", &json!({}), "gpu", &labels).unwrap();
    crate::db::job_mark_started(&c, &j.id, "x.log").unwrap();
    crate::db::job_set_step(&c, &j.id, 3).unwrap();
    drop(c);
    p.job_id = Some(j.id.clone());
    ap.store(&p);
    let s = ap.stop("prod-cancel-render").unwrap();
    assert!(s.job_id.is_none());
    let v = ap.board_item(&s);
    assert_eq!((board_status(&v, "mix"), board_status(&v, "render"), board_status(&v, "qa")), ("done".to_string(), "canceled".to_string(), "pending".to_string()));
    assert_eq!(v["currentStep"], "render");
    assert_eq!(v["can"]["resume"], false, "測試資料沒有工作樹，不能從中斷處繼續");
}
