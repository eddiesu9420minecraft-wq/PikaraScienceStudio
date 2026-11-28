//! ProcessManagerBackend: start / kill / pause / resume whole process trees on every platform.
//!
//! A pipeline step is a tree (render.mjs → node → chrome-headless-shell ×N → GPU process; python → torch workers;
//! ffmpeg). Everything here acts on the whole tree, never only on the direct child.
//!
//! * Windows: `taskkill /T /F` (unchanged since v0.1), pause = `NtSuspendProcess` on every process in the tree.
//! * Unix: children are started as their own process group (`process_group(0)`), so a kill reaches grandchildren
//!   that were re-parented; descendants found via sysinfo are signalled too (a child may start its own group, e.g.
//!   Chromium's zygote). Pause = SIGSTOP, resume = SIGCONT.
//!
//! Pausing never deletes or rewrites anything: the processes keep their memory (models stay resident, VRAM /
//! unified memory stays allocated) and continue exactly where they stopped.

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::time::Duration;

/// Prepare a Command for a background pipeline process: no console window on Windows, its own process group on Unix.
pub fn configure(c: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(crate::CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
}

/// `root` and every descendant (depth-first order, root first), from a fresh process table.
pub fn tree(root: u32) -> Vec<u32> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, p) in sys.processes() {
        if let Some(pp) = p.parent() {
            children.entry(pp.as_u32()).or_default().push(pid.as_u32());
        }
    }
    let mut out = vec![];
    let mut seen = HashSet::new();
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if !seen.insert(p) {
            continue;
        }
        out.push(p);
        if let Some(c) = children.get(&p) {
            stack.extend(c.iter().copied());
        }
    }
    out
}

/// Kill a whole process tree. Bounded (15 s): must never block the scheduler or a cancel forever — e.g. when the
/// target is stuck inside a GPU driver call during a driver reset. Returns a human-readable report.
pub fn kill_tree(pid: u32) -> String {
    #[cfg(windows)]
    {
        use std::process::Stdio;
        let mut c = Command::new("taskkill");
        configure(&mut c);
        c.stdin(Stdio::null());
        c.args(["/T", "/F", "/PID", &pid.to_string()]).stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = match c.spawn() {
            Ok(ch) => ch,
            Err(e) => return format!("cannot start taskkill: {e}"),
        };
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(o)) => {
                let mut s = String::from_utf8_lossy(&o.stdout).into_owned();
                s.push_str(&String::from_utf8_lossy(&o.stderr));
                s
            }
            Ok(Err(e)) => e.to_string(),
            Err(_) => format!("taskkill /T /F /PID {pid} did not finish within 15 s"),
        }
    }
    #[cfg(unix)]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let members = tree(pid);
            // stop first so nothing forks while we walk the tree, then kill group + every member
            let n = signal_all(&members, "STOP");
            let _ = Command::new("kill").args(["-KILL", "--", &format!("-{pid}")]).stderr(std::process::Stdio::null()).status();
            let k = signal_all(&members, "KILL");
            let _ = tx.send(format!("killed process group {pid} and {k}/{} tree members (stopped {n})", members.len()));
        });
        rx.recv_timeout(Duration::from_secs(15)).unwrap_or_else(|_| format!("kill of process tree {pid} did not finish within 15 s"))
    }
}

#[cfg(unix)]
fn signal_all(pids: &[u32], sig: &str) -> usize {
    use sysinfo::{Pid, ProcessesToUpdate, Signal, System};
    let s = match sig {
        "STOP" => Signal::Stop,
        "CONT" => Signal::Continue,
        _ => Signal::Kill,
    };
    let mut sys = System::new();
    let list: Vec<Pid> = pids.iter().map(|p| Pid::from_u32(*p)).collect();
    sys.refresh_processes(ProcessesToUpdate::Some(&list), true);
    pids.iter().filter(|p| sys.process(Pid::from_u32(**p)).and_then(|pr| pr.kill_with(s)).unwrap_or(false)).count()
}

#[cfg(windows)]
mod win {
    #[link(name = "ntdll")]
    extern "system" {
        fn NtSuspendProcess(h: isize) -> i32;
        fn NtResumeProcess(h: isize) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn CloseHandle(h: isize) -> i32;
    }
    const PROCESS_SUSPEND_RESUME: u32 = 0x0800;

    pub fn apply(pid: u32, suspend: bool) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
            if h == 0 {
                return false;
            }
            let r = if suspend { NtSuspendProcess(h) } else { NtResumeProcess(h) };
            CloseHandle(h);
            r >= 0
        }
    }
}

/// Pause a whole process tree. Returns how many processes were paused (0 = nothing found / not permitted).
pub fn suspend_tree(pid: u32) -> usize {
    let members = tree(pid);
    #[cfg(windows)]
    {
        members.iter().filter(|p| win::apply(**p, true)).count()
    }
    #[cfg(unix)]
    {
        // the whole process group (children started by configure()), then every descendant found in the table
        let _ = Command::new("kill").args(["-STOP", "--", &format!("-{pid}")]).stderr(std::process::Stdio::null()).status();
        signal_all(&members, "STOP")
    }
}

/// Resume a paused tree. Children first is not required (resume order does not matter for SIGCONT / NtResume),
/// but the root is resumed last so it never sees a still-stopped child as "hung".
pub fn resume_tree(pid: u32) -> usize {
    let mut members = tree(pid);
    members.reverse();
    #[cfg(windows)]
    {
        members.iter().filter(|p| win::apply(**p, false)).count()
    }
    #[cfg(unix)]
    {
        let n = signal_all(&members, "CONT");
        let _ = Command::new("kill").args(["-CONT", "--", &format!("-{pid}")]).stderr(std::process::Stdio::null()).status();
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::process::Stdio;

    /// A child that prints a counter every 100 ms: paused → the counter stops; resumed → it continues; killed → gone.
    #[test]
    fn pause_resume_and_kill_a_real_tree() {
        let mut c = if cfg!(windows) {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-Command", "$i=0; while($true){ $i++; [Console]::Out.WriteLine($i); [Console]::Out.Flush(); Start-Sleep -Milliseconds 100 }"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "i=0; while true; do i=$((i+1)); echo $i; sleep 0.1; done"]);
            c
        };
        configure(&mut c);
        c.stdout(Stdio::piped()).stdin(Stdio::null());
        let mut child = c.spawn().unwrap();
        let pid = child.id();
        let mut out = child.stdout.take().unwrap();
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let b2 = buf.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 256];
            while let Ok(n) = out.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                b2.lock().unwrap().extend_from_slice(&chunk[..n]);
            }
        });
        let lines = || String::from_utf8_lossy(&buf.lock().unwrap()).lines().count();
        std::thread::sleep(Duration::from_millis(2500));
        assert!(lines() > 3, "child is producing output");
        assert!(suspend_tree(pid) >= 1, "paused at least the root");
        std::thread::sleep(Duration::from_millis(500)); // let in-flight output drain
        let at_pause = lines();
        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(lines(), at_pause, "no output while paused");
        assert!(resume_tree(pid) >= 1);
        std::thread::sleep(Duration::from_millis(1200));
        assert!(lines() > at_pause + 3, "output continues after resume");
        kill_tree(pid);
        let t0 = std::time::Instant::now();
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(t0.elapsed() < Duration::from_secs(10), "child must exit after kill_tree");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
