//! Project info, outputs (with ffprobe metadata), PUBLISH_METADATA.md sections, Explorer integration.
//! There is deliberately NO upload code anywhere in Studio.

use crate::util::{clean_path, run};
use crate::{gitops, narration};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub fn info(project: &crate::db::Project) -> Value {
    let root = Path::new(&project.root_path);
    let mut episodes = vec![];
    for loc in ["zh-TW", "zh-CN"] {
        if let Ok(r) = narration::read(root, loc) {
            for s in r["sequences"].as_array().cloned().unwrap_or_default() {
                let scenes = s["scenes"].as_array().cloned().unwrap_or_default();
                let lines: usize = scenes.iter().map(|x| x["lines"].as_array().map(|a| a.len()).unwrap_or(0)).sum();
                episodes.push(json!({
                    "locale": loc, "seqKey": s["key"], "title": s["title"], "voiceEngine": s["voiceEngine"],
                    "scenes": scenes.len(), "lines": lines
                }));
            }
        }
    }
    json!({
        "project": project,
        "episodes": episodes,
        "outputs": outputs(root, false),
        "git": gitops::status(root),
    })
}

fn mtime_iso(m: &std::fs::Metadata) -> String {
    m.modified()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

/// *.mp4 / *.srt / *.png deliverables: the project root (older layout) and every video folder
/// (`projects/<EP>/{output,subtitles,thumbnail}`, where productions deliver since v0.3). Paths are absolute.
pub fn outputs(root: &Path, probe: bool) -> Vec<Value> {
    let mut dirs: Vec<(PathBuf, Option<String>)> = vec![(root.to_path_buf(), None)];
    if let Ok(rd) = std::fs::read_dir(root.join("projects")) {
        for e in rd.flatten().filter(|e| e.path().is_dir()) {
            let ep = e.file_name().to_string_lossy().to_string();
            for s in ["output", "subtitles", "thumbnail"] {
                dirs.push((e.path().join(s), Some(ep.clone())));
            }
        }
    }
    let mut v = vec![];
    for (dir, ep) in dirs {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let ext = p.extension().map(|x| x.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            if !["mp4", "srt", "png"].contains(&ext.as_str()) {
                continue;
            }
            let Ok(m) = e.metadata() else { continue };
            if !m.is_file() {
                continue;
            }
            let pr = if probe && ext == "mp4" { ffprobe(&p) } else { None };
            v.push(json!({
                "name": e.file_name().to_string_lossy(),
                "path": clean_path(&p),
                "ext": ext,
                "size": m.len(),
                "mtime": mtime_iso(&m),
                "episode": ep,
                "probe": pr,
            }));
        }
    }
    v.sort_by(|a, b| b["mtime"].as_str().cmp(&a["mtime"].as_str()));
    v
}

/// Resolve a path the UI sends. Absolute paths stay as they are; relative ones (production outputs are stored
/// relative to the project root, e.g. `projects/EP16/output/EP16_Bilibili_zh-CN.mp4`) are joined to the project
/// root — never to the process working directory, which depends on how Studio was started (CYW, shortcut, CLI).
pub fn resolve_in_project(root: &Path, path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    let mut out = root.to_path_buf();
    for c in path.split(|c| c == '/' || c == '\\').filter(|c| !c.is_empty() && *c != ".") {
        out.push(c);
    }
    out
}

fn parse_rate(r: &str) -> Option<f64> {
    let (a, b) = r.split_once('/')?;
    let (a, b): (f64, f64) = (a.parse().ok()?, b.parse().ok()?);
    (b > 0.0).then(|| (a / b * 1000.0).round() / 1000.0)
}

pub fn parse_ffprobe(j: &Value, size: u64) -> Value {
    let streams = j["streams"].as_array().cloned().unwrap_or_default();
    let v = streams.iter().find(|s| s["codec_type"] == "video");
    let a = streams.iter().find(|s| s["codec_type"] == "audio");
    let f = &j["format"];
    json!({
        "durationS": f["duration"].as_str().and_then(|d| d.parse::<f64>().ok()),
        "width": v.and_then(|v| v["width"].as_u64()),
        "height": v.and_then(|v| v["height"].as_u64()),
        "fps": v.and_then(|v| v["avg_frame_rate"].as_str()).and_then(parse_rate),
        "vcodec": v.and_then(|v| v["codec_name"].as_str()),
        "acodec": a.and_then(|a| a["codec_name"].as_str()),
        "bitRate": f["bit_rate"].as_str().and_then(|b| b.parse::<u64>().ok()),
        "sizeBytes": size,
    })
}

pub fn ffprobe(p: &Path) -> Option<Value> {
    let ps = p.to_string_lossy().to_string();
    let exe = crate::util::tool("ffprobe")?;
    let o = run(
        &exe,
        &["-v", "error", "-print_format", "json", "-show_format", "-show_streams", &ps],
        None,
        Duration::from_secs(30),
    )
    .ok()?;
    if !o.ok() {
        return None;
    }
    let j: Value = serde_json::from_str(&o.stdout).ok()?;
    let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    Some(parse_ffprobe(&j, size))
}

/// Split a markdown file into heading sections.
pub fn md_sections(text: &str) -> Vec<Value> {
    let mut out = vec![];
    let mut cur: Option<(usize, String, Vec<&str>)> = None;
    let mut in_fence = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
        }
        let level = if in_fence { 0 } else { line.chars().take_while(|c| *c == '#').count() };
        if (1..=6).contains(&level) && line.chars().nth(level) == Some(' ') {
            if let Some((l, t, c)) = cur.take() {
                out.push(json!({"level": l, "title": t, "content": c.join("\n").trim().to_string()}));
            }
            cur = Some((level, line[level..].trim().to_string(), vec![]));
        } else if let Some((_, _, c)) = cur.as_mut() {
            c.push(line);
        } else {
            cur = Some((0, String::new(), vec![line]));
        }
    }
    if let Some((l, t, c)) = cur {
        out.push(json!({"level": l, "title": t, "content": c.join("\n").trim().to_string()}));
    }
    out
}

