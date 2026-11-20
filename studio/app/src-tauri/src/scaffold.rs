//! "New project": scaffold a fresh Pikara Science project folder from a pipeline template (an existing
//! project such as <PROJECT_DIR>, or `<exe dir>\pipeline-template` in a packaged build).
//! Copies the pipeline code (scripts/, src/, public/fonts/, package.json, lock file, tsconfig, remotion config,
//! .gitignore), resets the content (narration with one episode skeleton, empty timeline, no custom acts),
//! optionally links the shared CosyVoice install (directory junction, no copy of the 9 GB model),
//! `git init` + first commit. Works with paths containing Chinese characters and spaces.

use crate::episodes;
use crate::gitops;
use crate::util::{clean_path, now_iso, run};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Top-level files copied when present.
const FILES: &[&str] = &["package.json", "package-lock.json", "tsconfig.json", "remotion.config.ts", ".gitignore", "LICENSE"];
/// Folders copied recursively (relative to the template root).
const DIRS: &[&str] = &["scripts", "src", "public/fonts"];
/// Never copied (generated, machine-specific or release-only).
const SKIP_NAMES: &[&str] = &["__pycache__", "node_modules", "timeline.generated.json", "export_release.py"];

pub struct NewProject<'a> {
    pub dest: &'a Path,
    pub title: &'a str,
    pub template: &'a Path,
    pub link_tools: bool,
}

/// Is `dir` a usable template (has the pipeline entry points)?
pub fn is_template(dir: &Path) -> bool {
    ["scripts/render.mjs", "scripts/build_timeline.py", "src/Root.tsx", "src/data/narration.json", "package.json"]
        .iter()
        .all(|f| dir.join(f).is_file())
}

/// Candidate templates in order: explicit → `<exe dir>\pipeline-template` → fallback (current project).
pub fn find_template(explicit: Option<&Path>, fallback: Option<&Path>) -> Result<PathBuf, String> {
    let mut tried = vec![];
    let exe_tpl = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("pipeline-template")));
    for c in [explicit.map(Path::to_path_buf), exe_tpl, fallback.map(Path::to_path_buf)].into_iter().flatten() {
        if is_template(&c) {
            return Ok(c);
        }
        tried.push(clean_path(&c));
    }
    Err(format!(
        "找不到可用的專案範本（需要 scripts/render.mjs、src/Root.tsx、src/data/narration.json 等檔案）。已檢查：{}",
        if tried.is_empty() { "（無）".into() } else { tried.join("、") }
    ))
}

fn copy_tree(from: &Path, to: &Path, n: &mut u64, bytes: &mut u64) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("無法建立資料夾 {}：{e}", to.display()))?;
    for e in std::fs::read_dir(from).map_err(|e| format!("無法讀取 {}：{e}", from.display()))?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if SKIP_NAMES.contains(&name.as_str()) || name.starts_with(".studio-tmp") {
            continue;
        }
        let src = e.path();
        let dst = to.join(&name);
        let ft = e.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            copy_tree(&src, &dst, n, bytes)?;
        } else if ft.is_file() {
            *bytes += std::fs::copy(&src, &dst).map_err(|e| format!("複製 {} 失敗：{e}", src.display()))?;
            *n += 1;
        }
    }
    Ok(())
}

