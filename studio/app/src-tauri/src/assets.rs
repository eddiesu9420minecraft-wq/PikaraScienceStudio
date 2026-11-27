//! v0.2.1 material import for Autonomous Production Mode.
//!
//! The user picks files (TXT / Markdown / PDF, images, MP4 and other video, screen recordings, WAV / MP3 music,
//! a custom script, reference documents). `import` copies them into the video's own folder
//! (`projects/EP07/assets/`, never moved from where the user keeps them); the worktree and — after delivery — the
//! project get a junction `public/user/<ep>` → that folder so Remotion can use `staticFile('user/<ep>/<file>')`.
//! `manifest` writes `out/auto/ASSETS.md` (kind, size, resolution, duration, how to use it) and extracts a few key
//! frames of every video so the AI can look at real screenshots instead of inventing UI.

use crate::util::{clean_path, run};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Asset {
    /// Where the user's file is (absolute path, as picked).
    pub source: String,
    /// File name inside `<video>/assets/` (set by `import`).
    pub name: String,
    /// text | pdf | image | video | recording | music | script | reference
    pub kind: String,
    /// What it is / how to use it (user's words, passed to the AI).
    pub note: String,
    pub bytes: u64,
}

pub const KINDS: [&str; 8] = ["text", "pdf", "image", "video", "recording", "music", "script", "reference"];
const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 60;

pub fn kind_label(k: &str) -> &'static str {
    match k {
        "text" => "文字",
        "pdf" => "PDF",
        "image" => "圖片／截圖",
        "video" => "影片素材",
        "recording" => "操作錄影",
        "music" => "背景音樂",
        "script" => "自訂腳本",
        "reference" => "參考文件",
        _ => "其他",
    }
}

pub fn detect_kind(path: &str) -> Option<&'static str> {
    let ext = Path::new(path).extension()?.to_string_lossy().to_ascii_lowercase();
    Some(match ext.as_str() {
        "txt" | "md" | "markdown" => "text",
        "pdf" => "pdf",
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" => "image",
        "mp4" | "mov" | "mkv" | "webm" | "avi" | "m4v" => "video",
        "wav" | "mp3" | "flac" | "m4a" | "ogg" | "aac" => "music",
        "docx" | "html" | "htm" | "json" | "csv" => "reference",
        _ => return None,
    })
}

fn allowed_for(kind: &str, path: &str) -> bool {
    let d = detect_kind(path);
    match kind {
        "recording" => d == Some("video"),
        "script" => d == Some("text"),
        "reference" => matches!(d, Some("text" | "pdf" | "reference")),
        k => d == Some(match k {
            "text" => "text",
            "pdf" => "pdf",
            "image" => "image",
            "video" => "video",
            "music" => "music",
            _ => "",
        }),
    }
}

fn safe_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_alphanumeric() || "._-".contains(c) || (c as u32) > 0x2E80 { c } else { '_' }).collect();
    let s = s.trim_matches('.').to_string();
    if s.is_empty() { "asset".into() } else { s.chars().take(80).collect() }
}

/// Validate the list, fill in kinds, copy every file into `dir` (`<video>/assets`). Re-running is a no-op for files
/// that are already there.
pub fn import(dir: &Path, assets: &mut Vec<Asset>) -> Result<(), String> {
    if assets.len() > MAX_FILES {
        return Err(format!("素材最多 {MAX_FILES} 個（目前 {} 個）", assets.len()));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut taken: Vec<String> = vec![];
    for a in assets.iter_mut() {
        a.note = a.note.chars().take(500).collect();
        let src = PathBuf::from(a.source.trim());
        if a.kind.is_empty() {
            a.kind = detect_kind(&a.source).ok_or(format!("不支援的素材格式：{}", a.source))?.to_string();
        }
        if !KINDS.contains(&a.kind.as_str()) {
            return Err(format!("素材類型不正確：{}", a.kind));
        }
        if !allowed_for(&a.kind, &a.source) {
            return Err(format!("{} 不能當作「{}」使用", a.source, kind_label(&a.kind)));
        }
        let already = !a.name.is_empty() && dir.join(&a.name).is_file();
        if already {
            taken.push(a.name.to_lowercase());
            continue;
        }
        let meta = std::fs::metadata(&src).map_err(|_| format!("找不到素材檔案：{}", a.source))?;
        if !meta.is_file() {
            return Err(format!("素材必須是檔案：{}", a.source));
        }
        if meta.len() > MAX_BYTES {
            return Err(format!("素材太大（{:.1} GB，上限 4 GB）：{}", meta.len() as f64 / 1e9, a.source));
        }
        let base = safe_name(&src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
        let mut name = base.clone();
        let mut i = 2;
        while taken.contains(&name.to_lowercase()) || dir.join(&name).exists() {
            let p = Path::new(&base);
            let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let ext = p.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
            name = format!("{stem}-{i}{ext}");
            i += 1;
        }
        std::fs::copy(&src, dir.join(&name)).map_err(|e| format!("複製素材 {} 失敗：{e}", a.source))?;
        taken.push(name.to_lowercase());
        a.name = name;
        a.bytes = meta.len();
    }
    Ok(())
}

/// The custom-script asset's text (first `script` asset), if any.
pub fn script_text(dir: &Path, assets: &[Asset]) -> Option<String> {
    let a = assets.iter().find(|a| a.kind == "script")?;
    let b = std::fs::read(dir.join(&a.name)).ok()?;
    Some(String::from_utf8_lossy(&b).trim_start_matches('\u{feff}').to_string())
}

pub fn music<'a>(assets: &'a [Asset]) -> Option<&'a Asset> {
    assets.iter().find(|a| a.kind == "music")
}

