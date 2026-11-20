//! Multi-episode support: an episode is `sequences.<epId>` in narration.json (zh-TW `src/`, zh-CN `src_cn/`,
//! managed independently). Create a new episode skeleton (validated, atomic write, git commit of that file only),
//! list episodes with their timeline / voice / output status.

use crate::narration;
use crate::util::clean_path;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::path::Path;

static RE_EP: Lazy<Regex> = Lazy::new(|| Regex::new(r"^ep\d{2,3}$").unwrap());

/// `ep01`, `ep02`, `ep120` (lower-case "ep" + 2–3 digits).
pub fn valid_id(id: &str) -> bool {
    RE_EP.is_match(id)
}

pub fn number(id: &str) -> Option<u32> {
    valid_id(id).then(|| id[2..].parse().ok()).flatten()
}

/// Next free id after the highest existing `epNN` (ep01 when none).
pub fn next_id(doc: &Value) -> String {
    let max = doc["sequences"].as_object().map(|m| m.keys().filter_map(|k| number(k)).max().unwrap_or(0)).unwrap_or(0);
    format!("ep{:02}", max + 1)
}

pub fn exists(root: &Path, locale: &str, id: &str) -> bool {
    narration::read(root, locale).map(|r| r["doc"]["sequences"].get(id).is_some()).unwrap_or(false)
}

/// The skeleton the user then edits in the Script editor: one scene, one line. Every field passes
/// `narration::validate` (no anchors yet; the line id is `<ep>-01`, unique inside the sequence).
pub fn skeleton(id: &str, title: &str, scene_title: &str, first_line: &str) -> Value {
    json!({
        "voiceEngine": "cosyvoice",
        "title": title,
        "scenes": [{
            "id": "s01",
            "title": scene_title,
            "lines": [{ "id": format!("{id}-01"), "subtitle": first_line }]
        }]
    })
}

pub struct NewEpisode<'a> {
    pub id: Option<&'a str>,
    pub title: &'a str,
    pub scene_title: Option<&'a str>,
    pub first_line: Option<&'a str>,
    pub locales: Vec<String>,
}

/// Insert `sequences.<id>` into each requested narration file, validate the whole document, write atomically
/// and commit only that file ("Studio: new episode <id>"). Refuses an existing id (never overwrites an episode).
pub fn create(root: &Path, req: &NewEpisode) -> Result<Value, String> {
    let title = req.title.trim();
    if title.is_empty() {
        return Err("請輸入新集數的標題".into());
    }
    if title.chars().count() > 80 {
        return Err("標題太長（最多 80 字）".into());
    }
    if req.locales.is_empty() {
        return Err("請至少選擇一個語系（zh-TW 或 zh-CN）".into());
    }
    // Pick the id once (from zh-TW when present) so both locales get the same episode id.
    let first = narration::read(root, &req.locales[0])?;
    let id = match req.id.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()) {
        Some(i) => {
            if !valid_id(&i) {
                return Err(format!("集數 id「{i}」格式不正確：請用 ep 加 2–3 位數字，例如 ep02"));
            }
            i
        }
        None => next_id(&first["doc"]),
    };
    let scene_title = req.scene_title.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("開場");
    let first_line = req.first_line.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("在這裡輸入第一句旁白。");
    let mut results = vec![];
    for loc in &req.locales {
        let r = narration::read(root, loc)?;
        if r["doc"]["sequences"].get(&id).is_some() {
            return Err(format!("{loc} 的旁白已經有 {id}，不會覆寫既有集數。請換一個 id。"));
        }
    }
    for loc in &req.locales {
        let r = narration::read(root, loc)?;
        let mut doc = r["doc"].clone();
        let seqs = doc
            .get_mut("sequences")
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| format!("{} 缺少 sequences 物件", r["path"].as_str().unwrap_or("")))?;
        seqs.insert(id.clone(), skeleton(&id, title, scene_title, first_line));
        let v = narration::validate(&doc);
        if !v.ok {
            return Err(format!("新集數驗證失敗：{}", v.errors.iter().take(3).map(|e| e.message.clone()).collect::<Vec<_>>().join("；")));
        }
        let msg = format!("Studio: new episode {id}（{loc}）");
        let saved = narration::save(root, loc, &doc, r["sha256"].as_str().unwrap_or(""), Some(&msg))?;
        results.push(json!({"locale": loc, "path": r["path"], "sha256": saved["sha256"], "commit": saved["commit"], "commitError": saved["commitError"]}));
    }
    let ep = id.to_ascii_uppercase();
    Ok(json!({
        "episodeId": id,
        "title": title,
        "files": results,
        "compositions": [ep.clone(), format!("{ep}-30fps"), format!("{ep}-YT15")],
        "outputs": outputs_for(&id),
        "next": "在「劇本編輯」選擇這一集，寫好旁白（字幕、朗讀、錨點）後存檔；再到「製作」產生配音、時間軸並渲染。",
    }))
}

