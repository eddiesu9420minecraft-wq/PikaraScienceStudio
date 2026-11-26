//! Background-thread health: heartbeats, panic-safe loops and a stall watchdog.
//!
//! Why (2026-11-23 incident): after two GPU driver resets (Windows LiveKernelEvent 141/117 at 20:17–20:18) Studio's
//! monitor stopped writing metrics 9 s later and nothing ran from the queue for 106 minutes, until Studio was restarted;
//! the EP13 voice-over looked "stuck for hours" although it had never started. A background thread that panics dies
//! silently (the window stays open), and one blocked in an external call (nvidia-smi / taskkill during a driver
//! reset) freezes the scheduler forever. Every long-lived thread now:
//!   * runs its body through [`run_loop`] — a panic is caught, logged and the loop continues;
//!   * reports a heartbeat + what it is doing via [`beat`];
//! and the watchdog thread writes `logs/studio-watchdog.log` (plain file — the DB may be the thing that is stuck)
//! when a heartbeat is older than [`STALL_SECS`], so the next incident leaves evidence of *which* call blocked.

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;
use std::time::Duration;

/// A loop that has not reported for this long is considered stalled (loops tick every 1–2 s; the slowest legit step
/// is a bounded external call of ≤ 30 s).
pub const STALL_SECS: i64 = 120;

#[derive(Clone, Debug)]
struct Beat {
    at_ms: i64,
    doing: String,
    panics: u32,
    last_panic: Option<String>,
}

static BEATS: Lazy<Mutex<HashMap<&'static str, Beat>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn now() -> i64 {
    crate::util::now_ms()
}

fn beats() -> std::sync::MutexGuard<'static, HashMap<&'static str, Beat>> {
    BEATS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Record that thread `name` is alive and about to do `doing`.
pub fn beat(name: &'static str, doing: &str) {
    let mut b = beats();
    let e = b.entry(name).or_insert(Beat { at_ms: 0, doing: String::new(), panics: 0, last_panic: None });
    e.at_ms = now();
    if e.doing != doing {
        e.doing = doing.to_string();
    }
}

fn panic_text(p: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".into()
    }
}

/// Run one iteration of a long-lived loop; a panic is caught and logged instead of killing the thread.
/// Returns false if the body panicked.
pub fn run_loop(name: &'static str, body: impl FnOnce()) -> bool {
    beat(name, "tick");
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(()) => {
            beat(name, "idle");
            true
        }
        Err(p) => {
            let msg = panic_text(&*p);
            {
                let mut b = beats();
                if let Some(e) = b.get_mut(name) {
                    e.panics += 1;
                    e.last_panic = Some(msg.clone());
                    e.at_ms = now();
                }
            }
            log_line(&format!("PANIC in {name}: {msg} — thread keeps running"));
            // don't spin if the panic repeats every iteration
            std::thread::sleep(Duration::from_secs(2));
            false
        }
    }
}

/// Snapshot for the UI / CLI: `{name: {ageSec, doing, panics, lastPanic, stalled}}`.
pub fn status() -> Value {
    let t = now();
    let b = beats();
    let mut m = serde_json::Map::new();
    for (k, v) in b.iter() {
        let age = (t - v.at_ms) / 1000;
        m.insert(
            (*k).to_string(),
            json!({"ageSec": age, "doing": v.doing, "panics": v.panics, "lastPanic": v.last_panic, "stalled": age > STALL_SECS}),
        );
    }
    Value::Object(m)
}

/// Names of loops whose heartbeat is older than `secs`, with what they were doing.
pub fn stalled(secs: i64) -> Vec<(String, i64, String)> {
    let t = now();
    beats().iter().filter(|(_, v)| t - v.at_ms > secs * 1000).map(|(k, v)| (k.to_string(), (t - v.at_ms) / 1000, v.doing.clone())).collect()
}

pub fn log_line(line: &str) {
    let dir = crate::util::data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("studio-watchdog.log")) {
        let _ = writeln!(f, "{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), line);
    }
    eprintln!("[watchdog] {line}");
}

/// Watchdog thread: every 30 s, log loops that stopped reporting (once per stall, and again when they recover).
pub fn spawn() {
    let _ = std::thread::Builder::new().name("studio-watchdog".into()).spawn(|| {
        let mut reported: HashMap<String, bool> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_secs(30));
            let st = stalled(STALL_SECS);
            for (name, age, doing) in &st {
                if !reported.get(name).copied().unwrap_or(false) {
                    log_line(&format!("STALL {name}: no heartbeat for {age}s, last doing「{doing}」"));
                    reported.insert(name.clone(), true);
                }
            }
            for (name, was) in reported.iter_mut() {
                if *was && !st.iter().any(|s| &s.0 == name) {
                    log_line(&format!("RECOVERED {name}"));
                    *was = false;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_in_loop_is_caught_and_counted() {
        let ok = run_loop("test-panicker", || panic!("boom"));
        assert!(!ok);
        let s = status();
        assert_eq!(s["test-panicker"]["panics"], 1);
        assert_eq!(s["test-panicker"]["lastPanic"], "boom");
        assert!(run_loop("test-panicker", || {}), "next iteration runs normally");
    }

    #[test]
    fn stale_heartbeat_is_reported() {
        beat("test-stuck", "nvidia-smi");
        beats().get_mut("test-stuck").unwrap().at_ms -= 200_000;
        let st = stalled(STALL_SECS);
        let hit = st.iter().find(|s| s.0 == "test-stuck").expect("stalled");
        assert!(hit.1 >= 200);
        assert_eq!(hit.2, "nvidia-smi");
        beat("test-stuck", "ok");
        assert!(!stalled(STALL_SECS).iter().any(|s| s.0 == "test-stuck"));
    }
}
