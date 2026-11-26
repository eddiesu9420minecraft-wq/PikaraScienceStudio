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