/// Publish metadata for a video: `projects/<EP>/docs/<EP>_PUBLISH_METADATA.md` when the video is in a video
/// folder; otherwise the project root's PUBLISH_METADATA.md (older layout), then the newest episode file.
pub fn publish_metadata(root: &Path, video: Option<&str>) -> Value {
    let mut cands = vec![];
    if let Some(v) = video {
        // <root>/projects/<EP>/<sub>/<file>
        let v = resolve_in_project(root, v);
        if let Some(epdir) = v.parent().and_then(|d| d.parent()) {
            if epdir.parent().and_then(|x| x.file_name()).is_some_and(|n| n == "projects" || n == "sandbox") {
                let ep = epdir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                cands.push(epdir.join("docs").join(format!("{ep}_PUBLISH_METADATA.md")));
            }
        }
    }
    cands.push(root.join("PUBLISH_METADATA.md"));
    let mut eps: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(root.join("projects"))
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path().join("docs").join(format!("{}_PUBLISH_METADATA.md", e.file_name().to_string_lossy())))
                .filter_map(|f| std::fs::metadata(&f).and_then(|m| m.modified()).ok().map(|t| (t, f)))
                .collect()
        })
        .unwrap_or_default();
    eps.sort_by(|a, b| b.0.cmp(&a.0));
    cands.extend(eps.into_iter().map(|x| x.1));
    for p in &cands {
        if let Ok(t) = std::fs::read_to_string(p) {
            return json!({"path": clean_path(p), "exists": true, "sections": md_sections(&t)});
        }
    }
    json!({"path": clean_path(&cands[0]), "exists": false, "sections": []})
}

