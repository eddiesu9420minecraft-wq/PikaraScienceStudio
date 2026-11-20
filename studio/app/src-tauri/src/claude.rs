//! Claude Code CLI integration: detection, project Skill install, isolated git worktrees.
//! Studio never merges automatically — merge/discard are explicit user commands.

use crate::gitops::{self, git};
use crate::jobs::worktree_dir;
use crate::util::{clean_path, run, which};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub fn claude_path() -> Option<String> {
    if let Some(p) = which("claude") {
        return Some(p);
    }
    // common install locations (native installer, npm global)
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    for c in [
        format!(r"{home}\.local\bin\claude.exe"),
        format!(r"{appdata}\npm\claude.cmd"),
        format!(r"{appdata}\npm\claude"),
    ] {
        if Path::new(&c).exists() {
            return Some(c);
        }
    }
    None
}

pub fn detect() -> Value {
    match claude_path() {
        Some(p) => {
            let v = run(&p, &["--version"], None, Duration::from_secs(20)).ok().filter(|o| o.ok()).map(|o| o.stdout.trim().to_string());
            json!({"found": true, "path": p, "version": v})
        }
        None => json!({"found": false, "path": null, "version": null}),
    }
}

pub const SKILL_REL: &str = r".claude\skills\pikara-video\SKILL.md";

pub fn skill_text() -> &'static str {
    include_str!("../resources/pikara-video-SKILL.md")
}

pub fn install_skill(root: &Path, overwrite: bool) -> Result<Value, String> {
    let p = root.join(SKILL_REL);
    let existed = p.exists();
    if existed && !overwrite {
        return Ok(json!({"path": clean_path(&p), "written": false, "existed": true}));
    }
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    crate::util::atomic_write(&p, skill_text().as_bytes())?;
    Ok(json!({"path": clean_path(&p), "written": true, "existed": existed}))
}

/// Make sure .studio/ never shows up as untracked in the user's repo (uses .git/info/exclude, not .gitignore).
pub fn ensure_excluded(root: &Path) -> Result<(), String> {
    let o = git(root, &["rev-parse", "--git-path", "info/exclude"])?;
    if !o.ok() {
        return Err(format!("not a git repository: {}", o.combined()));
    }
    let rel = o.stdout.trim();
    let p = if Path::new(rel).is_absolute() { PathBuf::from(rel) } else { root.join(rel) };
    let cur = std::fs::read_to_string(&p).unwrap_or_default();
    if !cur.lines().any(|l| l.trim() == ".studio/") {
        std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut s = cur;
        if !s.is_empty() && !s.ends_with('\n') {
            s.push('\n');
        }
        s.push_str("# Pikara Studio worktrees\n.studio/\n");
        std::fs::write(&p, s).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn valid_wid(w: &str) -> Result<(), String> {
    if w.is_empty() || w.len() > 64 || !w.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("invalid worktree id {w}"));
    }
    Ok(())
}

pub fn branch_of(wid: &str) -> String {
    format!("studio/claude/{wid}")
}

fn branch_exists(root: &Path, br: &str) -> bool {
    git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{br}")]).map(|o| o.ok()).unwrap_or(false)
}

/// The revision to diff/merge for a worktree: its branch, or — if the branch is gone — the worktree's own HEAD.
/// None = orphan (no branch, no valid worktree): the only sensible action is discard.
pub fn resolve_ref(root: &Path, wid: &str) -> Option<String> {
    let br = branch_of(wid);
    if branch_exists(root, &br) {
        return Some(br);
    }
    let p = worktree_dir(root, wid);
    if p.join(".git").exists() {
        let o = git(&p, &["rev-parse", "HEAD"]).ok()?;
        if o.ok() {
            return Some(o.stdout.trim().to_string());
        }
    }
    None
}

fn orphan_err(wid: &str) -> String {
    format!("工作樹 {wid} 已沒有分支 studio/claude/{wid}，也不是有效的 git worktree（孤兒）。請按「捨棄」清除。")
}

pub fn list(root: &Path, job_for: impl Fn(&str) -> Option<String>) -> Vec<Value> {
    let mut out = vec![];
    let dir = root.join(".studio").join("worktrees");
    let mut ids: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    // also branches whose folder was removed by hand
    if let Ok(o) = git(root, &["branch", "--list", "studio/claude/*", "--format=%(refname:short)"]) {
        for b in o.stdout.lines() {
            if let Some(id) = b.trim().strip_prefix("studio/claude/") {
                if !ids.iter().any(|x| x == id) {
                    ids.push(id.to_string());
                }
            }
        }
    }
    for id in ids {
        let br_name = branch_of(&id);
        let resolved = resolve_ref(root, &id);
        let br = resolved.clone().unwrap_or_else(|| br_name.clone());
        let ahead = git(root, &["rev-list", "--count", &format!("HEAD..{br}")])
            .ok()
            .filter(|o| o.ok())
            .and_then(|o| o.stdout.trim().parse::<i64>().ok())
            .unwrap_or(0);
        let changed = git(root, &["diff", "--name-only", &format!("HEAD...{br}")])
            .ok()
            .filter(|o| o.ok())
            .map(|o| o.stdout.lines().filter(|l| !l.trim().is_empty()).count())
            .unwrap_or(0);
        let p = worktree_dir(root, &id);
        out.push(json!({
            "id": id, "path": clean_path(&p), "branch": br_name, "jobId": job_for(&id),
            "exists": p.exists(), "commitsAhead": if resolved.is_some() { ahead } else { 0 },
            "changedFiles": if resolved.is_some() { changed } else { 0 },
            "branchExists": branch_exists(root, &br_name), "orphan": resolved.is_none()
        }));
    }
    out
}