/// Reset content so the new project starts with exactly one episode skeleton and no EP01 data.
fn reset_content(dest: &Path, template: &Path, title: &str) -> Result<(), String> {
    let data = dest.join("src").join("data");
    let tpl_doc: Value = serde_json::from_str(
        std::fs::read_to_string(template.join("src").join("data").join("narration.json")).map_err(|e| e.to_string())?.trim_start_matches('\u{feff}'),
    )
    .map_err(|e| format!("範本的 narration.json 不是有效 JSON：{e}"))?;
    let mut doc = serde_json::Map::new();
    for k in ["voice", "fps", "defaults"] {
        if let Some(v) = tpl_doc.get(k) {
            doc.insert(k.into(), v.clone());
        }
    }
    let mut seqs = serde_json::Map::new();
    seqs.insert("ep01".into(), episodes::skeleton("ep01", title, "開場", "在這裡輸入第一句旁白。"));
    doc.insert("sequences".into(), Value::Object(seqs));
    let doc = Value::Object(doc);
    let v = crate::narration::validate(&doc);
    if !v.ok {
        return Err(format!("新專案旁白驗證失敗：{:?}", v.errors.iter().map(|e| &e.message).collect::<Vec<_>>()));
    }
    std::fs::write(data.join("narration.json"), serde_json::to_string_pretty(&doc).unwrap() + "\n").map_err(|e| e.to_string())?;
    std::fs::write(data.join("timeline.generated.json"), "{}\n").map_err(|e| e.to_string())?;
    // custom (hand-made) acts belong to the template's episodes only
    let reg = dest.join("src").join("episode").join("registry.ts");
    if let Ok(t) = std::fs::read_to_string(&reg) {
        if let (Some(a), Some(b)) = (t.find("// <studio:custom-acts>"), t.find("// </studio:custom-acts>")) {
            let line_end = a + t[a..].find('\n').map(|i| i + 1).unwrap_or(t.len() - a);
            let new = format!("{}{}", &t[..line_end], &t[b..]);
            std::fs::write(&reg, new).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn create(req: &NewProject) -> Result<Value, String> {
    let title = req.title.trim();
    if title.is_empty() {
        return Err("請輸入新專案（第一集）的標題".into());
    }
    let dest = req.dest;
    if dest.exists() {
        let empty = std::fs::read_dir(dest).map(|mut r| r.next().is_none()).unwrap_or(false);
        if !empty {
            return Err(format!("目標資料夾已存在而且不是空的：{}。請選一個新的資料夾名稱。", dest.display()));
        }
    }
    if !is_template(req.template) {
        return Err(format!("{} 不是可用的專案範本", req.template.display()));
    }
    let tpl = std::fs::canonicalize(req.template).map_err(|e| e.to_string())?;
    let dest_abs = if dest.is_absolute() { dest.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(dest) };
    let tpl_clean = PathBuf::from(clean_path(&tpl));
    if dest_abs.starts_with(&tpl_clean) && !dest_abs.starts_with(tpl_clean.join("out")) {
        return Err("新專案不能建立在範本專案的原始碼資料夾裡（可以放在範本的 out\\ 之下作測試）".into());
    }
    std::fs::create_dir_all(dest).map_err(|e| format!("無法建立 {}：{e}", dest.display()))?;
    let (mut n, mut bytes) = (0u64, 0u64);
    for f in FILES {
        let s = tpl.join(f);
        if s.is_file() {
            bytes += std::fs::copy(&s, dest.join(f)).map_err(|e| format!("複製 {f} 失敗：{e}"))?;
            n += 1;
        }
    }
    for d in DIRS {
        let s = tpl.join(d.replace('/', "\\"));
        if s.is_dir() {
            copy_tree(&s, &dest.join(d.replace('/', "\\")), &mut n, &mut bytes)?;
        }
    }
    reset_content(dest, &tpl, title)?;
    for d in ["out", "public/assets/audio"] {
        std::fs::create_dir_all(dest.join(d.replace('/', "\\"))).map_err(|e| e.to_string())?;
    }
    // shared CosyVoice install: a junction (no admin rights needed), ignored by git via .gitignore
    let mut tools = Value::Null;
    let cosy = tpl.join("tools").join("CosyVoice");
    if req.link_tools && cosy.is_dir() {
        std::fs::create_dir_all(dest.join("tools")).map_err(|e| e.to_string())?;
        let link = dest.join("tools").join("CosyVoice");
        // chcp 65001 first: otherwise mklink prints the (Chinese) paths in the console code page
        let (l, c) = (clean_path(&link), clean_path(&cosy));
        let o = run("cmd", &["/d", "/c", "chcp", "65001", ">nul", "&", "mklink", "/J", &l, &c], None, Duration::from_secs(30))?;
        tools = json!({"junction": clean_path(&link), "target": clean_path(&cosy), "ok": o.ok(), "output": o.combined().trim()});
    }
    let meta = json!({
        "name": dest.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
        "title": title,
        "createdAt": now_iso(),
        "createdBy": format!("Pikara Science Studio {}", env!("CARGO_PKG_VERSION")),
        "template": clean_path(&tpl),
    });
    std::fs::write(dest.join("pikara-project.json"), serde_json::to_string_pretty(&meta).unwrap() + "\n").map_err(|e| e.to_string())?;
    std::fs::write(
        dest.join("README.md"),
        format!(
            "# {title}\n\n由 Pikara Science Studio 建立（範本：{}）。\n\n1. `npm install`（或在 Studio「環境醫生」按修復）\n2. 在 Studio「劇本編輯」撰寫 ep01 的旁白\n3. 「製作」：配音 → 時間軸 → 混音 → 渲染（輸出 `EP01_Final.mp4`）\n",
            clean_path(&tpl)
        ),
    )
    .map_err(|e| e.to_string())?;
    // git init + first commit (only the scaffold; tools/ and out/ are ignored)
    let mut git = json!({});
    match gitops::git(dest, &["init", "-q"]) {
        Ok(o) if o.ok() => {
            let _ = gitops::git(dest, &["add", "-A"]);
            let c = gitops::git_commit(dest, &["commit", "-q", "-m", &format!("Studio: new project「{title}」")]);
            let head = gitops::git(dest, &["rev-parse", "HEAD"]).ok().filter(|o| o.ok()).map(|o| o.stdout.trim().to_string());
            git = json!({"init": true, "commit": head, "error": c.err().or_else(|| head.is_none().then(|| "commit failed".to_string()))});
        }
        Ok(o) => git = json!({"init": false, "error": o.combined()}),
        Err(e) => git = json!({"init": false, "error": e}),
    }
    Ok(json!({
        "path": clean_path(dest),
        "title": title,
        "template": clean_path(&tpl),
        "files": n,
        "bytes": bytes,
        "tools": tools,
        "git": git,
        "next": "在 Studio 執行「環境醫生」→ 修復 npm 套件（npm install），再到「劇本編輯」撰寫第一集。",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
    }

    #[test]
    fn scaffold_into_chinese_path_with_spaces() {
        let tpl = std::fs::canonicalize(project_root()).unwrap();
        if !is_template(&tpl) {
            return;
        }
        let dest = std::env::temp_dir().join(format!("pss 新專案 測試 {}", &uuid::Uuid::new_v4().to_string()[..6])).join("我的 科普");
        let r = create(&NewProject { dest: &dest, title: "測試 專案", template: &tpl, link_tools: false }).unwrap();
        assert!(r["files"].as_u64().unwrap() > 50, "{r}");
        assert!(r["git"]["commit"].is_string(), "{r}");
        let nar = crate::narration::read(&dest, "zh-TW").unwrap();
        assert!(crate::narration::validate(&nar["doc"]).ok);
        let keys: Vec<&String> = nar["doc"]["sequences"].as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["ep01"]);
        assert_eq!(nar["doc"]["sequences"]["ep01"]["title"], "測試 專案");
        assert_eq!(std::fs::read_to_string(dest.join(r"src\data\timeline.generated.json")).unwrap().trim(), "{}");
        let reg = std::fs::read_to_string(dest.join(r"src\episode\registry.ts")).unwrap();
        assert!(!reg.contains("ep01: EP01_ACTS"), "custom acts cleared");
        assert!(dest.join(r"scripts\render.mjs").is_file() && !dest.join(r"scripts\export_release.py").exists());
        assert!(dest.join(r"public\fonts\NotoSansTC-VF.ttf").is_file());
        assert!(!dest.join("node_modules").exists() && !dest.join("src_cn").exists());
        // not empty → refused
        assert!(create(&NewProject { dest: &dest, title: "x", template: &tpl, link_tools: false }).unwrap_err().contains("不是空的"));
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }
}
