//! Git worktree / filesystem operations: checkpoints, prepare, deliver (merge outputs into the project), cleanup.

use super::*;

// ------------------------------------------------------------------ git / filesystem

pub(crate) fn checkpoint(wt: &Path, msg: &str) -> Option<String> {
    let _ = git(wt, &["add", "-A"]);
    let staged = git(wt, &["diff", "--cached", "--quiet"]).map(|o| !o.ok()).unwrap_or(false);
    if staged {
        let _ = studio_commit(wt, msg);
    }
    git(wt, &["rev-parse", "--short", "HEAD"]).ok().filter(|o| o.ok()).map(|o| o.stdout.trim().to_string())
}

pub(crate) fn studio_commit(dir: &Path, msg: &str) -> Result<crate::util::RunOut, String> {
    crate::util::run_env(
        "git",
        &["commit", "-q", "-m", msg],
        Some(dir),
        &[("GIT_AUTHOR_NAME", "Pikara Studio (Auto)"), ("GIT_AUTHOR_EMAIL", "studio@pikara.local"), ("GIT_COMMITTER_NAME", "Pikara Studio"), ("GIT_COMMITTER_EMAIL", "studio@pikara.local")],
        Duration::from_secs(120),
    )
}

/// Paths inside a worktree that are linked (directory junctions) to the main project instead of copied.
pub(crate) const LINKS: [&str; 2] = ["node_modules", r"tools\CosyVoice"];

pub(crate) fn prepare_worktree(root: &Path, wid: &str, branch: &str) -> Result<String, String> {
    let wt = worktree_dir(root, wid);
    crate::claude::ensure_excluded(root)?;
    let dirty = gitops::status(root).dirty;
    // the production runs the scripts committed in its worktree: bring them up to this build's pipeline first
    // (main project before branching; an existing worktree that is resumed after a Studio update in place)
    let synced = if !wt.join(".git").exists() {
        let s = crate::pipeline_sync::sync(root, true, false, true);
        let o = git(root, &["worktree", "add", "--quiet", &wt.to_string_lossy(), "-b", branch, "HEAD"])?;
        if !o.ok() {
            return Err(format!("建立工作樹失敗：{}", o.combined()));
        }
        s
    } else {
        crate::pipeline_sync::sync(&wt, true, false, true)
    };
    let synced = match synced {
        Ok(v) => crate::pipeline_sync::summary(&v),
        Err(e) => format!("管線腳本沒有更新：{e}"),
    };
    let mut linked = vec![];
    for rel in LINKS {
        let target = root.join(rel);
        let link = wt.join(rel);
        if target.exists() && !link.exists() {
            if let Some(par) = link.parent() {
                std::fs::create_dir_all(par).map_err(|e| e.to_string())?;
            }
            let (l, t) = (link.to_string_lossy().to_string(), target.to_string_lossy().to_string());
            let o = run("cmd", &["/d", "/c", "chcp", "65001", ">nul", "&", "mklink", "/J", &l, &t], None, Duration::from_secs(30))?;
            if !o.ok() {
                return Err(format!("無法建立目錄連結 {rel}：{}", o.combined()));
            }
            linked.push(rel);
        }
    }
    // the project Skill tells Claude how the pipeline works; new projects may not have it committed
    let skill = wt.join(crate::claude::SKILL_REL);
    if !skill.exists() {
        crate::claude::install_skill(&wt, false)?;
        linked.push("（已安裝 pikara-video Skill）");
    }
    // ignored files the pipeline needs (fonts etc.): copy
    let mut copied = 0;
    if let Ok(o) = git(root, &["ls-files", "--others", "--ignored", "--exclude-standard", "--", "public/fonts"]) {
        for f in o.stdout.lines().filter(|l| !l.trim().is_empty()) {
            let (a, b) = (root.join(f), wt.join(f));
            if a.is_file() && !b.exists() {
                if let Some(par) = b.parent() {
                    let _ = std::fs::create_dir_all(par);
                }
                if std::fs::hard_link(&a, &b).or_else(|_| std::fs::copy(&a, &b).map(|_| ())).is_ok() {
                    copied += 1;
                }
            }
        }
    }
    Ok(format!(
        "工作樹 {}（分支 {branch}）；{synced}；連結 {}；複製 {copied} 個被忽略的資源檔{}",
        clean_path(&wt),
        if linked.is_empty() { "無".into() } else { linked.join("、") },
        if dirty.is_empty() { String::new() } else { format!("。注意：專案有 {} 個未提交的修改，自動製作使用最後一次提交的版本", dirty.len()) }
    ))
}

