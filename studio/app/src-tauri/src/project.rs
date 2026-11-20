//! Project info, outputs (with ffprobe metadata), PUBLISH_METADATA.md sections, Explorer integration.
//! There is deliberately NO upload code anywhere in Studio.

use crate::util::{clean_path, run};
use crate::{gitops, narration};
use serde_json::{json, Value};
use std::path::Path;
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

/// *.mp4 / *.srt / *.png in the project root (deliverables live there).
pub fn outputs(root: &Path, probe: bool) -> Vec<Value> {
    let mut v = vec![];
    if let Ok(rd) = std::fs::read_dir(root) {
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
                "probe": pr,
            }));
        }
    }
    v.sort_by(|a, b| b["mtime"].as_str().cmp(&a["mtime"].as_str()));
    v
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

pub fn publish_metadata(root: &Path) -> Value {
    let p = root.join("PUBLISH_METADATA.md");
    match std::fs::read_to_string(&p) {
        Ok(t) => json!({"path": clean_path(&p), "exists": true, "sections": md_sections(&t)}),
        Err(_) => json!({"path": clean_path(&p), "exists": false, "sections": []}),
    }
}

pub fn open_path(root: &Path, path: &Path, reveal: bool) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("not found: {}", path.display()));
    }
    if !crate::util::is_inside(root, path) {
        return Err("path is outside the project".into());
    }
    let p = clean_path(&std::fs::canonicalize(path).map_err(|e| e.to_string())?);
    let mut c = std::process::Command::new("explorer.exe");
    if reveal {
        c.arg(format!("/select,{p}"));
    } else {
        c.arg(&p);
    }
    c.spawn().map_err(|e| e.to_string())?;
    Ok(())
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
    fn real_publish_metadata_has_both_platforms() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let m = publish_metadata(&root);
        if m["exists"] == true {
            let titles: Vec<String> = m["sections"].as_array().unwrap().iter().map(|s| s["title"].as_str().unwrap().to_string()).collect();
            assert!(titles.iter().any(|t| t.contains("YouTube")), "{titles:?}");
            assert!(titles.iter().any(|t| t.contains("Bilibili")), "{titles:?}");
        }
    }
}