fn probe(path: &Path) -> Option<Value> {
    let o = run(
        "ffprobe",
        &["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", &path.to_string_lossy()],
        None,
        Duration::from_secs(30),
    )
    .ok()?;
    serde_json::from_str(&o.stdout).ok()
}

/// Write `out/auto/ASSETS.md` in the worktree and extract up to 4 key frames per video into `out/auto/asset_frames/`.
/// `link_rel` is the folder Remotion sees (`public/user/<ep>`). Returns the Markdown.
pub fn manifest(wt: &Path, ep: &str, assets: &[Asset]) -> String {
    if assets.is_empty() {
        return String::new();
    }
    let dir = wt.join("public").join("user").join(ep);
    let frames_dir = wt.join("out").join("auto").join("asset_frames");
    let _ = std::fs::create_dir_all(&frames_dir);
    let mut rows = vec![];
    let mut texts = vec![];
    for a in assets {
        let f = dir.join(&a.name);
        let mut detail = format!("{:.1} MB", a.bytes as f64 / 1_048_576.0);
        let mut frames = vec![];
        if ["image", "video", "recording", "music"].contains(&a.kind.as_str()) {
            if let Some(p) = probe(&f) {
                let st = p["streams"].as_array().cloned().unwrap_or_default();
                if let Some(v) = st.iter().find(|s| s["codec_type"] == "video") {
                    detail.push_str(&format!("，{}×{}", v["width"], v["height"]));
                }
                let dur = p["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0);
                if dur > 0.0 && a.kind != "image" {
                    detail.push_str(&format!("，{dur:.1} 秒"));
                }
                if ["video", "recording"].contains(&a.kind.as_str()) && dur > 0.0 {
                    let stem = Path::new(&a.name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    for (i, t) in [0.08, 0.35, 0.62, 0.9].iter().enumerate() {
                        let out = frames_dir.join(format!("{stem}-{}.jpg", i + 1));
                        let ts = format!("{:.2}", dur * t);
                        let ok = run("ffmpeg", &["-hide_banner", "-loglevel", "error", "-y", "-ss", &ts, "-i", &f.to_string_lossy(), "-frames:v", "1", "-vf", "scale=960:-2", &out.to_string_lossy()], None, Duration::from_secs(60))
                            .map(|o| o.ok())
                            .unwrap_or(false);
                        if ok && out.exists() {
                            frames.push(format!("out/auto/asset_frames/{stem}-{}.jpg（{ts} 秒）", i + 1));
                        }
                    }
                }
            }
        }
        let usage = match a.kind.as_str() {
            "image" => format!("畫面中使用：<Img src={{staticFile('user/{ep}/{}')}} />（import {{Img, staticFile}} from 'remotion'）", a.name),
            "video" | "recording" => format!("畫面中使用：<OffthreadVideo src={{staticFile('user/{ep}/{}')}} muted />，可用 startFrom／endAt 截取片段", a.name),
            "music" => "背景音樂：Studio 混音時自動使用（循環／裁切到影片長度），不需要寫程式".into(),
            "script" => "使用者的自訂腳本（旁白來源）".into(),
            _ => format!("用 Read 讀取：public/user/{ep}/{}", a.name),
        };
        rows.push(format!(
            "| `public/user/{ep}/{}` | {} | {} | {} | {}{} |",
            a.name,
            kind_label(&a.kind),
            detail,
            if a.note.is_empty() { "—".into() } else { a.note.replace('|', "／") },
            usage,
            if frames.is_empty() { String::new() } else { format!("；關鍵幀（用 Read 查看）：{}", frames.join("、")) }
        ));
        if ["text", "reference", "script"].contains(&a.kind.as_str()) {
            if let Ok(b) = std::fs::read(&f) {
                let t = String::from_utf8_lossy(&b).to_string();
                if t.chars().count() <= 6000 && !t.trim().is_empty() {
                    texts.push(format!("### {}\n\n{}\n", a.name, t.trim()));
                }
            }
        }
    }
    let md = format!(
        "# {} 素材清單\n\n素材資料夾：public/user/{ep}/（Studio 匯入的使用者檔案；不要修改或刪除）\n\n| 檔案 | 類型 | 資訊 | 使用者說明 | 使用方式 |\n|---|---|---|---|---|\n{}\n\n{}",
        ep.to_uppercase(),
        rows.join("\n"),
        if texts.is_empty() { String::new() } else { format!("## 文字素材內容\n\n{}", texts.join("\n")) }
    );
    let _ = std::fs::write(wt.join("out").join("auto").join("ASSETS.md"), &md);
    md
}

/// Prompt section listing the material (empty when there is none).
pub fn prompt_block(ep: &str, assets: &[Asset]) -> String {
    if assets.is_empty() {
        return String::new();
    }
    let list: Vec<String> = assets
        .iter()
        .map(|a| format!("- public/user/{ep}/{}（{}）{}", a.name, kind_label(&a.kind), if a.note.is_empty() { String::new() } else { format!("：{}", a.note) }))
        .collect();
    let visual = assets.iter().any(|a| ["image", "video", "recording"].contains(&a.kind.as_str()));
    format!(
        "\n【使用者提供的素材】完整清單與使用方式在 out/auto/ASSETS.md（先讀）。\n{}\n- 文字、PDF、參考文件：用 Read 讀取並依內容撰寫，不要虛構其中沒有的細節。\n{}",
        list.join("\n"),
        if visual {
            "- 圖片、截圖、影片、操作錄影：畫面必須使用這些真實素材（staticFile 讀取），不得自行畫出虛構的軟體介面或假截圖；可以加框線、放大、標註箭頭與文字說明。影片素材先用 Read 看 out/auto/asset_frames/ 的關鍵幀了解內容。\n"
        } else {
            ""
        }
    )
}

/// Junction `<wt or root>/public/user/<ep>` → `<video>/assets`.
pub fn link(base: &Path, ep: &str, assets_dir: &Path) -> Result<bool, String> {
    let l = base.join("public").join("user").join(ep);
    if std::fs::symlink_metadata(&l).is_ok() || !assets_dir.exists() {
        return Ok(false);
    }
    std::fs::create_dir_all(l.parent().unwrap()).map_err(|e| e.to_string())?;
    crate::platform::link_dir(&l, assets_dir).map_err(|e| format!("無法建立素材連結 {}：{e}", clean_path(&l)))?;
    Ok(true)
}

/// Remove `public/user/*` junctions (never the material itself).
pub fn unlink_all(base: &Path) {
    if let Ok(rd) = std::fs::read_dir(base.join("public").join("user")) {
        for e in rd.flatten() {
            if std::fs::symlink_metadata(e.path()).map(|m| m.file_type().is_symlink() || is_junction(&e.path())).unwrap_or(false) {
                let _ = crate::platform::unlink_dir(&e.path());
            }
        }
    }
}

fn is_junction(p: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        std::fs::symlink_metadata(p).map(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0).unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = p;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_import() {
        assert_eq!(detect_kind("a/B.PNG"), Some("image"));
        assert_eq!(detect_kind("x.mp3"), Some("music"));
        assert_eq!(detect_kind("x.exe"), None);
        let d = std::env::temp_dir().join(format!("pikara-assets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        let src = d.join("我的 截圖.png");
        std::fs::write(&src, b"\x89PNG").unwrap();
        let txt = d.join("script.md");
        std::fs::write(&txt, "## 開場\n你好。").unwrap();
        let mut list = vec![
            Asset { source: src.to_string_lossy().into(), ..Default::default() },
            Asset { source: txt.to_string_lossy().into(), kind: "script".into(), ..Default::default() },
            Asset { source: src.to_string_lossy().into(), note: "第二份".into(), ..Default::default() },
        ];
        let out = d.join("EP09").join("assets");
        import(&out, &mut list).unwrap();
        assert_eq!(list[0].kind, "image");
        assert_eq!(list[0].name, "我的_截圖.png");
        assert_eq!(list[2].name, "我的_截圖-2.png");
        assert!(out.join("我的_截圖-2.png").exists());
        assert_eq!(script_text(&out, &list).unwrap(), "## 開場\n你好。");
        let again = list.clone();
        import(&out, &mut list).unwrap();
        assert_eq!(list, again, "re-import is a no-op");
        let mut bad = vec![Asset { source: txt.to_string_lossy().into(), kind: "image".into(), ..Default::default() }];
        assert!(import(&out, &mut bad).is_err());
        let p = prompt_block("ep09", &list);
        assert!(p.contains("public/user/ep09/我的_截圖.png") && p.contains("不得自行畫出虛構"), "{p}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
