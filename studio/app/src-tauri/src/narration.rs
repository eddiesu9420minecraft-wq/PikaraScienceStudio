//! narration.json editor backend: read, validate (same rules as scripts/build_timeline.py), atomic save + git commit.

use crate::gitops;
use crate::util::{atomic_write, sha256_hex};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Same punctuation set as build_timeline.py `PUNCT`.
const PUNCT: &str = "，。？！；：、,.?!;:「」『』（）() ";

pub fn norm(s: &str) -> String {
    s.chars().filter(|c| !PUNCT.contains(*c) && !c.is_whitespace()).flat_map(|c| c.to_lowercase()).collect()
}

pub fn rel_path(locale: &str) -> Result<&'static str, String> {
    match locale {
        "zh-TW" => Ok("src/data/narration.json"),
        "zh-CN" => Ok("src_cn/data/narration.json"),
        _ => Err(format!("unknown locale {locale} (use zh-TW or zh-CN)")),
    }
}

pub fn file_path(root: &Path, locale: &str) -> Result<PathBuf, String> {
    Ok(root.join(rel_path(locale)?.replace('/', "\\")))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub seq_key: String,
    pub scene_id: Option<String>,
    pub line_id: Option<String>,
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Validation {
    pub ok: bool,
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
}

fn s(v: &Value) -> Option<&str> {
    v.as_str()
}

/// Structured view: sequences → scenes → lines.
pub fn summarize(doc: &Value) -> Vec<Value> {
    let mut out = vec![];
    if let Some(seqs) = doc.get("sequences").and_then(|v| v.as_object()) {
        for (key, seq) in seqs {
            let scenes: Vec<Value> = seq
                .get("scenes")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|sc| {
                            let lines: Vec<Value> = sc
                                .get("lines")
                                .and_then(|v| v.as_array())
                                .map(|ls| {
                                    ls.iter()
                                        .map(|l| {
                                            json!({
                                                "id": l.get("id").cloned().unwrap_or(Value::Null),
                                                "subtitle": l.get("subtitle").cloned().unwrap_or(json!("")),
                                                "speak": l.get("speak").cloned().unwrap_or(Value::Null),
                                                "anchors": l.get("anchors").cloned().unwrap_or(json!({})),
                                                "pauseAfter": l.get("pauseAfter").cloned().unwrap_or(Value::Null),
                                            })
                                        })
                                        .collect()
                                })
                                .unwrap_or_default();
                            json!({"id": sc.get("id"), "title": sc.get("title"), "lines": lines})
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.push(json!({
                "key": key,
                "title": seq.get("title").cloned().unwrap_or(Value::Null),
                "voiceEngine": seq.get("voiceEngine").cloned().unwrap_or(Value::Null),
                "scenes": scenes
            }));
        }
    }
    out
}

pub fn validate(doc: &Value) -> Validation {
    let mut errors = vec![];
    let mut warnings = vec![];
    let err = |list: &mut Vec<Issue>, seq: &str, sc: Option<&str>, ln: Option<&str>, field: &str, msg: String| {
        list.push(Issue {
            seq_key: seq.into(),
            scene_id: sc.map(|x| x.into()),
            line_id: ln.map(|x| x.into()),
            field: field.into(),
            message: msg,
        })
    };
    let Some(seqs) = doc.get("sequences").and_then(|v| v.as_object()) else {
        err(&mut errors, "", None, None, "sequences", "缺少 sequences 物件".into());
        return Validation { ok: false, errors, warnings };
    };
    for (key, seq) in seqs {
        let Some(scenes) = seq.get("scenes").and_then(|v| v.as_array()) else {
            err(&mut errors, key, None, None, "scenes", "缺少 scenes 陣列".into());
            continue;
        };
        let mut scene_ids = HashSet::new();
        let mut line_ids: HashMap<String, String> = HashMap::new();
        for sc in scenes {
            let sid = sc.get("id").and_then(s).unwrap_or("");
            if sid.is_empty() {
                err(&mut errors, key, None, None, "id", "場景缺少 id".into());
            } else if !scene_ids.insert(sid.to_string()) {
                err(&mut errors, key, Some(sid), None, "id", format!("場景 id 重複：{sid}"));
            }
            let Some(lines) = sc.get("lines").and_then(|v| v.as_array()) else {
                err(&mut errors, key, Some(sid), None, "lines", "缺少 lines 陣列".into());
                continue;
            };
            if lines.is_empty() {
                err(&mut warnings, key, Some(sid), None, "lines", "這個場景沒有任何句子".into());
            }
            let mut anchor_names = HashSet::new();
            for l in lines {
                let lid = l.get("id").and_then(s).unwrap_or("");
                if lid.is_empty() {
                    err(&mut errors, key, Some(sid), None, "id", "句子缺少 id".into());
                } else if let Some(prev) = line_ids.insert(lid.to_string(), sid.to_string()) {
                    err(&mut errors, key, Some(sid), Some(lid), "id", format!("句子 id 重複：{lid}（也出現在 {prev}）"));
                }
                let subtitle = l.get("subtitle").and_then(s).unwrap_or("");
                if subtitle.trim().is_empty() {
                    err(&mut errors, key, Some(sid), Some(lid), "subtitle", "字幕是空的".into());
                }
                let speak_v = l.get("speak");
                if let Some(v) = speak_v {
                    if !v.is_string() && !v.is_null() {
                        err(&mut errors, key, Some(sid), Some(lid), "speak", "speak 必須是字串".into());
                    }
                }
                let speak = speak_v.and_then(s).filter(|x| !x.trim().is_empty()).unwrap_or(subtitle);
                if let Some(p) = l.get("pauseAfter") {
                    match p.as_f64() {
                        Some(x) if (0.0..=10.0).contains(&x) => {}
                        _ => err(&mut errors, key, Some(sid), Some(lid), "pauseAfter", format!("pauseAfter 必須是 0–10 秒的數字（目前 {p}）")),
                    }
                }
                if subtitle.chars().count() > 40 {
                    err(&mut warnings, key, Some(sid), Some(lid), "subtitle", format!("字幕 {} 字，偏長（會被切成多段）", subtitle.chars().count()));
                }
                if let Some(anchors) = l.get("anchors") {
                    match anchors.as_object() {
                        None => err(&mut errors, key, Some(sid), Some(lid), "anchors", "anchors 必須是物件".into()),
                        Some(map) => {
                            let ns = norm(speak);
                            for (name, word) in map {
                                let w = word.as_str().unwrap_or("");
                                if w.is_empty() || !ns.contains(&norm(w)) {
                                    let in_sub = !w.is_empty() && norm(subtitle).contains(&norm(w));
                                    let hint = if in_sub && speak != subtitle { "（只出現在字幕，朗讀文字 speak 裡沒有）" } else { "" };
                                    err(&mut errors, key, Some(sid), Some(lid), "anchors", format!("錨點「{name}」的詞「{w}」不在朗讀文字中{hint}"));
                                }
                                if !anchor_names.insert(name.clone()) {
                                    err(&mut errors, key, Some(sid), Some(lid), "anchors", format!("場景 {sid} 內錨點名稱重複：{name}"));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Validation { ok: errors.is_empty(), errors, warnings }
}

/// Serialize like Python `json.dumps(indent=2, ensure_ascii=False)` and keep the file's newline style.
pub fn serialize_like(doc: &Value, original: &str) -> Result<String, String> {
    let mut out = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    if original.contains("\r\n") {
        out = out.replace('\n', "\r\n");
    }
    let nl = if original.contains("\r\n") { "\r\n" } else { "\n" };
    if original.ends_with('\n') && !out.ends_with('\n') {
        out.push_str(nl);
    }
    Ok(out)
}

pub fn read(root: &Path, locale: &str) -> Result<Value, String> {
    let p = file_path(root, locale)?;
    let bytes = std::fs::read(&p).map_err(|e| format!("讀取 {} 失敗：{e}", p.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let doc: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("{} 不是有效 JSON：{e}", p.display()))?;
    Ok(json!({
        "path": crate::util::clean_path(&p),
        "locale": locale,
        "sha256": sha256_hex(&bytes),
        "sequences": summarize(&doc),
        "doc": doc,
    }))
}

pub fn save(root: &Path, locale: &str, doc: &Value, expected_sha: &str, message: Option<&str>) -> Result<Value, String> {
    let validation = validate(doc);
    if !validation.ok {
        return Err(format!(
            "驗證失敗，未儲存：{}",
            validation.errors.iter().take(5).map(|e| e.message.clone()).collect::<Vec<_>>().join("；")
        ));
    }
    let p = file_path(root, locale)?;
    let original = std::fs::read(&p).map_err(|e| format!("讀取 {} 失敗：{e}", p.display()))?;
    let cur_sha = sha256_hex(&original);
    if !expected_sha.is_empty() && cur_sha != expected_sha {
        return Err("檔案在外部被修改過（sha256 不同），請重新載入後再儲存".into());
    }
    let text = serialize_like(doc, &String::from_utf8_lossy(&original))?;
    if text.as_bytes() == original.as_slice() {
        return Ok(json!({"sha256": cur_sha, "commit": Value::Null, "commitError": "沒有變更", "validation": validation}));
    }
    atomic_write(&p, text.as_bytes())?;
    let new_sha = sha256_hex(text.as_bytes());
    let rel = rel_path(locale)?;
    let msg = message.filter(|m| !m.trim().is_empty()).unwrap_or("Studio: edit narration");
    let (commit, commit_error) = commit_file(root, rel, msg);
    Ok(json!({"sha256": new_sha, "commit": commit, "commitError": commit_error, "validation": validation}))
}

/// `git add <file>` + `git commit -m msg -- <file>` (only that file, never the user's other changes).
pub fn commit_file(root: &Path, rel: &str, msg: &str) -> (Option<String>, Option<String>) {
    match gitops::git(root, &["add", "--", rel]) {
        Ok(o) if o.ok() => {}
        Ok(o) => return (None, Some(o.combined())),
        Err(e) => return (None, Some(e)),
    }
    match gitops::git_commit(root, &["commit", "-m", msg, "--", rel]) {
        Ok(o) if o.ok() => {
            let h = gitops::git(root, &["rev-parse", "HEAD"]).ok().map(|o| o.stdout.trim().to_string());
            (h, None)
        }
        Ok(o) => (None, Some(o.combined())),
        Err(e) => (None, Some(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_root() -> PathBuf {
        // studio/app/src-tauri → project root
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
    }

    #[test]
    fn real_narration_validates_and_roundtrips_byte_exact() {
        for loc in ["zh-TW", "zh-CN"] {
            let p = file_path(&project_root(), loc).unwrap();
            if !p.exists() {
                continue;
            }
            let original = std::fs::read_to_string(&p).unwrap();
            let doc: Value = serde_json::from_str(&original).unwrap();
            let v = validate(&doc);
            assert!(v.ok, "{loc}: {:?}", v.errors);
            assert_eq!(serialize_like(&doc, &original).unwrap(), original, "{loc} round-trip must be byte-exact");
            if loc == "zh-TW" {
                let seqs = summarize(&doc);
                let ep = seqs.iter().find(|s| s["key"] == "ep01").unwrap();
                let n: usize = ep["scenes"].as_array().unwrap().iter().map(|s| s["lines"].as_array().unwrap().len()).sum();
                assert_eq!(n, 75, "PROGRESS.md says 75 lines");
            }
        }
    }

    #[test]
    fn detects_bad_anchor_duplicate_ids_and_pause() {
        let doc = json!({"sequences": {"x": {"scenes": [
            {"id": "s1", "lines": [
                {"id": "a", "subtitle": "量化之後很小", "speak": "壓縮之後很小", "anchors": {"k": "量化"}},
                {"id": "a", "subtitle": "按下 Enter", "anchors": {"e": "按下"}, "pauseAfter": 99}
            ]},
            {"id": "s1", "lines": [{"id": "b", "subtitle": "", "anchors": {"g": "GPU"}}]}
        ]}}});
        let v = validate(&doc);
        assert!(!v.ok);
        let msgs: Vec<String> = v.errors.iter().map(|e| format!("{}:{}", e.field, e.message)).collect();
        assert!(msgs.iter().any(|m| m.starts_with("anchors") && m.contains("量化") && m.contains("只出現在字幕")), "{msgs:?}");
        assert!(msgs.iter().any(|m| m.contains("句子 id 重複")));
        assert!(msgs.iter().any(|m| m.contains("場景 id 重複")));
        assert!(msgs.iter().any(|m| m.starts_with("pauseAfter")));
        assert!(msgs.iter().any(|m| m.starts_with("subtitle")));
        assert!(msgs.iter().any(|m| m.contains("GPU")));
        // punctuation/space/case-insensitive match exactly like build_timeline.norm ("llama.cpp" ~ "llama C P P")
        let ok = json!({"sequences": {"x": {"scenes": [{"id": "s", "lines": [{"id": "1", "subtitle": "GPU，也就是顯示卡", "anchors": {"g": "gpu"}},
            {"id": "2", "subtitle": "llama.cpp", "speak": "llama C P P", "anchors": {"l": "llama.cpp"}}]}]}}});
        assert!(validate(&ok).ok);
    }

    #[test]
    fn save_is_atomic_commits_and_detects_external_edits() {
        let d = std::env::temp_dir().join(format!("pss-narr-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("src").join("data")).unwrap();
        let p = d.join("src").join("data").join("narration.json");
        let orig = "{\r\n  \"sequences\": {\r\n    \"x\": {\r\n      \"scenes\": [\r\n        {\r\n          \"id\": \"s\",\r\n          \"lines\": [\r\n            {\r\n              \"id\": \"1\",\r\n              \"subtitle\": \"按下 Enter\"\r\n            }\r\n          ]\r\n        }\r\n      ]\r\n    }\r\n  }\r\n}";
        std::fs::write(&p, orig).unwrap();
        gitops::git(&d, &["init", "-q"]).unwrap();
        gitops::git(&d, &["add", "."]).unwrap();
        gitops::git_commit(&d, &["commit", "-qm", "init"]).unwrap();
        let r = read(&d, "zh-TW").unwrap();
        let sha = r["sha256"].as_str().unwrap().to_string();
        let mut doc = r["doc"].clone();
        doc["sequences"]["x"]["scenes"][0]["lines"][0]["subtitle"] = json!("按下 Enter 之後");
        // bad edit refused, file untouched
        let mut bad = doc.clone();
        bad["sequences"]["x"]["scenes"][0]["lines"][0]["anchors"] = json!({"z": "不存在"});
        assert!(save(&d, "zh-TW", &bad, &sha, None).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), orig);
        // wrong sha refused
        assert!(save(&d, "zh-TW", &doc, "deadbeef", None).unwrap_err().contains("外部"));
        let res = save(&d, "zh-TW", &doc, &sha, None).unwrap();
        assert!(res["commit"].is_string(), "{res}");
        let written = std::fs::read_to_string(&p).unwrap();
        assert!(written.contains("按下 Enter 之後") && written.contains("\r\n"));
        let l = gitops::log(&d, 5).unwrap();
        assert_eq!(l[0]["subject"], "Studio: edit narration");
        let _ = std::fs::remove_dir_all(&d);
    }
}