/// Default deliverable names for an episode.
pub fn outputs_for(id: &str) -> Value {
    let ep = id.to_ascii_uppercase();
    json!({
        "final": format!("{ep}_Final.mp4"),
        "srt": format!("{ep}.srt"),
        "youtube": format!("{ep}_YouTube_zh-TW.mp4"),
        "youtubeSrt": format!("{ep}_YouTube_zh-TW.srt"),
        "bilibili": format!("{ep}_Bilibili_zh-CN.mp4"),
        "bilibiliSrt": format!("{ep}_Bilibili_zh-CN.srt"),
    })
}

fn timeline_ids(root: &Path, src: &str) -> Map<String, Value> {
    let p = root.join(src).join("data").join("timeline.generated.json");
    std::fs::read_to_string(p)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// All episodes (union of zh-TW and zh-CN narration), sorted by number, with per-locale status.
pub fn list(root: &Path) -> Value {
    let mut ids: Vec<String> = vec![];
    let mut per: Vec<(String, Value)> = vec![];
    for (loc, src, voice) in [("zh-TW", "src", "voiceover_cosy"), ("zh-CN", "src_cn", "voiceover_cosy_cn")] {
        let Ok(r) = narration::read(root, loc) else { continue };
        let tls = timeline_ids(root, src);
        for (k, seq) in r["doc"]["sequences"].as_object().cloned().unwrap_or_default() {
            if !valid_id(&k) {
                continue;
            }
            if !ids.contains(&k) {
                ids.push(k.clone());
            }
            let scenes = seq["scenes"].as_array().cloned().unwrap_or_default();
            let line_ids: Vec<String> = scenes.iter().flat_map(|s| s["lines"].as_array().cloned().unwrap_or_default()).filter_map(|l| l["id"].as_str().map(String::from)).collect();
            let vdir = root.join("public").join("assets").join("audio").join(voice).join(&k);
            let voiced = line_ids.iter().filter(|l| vdir.join(format!("{l}.mp3")).exists()).count();
            let tl = tls.get(&k);
            per.push((k.clone(), json!({
                "locale": loc,
                "title": seq["title"],
                "scenes": scenes.len(),
                "lines": line_ids.len(),
                "voiced": voiced,
                "timeline": tl.map(|t| json!({"totalFrames": t["totalFrames"], "duration": t["duration"], "mix": t["mix"]})),
            })));
        }
    }
    ids.sort_by_key(|k| number(k).unwrap_or(0));
    Value::Array(
        ids.iter()
            .map(|k| {
                let outs = outputs_for(k);
                let present: Map<String, Value> = outs
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(n, f)| {
                        let p = root.join(f.as_str().unwrap());
                        (n.clone(), if p.is_file() { json!(clean_path(&p)) } else { Value::Null })
                    })
                    .collect();
                let locales: Map<String, Value> = per.iter().filter(|(id, _)| id == k).map(|(_, v)| (v["locale"].as_str().unwrap().to_string(), v.clone())).collect();
                let title = locales.get("zh-TW").or(locales.get("zh-CN")).map(|v| v["title"].clone()).unwrap_or(Value::Null);
                json!({
                    "id": k,
                    "comp": k.to_ascii_uppercase(),
                    "title": title,
                    "locales": locales,
                    "outputs": outs,
                    "present": present,
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitops;

    fn temp_project(narr_tw: &str, narr_cn: Option<&str>) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pss-ep 測試 {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("src").join("data")).unwrap();
        std::fs::write(d.join("src").join("data").join("narration.json"), narr_tw).unwrap();
        if let Some(c) = narr_cn {
            std::fs::create_dir_all(d.join("src_cn").join("data")).unwrap();
            std::fs::write(d.join("src_cn").join("data").join("narration.json"), c).unwrap();
        }
        gitops::git(&d, &["init", "-q"]).unwrap();
        gitops::git(&d, &["add", "."]).unwrap();
        gitops::git_commit(&d, &["commit", "-qm", "init"]).unwrap();
        d
    }

    const BASE: &str = "{\n  \"fps\": 60,\n  \"sequences\": {\n    \"arttest\": {\n      \"scenes\": []\n    },\n    \"ep01\": {\n      \"title\": \"EP01\",\n      \"scenes\": [\n        {\n          \"id\": \"act01\",\n          \"lines\": [\n            {\n              \"id\": \"a1-00\",\n              \"subtitle\": \"按下 Enter\"\n            }\n          ]\n        }\n      ]\n    }\n  }\n}\n";

    #[test]
    fn ids_and_next() {
        assert!(valid_id("ep02") && valid_id("ep120") && !valid_id("ep1") && !valid_id("EP02") && !valid_id("ep02;x") && !valid_id("arttest"));
        let doc: Value = serde_json::from_str(BASE).unwrap();
        assert_eq!(next_id(&doc), "ep02");
        assert_eq!(next_id(&json!({"sequences": {"ep09": {}, "ep10": {}, "arttest": {}}})), "ep11");
        assert_eq!(next_id(&json!({"sequences": {}})), "ep01");
    }

    #[test]
    fn create_validates_commits_and_never_overwrites() {
        let d = temp_project(BASE, Some(BASE));
        let r = create(&d, &NewEpisode { id: None, title: "什麼是 Token", scene_title: None, first_line: None, locales: vec!["zh-TW".into()] }).unwrap();
        assert_eq!(r["episodeId"], "ep02");
        assert!(r["files"][0]["commit"].is_string(), "{r}");
        assert_eq!(r["compositions"], json!(["EP02", "EP02-30fps", "EP02-YT15"]));
        assert_eq!(r["outputs"]["bilibili"], "EP02_Bilibili_zh-CN.mp4");
        // written file: ep01 untouched, ep02 appended, document still valid
        let tw = narration::read(&d, "zh-TW").unwrap();
        assert!(narration::validate(&tw["doc"]).ok);
        assert_eq!(tw["doc"]["sequences"]["ep01"]["scenes"][0]["lines"][0]["subtitle"], "按下 Enter");
        assert_eq!(tw["doc"]["sequences"]["ep02"]["scenes"][0]["lines"][0]["id"], "ep02-01");
        let keys: Vec<&String> = tw["doc"]["sequences"].as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["arttest", "ep01", "ep02"], "key order preserved, new episode last");
        // zh-CN managed independently: not touched
        let cn = narration::read(&d, "zh-CN").unwrap();
        assert!(cn["doc"]["sequences"].get("ep02").is_none());
        assert_eq!(gitops::log(&d, 1).unwrap()[0]["subject"], "Studio: new episode ep02（zh-TW）");
        // refuses existing id, bad id, empty title
        assert!(create(&d, &NewEpisode { id: Some("ep02"), title: "x", scene_title: None, first_line: None, locales: vec!["zh-TW".into()] }).unwrap_err().contains("不會覆寫"));
        assert!(create(&d, &NewEpisode { id: Some("ep2"), title: "x", scene_title: None, first_line: None, locales: vec!["zh-TW".into()] }).is_err());
        assert!(create(&d, &NewEpisode { id: None, title: "  ", scene_title: None, first_line: None, locales: vec!["zh-TW".into()] }).is_err());
        // both locales at once → same id ep03 in both files
        let r3 = create(&d, &NewEpisode { id: None, title: "EP03", scene_title: Some("第一段"), first_line: Some("第一句。"), locales: vec!["zh-TW".into(), "zh-CN".into()] }).unwrap();
        assert_eq!(r3["episodeId"], "ep03");
        assert!(narration::read(&d, "zh-CN").unwrap()["doc"]["sequences"].get("ep03").is_some());
        let l = list(&d);
        let ids: Vec<&str> = l.as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["ep01", "ep02", "ep03"]);
        assert_eq!(l[1]["locales"]["zh-TW"]["lines"], 1);
        assert!(l[1]["locales"].get("zh-CN").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }
}