/// Remove junctions first (so nothing is deleted through them), then the worktree, then (optionally) the branch.
pub fn remove_worktree(root: &Path, wid: &str, delete_branch: bool) -> Result<(), String> {
    let wt = worktree_dir(root, wid);
    crate::assets::unlink_all(&wt); // public/user/<ep> material junctions (the material itself stays)
    for rel in LINKS {
        let l = wt.join(rel);
        if std::fs::symlink_metadata(&l).is_ok() {
            // RemoveDirectoryW on a junction removes the link itself, never the target's contents
            std::fs::remove_dir(&l).map_err(|e| format!("無法移除目錄連結 {}：{e}", clean_path(&l)))?;
        }
    }
    if wt.exists() {
        let _ = git(root, &["worktree", "remove", "--force", &wt.to_string_lossy()]);
    }
    if wt.exists() {
        std::fs::remove_dir_all(&wt).map_err(|e| format!("無法刪除 {}：{e}", clean_path(&wt)))?;
    }
    let _ = git(root, &["worktree", "prune"]);
    if delete_branch {
        let o = git(root, &["for-each-ref", "--format=%(refname:short)", "refs/heads/studio/auto/"])?;
        for b in o.stdout.lines().filter(|b| b.ends_with(&wid.trim_start_matches("auto-").to_string())) {
            let _ = git(root, &["branch", "-D", b]);
        }
    }
    Ok(())
}

/// Write the episode's narration into `<video>/script/` (JSON + readable Markdown).
pub(crate) fn write_script_files(src_root: &Path, dst: &Path, ep: &str, cn_tree: bool) {
    let _ = std::fs::create_dir_all(dst);
    for (loc, suffix) in [("zh-TW", ""), ("zh-CN", "_zh-CN")] {
        if loc == "zh-CN" && !cn_tree {
            continue;
        }
        let Ok(r) = crate::narration::read(src_root, loc) else { continue };
        let seq = &r["doc"]["sequences"][ep];
        if seq.is_null() {
            continue;
        }
        let _ = std::fs::write(dst.join(format!("{}{suffix}.narration.json", ep_upper(ep))), serde_json::to_string_pretty(seq).unwrap_or_default());
        let mut md = format!("# {} {}\n\n", ep_upper(ep), seq["title"].as_str().unwrap_or(""));
        for sc in seq["scenes"].as_array().cloned().unwrap_or_default() {
            md.push_str(&format!("## {} {}\n\n", sc["id"].as_str().unwrap_or(""), sc["title"].as_str().unwrap_or("")));
            for l in sc["lines"].as_array().cloned().unwrap_or_default() {
                md.push_str(&format!("- {}\n", l["subtitle"].as_str().unwrap_or("")));
            }
            md.push('\n');
        }
        let _ = std::fs::write(dst.join(format!("{}{suffix}.md", ep_upper(ep))), md);
    }
}

/// Link (or copy) files of `from` whose names pass `keep` into `to`.
pub(crate) fn link_files(from: &Path, to: &Path, keep: &dyn Fn(&str) -> bool) -> usize {
    let Ok(rd) = std::fs::read_dir(from) else { return 0 };
    let _ = std::fs::create_dir_all(to);
    let mut n = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !e.path().is_file() || !keep(&name) {
            continue;
        }
        let dst = to.join(&name);
        if dst.exists() {
            continue;
        }
        if std::fs::hard_link(e.path(), &dst).or_else(|_| std::fs::copy(e.path(), &dst).map(|_| ())).is_ok() {
            n += 1;
        }
    }
    n
}