pub fn diff(root: &Path, wid: &str) -> Result<Value, String> {
    valid_wid(wid)?;
    let br = resolve_ref(root, wid).ok_or_else(|| orphan_err(wid))?;
    let range = format!("HEAD...{br}");
    let stat = git(root, &["diff", "--stat", &range])?;
    if !stat.ok() {
        return Err(stat.combined());
    }
    let d = git(root, &["diff", &range])?;
    let commits = git(root, &["log", "--format=%h %s", &format!("HEAD..{br}")])?;
    let mut diff_text = d.stdout;
    if diff_text.len() > 2_000_000 {
        diff_text.truncate(2_000_000);
        diff_text.push_str("\n… (diff truncated)");
    }
    Ok(json!({"stat": stat.stdout, "diff": diff_text, "commits": commits.stdout.lines().collect::<Vec<_>>()}))
}

pub fn merge(root: &Path, wid: &str) -> Result<Value, String> {
    valid_wid(wid)?;
    let br = resolve_ref(root, wid).ok_or_else(|| orphan_err(wid))?;
    let o = gitops::git_commit(root, &["merge", "--no-ff", "--no-edit", &br])?;
    if !o.ok() {
        let _ = git(root, &["merge", "--abort"]);
    }
    Ok(json!({"merged": o.ok(), "output": o.combined()}))
}

pub fn discard(root: &Path, wid: &str) -> Result<Value, String> {
    valid_wid(wid)?;
    let p = worktree_dir(root, wid);
    let mut out = String::new();
    if p.exists() {
        let o = git(root, &["worktree", "remove", "--force", &p.to_string_lossy()])?;
        out.push_str(&o.combined());
    }
    if p.exists() {
        // not a registered worktree (or remove left files behind): delete the leftover folder
        std::fs::remove_dir_all(&p).map_err(|e| format!("無法刪除 {}：{e}", p.display()))?;
        out.push_str("removed leftover folder
");
    }
    let _ = git(root, &["worktree", "prune"]);
    let br = branch_of(wid);
    if branch_exists(root, &br) {
        let b = git(root, &["branch", "-D", &br])?;
        out.push_str(&b.combined());
    }
    Ok(json!({"removed": !p.exists(), "output": out}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_is_real_content() {
        let s = skill_text();
        assert!(s.starts_with("---\nname: pikara-video"));
        assert!(s.contains("scripts/render.mjs"));
        assert!(s.contains("narration.json"));
    }

    #[test]
    fn worktree_lifecycle_merge_and_discard() {
        let d = std::env::temp_dir().join(format!("pss-wt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        git(&d, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(d.join("a.txt"), "1\n").unwrap();
        git(&d, &["add", "."]).unwrap();
        gitops::git_commit(&d, &["commit", "-qm", "init"]).unwrap();
        ensure_excluded(&d).unwrap();
        for (wid, keep) in [("w1", true), ("w2", false)] {
            let p = worktree_dir(&d, wid);
            assert!(git(&d, &["worktree", "add", &p.to_string_lossy(), "-b", &branch_of(wid), "HEAD"]).unwrap().ok());
            std::fs::write(p.join("a.txt"), format!("{wid}\n")).unwrap();
            git(&p, &["add", "-A"]).unwrap();
            assert!(gitops::git_commit(&p, &["commit", "-qm", wid]).unwrap().ok());
            if keep {
                let l = list(&d, |_| None);
                let w = l.iter().find(|x| x["id"] == wid).unwrap();
                assert_eq!(w["commitsAhead"], 1);
                assert_eq!(w["changedFiles"], 1);
                let df = diff(&d, wid).unwrap();
                assert!(df["diff"].as_str().unwrap().contains("+w1"));
                let m = merge(&d, wid).unwrap();
                assert_eq!(m["merged"], true, "{m}");
                assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap().trim(), "w1");
            }
        }
        // main tree must not see .studio as untracked
        let st = gitops::status(&d);
        assert!(st.dirty.is_empty(), "{:?}", st.dirty);
        let r = discard(&d, "w2").unwrap();
        assert_eq!(r["removed"], true);
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap().trim(), "w1", "discard must not touch main");
        assert!(diff(&d, "../x").is_err());
        // orphan: folder without branch / worktree registration → listed as orphan, diff errors gracefully, discard cleans it
        std::fs::create_dir_all(worktree_dir(&d, "orph1")).unwrap();
        let l = list(&d, |_| None);
        assert_eq!(l.iter().find(|x| x["id"] == "orph1").unwrap()["orphan"], true);
        assert!(diff(&d, "orph1").unwrap_err().contains("孤兒"));
        assert!(merge(&d, "orph1").is_err());
        assert_eq!(discard(&d, "orph1").unwrap()["removed"], true);
        assert!(!worktree_dir(&d, "orph1").exists());
        let _ = discard(&d, "w1");
        let _ = std::fs::remove_dir_all(&d);
    }
}
