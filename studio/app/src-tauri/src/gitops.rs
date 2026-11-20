//! Git via the system `git` CLI (no libgit2 → no GPL linking questions).

use crate::util::{now_iso, run_env, RunOut};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

const ID_ENV: &[(&str, &str)] = &[
    ("GIT_AUTHOR_NAME", "Pikara Studio"),
    ("GIT_AUTHOR_EMAIL", "studio@pikara.local"),
    ("GIT_COMMITTER_NAME", "Pikara Studio"),
    ("GIT_COMMITTER_EMAIL", "studio@pikara.local"),
];

pub fn git(root: &Path, args: &[&str]) -> Result<RunOut, String> {
    // -c core.quotepath=off keeps Chinese file names readable in porcelain output.
    let mut a: Vec<&str> = vec!["-c", "core.quotepath=off"];
    a.extend_from_slice(args);
    run_env("git", &a, Some(root), &[("GIT_TERMINAL_PROMPT", "0")], Duration::from_secs(120))
}

/// Commit using the user's identity if configured, otherwise a Studio identity.
pub fn git_commit(root: &Path, args: &[&str]) -> Result<RunOut, String> {
    let has_user = git(root, &["config", "user.email"]).map(|o| o.ok() && !o.stdout.trim().is_empty()).unwrap_or(false);
    let mut a: Vec<&str> = vec!["-c", "core.quotepath=off"];
    a.extend_from_slice(args);
    let env: &[(&str, &str)] = if has_user { &[] } else { ID_ENV };
    run_env("git", &a, Some(root), env, Duration::from_secs(120))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub head_subject: Option<String>,
    pub dirty: Vec<Value>,
}

pub fn status(root: &Path) -> GitStatus {
    let inside = git(root, &["rev-parse", "--is-inside-work-tree"]).map(|o| o.ok() && o.stdout.trim() == "true").unwrap_or(false);
    if !inside {
        return GitStatus { is_repo: false, branch: None, head: None, head_subject: None, dirty: vec![] };
    }
    let branch = git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().filter(|o| o.ok()).map(|o| o.stdout.trim().to_string());
    let head = git(root, &["rev-parse", "HEAD"]).ok().filter(|o| o.ok()).map(|o| o.stdout.trim().to_string());
    let subj = git(root, &["log", "-1", "--format=%s"]).ok().filter(|o| o.ok()).map(|o| o.stdout.trim().to_string());
    let dirty = git(root, &["status", "--porcelain=v1", "-uall"])
        .map(|o| parse_porcelain(&o.stdout))
        .unwrap_or_default();
    GitStatus { is_repo: true, branch, head, head_subject: subj, dirty }
}

pub fn parse_porcelain(s: &str) -> Vec<Value> {
    s.lines()
        .filter(|l| l.len() > 3)
        .map(|l| json!({"code": &l[..2], "path": l[3..].trim_matches('"')}))
        .collect()
}

pub fn log(root: &Path, limit: usize) -> Result<Vec<Value>, String> {
    let n = format!("-n{}", limit.clamp(1, 500));
    let o = git(root, &["log", &n, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI"])?;
    if !o.ok() {
        return Err(o.combined());
    }
    Ok(o.stdout
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            (f.len() == 5).then(|| json!({"hash": f[0], "short": f[1], "subject": f[2], "author": f[3], "date": f[4]}))
        })
        .collect())
}

fn valid_rev(c: &str) -> Result<(), String> {
    if c.len() < 4 || c.len() > 64 || !c.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(format!("not a commit hash: {c}"));
    }
    Ok(())
}

pub fn valid_branch(b: &str) -> Result<(), String> {
    let ok = !b.is_empty()
        && b.len() < 120
        && !b.starts_with('-')
        && !b.contains("..")
        && b.chars().all(|c| c.is_ascii_alphanumeric() || "/-_.".contains(c));
    if ok { Ok(()) } else { Err(format!("invalid branch name: {b}")) }
}

pub fn revert(root: &Path, commit: &str) -> Result<Value, String> {
    valid_rev(commit)?;
    let o = git_commit(root, &["revert", "--no-edit", commit])?;
    if !o.ok() {
        // leave the tree clean if the revert stopped on conflicts
        let _ = git(root, &["revert", "--abort"]);
    }
    Ok(json!({"ok": o.ok(), "output": o.combined()}))
}

pub fn branch_from(root: &Path, commit: &str, branch: &str) -> Result<Value, String> {
    valid_rev(commit)?;
    valid_branch(branch)?;
    let o = git(root, &["branch", branch, commit])?;
    Ok(json!({"ok": o.ok(), "output": o.combined()}))
}

pub fn reset_hard(root: &Path, commit: &str, confirm: &str) -> Result<Value, String> {
    valid_rev(commit)?;
    let expect = format!("RESET {}", &commit[..7.min(commit.len())]);
    if confirm != expect {
        return Err(format!("confirmation mismatch: type exactly \"{expect}\""));
    }
    let backup = format!("studio/backup-{}", now_iso().replace([':', '.'], "-"));
    let b = git(root, &["branch", &backup, "HEAD"])?;
    if !b.ok() {
        return Err(format!("could not create backup branch: {}", b.combined()));
    }
    let o = git(root, &["reset", "--hard", commit])?;
    Ok(json!({"ok": o.ok(), "output": format!("backup branch {backup}\n{}", o.combined())}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_and_validation() {
        let v = parse_porcelain(" M scripts/qa_video.py\n?? NIGHT_REPORT.md\n");
        assert_eq!(v.len(), 2);
        assert_eq!(v[0]["code"], " M");
        assert_eq!(v[1]["path"], "NIGHT_REPORT.md");
        assert!(valid_rev("fe17a04").is_ok());
        assert!(valid_rev("HEAD~1; rm").is_err());
        assert!(valid_branch("studio/restore-fe17a04").is_ok());
        assert!(valid_branch("--force").is_err());
    }

    #[test]
    fn reset_requires_exact_confirmation() {
        let r = reset_hard(Path::new("."), "fe17a04abc", "yes");
        assert!(r.unwrap_err().contains("RESET fe17a04"));
    }

    #[test]
    fn revert_and_log_in_temp_repo() {
        let d = std::env::temp_dir().join(format!("pss-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        git(&d, &["init", "-q"]).unwrap();
        std::fs::write(d.join("a.txt"), "1").unwrap();
        git(&d, &["add", "a.txt"]).unwrap();
        assert!(git_commit(&d, &["commit", "-qm", "one"]).unwrap().ok());
        std::fs::write(d.join("a.txt"), "2").unwrap();
        git(&d, &["add", "a.txt"]).unwrap();
        assert!(git_commit(&d, &["commit", "-qm", "two"]).unwrap().ok());
        let l = log(&d, 10).unwrap();
        assert_eq!(l.len(), 2);
        let head = l[0]["hash"].as_str().unwrap().to_string();
        let r = revert(&d, &head).unwrap();
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "1");
        assert_eq!(log(&d, 10).unwrap().len(), 3);
        assert!(status(&d).is_repo);
        let _ = std::fs::remove_dir_all(&d);
    }
}