/// Delivery (v0.2.1 layout). Every output goes into the video's own folder (`projects/EP07/…`, see layout.rs):
/// output/ (.mp4), subtitles/, thumbnail/, docs/ (sources, upload text, QA), script/, scenes/ (key frames), voice/.
/// Formal episodes: text files are committed in the worktree under `projects/EP07/` and the branch is merged
/// (`--no-ff`, episode-aware conflict resolution); videos, stills and voice are moved / linked (git-ignored).
/// Sandbox tests (TEST numbers): everything is copied to `sandbox/TEST001/`; nothing is merged into the project.
/// Never overwrites a different existing file.
pub(crate) fn deliver(root: &Path, wt: &Path, p: &Production) -> Result<(Vec<String>, bool, String), String> {
    let E = ep_upper(&p.episode);
    let sandbox = crate::layout::is_test(&p.episode);
    let vrel = crate::layout::video_rel(&p.episode);
    let re = Regex::new(&format!(r"^{E}(_.*)?\.(mp4|srt|png|md)$")).unwrap();
    let cn_tree = content::wants_cn(&p.config);
    // 1. sort the worktree's outputs into the video folder (inside the worktree)
    let wv = wt.join(vrel.replace('/', "\\"));
    for s in crate::layout::SUBDIRS {
        let _ = std::fs::create_dir_all(wv.join(s));
    }
    let mut videos = vec![];
    for e in std::fs::read_dir(wt).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !e.path().is_file() || !re.is_match(&name) {
            continue;
        }
        let dst = wv.join(crate::layout::subdir_for(&name)).join(&name);
        if name.ends_with(".mp4") {
            videos.push(name.clone());
        }
        if !dst.exists() {
            std::fs::rename(e.path(), &dst).or_else(|_| std::fs::copy(e.path(), &dst).map(|_| ())).map_err(|x| format!("整理 {name} 失敗：{x}"))?;
        } else {
            let _ = std::fs::remove_file(e.path());
        }
    }
    write_script_files(wt, &wv.join("script"), &p.episode, cn_tree);
    let _ = std::fs::copy(wt.join("out/auto/BRIEF.md"), wv.join("BRIEF.md"));
    if wt.join("out/auto/ASSETS.md").exists() {
        let _ = std::fs::copy(wt.join("out/auto/ASSETS.md"), wv.join("docs").join(format!("{E}_ASSETS.md")));
    }
    let _ = link_files(&wt.join("out/qa"), &wv.join("docs").join("qa"), &|n| n.starts_with(&E));
    let _ = std::fs::write(
        wv.join("production.json"),
        serde_json::to_string_pretty(&json!({"id": p.id, "episode": p.episode, "topic": p.config.topic, "mode": content::mode(&p.config), "language": content::lang(&p.config), "createdAt": p.created_at, "sandbox": sandbox, "warnings": p.warnings})).unwrap_or_default(),
    );
    // stills / voice: binary, git-ignored — linked straight into the project's video folder below
    let rv = root.join(vrel.replace('/', "\\"));
    let voice_dirs: Vec<PathBuf> = ["public/assets/audio/voiceover_cosy", "public/assets/audio/voiceover_cosy_cn"].iter().map(|d| wt.join(d).join(&p.episode)).filter(|d| d.exists()).collect();
    let link_binaries = |rv: &Path| {
        let _ = link_files(&wt.join("out/stills"), &rv.join("scenes"), &|n| n.starts_with(&E));
        for d in &voice_dirs {
            let to = if d.to_string_lossy().contains("voiceover_cosy_cn") { rv.join("voice").join("zh-CN") } else { rv.join("voice") };
            let _ = link_files(d, &to, &|n| n.ends_with(".mp3") || n.ends_with(".wav") || n.ends_with(".json"));
        }
    };
    if sandbox {
        // copy the whole video folder; the project's source tree is not touched
        let n = copy_tree(&wv, &rv)?;
        link_binaries(&rv);
        let mut all = list_outputs(root, &vrel);
        all.sort();
        return Ok((all.clone(), true, format!("Sandbox 測試完成（不合併到專案、不佔用正式集數）：{n} 個檔案已放到 {vrel}/；成品：{}", all.join("、"))));
    }
    // 2. formal: videos to the project's video folder (ignored by git), then commit + merge the text outputs
    for name in &videos {
        let (a, b) = (wv.join("output").join(name), rv.join("output").join(name));
        std::fs::create_dir_all(b.parent().unwrap()).map_err(|e| e.to_string())?;
        if b.exists() {
            let same = std::fs::metadata(&a).ok().zip(std::fs::metadata(&b).ok()).map(|(x, y)| x.len() == y.len()).unwrap_or(false);
            if !same {
                return Err(format!("專案已經有 {vrel}/output/{name}，內容不同，不會覆寫。請改名或移走後按「繼續」。"));
            }
            continue;
        }
        std::fs::rename(&a, &b).or_else(|_| std::fs::copy(&a, &b).map(|_| ())).map_err(|x| format!("移動 {name} 失敗：{x}"))?;
    }
    link_binaries(&rv);
    checkpoint(wt, &format!("auto({E}): 交付 {}", p.config.topic.chars().take(40).collect::<String>()));
    let br = p.branch.clone().ok_or("沒有分支")?;
    // files the branch adds under the video folder that already exist untracked in the project (an interrupted
    // earlier delivery, BRIEF.md written at start): identical → remove so the merge can bring them; different → stop
    if let Ok(o) = git(root, &["diff", "--name-only", "--diff-filter=A", &format!("HEAD...{br}"), "--", &vrel]) {
        for f in o.stdout.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
            let (a, b) = (wt.join(f.replace('/', "\\")), root.join(f.replace('/', "\\")));
            if b.is_file() {
                let same = std::fs::read(&a).ok().zip(std::fs::read(&b).ok()).map(|(x, y)| x == y).unwrap_or(false);
                if same || f.ends_with("BRIEF.md") || f.ends_with("production.json") {
                    let _ = std::fs::remove_file(&b);
                } else {
                    return Err(format!("專案已經有 {f}，內容不同，不會覆寫。請改名或移走後按「繼續」。"));
                }
            }
        }
    }
    let o = crate::util::run_env(
        "git",
        &["merge", "--no-ff", "--no-edit", "-m", &format!("Studio 自動製作 {E}：{}", p.config.topic.chars().take(60).collect::<String>()), &br],
        Some(root),
        &[("GIT_AUTHOR_NAME", "Pikara Studio (Auto)"), ("GIT_AUTHOR_EMAIL", "studio@pikara.local"), ("GIT_COMMITTER_NAME", "Pikara Studio"), ("GIT_COMMITTER_EMAIL", "studio@pikara.local")],
        Duration::from_secs(300),
    )?;
    let merged_ok = o.ok() || resolve_episode_conflicts(root, &p.episode).unwrap_or(false);
    if !merged_ok {
        let _ = git(root, &["merge", "--abort"]);
        // the project has no branch files: copy the video folder so the user still gets everything
        let _ = copy_tree(&wv, &rv);
        return Ok((
            list_outputs(root, &vrel),
            false,
            format!(
                "成品已放到 {vrel}/，但原始碼無法自動合併（專案在製作期間有其他修改）：{}\n分支 {br} 與工作樹保留；請在「提示詞」頁的工作樹清單檢視差異後手動合併，或解決衝突後按「繼續」。",
                first_line(&o.combined())
            ),
        ));
    }
    // imported material stays usable for re-renders in the project itself
    if !p.config.assets.is_empty() {
        let _ = crate::assets::link(root, &p.episode, &rv.join("assets"));
    }
    let mut all = list_outputs(root, &vrel);
    all.sort();
    Ok((all.clone(), true, format!("已合併 {br}，成品在 {vrel}/：{}", all.join("、"))))
}