pub fn open_path(root: &Path, path: &str, reveal: bool) -> Result<(), String> {
    let path = &resolve_in_project(root, path);
    if path.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("path is outside the project".into());
    }
    if !path.exists() {
        return Err(format!("找不到檔案：{}", clean_path(path)));
    }
    if !crate::util::is_inside(root, path) {
        return Err("path is outside the project".into());
    }
    let p = clean_path(&std::fs::canonicalize(path).map_err(|e| e.to_string())?);
    // automated UI tests: resolve and check everything, but don't open an Explorer window on the user's screen
    if let Some(log) = std::env::var_os("PIKARA_OPEN_DRYRUN").filter(|v| !v.is_empty()) {
        use std::io::Write;
        // one write per line: concurrent clicks must not interleave
        let line = format!("{}\t{p}\n", if reveal { "reveal" } else { "open" });
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(log).and_then(|mut f| f.write_all(line.as_bytes()));
        return Ok(());
    }
    crate::platform::open_in_file_manager(Path::new(&p), reveal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffprobe_json_parsing() {
        let j = json!({"streams": [
            {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "avg_frame_rate": "30/1"},
            {"codec_type": "audio", "codec_name": "aac"}],
            "format": {"duration": "841.900000", "bit_rate": "8000000"}});
        let p = parse_ffprobe(&j, 123);
        assert_eq!(p["width"], 1920);
        assert_eq!(p["fps"], 30.0);
        assert_eq!(p["acodec"], "aac");
        assert_eq!(p["durationS"], 841.9);
        assert_eq!(parse_rate("30000/1001"), Some(29.97));
    }

    #[test]
    fn markdown_sections_ignore_hashes_in_code_fences() {
        let s = md_sections("# T\nintro\n## YouTube\n```\n#AI #GGUF\n```\n## Bilibili\nb");
        assert_eq!(s.len(), 3);
        assert_eq!(s[1]["title"], "YouTube");
        assert!(s[1]["content"].as_str().unwrap().contains("#AI"));
        assert_eq!(s[2]["level"], 2);
    }

    #[test]
    fn relative_output_paths_resolve_against_the_project_root_not_the_cwd() {
        let d = std::env::temp_dir().join(format!("pss-open 測試 {}", uuid::Uuid::new_v4()));
        let ep = d.join("projects").join("EP16");
        for s in ["output", "docs", "thumbnail"] {
            std::fs::create_dir_all(ep.join(s)).unwrap();
        }
        std::fs::write(ep.join("output").join("EP16_Bilibili_zh-CN.mp4"), b"x").unwrap();
        std::fs::write(ep.join("thumbnail").join("EP16_Bilibili_zh-CN_Thumbnail.png"), b"x").unwrap();
        std::fs::write(ep.join("docs").join("EP16_PUBLISH_METADATA.md"), "# EP16\n## Bilibili\nt").unwrap();
        // the process CWD is somewhere else (as when CYW starts Studio from its apps folder)
        assert_ne!(std::env::current_dir().unwrap(), d);
        assert!(!Path::new("projects/EP16/output/EP16_Bilibili_zh-CN.mp4").exists());
        let r = resolve_in_project(&d, "projects/EP16/output/EP16_Bilibili_zh-CN.mp4");
        assert!(r.is_file(), "{}", r.display());
        assert!(resolve_in_project(&d, "projects\\EP16\\docs\\EP16_PUBLISH_METADATA.md").is_file());
        assert_eq!(resolve_in_project(&d, &r.to_string_lossy()), r, "absolute paths stay unchanged");
        // traversal is refused before anything is opened; a missing file says so
        assert!(open_path(&d, "projects/../../../Windows/notepad.exe", false).unwrap_err().contains("outside"));
        assert!(open_path(&d, "projects/EP16/output/missing.mp4", false).unwrap_err().contains("找不到"));
        // outputs include the video folder; publish metadata follows the selected video
        let outs = outputs(&d, false);
        assert!(outs.iter().any(|o| o["name"] == "EP16_Bilibili_zh-CN.mp4" && o["episode"] == "EP16"), "{outs:?}");
        let m = publish_metadata(&d, Some("projects/EP16/output/EP16_Bilibili_zh-CN.mp4"));
        assert_eq!(m["exists"], true);
        assert!(m["path"].as_str().unwrap().ends_with("EP16_PUBLISH_METADATA.md"));
        assert_eq!(publish_metadata(&d, None)["exists"], true, "falls back to the newest episode file");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn real_publish_metadata_has_both_platforms() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let m = publish_metadata(&root, None);
        if m["exists"] == true {
            let titles: Vec<String> = m["sections"].as_array().unwrap().iter().map(|s| s["title"].as_str().unwrap().to_string()).collect();
            assert!(titles.iter().any(|t| t.contains("YouTube")), "{titles:?}");
            assert!(titles.iter().any(|t| t.contains("Bilibili")), "{titles:?}");
        }
    }
}
