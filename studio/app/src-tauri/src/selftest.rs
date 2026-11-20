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
        let c = dbh.lock().unwrap();
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
        drop(dbh.lock().unwrap());
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
            let cur = db::job_get(&dbh.lock().unwrap(), &j.id)?;
            if cur.status == "succeeded" || cur.status == "failed" {
                let ev = db::events_list(&dbh.lock().unwrap(), &j.id, 0, 100)?;
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
        let cur = db::job_get(&dbh.lock().unwrap(), &j.id)?;
        q.force_external_busy.store(false, std::sync::atomic::Ordering::Relaxed);
        q.cancel(&j.id)?;
        if cur.status != "waiting_resource" {
            return Err(format!("GPU job was not held back: {}", cur.status));
        }
        Ok(json!({"realExternal": e, "heldStatus": cur.status, "waitReason": cur.wait_reason}))
    });

    step(&mut results, "queue.recovery", || {
        let c = dbh.lock().unwrap();
        let j = db::job_insert(&c, Some(&project_id), "qa", "stale", &json!({}), "cpu", &["qa".into()])?;
        db::job_mark_started(&c, &j.id, "x")?;
        c.execute("UPDATE jobs SET heartbeat_ms=heartbeat_ms-60000 WHERE id=?1", [&j.id]).map_err(|e| e.to_string())?;
        drop(c);
        let ids = q.recover();
        let after = db::job_get(&dbh.lock().unwrap(), &j.id)?;
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
        let md = project::publish_metadata(&project_root);
        Ok(json!({"files": o.len(), "mp4": probed, "publishSections": md["sections"].as_array().map(|a| a.len())}))
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
            let _ = db::settings_merge(&dbh.lock().unwrap(), &json!({"claudeMaxTurns": 4}));
            let wid = format!("st{}", &uuid::Uuid::new_v4().to_string()[..6]);
            let prompt = "Studio selftest. Read src/data/narration.json and answer in ONE line: how many scenes does sequence ep01 have? Do not edit any file.";
            let j = q.enqueue(Some(&project_id), "claude", &json!({"prompt": prompt, "allowEdits": false, "worktreeId": wid, "title": "selftest"}), &project_root)?;
            let t = Instant::now();
            loop {
                q.tick();
                let cur = db::job_get(&dbh.lock().unwrap(), &j.id)?;
                if ["succeeded", "failed", "canceled"].contains(&cur.status.as_str()) {
                    let ev = db::events_list(&dbh.lock().unwrap(), &j.id, 0, 100_000)?;
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
                let cur = db::job_get(&dbh.lock().unwrap(), &j.id)?;
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
                    let ev = db::events_list(&dbh.lock().unwrap(), &j.id, 0, 100_000)?;
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