/// Copy a folder tree (files that already exist with the same size are skipped; different ones are not overwritten).
pub(crate) fn copy_tree(a: &Path, b: &Path) -> Result<usize, String> {
    let mut n = 0;
    std::fs::create_dir_all(b).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(a).map_err(|e| e.to_string())?.flatten() {
        let (pa, pb) = (e.path(), b.join(e.file_name()));
        if pa.is_dir() {
            n += copy_tree(&pa, &pb)?;
        } else if !pb.exists() {
            std::fs::copy(&pa, &pb).map_err(|x| format!("複製 {} 失敗：{x}", clean_path(&pa)))?;
            n += 1;
        }
    }
    Ok(n)
}

/// Finished files of a video folder (relative to the project root): videos, subtitles, thumbnails, docs.
pub(crate) fn list_outputs(root: &Path, vrel: &str) -> Vec<String> {
    let mut out = vec![];
    for s in ["output", "subtitles", "thumbnail", "docs"] {
        if let Ok(rd) = std::fs::read_dir(root.join(vrel.replace('/', "\\")).join(s)) {
            for e in rd.flatten() {
                if e.path().is_file() {
                    out.push(format!("{vrel}/{s}/{}", e.file_name().to_string_lossy()));
                }
            }
        }
    }
    out
}

