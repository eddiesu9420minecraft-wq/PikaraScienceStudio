//! Inactivity detection shared by the job queue (kill a step that has gone silent) and the autopilot (show the
//! last activity, detect a production that looks busy but has stopped working).
//!
//! "Activity" is either output from the process (stdout / stderr, AI tool calls) or a file changing in its working
//! folder: an AI agent can run a long, quiet command that still writes files, and must not be killed for it.

use std::path::Path;
use std::time::{Duration, SystemTime};

/// Folders never scanned for file activity (large, or changed by things other than the step itself).
const SKIP_DIRS: [&str; 6] = ["node_modules", ".git", ".studio", "target", "dist", "__pycache__"];

/// Newest modification time of any file under `dir` (skipping [`SKIP_DIRS`]), looking at no more than
/// `max_entries` entries so a huge folder cannot make the check slow. `None` when nothing could be read.
pub fn newest_mtime(dir: &Path, max_entries: usize) -> Option<SystemTime> {
    let mut stack = vec![dir.to_path_buf()];
    let mut seen = 0usize;
    let mut newest: Option<SystemTime> = None;
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > max_entries {
                return newest;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                let n = e.file_name();
                let n = n.to_string_lossy();
                if !SKIP_DIRS.contains(&n.as_ref()) {
                    stack.push(e.path());
                }
            } else if ft.is_file() {
                if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
                    if newest.map_or(true, |n| m > n) {
                        newest = Some(m);
                    }
                }
            }
        }
    }
    newest
}

/// Seconds since the newest file change under `dir` (`None` when nothing could be read).
pub fn files_quiet_secs(dir: &Path) -> Option<u64> {
    newest_mtime(dir, 20_000).map(|t| SystemTime::now().duration_since(t).unwrap_or(Duration::ZERO).as_secs())
}

/// How a running step looks from the outside, given seconds without output and without file changes.
/// `active`: something happened in the last 2 minutes. `quiet`: nothing for a while (an AI thinking about a long
/// file, a slow command). `suspect`: quiet for half the limit. `stalled`: past the limit, will be (or was) stopped.
pub fn state(output_quiet: u64, files_quiet: Option<u64>, limit: u64) -> &'static str {
    let quiet = files_quiet.map_or(output_quiet, |f| output_quiet.min(f));
    if quiet < 120 {
        "active"
    } else if limit == 0 || quiet < limit / 2 {
        "quiet"
    } else if quiet < limit {
        "suspect"
    } else {
        "stalled"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_mtime_skips_heavy_dirs_and_finds_recent_files() {
        let d = std::env::temp_dir().join(format!("pikara-activity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("src/acts")).unwrap();
        std::fs::create_dir_all(d.join("node_modules/x")).unwrap();
        std::fs::write(d.join("src/acts/S01.tsx"), "a").unwrap();
        let t1 = newest_mtime(&d, 1000).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        // a change inside node_modules is not activity of the step
        std::fs::write(d.join("node_modules/x/i.js"), "b").unwrap();
        assert_eq!(newest_mtime(&d, 1000).unwrap(), t1);
        std::thread::sleep(Duration::from_millis(30));
        std::fs::write(d.join("src/acts/S02.tsx"), "c").unwrap();
        assert!(newest_mtime(&d, 1000).unwrap() > t1);
        assert!(files_quiet_secs(&d).unwrap() < 5);
        assert!(newest_mtime(&d.join("missing"), 1000).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn state_uses_the_most_recent_of_output_and_files() {
        assert_eq!(state(10, None, 1200), "active");
        assert_eq!(state(300, None, 1200), "quiet");
        assert_eq!(state(700, None, 1200), "suspect");
        assert_eq!(state(1300, None, 1200), "stalled");
        // silent output but files still changing → still working
        assert_eq!(state(5000, Some(30), 1200), "active");
        assert_eq!(state(5000, Some(1500), 1200), "stalled");
        // no limit configured: never reported as stalled
        assert_eq!(state(99_999, None, 0), "quiet");
    }
}
