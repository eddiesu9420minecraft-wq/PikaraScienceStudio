//! `PikaraScienceStudio.exe --selftest [--project <dir>] [--out <file.json>]`
//! Runs the real backend headless (no window): DB roundtrip, queue with a real CPU process, recovery,
//! doctor, monitor samples, external GPU detection, narration validation, prompt build, outputs + ffprobe.
//! Never starts GPU work.

use crate::db;
use crate::queue::Queue;
use crate::{claude, doctor, gitops, monitor, narration, project, prompt};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn step(results: &mut Vec<Value>, name: &str, f: impl FnOnce() -> Result<Value, String>) -> bool {
    let t = Instant::now();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|_| Err("panicked".into()));
    let ms = t.elapsed().as_millis() as u64;
    let ok = r.is_ok();
    results.push(match r {
        Ok(v) => json!({"name": name, "ok": true, "ms": ms, "result": v}),
        Err(e) => json!({"name": name, "ok": false, "ms": ms, "error": e}),
    });
    ok
}

pub fn run(args: &[String]) -> i32 {
    let get = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let project_root = get("--project")
        .map(PathBuf::from)
        .or_else(|| std::env::var("PIKARA_PROJECT").ok().map(PathBuf::from))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let out_file = get("--out");
    // isolated data dir so the selftest never touches the user's real queue
    let data = std::env::temp_dir().join(format!("pikara-studio-selftest-{}", std::process::id()));
    std::env::set_var("PIKARA_STUDIO_DATA", &data);
    let mut results = vec![];

    let conn = match db::open(&data.join("studio.db")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("db open failed: {e}");
            return 2;
        }
    };
    let dbh: db::Db = Arc::new(Mutex::new(conn));
    let q = Queue::new(dbh.clone(), Arc::new(|_, _| {}));
    let mut project_id = String::new();

    step(&mut results, "db.roundtrip", || {
        let c = dbh.lock().unwrap_or_else(|e| e.into_inner());
        let v = db::user_version(&c);
        let s = db::settings_merge(&c, &json!({"maxCpuJobs": 2}))?;
        let tables: Vec<String> = c
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(json!({"userVersion": v, "tables": tables, "settings": s}))
    });

    step(&mut results, "project.register", || {
        drop(dbh.lock().unwrap_or_else(|e| e.into_inner()));
        let p = crate::register_project(&dbh, &project_root.to_string_lossy())?;
        project_id = p.id.clone();
        let info = project::info(&p);
        Ok(json!({"project": p, "episodes": info["episodes"], "outputs": info["outputs"].as_array().map(|a| a.len()), "git": info["git"]["branch"], "dirty": info["git"]["dirty"].as_array().map(|a| a.len())}))
    });

    step(&mut results, "narration.validate", || {
        let mut out = json!({});
        for loc in ["zh-TW", "zh-CN"] {
            let r = narration::read(&project_root, loc)?;
            let v = narration::validate(&r["doc"]);
            let lines: usize = r["sequences"].as_array().unwrap().iter().flat_map(|s| s["scenes"].as_array().cloned().unwrap_or_default()).map(|s| s["lines"].as_array().map(|a| a.len()).unwrap_or(0)).sum();
            let original = std::fs::read_to_string(narration::file_path(&project_root, loc)?).map_err(|e| e.to_string())?;
            let byte_exact = narration::serialize_like(&r["doc"], &original)? == original;
            out[loc] = json!({"ok": v.ok, "errors": v.errors.len(), "warnings": v.warnings.len(), "lines": lines, "roundTripByteExact": byte_exact});
            if !v.ok || !byte_exact {
                return Err(format!("{loc}: {out}"));
            }
        }
        Ok(out)
    });

    step(&mut results, "prompt.build", || {
        let t = prompt::build(&project_root, "fix_qa_issues", &json!({"seqKey": "ep01"}), &prompt::Extra { job_summary: None, job_log_tail: None })?;
        Ok(json!({"chars": t.chars().count(), "head": t.lines().take(6).collect::<Vec<_>>()}))
    });

    step(&mut results, "queue.cpu_job", || {
        let j = q.enqueue(Some(&project_id), "custom", &json!({"command": "echo selftest-ok && git --version"}), &project_root)?;
        let t = Instant::now();
        loop {
            q.tick();
            let cur = db::job_get(&dbh.lock().unwrap_or_else(|e| e.into_inner()), &j.id)?;
            if cur.status == "succeeded" || cur.status == "failed" {
                let ev = db::events_list(&dbh.lock().unwrap_or_else(|e| e.into_inner()), &j.id, 0, 100)?;
                let lines: Vec<String> = ev.iter().map(|e| format!("[{}] {}", e.stream, e.line)).collect();
                if cur.status != "succeeded" || !lines.iter().any(|l| l.contains("selftest-ok")) {
                    return Err(format!("job {}: {lines:?}", cur.status));
                }
                return Ok(json!({"status": cur.status, "exitCode": cur.exit_code, "events": lines}));
            }
            if t.elapsed() > Duration::from_secs(30) {
                return Err("timeout".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });

    step(&mut results, "queue.gpu_lock_external", || {
        let e = q.check_external(None);
        q.force_external_busy.store(true, std::sync::atomic::Ordering::Relaxed);
        let j = q.enqueue(Some(&project_id), "render", &json!({"comp": "EP01-30fps", "out": "SELFTEST_never_rendered.mp4"}), &project_root)?;
        q.tick();
        let cur = db::job_get(&dbh.lock().unwrap_or_else(|e| e.into_inner()), &j.id)?;
        q.force_external_busy.store(false, std::sync::atomic::Ordering::Relaxed);
        q.cancel(&j.id)?;
        if cur.status != "waiting_resource" {
            return Err(format!("GPU job was not held back: {}", cur.status));
        }
        Ok(json!({"realExternal": e, "heldStatus": cur.status, "waitReason": cur.wait_reason}))
    });

    step(&mut results, "queue.recovery", || {
        let c = dbh.lock().unwrap_or_else(|e| e.into_inner());
        let j = db::job_insert(&c, Some(&project_id), "qa", "stale", &json!({}), "cpu", &["qa".into()])?;
        db::job_mark_started(&c, &j.id, "x")?;
        c.execute("UPDATE jobs SET heartbeat_ms=heartbeat_ms-60000 WHERE id=?1", [&j.id]).map_err(|e| e.to_string())?;
        drop(c);
        let ids = q.recover();
        let after = db::job_get(&dbh.lock().unwrap_or_else(|e| e.into_inner()), &j.id)?;
        q.cancel(&j.id)?;
        if !ids.contains(&j.id) || after.status != "queued" {
            return Err(format!("recovery failed: {ids:?} {}", after.status));
        }
        Ok(json!({"recovered": ids.len(), "requeuedStatus": after.status, "attempt": after.attempt}))
    });

    step(&mut results, "monitor.sample", || {
        let m = monitor::Monitor::new();
        let a = m.sample(|g| q.check_external(g));
        std::thread::sleep(Duration::from_millis(1200));
        let b = m.sample(|g| q.check_external(g));
        Ok(json!({"first": a, "second": b}))
    });

    step(&mut results, "doctor.run", || {
        let r = crate::doctor_report(&dbh, &q, Some(&project_id), false)?;
        let summary: Vec<String> = r["checks"].as_array().unwrap().iter().map(|c| format!("{} {} — {}", c["status"].as_str().unwrap_or(""), c["id"].as_str().unwrap_or(""), c["detail"].as_str().unwrap_or(""))).collect();
        Ok(json!({"checks": summary}))
    });

    step(&mut results, "outputs.ffprobe", || {
        let o = project::outputs(&project_root, true);
        let probed: Vec<Value> = o.iter().filter(|x| x["ext"] == "mp4").map(|x| json!({"name": x["name"], "probe": x["probe"]})).collect();
        let with_duration = probed.iter().filter(|x| x["probe"]["durationS"].as_f64().unwrap_or(0.0) > 0.0).count();
        if !probed.is_empty() && with_duration == 0 {
            return Err(format!("ffprobe returned no duration for any of {} mp4 files", probed.len()));
        }
        let md = project::publish_metadata(&project_root, None);
        Ok(json!({"files": o.len(), "mp4": probed, "publishSections": md["sections"].as_array().map(|a| a.len())}))
    });

    // ---- multi-episode (v1.2) ----
    step(&mut results, "episodes.list", || {
        let l = crate::episodes::list(&project_root);
        let ids: Vec<String> = l.as_array().unwrap().iter().filter_map(|e| e["id"].as_str().map(String::from)).collect();
        if !ids.iter().any(|i| i == "ep01") {
            return Err(format!("ep01 not found: {ids:?}"));
        }
        // every episode maps to its own commands / output names
        let s = db::settings_get(&dbh.lock().unwrap_or_else(|e| e.into_inner()));
        let ctx = crate::jobs::Ctx { root: &project_root, settings: &s, job_id: "selftest" };
        let mut maps = vec![];
        for id in &ids {
            let ep = id.to_ascii_uppercase();
            let r = crate::jobs::build_steps("render", &json!({"episode": id}), &ctx)?;
            let b = crate::jobs::build_steps("bilibili", &json!({"episode": id}), &ctx)?;
            let want_r = [format!("{ep}-30fps"), format!("{ep}_Final.mp4")];
            if !want_r.iter().all(|w| r[0].args.contains(w)) || !b[5].args.contains(&format!("{ep}_Bilibili_zh-CN.mp4")) {
                return Err(format!("{id}: {:?} / {:?}", r[0].args, b[5].args));
            }
            maps.push(json!({"id": id, "render": r[0].args, "bilibiliSteps": b.len()}));
        }
        Ok(json!({"episodes": l, "commandMaps": maps}))
    });

    step(&mut results, "episodes.create_in_temp_copy", || {
        // copy the real narration files into a temp git repo (Chinese + space path), create the next episode there
        let d = std::env::temp_dir().join(format!("pss 自我測試 {}", std::process::id()));
        for loc in ["zh-TW", "zh-CN"] {
            let src = narration::file_path(&project_root, loc)?;
            if src.exists() {
                let dst = narration::file_path(&d, loc)?;
                std::fs::create_dir_all(dst.parent().unwrap()).map_err(|e| e.to_string())?;
                std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
            }
        }
        gitops::git(&d, &["init", "-q"])?;
        gitops::git(&d, &["add", "."])?;
        gitops::git_commit(&d, &["commit", "-qm", "selftest base"])?;
        let before = narration::read(&d, "zh-TW")?;
        let r = crate::create_episode(&d, "自我測試集數", None, None, None, Some(vec!["zh-TW".into()]))?;
        let after = narration::read(&d, "zh-TW")?;
        let v = narration::validate(&after["doc"]);
        let id = r["episodeId"].as_str().unwrap_or("").to_string();
        let dup = crate::create_episode(&d, "x", Some(&id), None, None, None).is_err();
        let old_same = before["doc"]["sequences"].as_object().unwrap().iter().all(|(k, val)| &after["doc"]["sequences"][k] == val);
        let _ = std::fs::remove_dir_all(&d);
        if !v.ok || !dup || !old_same || r["files"][0]["commit"].is_null() {
            return Err(format!("valid={} dupRefused={dup} oldUnchanged={old_same} {r}", v.ok));
        }
        Ok(json!({"created": id, "commit": r["files"][0]["commit"], "duplicateRefused": dup, "existingEpisodesUnchanged": old_same}))
    });

    step(&mut results, "project.scaffold_cpu_job", || {
        // new project from this project's pipeline in a Chinese + space path, then a real CPU job through the queue
        let dest = std::env::temp_dir().join(format!("pss 新專案 {}", std::process::id())).join("測試 專案");
        let r = crate::create_project(&dbh, &dest.to_string_lossy(), "自我測試 專案", Some(&project_root), false)?;
        let pid = r["project"]["id"].as_str().unwrap_or("").to_string();
        let j = q.enqueue(Some(&pid), "timeline", &json!({"episode": "ep01", "estimate": true}), &dest)?;
        let t = Instant::now();
        let res = loop {
            q.tick();
            let cur = db::job_get(&dbh.lock().unwrap_or_else(|e| e.into_inner()), &j.id)?;
            if ["succeeded", "failed"].contains(&cur.status.as_str()) {
                break cur;
            }
            if t.elapsed() > Duration::from_secs(60) {
                return Err("timeout".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let tl = std::fs::read_to_string(dest.join(r"src\data\timeline.generated.json")).unwrap_or_default();
        let ok = res.status == "succeeded" && tl.contains("\"ep01\"");
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
        if !ok {
            return Err(format!("{} {:?}", res.status, res.error));
        }
        Ok(json!({"path": r["scaffold"]["path"], "files": r["scaffold"]["files"], "commit": r["scaffold"]["git"]["commit"], "cpuJob": res.status}))
    });

    step(&mut results, "autopilot.plan_and_checks", || {
        use crate::autopilot as ap;
        // config rules (subscription = no USD cap), episode allocation against the real project, pronunciation metric
        let mut cfg = ap::AutoConfig { topic: "自我檢查".into(), budget_usd: Some(9.0), ..Default::default() };
        cfg.validate()?;
        if cfg.budget_usd.is_some() || cfg.billing != "subscription" {
            return Err("subscription mode must not carry a USD cap".into());
        }
        let next = ap::allocate_episode(&dbh.lock().unwrap_or_else(|e| e.into_inner()), &project_root)?;
        let per_ok = ap::pron_error("一個七十億參數的模型", "一個70億參數的模型");
        let per_bad = ap::pron_error("放上工作桌", "放上公主");
        if per_ok > ap::MAX_PER || per_bad <= ap::MAX_PER {
            return Err(format!("pronunciation metric wrong: {per_ok} / {per_bad}"));
        }
        let tables: i64 = dbh.lock().unwrap_or_else(|e| e.into_inner()).query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('productions','production_events')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if tables != 2 {
            return Err("productions tables missing".into());
        }
        Ok(json!({"nextEpisode": next, "stages": ap::STAGES.len(), "perDigits": per_ok, "perMisread": per_bad}))
    });
    step(&mut results, "content.modes_and_language", || {
        // v0.2.1: three modes, four output languages, requirements reach every AI step, custom script is verbatim
        use crate::autopilot as ap;
        use crate::content;
        let mut c = ap::AutoConfig { topic: "自我檢查".into(), mode: "guided".into(), language: "zh-CN".into(), must_avoid: "禁止詞甲".into(), chapters: vec!["第一章".into()], ..Default::default() };
        c.validate()?;
        if c.youtube || !content::cn_only(&c) {
            return Err("zh-CN only must not plan a zh-TW / YouTube render".into());
        }
        let b = content::brief_block(&c, "fix");
        if !b.contains("禁止詞甲") || !b.contains("指導模式") {
            return Err("brief missing from fix prompt".into());
        }
        let script = "## 開場\n第一句話。第二句話。";
        let (_, sc) = content::parse_script(script, false, &[]);
        let seq = content::script_to_seq("test001", "自我檢查", &sc);
        content::fidelity(script, &seq, false)?;
        Ok(json!({"modes": content::MODES, "languages": content::LANGS, "scriptLines": sc[0].1.len()}))
    });
    step(&mut results, "layout.and_envfix", || {
        // per-video folders and TEST numbering; venv diagnosis of this project's CosyVoice (read-only)
        let next_test = crate::layout::next_test(&project_root, &[]);
        let venv = project_root.join("tools").join("CosyVoice").join(".venv");
        let d = crate::envfix::diagnose(&venv);
        Ok(json!({"videoFolder": crate::layout::video_rel("ep07"), "nextTest": next_test, "venv": {"found": d.cfg_found, "homeExists": d.home_exists, "pythonOk": d.python_ok, "problem": d.problem}, "studioPackaged": d.studio_packaged}))
    });
    step(&mut results, "claude.detect", || Ok(claude::detect()));
    step(&mut results, "git.log", || Ok(json!(gitops::log(&project_root, 3)?)));
    step(&mut results, "doctor.instructions_only_for_system", || {
        for id in ["longpaths_instructions", "driver_instructions"] {
            if doctor::instructions(id).is_none() {
                return Err(id.into());
            }
        }
        Ok(json!("system fixes are instructions only"))
    });

    // Optional real headless Claude run in an isolated worktree (read-only tools, 3 turns), then discard.
    if args.iter().any(|a| a == "--claude-job") {
        step(&mut results, "claude.headless_worktree_run", || {
            claude::ensure_excluded(&project_root)?;
            let _ = db::settings_merge(&dbh.lock().unwrap_or_else(|e| e.into_inner()), &json!({"claudeMaxTurns": 4}));
            let wid = format!("st{}", &uuid::Uuid::new_v4().to_string()[..6]);
            let prompt = "Studio selftest. Read src/data/narration.json and answer in ONE line: how many scenes does sequence ep01 have? Do not edit any file.";
            let j = q.enqueue(Some(&project_id), "claude", &json!({"prompt": prompt, "allowEdits": false, "worktreeId": wid, "title": "selftest"}), &project_root)?;
            let t = Instant::now();
            loop {
                q.tick();
                let cur = db::job_get(&dbh.lock().unwrap_or_else(|e| e.into_inner()), &j.id)?;
                if ["succeeded", "failed", "canceled"].contains(&cur.status.as_str()) {
                    let ev = db::events_list(&dbh.lock().unwrap_or_else(|e| e.into_inner()), &j.id, 0, 100_000)?;
                    let lines: Vec<String> = ev.iter().map(|e| e.line.chars().take(300).collect()).collect();
                    let wts = claude::list(&project_root, |_| None);
                    let mine = wts.iter().find(|w| w["id"] == wid.as_str()).cloned();
                    let d = claude::discard(&project_root, &wid)?;
                    if cur.status != "succeeded" {
                        return Err(format!("{}: {lines:?}", cur.status));
                    }
                    return Ok(json!({"status": cur.status, "seconds": t.elapsed().as_secs(), "worktree": mine, "discarded": d["removed"], "log": lines}));
                }
                if t.elapsed() > Duration::from_secs(300) {
                    q.cancel(&j.id)?;
                    let _ = claude::discard(&project_root, &wid);
                    return Err("timeout".into());
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        });
    }

    // Optional real GPU job through the queue (only when asked, and only if the GPU lock grants it).
    if args.iter().any(|a| a == "--gpu-job") {
        let out_name = "STUDIO_GPU_SELFTEST.mp4";
        step(&mut results, "queue.gpu_job_real_render", || {
            let j = q.enqueue(Some(&project_id), "render", &json!({"comp": "ArtTest", "mode": "gpu", "out": out_name, "frames": "0-59"}), &project_root)?;
            let t = Instant::now();
            let mut seen_progress = vec![];
            loop {
                q.tick();
                q.heartbeat();
                let cur = db::job_get(&dbh.lock().unwrap_or_else(|e| e.into_inner()), &j.id)?;
                if cur.status == "waiting_resource" && t.elapsed() > Duration::from_secs(20) {
                    q.cancel(&j.id)?;
                    return Err(format!("GPU lock not granted: {}", cur.wait_reason.unwrap_or_default()));
                }
                if let Some(pt) = &cur.progress_text {
                    let s = format!("{:.2} {pt}", cur.progress);
                    if seen_progress.last() != Some(&s) {
                        seen_progress.push(s);
                    }
                }
                if ["succeeded", "failed", "canceled"].contains(&cur.status.as_str()) {
                    let ev = db::events_list(&dbh.lock().unwrap_or_else(|e| e.into_inner()), &j.id, 0, 100_000)?;
                    let tail: Vec<String> = ev.iter().rev().take(12).rev().map(|e| format!("[{}] {}", e.stream, e.line)).collect();
                    let out_path = project_root.join(out_name);
                    let probe = project::ffprobe(&out_path);
                    let _ = std::fs::remove_file(&out_path);
                    if cur.status != "succeeded" {
                        return Err(format!("{} exit {:?}: {tail:?}", cur.status, cur.exit_code));
                    }
                    return Ok(json!({"status": cur.status, "seconds": t.elapsed().as_secs(), "progress": seen_progress, "probe": probe, "logTail": tail}));
                }
                if t.elapsed() > Duration::from_secs(900) {
                    q.cancel(&j.id)?;
                    return Err("timeout".into());
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        });
    }

    let passed = results.iter().filter(|r| r["ok"] == true).count();
    let total = results.len();
    let report = json!({"selftest": "pikara-science-studio", "version": env!("CARGO_PKG_VERSION"), "project": project_root, "passed": passed, "total": total, "results": results});
    let text = serde_json::to_string_pretty(&report).unwrap();
    if let Some(f) = out_file {
        let _ = std::fs::write(&f, &text);
    }
    println!("{text}");
    let _ = std::fs::remove_dir_all(&data);
    if passed == total { 0 } else { 1 }
}