/// Episode-aware conflict resolution for a merge in progress. Productions add a new key (`sequences.<ep>` in
/// narration.json, `<ep>` in timeline.generated.json, an entry in registry.ts); when the project gained another
/// episode meanwhile, git reports a textual conflict. Take the project's version and add this episode's entry.
/// Returns Ok(true) when every conflict was resolved and the merge commit was made.
pub(crate) fn resolve_episode_conflicts(root: &Path, ep: &str) -> Result<bool, String> {
    let o = git(root, &["diff", "--name-only", "--diff-filter=U"])?;
    let files: Vec<String> = o.stdout.lines().map(|l| l.trim().replace('\\', "/")).filter(|l| !l.is_empty()).collect();
    if files.is_empty() {
        return Ok(false);
    }
    let show = |stage: u8, f: &str| git(root, &["show", &format!(":{stage}:{f}")]).ok().filter(|o| o.ok()).map(|o| o.stdout);
    for f in &files {
        let resolved: String = match f.as_str() {
            "src/data/narration.json" | "src_cn/data/narration.json" | "src/data/timeline.generated.json" | "src_cn/data/timeline.generated.json" => {
                let (Some(ours), Some(theirs)) = (show(2, f), show(3, f)) else { return Ok(false) };
                let mut o: Value = serde_json::from_str(&ours).map_err(|e| e.to_string())?;
                let t: Value = serde_json::from_str(&theirs).map_err(|e| e.to_string())?;
                let base = show(1, f).and_then(|b| serde_json::from_str::<Value>(&b).ok());
                let (o_map, t_map, b_map) = if f.ends_with("narration.json") {
                    (o.get_mut("sequences"), t.get("sequences"), base.as_ref().and_then(|b| b.get("sequences")))
                } else {
                    (Some(&mut o), Some(&t), base.as_ref())
                };
                let (Some(o_map), Some(t_map)) = (o_map.and_then(|v| v.as_object_mut()), t_map.and_then(|v| v.as_object())) else { return Ok(false) };
                // only safe when the branch changed nothing but its own episode
                for (k, v) in t_map {
                    let base_v = b_map.and_then(|b| b.get(k));
                    if k != ep && base_v != Some(v) {
                        return Ok(false);
                    }
                }
                match t_map.get(ep) {
                    Some(v) => {
                        o_map.insert(ep.to_string(), v.clone());
                    }
                    None => return Ok(false),
                }
                crate::narration::serialize_like(&o, &ours)?
            }
            "src/episode/registry.ts" | "src_cn/episode/registry.ts" => {
                // imports + CUSTOM_ACTS entries are line additions on both sides: union merge keeps both
                let dir = std::env::temp_dir().join(format!("pikara-merge-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let mut paths = vec![];
                for (i, st) in [2u8, 1, 3].iter().enumerate() {
                    let pth = dir.join(format!("{i}.ts"));
                    std::fs::write(&pth, show(*st, f).unwrap_or_default()).map_err(|e| e.to_string())?;
                    paths.push(pth.to_string_lossy().to_string());
                }
                let r = git(root, &["merge-file", "-p", "--union", &paths[0], &paths[1], &paths[2]])?;
                let _ = std::fs::remove_dir_all(&dir);
                if r.stdout.is_empty() {
                    return Ok(false);
                }
                r.stdout
            }
            _ => return Ok(false),
        };
        std::fs::write(root.join(f), resolved).map_err(|e| e.to_string())?;
        git(root, &["add", "--", f])?;
    }
    let c = crate::util::run_env(
        "git",
        &["commit", "--no-edit", "-q"],
        Some(root),
        &[("GIT_AUTHOR_NAME", "Pikara Studio (Auto)"), ("GIT_AUTHOR_EMAIL", "studio@pikara.local"), ("GIT_COMMITTER_NAME", "Pikara Studio"), ("GIT_COMMITTER_EMAIL", "studio@pikara.local")],
        Duration::from_secs(120),
    )?;
    Ok(c.ok())
}
