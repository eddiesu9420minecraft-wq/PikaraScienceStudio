//! v0.3 episode workspace: stages, input fingerprints, freshness and asset versions.
//!
//! The UI never guesses paths: every location, status and timestamp shown for an episode comes from here.
//!
//! Stage graph (per episode × language):
//! ```text
//!   script ──► voice (per line) ──► timeline + subtitles ──► mix ──► video (frames + encode) ──► qa
//!                                         ▲                    ▲          ▲
//!               tempo preset, grid ───────┘   mix script, bgm ─┘          └── animation code, encode settings
//! ```
//! Each derived stage has an *input fingerprint* (sha256 of exactly the inputs that change its output). When a
//! job finishes, the fingerprint of what it consumed is stored in `stage_records`; a stage is **fresh** when the
//! stored fingerprint equals the current one, **stale** when it differs, **missing** when there is no output.
//! Voice is tracked per line by content: the line's audio JSON records the text it spoke, so changing one line's
//! text marks exactly that line (and everything downstream) stale — nothing else.
//!
//! Legacy episodes (made before v0.3, no records): the first time an episode is opened, a stage whose output is
//! newer than all of its input files is *adopted* (its current fingerprint is recorded with `adopted = 1`), so
//! later edits are detected by fingerprint from then on.

use crate::db::{self, Settings};
use crate::util::{clean_path, now_iso, sha256_hex};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const MIGRATION: &str = r#"
CREATE TABLE stage_records (
  project_root TEXT NOT NULL,
  episode      TEXT NOT NULL,
  locale       TEXT NOT NULL,
  stage        TEXT NOT NULL,
  variant      TEXT NOT NULL DEFAULT '',
  input_fp     TEXT NOT NULL,
  output_path  TEXT,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  job_id       TEXT,
  adopted      INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (project_root, episode, locale, stage, variant)
);
CREATE TABLE asset_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_root TEXT NOT NULL,
  episode      TEXT NOT NULL,
  locale       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('voice','video')),
  item         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  path         TEXT NOT NULL,
  sha256       TEXT,
  status       TEXT NOT NULL CHECK (status IN ('candidate','active','archived','rejected')),
  meta_json    TEXT NOT NULL DEFAULT '{}',
  job_id       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_asset_versions ON asset_versions(project_root, episode, locale, kind, item, version);
"#;

/// Max Whisper character error rate for a re-voiced line to be switched in automatically
/// (same default as generate_voiceover_cosy.py --max-cer).
pub const MAX_CER: f64 = 0.25;

// ------------------------------------------------------------------ episode paths

#[derive(Clone, Debug)]
pub struct Ep {
    pub root: PathBuf,
    pub id: String,
    pub locale: String,
}

impl Ep {
    pub fn new(root: &Path, id: &str, locale: &str) -> Result<Ep, String> {
        if !crate::episodes::valid_id(id) {
            return Err(format!("集數 id 不正確：{id}"));
        }
        if !["zh-TW", "zh-CN"].contains(&locale) {
            return Err(format!("語言必須是 zh-TW 或 zh-CN：{locale}"));
        }
        Ok(Ep { root: root.to_path_buf(), id: id.to_string(), locale: locale.to_string() })
    }
    pub fn cn(&self) -> bool {
        self.locale == "zh-CN"
    }
    pub fn src(&self) -> &'static str {
        if self.cn() { "src_cn" } else { "src" }
    }
    pub fn upper(&self) -> String {
        self.id.to_ascii_uppercase()
    }
    pub fn voice_root_rel(&self) -> &'static str {
        if self.cn() { "public/assets/audio/voiceover_cosy_cn" } else { "public/assets/audio/voiceover_cosy" }
    }
    pub fn voice_dir(&self) -> PathBuf {
        self.root.join(self.voice_root_rel()).join(&self.id)
    }
    pub fn timeline_path(&self) -> PathBuf {
        self.root.join(self.src()).join("data").join("timeline.generated.json")
    }
    pub fn narration_path(&self) -> PathBuf {
        self.root.join(self.src()).join("data").join("narration.json")
    }
    pub fn mix_name(&self) -> String {
        if self.cn() { format!("{}_cn", self.id) } else { self.id.clone() }
    }
    pub fn mix_path(&self) -> PathBuf {
        self.root.join("public").join("assets").join("audio").join("mix").join(format!("{}.wav", self.mix_name()))
    }
    pub fn video_dir(&self) -> PathBuf {
        crate::layout::video_dir(&self.root, &self.id)
    }
    /// Deliverable file name of this language version.
    pub fn output_name(&self) -> String {
        if self.cn() { format!("{}_Bilibili_zh-CN.mp4", self.upper()) } else { format!("{}_Final.mp4", self.upper()) }
    }
    pub fn srt_name(&self) -> String {
        if self.cn() { format!("{}_Bilibili_zh-CN.srt", self.upper()) } else { format!("{}.srt", self.upper()) }
    }
    /// Current deliverable: projects/EPxx/output/<name>, else the legacy project-root file.
    pub fn output_path(&self) -> Option<PathBuf> {
        let n = self.output_name();
        [self.video_dir().join("output").join(&n), self.root.join(&n)].into_iter().find(|p| p.is_file())
    }
    pub fn output_target(&self) -> PathBuf {
        self.video_dir().join("output").join(self.output_name())
    }
    pub fn acts_dir(&self) -> PathBuf {
        self.root.join(self.src()).join("acts").join(&self.id)
    }
    pub fn versions_dir(&self, line: &str) -> PathBuf {
        self.video_dir().join("voice").join("versions").join(&self.locale).join(line)
    }
    pub fn candidates_root_rel(batch: &str) -> String {
        format!(".studio/revoice/{batch}")
    }
    pub fn candidate_dir(&self, batch: &str) -> PathBuf {
        self.root.join(".studio").join("revoice").join(batch).join(&self.id)
    }
    pub fn user_bgm(&self) -> Option<String> {
        let d = self.root.join("public").join("user").join(&self.id);
        let mut v: Vec<String> = std::fs::read_dir(&d)
            .ok()?
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| ["mp3", "wav", "m4a", "flac", "ogg", "aac"].iter().any(|x| n.to_ascii_lowercase().ends_with(&format!(".{x}"))))
            .collect();
        v.sort();
        v.into_iter().next().map(|n| format!("public/user/{}/{}", self.id, n))
    }
}

// ------------------------------------------------------------------ small helpers

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn iso(t: Option<SystemTime>) -> Value {
    t.map(|t| json!(chrono::DateTime::<chrono::Local>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, false))).unwrap_or(Value::Null)
}

fn file_sha(p: &Path) -> Option<String> {
    std::fs::read(p).ok().map(|b| sha256_hex(&b)[..16].to_string())
}

fn fp(v: &Value) -> String {
    sha256_hex(v.to_string().as_bytes())[..16].to_string()
}

fn read_json(p: &Path) -> Option<Value> {
    let t = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()
}

pub fn sequence(ep: &Ep) -> Result<Value, String> {
    let doc = read_json(&ep.narration_path()).ok_or_else(|| format!("讀不到 {}", clean_path(&ep.narration_path())))?;
    doc["sequences"].get(&ep.id).cloned().ok_or_else(|| format!("{} 的旁白裡沒有 {}", ep.locale, ep.id))
}

pub fn narration_defaults(ep: &Ep) -> Value {
    read_json(&ep.narration_path()).map(|d| json!({"fps": d["fps"], "defaults": d["defaults"]})).unwrap_or(Value::Null)
}

/// (scene id, line) for every line of the episode, in order.
pub fn lines(seq: &Value) -> Vec<(String, Value)> {
    seq["scenes"]
        .as_array()
        .map(|sc| {
            sc.iter()
                .flat_map(|s| {
                    let sid = s["id"].as_str().unwrap_or("").to_string();
                    s["lines"].as_array().cloned().unwrap_or_default().into_iter().map(move |l| (sid.clone(), l))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The text the voice engine reads for a line (`speak`, else `subtitle`).
pub fn speak_of(line: &Value) -> String {
    line.get("speak").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).or_else(|| line["subtitle"].as_str()).unwrap_or("").to_string()
}

// ------------------------------------------------------------------ voice lines

#[derive(Clone, Debug)]
pub struct VoiceLine {
    pub id: String,
    pub scene: String,
    pub subtitle: String,
    pub speak: String,
    pub mp3: PathBuf,
    /// "ok" | "missing" | "stale" (text changed since the audio was made)
    pub state: &'static str,
    pub sha: Option<String>,
    pub duration: Option<f64>,
    pub cer: Option<f64>,
    pub generated_at: Option<String>,
}

pub fn voice_lines(ep: &Ep) -> Result<Vec<VoiceLine>, String> {
    let seq = sequence(ep)?;
    let dir = ep.voice_dir();
    Ok(lines(&seq)
        .into_iter()
        .map(|(scene, l)| {
            let id = l["id"].as_str().unwrap_or("").to_string();
            let mp3 = dir.join(format!("{id}.mp3"));
            let meta = read_json(&dir.join(format!("{id}.json")));
            let speak = speak_of(&l);
            let state = if !mp3.is_file() {
                "missing"
            } else {
                match meta.as_ref().and_then(|m| m["speak"].as_str()) {
                    Some(s) if crate::narration::norm(s) != crate::narration::norm(&speak) => "stale",
                    _ => "ok",
                }
            };
            VoiceLine {
                sha: if mp3.is_file() { file_sha(&mp3) } else { None },
                duration: meta.as_ref().and_then(|m| m["duration"].as_f64()),
                cer: meta.as_ref().and_then(|m| m["alignment"]["cer"].as_f64()),
                generated_at: meta.as_ref().and_then(|m| m["generated_at"].as_str().map(String::from)),
                subtitle: l["subtitle"].as_str().unwrap_or("").to_string(),
                id,
                scene,
                speak,
                mp3,
                state,
            }
        })
        .collect())
}

// ------------------------------------------------------------------ fingerprints

pub struct Fps {
    pub script: String,
    pub timeline: String,
    pub mix: String,
    pub code: String,
}

/// Hash of every animation source file the renderer bundles (same filter as render.mjs).
pub fn code_fp(ep: &Ep) -> String {
    let mut files = vec![];
    fn walk(d: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut es: Vec<_> = rd.flatten().collect();
        es.sort_by_key(|e| e.file_name());
        for e in es {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else {
                let n = e.file_name().to_string_lossy().to_string();
                let ok = [".ts", ".tsx", ".json", ".css"].iter().any(|x| n.ends_with(x)) && n != "timeline.generated.json" && n != "narration.json";
                if ok {
                    out.push(p);
                }
            }
        }
    }
    walk(&ep.root.join(ep.src()), &mut files);
    let mut acc = String::new();
    for f in files {
        acc.push_str(&clean_path(f.strip_prefix(&ep.root).unwrap_or(&f)));
        acc.push_str(&file_sha(&f).unwrap_or_default());
    }
    sha256_hex(acc.as_bytes())[..16].to_string()
}

pub fn fingerprints(ep: &Ep, s: &Settings) -> Result<Fps, String> {
    let seq = sequence(ep)?;
    let vl = voice_lines(ep)?;
    let script = fp(&seq);
    // timeline: text + timing fields + each line's audio content + global timing settings
    let per: Vec<Value> = lines(&seq)
        .iter()
        .map(|(sc, l)| {
            let id = l["id"].as_str().unwrap_or("");
            let sha = vl.iter().find(|v| v.id == id).and_then(|v| v.sha.clone());
            json!([sc, id, l["subtitle"], speak_of(l), l["anchors"], l["pauseAfter"], sha])
        })
        .collect();
    let scenes: Vec<Value> = seq["scenes"].as_array().cloned().unwrap_or_default().iter().map(|s| json!([s["id"], s["title"]])).collect();
    let timeline = fp(&json!({
        "lines": per, "scenes": scenes, "narration": narration_defaults(ep), "seq": {"leadIn": seq["leadIn"], "tail": seq["tail"], "sceneGap": seq["sceneGap"], "pauseAfter": seq["pauseAfter"]},
        "tempo": crate::jobs::voice_tempo_preset(s.voice_tempo), "grid": std::env::var("PIKARA_TIMELINE_GRID").unwrap_or_else(|_| "0.1".into()),
        "script": file_sha(&ep.root.join("scripts").join("build_timeline.py")),
    }));
    let mix = fp(&json!({"timeline": timeline, "bgm": ep.user_bgm(), "script": file_sha(&ep.root.join("scripts").join("mix_audio.py"))}));
    Ok(Fps { script, timeline, mix, code: code_fp(ep) })
}

/// Fingerprint of a finished video: everything that changes its pixels or its audio track.
pub fn video_fp(f: &Fps, encode: &Value) -> String {
    fp(&json!({"timeline": f.timeline, "mix": f.mix, "code": f.code, "encode": encode}))
}

/// Encode settings of the default deliverable (what final_tw / bilibili produce).
pub fn default_encode() -> Value {
    json!({"fps": 30, "res": "1080p", "encoder": "auto", "quality": "standard"})
}

// ------------------------------------------------------------------ stage records

pub fn record_get(c: &Connection, ep: &Ep, stage: &str, variant: &str) -> Option<Value> {
    c.query_row(
        "SELECT input_fp, output_path, detail_json, job_id, adopted, completed_at FROM stage_records
         WHERE project_root=?1 AND episode=?2 AND locale=?3 AND stage=?4 AND variant=?5",
        params![clean_path(&ep.root), ep.id, ep.locale, stage, variant],
        |r| {
            Ok(json!({
                "inputFp": r.get::<_, String>(0)?, "outputPath": r.get::<_, Option<String>>(1)?,
                "detail": serde_json::from_str::<Value>(&r.get::<_, String>(2)?).unwrap_or(Value::Null),
                "jobId": r.get::<_, Option<String>>(3)?, "adopted": r.get::<_, i64>(4)? == 1, "completedAt": r.get::<_, String>(5)?,
            }))
        },
    )
    .optional()
    .ok()
    .flatten()
}

#[allow(clippy::too_many_arguments)]
pub fn record_set(c: &Connection, ep: &Ep, stage: &str, variant: &str, input_fp: &str, output: Option<&Path>, detail: &Value, job_id: Option<&str>, adopted: bool) -> Result<(), String> {
    c.execute(
        "INSERT INTO stage_records (project_root, episode, locale, stage, variant, input_fp, output_path, detail_json, job_id, adopted, completed_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(project_root, episode, locale, stage, variant) DO UPDATE SET
           input_fp=excluded.input_fp, output_path=excluded.output_path, detail_json=excluded.detail_json,
           job_id=excluded.job_id, adopted=excluded.adopted, completed_at=excluded.completed_at",
        params![clean_path(&ep.root), ep.id, ep.locale, stage, variant, input_fp, output.map(clean_path), detail.to_string(), job_id, adopted as i64, now_iso()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Called by the queue after a job succeeded: store what the finished stages consumed.
pub fn on_job_succeeded(c: &Connection, root: &Path, kind: &str, params: &Value, job_id: &str) -> Result<Vec<String>, String> {
    let ep_id = crate::jobs::episode_of(params)?;
    if !crate::episodes::valid_id(&ep_id) {
        return Ok(vec![]);
    }
    let cn = params["src"].as_str() == Some("src_cn") || params["locale"].as_str() == Some("zh-CN") || ["bilibili", "voiceover_cn"].contains(&kind);
    let ep = Ep::new(root, &ep_id, if cn { "zh-CN" } else { "zh-TW" })?;
    let s = db::settings_get(c);
    let f = fingerprints(&ep, &s)?;
    let mut done = vec![];
    let stages: &[&str] = match kind {
        "timeline" => &["timeline"],
        "mix" => &["mix"],
        "final_tw" | "bilibili" => &["timeline", "mix", "video"],
        "rerender" => &["timeline", "mix", "video"],
        _ => &[],
    };
    for st in stages {
        match *st {
            "timeline" => record_set(c, &ep, "timeline", "", &f.timeline, Some(&ep.timeline_path()), &json!({}), Some(job_id), false)?,
            "mix" => record_set(c, &ep, "mix", "", &f.mix, Some(&ep.mix_path()), &json!({}), Some(job_id), false)?,
            "video" => {
                let enc = if kind == "rerender" { encode_of(params) } else { default_encode() };
                let out = ep.output_path();
                record_set(c, &ep, "video", "", &video_fp(&f, &enc), out.as_deref(), &json!({"encode": enc}), Some(job_id), false)?
            }
            _ => {}
        }
        done.push(st.to_string());
    }
    Ok(done)
}

pub fn encode_of(p: &Value) -> Value {
    json!({
        "fps": p["fps"].as_u64().unwrap_or(30),
        "res": p["res"].as_str().unwrap_or("1080p"),
        "encoder": p["encoder"].as_str().unwrap_or("auto"),
        "quality": p["quality"].as_str().unwrap_or("standard"),
    })
}

// ------------------------------------------------------------------ workspace (all stages of one episode)

fn newest(paths: &[PathBuf]) -> Option<SystemTime> {
    paths.iter().filter_map(|p| mtime(p)).max()
}

fn list_files(d: &Path, exts: &[&str]) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(d)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file() && exts.iter().any(|x| p.extension().map(|e| e.to_string_lossy().eq_ignore_ascii_case(x)).unwrap_or(false)))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn file_entry(p: &Path) -> Value {
    json!({"path": clean_path(p), "name": p.file_name().map(|s| s.to_string_lossy().to_string()), "exists": p.exists(),
           "bytes": std::fs::metadata(p).map(|m| m.len()).ok(), "modifiedAt": iso(mtime(p))})
}

/// Freshness of a derived stage against its record; adopts legacy outputs once.
fn freshness(c: &Connection, ep: &Ep, stage: &str, cur_fp: &str, output: Option<&Path>, inputs_newest: Option<SystemTime>) -> (&'static str, Value, String) {
    let Some(out) = output.filter(|p| p.exists()) else {
        return ("missing", Value::Null, "尚未產生".into());
    };
    match record_get(c, ep, stage, "") {
        Some(r) if r["inputFp"].as_str() == Some(cur_fp) => {
            let why = if r["adopted"].as_bool() == Some(true) { "與輸入一致（舊專案基準）" } else { "與輸入一致" };
            ("fresh", r, why.into())
        }
        Some(r) => ("stale", r, "輸入已變更，需要更新".into()),
        None => {
            // legacy: no record. Output newer than every input file → adopt as baseline.
            let out_t = mtime(out);
            if out_t.is_some() && inputs_newest.map(|i| out_t.unwrap() >= i).unwrap_or(true) {
                let _ = record_set(c, ep, stage, "", cur_fp, Some(out), &json!({"legacy": true}), None, true);
                ("fresh", record_get(c, ep, stage, "").unwrap_or(Value::Null), "舊專案：輸出比輸入新，已建立基準".into())
            } else {
                ("stale", Value::Null, "舊專案：輸入檔比輸出新，可能需要更新".into())
            }
        }
    }
}

pub fn workspace(c: &Connection, ep: &Ep, s: &Settings) -> Result<Value, String> {
    let seq = sequence(ep)?;
    let vl = voice_lines(ep)?;
    let f = fingerprints(ep, s)?;
    let vdir = ep.video_dir();
    let mut stages = vec![];

    // research
    let mut research: Vec<PathBuf> = vec![];
    for p in [vdir.join("BRIEF.md"), vdir.join("production.json")] {
        if p.is_file() {
            research.push(p);
        }
    }
    research.extend(list_files(&vdir.join("docs"), &["md", "txt", "json", "pdf"]));
    stages.push(json!({"id": "research", "title": "主題與研究", "status": if research.is_empty() { "none" } else { "done" },
        "detail": format!("{} 個檔案", research.len()), "files": research.iter().map(|p| file_entry(p)).collect::<Vec<_>>(),
        "updatedAt": iso(newest(&research)), "location": clean_path(&vdir.join("docs"))}));

    // script
    let n_lines = vl.len();
    stages.push(json!({"id": "script", "title": "腳本", "status": "done", "detail": format!("{} 幕、{} 句", seq["scenes"].as_array().map(|a| a.len()).unwrap_or(0), n_lines),
        "files": [file_entry(&ep.narration_path())], "updatedAt": iso(mtime(&ep.narration_path())), "location": clean_path(&ep.narration_path()), "fingerprint": f.script}));

    // storyboard
    let stills = list_files(&vdir.join("scenes"), &["png", "jpg", "jpeg", "webp"]);
    stages.push(json!({"id": "storyboard", "title": "分鏡", "status": if stills.is_empty() { "none" } else { "done" }, "detail": format!("{} 張關鍵畫面", stills.len()),
        "files": stills.iter().take(24).map(|p| file_entry(p)).collect::<Vec<_>>(), "updatedAt": iso(newest(&stills)), "location": clean_path(&vdir.join("scenes"))}));

    // voice
    let missing = vl.iter().filter(|v| v.state == "missing").count();
    let stale = vl.iter().filter(|v| v.state == "stale").count();
    let voice_status = if n_lines == 0 { "none" } else if missing == n_lines { "missing" } else if missing + stale > 0 { "stale" } else { "fresh" };
    let mp3s: Vec<PathBuf> = vl.iter().filter(|v| v.mp3.is_file()).map(|v| v.mp3.clone()).collect();
    stages.push(json!({"id": "voice", "title": "配音", "status": voice_status,
        "detail": format!("{} 句完成、{} 句文字已改、{} 句缺少", n_lines - missing - stale, stale, missing),
        "updatedAt": iso(newest(&mp3s)), "location": clean_path(&ep.voice_dir()),
        "lines": vl.iter().map(|v| json!({"id": v.id, "scene": v.scene, "subtitle": v.subtitle, "speak": v.speak, "state": v.state, "duration": v.duration, "cer": v.cer,
            "path": clean_path(&v.mp3), "generatedAt": v.generated_at, "versions": version_count(c, ep, &v.id)})).collect::<Vec<_>>()}));

    // timeline + subtitles
    let tl_has = read_json(&ep.timeline_path()).map(|t| t.get(&ep.id).is_some()).unwrap_or(false);
    let srt_candidates = [vdir.join("subtitles").join(ep.srt_name()), ep.root.join(ep.srt_name()), ep.root.join("out").join("subtitles").join(format!("{}.srt", if ep.cn() { format!("{}_cn", ep.id) } else { ep.id.clone() }))];
    let srt = srt_candidates.iter().find(|p| p.is_file()).cloned();
    let mut tl_inputs = mp3s.clone();
    tl_inputs.push(ep.narration_path());
    let (st_tl, rec_tl, why_tl) = if tl_has { freshness(c, ep, "timeline", &f.timeline, Some(&ep.timeline_path()), newest(&tl_inputs)) } else { ("missing", Value::Null, "尚未建立".to_string()) };
    let tl_files: Vec<Value> = std::iter::once(file_entry(&ep.timeline_path())).chain(srt.iter().map(|p| file_entry(p))).collect();
    stages.push(json!({"id": "timeline", "title": "字幕與時間軸", "status": st_tl, "detail": why_tl, "record": rec_tl, "fingerprint": f.timeline,
        "files": tl_files,
        "updatedAt": iso(mtime(&ep.timeline_path())), "location": clean_path(&ep.timeline_path())}));

    // animation
    let acts = ep.acts_dir();
    let act_files = list_files(&acts, &["tsx", "ts"]);
    stages.push(json!({"id": "animation", "title": "動畫", "status": "done", "detail": if act_files.is_empty() { "通用樣板".to_string() } else { format!("{} 個場景元件", act_files.len()) },
        "fingerprint": f.code, "files": act_files.iter().map(|p| file_entry(p)).collect::<Vec<_>>(), "updatedAt": iso(newest(&act_files)), "location": clean_path(&acts)}));

    // mix
    let (st_mix, rec_mix, why_mix) = freshness(c, ep, "mix", &f.mix, Some(&ep.mix_path()), mtime(&ep.timeline_path()));
    stages.push(json!({"id": "mix", "title": "音訊混合", "status": st_mix, "detail": why_mix, "record": rec_mix, "fingerprint": f.mix, "bgm": ep.user_bgm(),
        "files": [file_entry(&ep.mix_path())], "updatedAt": iso(mtime(&ep.mix_path())), "location": clean_path(&ep.mix_path())}));

    // video
    let out = ep.output_path();
    let enc = record_get(c, ep, "video", "").map(|r| r["detail"]["encode"].clone()).filter(|v| v.is_object()).unwrap_or_else(default_encode);
    let vfp = video_fp(&f, &enc);
    let (st_v, rec_v, why_v) = freshness(c, ep, "video", &vfp, out.as_deref(), newest(&[ep.mix_path(), ep.timeline_path()]));
    stages.push(json!({"id": "video", "title": "渲染輸出", "status": st_v, "detail": why_v, "record": rec_v, "fingerprint": vfp,
        "files": out.iter().map(|p| file_entry(p)).collect::<Vec<_>>(), "updatedAt": iso(out.as_deref().and_then(mtime)),
        "location": clean_path(&ep.output_target()), "versions": video_versions(c, ep)}));

    // qa
    let qa: Vec<PathBuf> = list_files(&vdir.join("docs"), &["md", "json"]).into_iter().filter(|p| p.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase().contains("qa")).unwrap_or(false)).collect();
    let qa_t = newest(&qa);
    let qa_status = if qa.is_empty() { "missing" } else if out.as_deref().and_then(mtime).map(|o| qa_t.map(|q| q < o).unwrap_or(true)).unwrap_or(false) { "stale" } else { "done" };
    stages.push(json!({"id": "qa", "title": "QA 報告", "status": qa_status, "detail": format!("{} 份報告", qa.len()), "files": qa.iter().map(|p| file_entry(p)).collect::<Vec<_>>(), "updatedAt": iso(qa_t), "location": clean_path(&vdir.join("docs"))}));

    // upstream propagation: anything below a stale/missing stage needs an update too
    let order = ["voice", "timeline", "mix", "video"];
    let mut upstream_dirty: Option<String> = None;
    for st in stages.iter_mut() {
        let id = st["id"].as_str().unwrap_or("").to_string();
        if !order.contains(&id.as_str()) {
            continue;
        }
        let s = st["status"].as_str().unwrap_or("").to_string();
        if let Some(u) = &upstream_dirty {
            if s == "fresh" {
                st["status"] = json!("stale");
                st["detail"] = json!(format!("上游「{u}」已變更，需要更新"));
            }
        }
        if (s == "stale" || s == "missing") && upstream_dirty.is_none() {
            upstream_dirty = Some(st["title"].as_str().unwrap_or("").to_string());
        }
    }

    Ok(json!({
        "episode": ep.id, "locale": ep.locale, "title": seq["title"], "root": clean_path(&ep.root),
        "videoDir": clean_path(&vdir), "outputName": ep.output_name(), "stages": stages,
        "history": history(c, ep),
    }))
}

// ------------------------------------------------------------------ versions

fn version_count(c: &Connection, ep: &Ep, line: &str) -> i64 {
    c.query_row(
        "SELECT COUNT(*) FROM asset_versions WHERE project_root=?1 AND episode=?2 AND locale=?3 AND kind='voice' AND item=?4 AND status IN ('archived','candidate')",
        params![clean_path(&ep.root), ep.id, ep.locale, line],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

fn versions_query(c: &Connection, ep: &Ep, kind: &str, item: Option<&str>) -> Vec<Value> {
    let sql = "SELECT id, item, version, path, sha256, status, meta_json, job_id, created_at FROM asset_versions
               WHERE project_root=?1 AND episode=?2 AND locale=?3 AND kind=?4 AND (?5 IS NULL OR item=?5) ORDER BY item, version DESC";
    let Ok(mut st) = c.prepare(sql) else { return vec![] };
    st.query_map(params![clean_path(&ep.root), ep.id, ep.locale, kind, item], |r| {
        let path: String = r.get(3)?;
        Ok(json!({"id": r.get::<_, i64>(0)?, "item": r.get::<_, String>(1)?, "version": r.get::<_, i64>(2)?, "path": path.clone(),
                  "exists": Path::new(&path).exists(), "sha256": r.get::<_, Option<String>>(4)?, "status": r.get::<_, String>(5)?,
                  "meta": serde_json::from_str::<Value>(&r.get::<_, String>(6)?).unwrap_or(Value::Null), "jobId": r.get::<_, Option<String>>(7)?,
                  "createdAt": r.get::<_, String>(8)?}))
    })
    .map(|it| it.flatten().collect())
    .unwrap_or_default()
}

pub fn voice_versions(c: &Connection, ep: &Ep, line: Option<&str>) -> Vec<Value> {
    versions_query(c, ep, "voice", line)
}

pub fn video_versions(c: &Connection, ep: &Ep) -> Vec<Value> {
    versions_query(c, ep, "video", None)
}

fn next_version(c: &Connection, ep: &Ep, kind: &str, item: &str) -> i64 {
    c.query_row(
        "SELECT COALESCE(MAX(version),0)+1 FROM asset_versions WHERE project_root=?1 AND episode=?2 AND locale=?3 AND kind=?4 AND item=?5",
        params![clean_path(&ep.root), ep.id, ep.locale, kind, item],
        |r| r.get(0),
    )
    .unwrap_or(1)
}

#[allow(clippy::too_many_arguments)]
fn version_insert(c: &Connection, ep: &Ep, kind: &str, item: &str, version: i64, path: &Path, status: &str, meta: &Value, job: Option<&str>) -> Result<i64, String> {
    c.execute(
        "INSERT INTO asset_versions (project_root, episode, locale, kind, item, version, path, sha256, status, meta_json, job_id, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![clean_path(&ep.root), ep.id, ep.locale, kind, item, version, clean_path(path), file_sha(path), status, meta.to_string(), job, now_iso()],
    )
    .map_err(|e| e.to_string())?;
    Ok(c.last_insert_rowid())
}

fn copy_pair(src_mp3: &Path, dst_mp3: &Path) -> Result<(), String> {
    if let Some(d) = dst_mp3.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("無法建立 {}：{e}", clean_path(d)))?;
    }
    std::fs::copy(src_mp3, dst_mp3).map_err(|e| format!("複製 {} 失敗：{e}", clean_path(src_mp3)))?;
    let sj = src_mp3.with_extension("json");
    if sj.is_file() {
        std::fs::copy(&sj, dst_mp3.with_extension("json")).map_err(|e| format!("複製 {} 失敗：{e}", clean_path(&sj)))?;
    }
    Ok(())
}

/// Copy the current live audio of a line into its versions folder (never moves or deletes the live file).
pub fn archive_voice(c: &Connection, ep: &Ep, line: &str, job: Option<&str>, reason: &str) -> Result<Option<i64>, String> {
    let live = ep.voice_dir().join(format!("{line}.mp3"));
    if !live.is_file() {
        return Ok(None);
    }
    let sha = file_sha(&live);
    // already archived (same content)? don't duplicate
    let dup: Option<i64> = c
        .query_row(
            "SELECT version FROM asset_versions WHERE project_root=?1 AND episode=?2 AND locale=?3 AND kind='voice' AND item=?4 AND sha256=?5 AND status='archived'",
            params![clean_path(&ep.root), ep.id, ep.locale, line, sha],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    if let Some(v) = dup {
        return Ok(Some(v));
    }
    let v = next_version(c, ep, "voice", line);
    let dst = ep.versions_dir(line).join(format!("v{v:03}.mp3"));
    copy_pair(&live, &dst)?;
    let meta = read_json(&live.with_extension("json")).map(|m| json!({"speak": m["speak"], "duration": m["duration"], "cer": m["alignment"]["cer"], "generatedAt": m["generated_at"], "reason": reason})).unwrap_or(json!({"reason": reason}));
    version_insert(c, ep, "voice", line, v, &dst, "archived", &meta, job)?;
    Ok(Some(v))
}

/// Validation of a re-voiced candidate before it may become the current version.
pub fn check_candidate(ep: &Ep, cand_mp3: &Path, speak: &str) -> Result<Value, String> {
    if !cand_mp3.is_file() {
        return Err("沒有產生音檔".into());
    }
    let m = read_json(&cand_mp3.with_extension("json")).ok_or("缺少音檔資訊（.json）")?;
    if m["speak"].as_str().map(|s| crate::narration::norm(s) != crate::narration::norm(speak)).unwrap_or(true) {
        return Err("音檔的文字與目前腳本不一致".into());
    }
    let dur = m["duration"].as_f64().unwrap_or(0.0);
    if dur < 0.3 {
        return Err(format!("音檔太短（{dur:.2} 秒）"));
    }
    let cer = m["alignment"]["cer"].as_f64();
    if let Some(c) = cer {
        if c > MAX_CER {
            return Err(format!("語音辨識比對錯誤率 {c:.2} 超過 {MAX_CER}（可能唸錯或吞字），請試聽後決定"));
        }
    }
    let _ = ep;
    Ok(json!({"duration": dur, "cer": cer}))
}

/// Switch validated candidates of a re-voice batch in as the current audio. The previous audio is archived first;
/// failed candidates stay as candidates (the current audio is untouched). Returns per-line results.
pub fn promote_batch(c: &Connection, ep: &Ep, batch: &str, only: Option<&[String]>, force: bool, job: Option<&str>) -> Result<Value, String> {
    let dir = ep.candidate_dir(batch);
    let vl = voice_lines(ep)?;
    let mut results = vec![];
    let mut cands: Vec<PathBuf> = list_files(&dir, &["mp3"]);
    cands.retain(|p| !p.file_name().map(|n| n.to_string_lossy().contains(".best")).unwrap_or(false));
    for cand in cands {
        let line = cand.file_stem().unwrap().to_string_lossy().to_string();
        if let Some(o) = only {
            if !o.iter().any(|x| x == &line) {
                continue;
            }
        }
        let Some(v) = vl.iter().find(|v| v.id == line) else {
            results.push(json!({"line": line, "ok": false, "error": "腳本裡已沒有這一句"}));
            continue;
        };
        let check = check_candidate(ep, &cand, &v.speak);
        if let Err(e) = &check {
            if !force {
                // keep it as a reviewable candidate (copied next to the versions so the batch folder can be cleaned)
                let n = next_version(c, ep, "voice", &line);
                let keep = ep.versions_dir(&line).join(format!("v{n:03}.candidate.mp3"));
                copy_pair(&cand, &keep)?;
                version_insert(c, ep, "voice", &line, n, &keep, "candidate", &json!({"error": e, "batch": batch}), job)?;
                results.push(json!({"line": line, "ok": false, "error": e, "candidateVersion": n}));
                continue;
            }
        }
        let archived = archive_voice(c, ep, &line, job, "重新配音前的版本")?;
        copy_pair(&cand, &v.mp3)?;
        let n = next_version(c, ep, "voice", &line);
        let keep = ep.versions_dir(&line).join(format!("v{n:03}.mp3"));
        copy_pair(&cand, &keep)?;
        version_insert(c, ep, "voice", &line, n, &keep, "archived", &json!({"batch": batch, "check": check.as_ref().ok(), "forced": check.is_err(), "reason": "重新配音"}), job)?;
        results.push(json!({"line": line, "ok": true, "previousVersion": archived, "version": n, "check": check.ok(), "forced": force}));
    }
    let ok = results.iter().filter(|r| r["ok"] == true).count();
    Ok(json!({"episode": ep.id, "locale": ep.locale, "batch": batch, "promoted": ok, "failed": results.len() - ok, "results": results}))
}

/// Make an older version (or a reviewed candidate) the current audio of a line. The current audio is archived first.
pub fn restore_voice(c: &Connection, ep: &Ep, line: &str, version: i64, job: Option<&str>) -> Result<Value, String> {
    let row = voice_versions(c, ep, Some(line)).into_iter().find(|v| v["version"].as_i64() == Some(version)).ok_or(format!("{line} 沒有版本 v{version}"))?;
    let src = PathBuf::from(row["path"].as_str().unwrap_or(""));
    if !src.is_file() {
        return Err(format!("版本檔案不存在：{}", clean_path(&src)));
    }
    let archived = archive_voice(c, ep, line, job, "還原其他版本前的版本")?;
    let live = ep.voice_dir().join(format!("{line}.mp3"));
    copy_pair(&src, &live)?;
    if row["status"] == "candidate" {
        c.execute("UPDATE asset_versions SET status='archived' WHERE id=?1", params![row["id"].as_i64()]).map_err(|e| e.to_string())?;
    }
    Ok(json!({"line": line, "restored": version, "previousVersion": archived}))
}

pub fn reject_candidate(c: &Connection, ep: &Ep, line: &str, version: i64) -> Result<(), String> {
    c.execute(
        "UPDATE asset_versions SET status='rejected' WHERE project_root=?1 AND episode=?2 AND locale=?3 AND kind='voice' AND item=?4 AND version=?5 AND status='candidate'",
        params![clean_path(&ep.root), ep.id, ep.locale, line, version],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Keep the current deliverable as a version, then move a newly rendered file into place.
pub fn promote_output(c: &Connection, ep: &Ep, new_file: &Path, job: Option<&str>, meta: &Value) -> Result<Value, String> {
    if !new_file.is_file() {
        return Err(format!("找不到新的輸出：{}", clean_path(new_file)));
    }
    let name = ep.output_name();
    let target = ep.output_target();
    let vers = ep.video_dir().join("output").join("versions");
    std::fs::create_dir_all(&vers).map_err(|e| e.to_string())?;
    let mut previous = None;
    if let Some(cur) = ep.output_path() {
        let v = next_version(c, ep, "video", &name);
        let stem = name.trim_end_matches(".mp4");
        let keep = vers.join(format!("{stem}.v{v:03}.mp4"));
        // hard link when possible (no extra space, original untouched), else copy
        if std::fs::hard_link(&cur, &keep).is_err() {
            std::fs::copy(&cur, &keep).map_err(|e| format!("保留舊版影片失敗：{e}"))?;
        }
        version_insert(c, ep, "video", &name, v, &keep, "archived", &json!({"from": clean_path(&cur), "reason": "重新渲染前的版本"}), job)?;
        previous = Some(v);
    }
    std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = target.with_extension("mp4.studio-new");
    std::fs::copy(new_file, &tmp).map_err(|e| format!("複製新影片失敗：{e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("替換影片失敗：{e}"))?;
    let v = next_version(c, ep, "video", &name);
    let keep = vers.join(format!("{}.v{v:03}.mp4", name.trim_end_matches(".mp4")));
    if std::fs::hard_link(&target, &keep).is_err() {
        let _ = std::fs::copy(&target, &keep);
    }
    version_insert(c, ep, "video", &name, v, &keep, "archived", &json!({"reason": "重新渲染", "meta": meta}), job)?;
    // subtitles deliverable follows the timeline
    let srt_src = ep.root.join("out").join("subtitles").join(format!("{}.srt", if ep.cn() { format!("{}_cn", ep.id) } else { ep.id.clone() }));
    if srt_src.is_file() {
        let d = ep.video_dir().join("subtitles");
        let _ = std::fs::create_dir_all(&d);
        let _ = std::fs::copy(&srt_src, d.join(ep.srt_name()));
    }
    let _ = std::fs::remove_file(new_file);
    Ok(json!({"output": clean_path(&target), "previousVersion": previous, "version": v}))
}

/// Recent history of an episode: script commits, voice and video versions.
pub fn history(c: &Connection, ep: &Ep) -> Value {
    let rel = format!("{}/data/narration.json", ep.src());
    let commits = crate::gitops::git(&ep.root, &["log", "-n", "15", "--format=%h%x09%cI%x09%s", "--", &rel, &format!("{}/acts/{}", ep.src(), ep.id)])
        .ok()
        .filter(|o| o.ok())
        .map(|o| {
            o.stdout
                .lines()
                .filter_map(|l| {
                    let mut it = l.splitn(3, '\t');
                    Some(json!({"commit": it.next()?, "at": it.next()?, "subject": it.next()?}))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut ev: Vec<Value> = voice_versions(c, ep, None).into_iter().chain(video_versions(c, ep)).collect();
    ev.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
    ev.truncate(40);
    json!({"commits": commits, "versions": ev})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proj() -> PathBuf {
        let d = std::env::temp_dir().join(format!("pss-pipeline 測試 {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("src").join("data")).unwrap();
        std::fs::write(
            d.join("src").join("data").join("narration.json"),
            r#"{"fps":60,"defaults":{"leadIn":0.5,"pauseAfter":0.35,"sceneGap":1.2,"tail":1.5},"sequences":{"ep09":{"title":"T","voiceEngine":"cosyvoice","scenes":[
                {"id":"s01","title":"a","lines":[{"id":"ep09-01","subtitle":"第一句"},{"id":"ep09-02","subtitle":"第二句"}]},
                {"id":"s02","title":"b","lines":[{"id":"ep09-03","subtitle":"第三句"}]}]}}}"#,
        )
        .unwrap();
        let vd = d.join("public").join("assets").join("audio").join("voiceover_cosy").join("ep09");
        std::fs::create_dir_all(&vd).unwrap();
        for (i, t) in ["第一句", "第二句", "第三句"].iter().enumerate() {
            std::fs::write(vd.join(format!("ep09-0{}.mp3", i + 1)), format!("audio-{i}")).unwrap();
            std::fs::write(vd.join(format!("ep09-0{}.json", i + 1)), json!({"speak": t, "duration": 1.5, "alignment": {"cer": 0.0}}).to_string()).unwrap();
        }
        d
    }

    fn set_text(d: &Path, id: &str, text: &str) {
        let p = d.join("src").join("data").join("narration.json");
        let s = std::fs::read_to_string(&p).unwrap();
        let mut v: Value = serde_json::from_str(&s).unwrap();
        for sc in v["sequences"]["ep09"]["scenes"].as_array_mut().unwrap() {
            for l in sc["lines"].as_array_mut().unwrap() {
                if l["id"] == id {
                    l["subtitle"] = json!(text);
                }
            }
        }
        std::fs::write(&p, v.to_string()).unwrap();
    }

    #[test]
    fn text_change_marks_only_that_line_and_downstream() {
        let d = proj();
        let ep = Ep::new(&d, "ep09", "zh-TW").unwrap();
        let s = Settings::default();
        let c = db::open_memory().unwrap();
        let f0 = fingerprints(&ep, &s).unwrap();
        record_set(&c, &ep, "timeline", "", &f0.timeline, None, &json!({}), None, false).unwrap();
        record_set(&c, &ep, "mix", "", &f0.mix, None, &json!({}), None, false).unwrap();
        assert!(voice_lines(&ep).unwrap().iter().all(|v| v.state == "ok"));
        // unrelated setting (render perf mode) does not change any fingerprint
        let s2 = Settings { perf_mode: "eco".into(), ..Settings::default() };
        let f1 = fingerprints(&ep, &s2).unwrap();
        assert_eq!((f0.timeline.clone(), f0.mix.clone(), f0.code.clone()), (f1.timeline, f1.mix, f1.code));
        // change line 2's text → only line 2 stale, timeline/mix fingerprints change, code unchanged
        set_text(&d, "ep09-02", "改過的第二句");
        let vl = voice_lines(&ep).unwrap();
        let st: Vec<&str> = vl.iter().map(|v| v.state).collect();
        assert_eq!(st, vec!["ok", "stale", "ok"]);
        let f2 = fingerprints(&ep, &s).unwrap();
        assert_ne!(f0.script, f2.script);
        assert_ne!(f0.timeline, f2.timeline);
        assert_ne!(f0.mix, f2.mix);
        assert_eq!(f0.code, f2.code);
        // tempo preset change → timeline + mix change, script does not
        let s3 = Settings { voice_tempo: 1.1, ..Settings::default() };
        let f3 = fingerprints(&ep, &s3).unwrap();
        assert_eq!(f2.script, f3.script);
        assert_ne!(f2.timeline, f3.timeline);
        // encode settings change → only the video fingerprint changes
        let a = video_fp(&f2, &default_encode());
        let b = video_fp(&f2, &json!({"fps": 30, "res": "1080p", "encoder": "h264_nvenc", "quality": "high"}));
        assert_ne!(a, b);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn promote_keeps_old_audio_and_rollback_restores_it() {
        let d = proj();
        let ep = Ep::new(&d, "ep09", "zh-TW").unwrap();
        let c = db::open_memory().unwrap();
        set_text(&d, "ep09-02", "新的第二句");
        let cand = ep.candidate_dir("job1");
        std::fs::create_dir_all(&cand).unwrap();
        // good candidate for line 2, bad candidate (wrong text) for line 3
        std::fs::write(cand.join("ep09-02.mp3"), "NEW-2").unwrap();
        std::fs::write(cand.join("ep09-02.json"), json!({"speak": "新的第二句", "duration": 1.8, "alignment": {"cer": 0.05}}).to_string()).unwrap();
        std::fs::write(cand.join("ep09-03.mp3"), "BAD-3").unwrap();
        std::fs::write(cand.join("ep09-03.json"), json!({"speak": "別的句子", "duration": 1.8, "alignment": {"cer": 0.05}}).to_string()).unwrap();
        let r = promote_batch(&c, &ep, "job1", None, false, Some("job1")).unwrap();
        assert_eq!(r["promoted"], 1, "{r}");
        assert_eq!(r["failed"], 1);
        let live2 = ep.voice_dir().join("ep09-02.mp3");
        let live3 = ep.voice_dir().join("ep09-03.mp3");
        assert_eq!(std::fs::read_to_string(&live2).unwrap(), "NEW-2");
        assert_eq!(std::fs::read_to_string(&live3).unwrap(), "audio-2", "failed candidate never replaces the current audio");
        // old audio of line 2 kept as v001 and restorable
        let vs = voice_versions(&c, &ep, Some("ep09-02"));
        let old = vs.iter().find(|v| v["version"] == 1).unwrap();
        assert_eq!(std::fs::read_to_string(old["path"].as_str().unwrap()).unwrap(), "audio-1");
        restore_voice(&c, &ep, "ep09-02", 1, None).unwrap();
        assert_eq!(std::fs::read_to_string(&live2).unwrap(), "audio-1");
        // and the re-voiced audio is still there as a version
        assert!(voice_versions(&c, &ep, Some("ep09-02")).iter().any(|v| std::fs::read_to_string(v["path"].as_str().unwrap()).ok().as_deref() == Some("NEW-2")));
        // line 3 candidate kept for review
        assert!(voice_versions(&c, &ep, Some("ep09-03")).iter().any(|v| v["status"] == "candidate"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn output_promote_keeps_previous_video() {
        let d = proj();
        let ep = Ep::new(&d, "ep09", "zh-TW").unwrap();
        let c = db::open_memory().unwrap();
        std::fs::create_dir_all(ep.video_dir().join("output")).unwrap();
        std::fs::write(ep.output_target(), "OLD-VIDEO").unwrap();
        let newf = d.join("new.mp4");
        std::fs::write(&newf, "NEW-VIDEO").unwrap();
        let r = promote_output(&c, &ep, &newf, None, &json!({})).unwrap();
        assert_eq!(std::fs::read_to_string(ep.output_target()).unwrap(), "NEW-VIDEO");
        let vs = video_versions(&c, &ep);
        assert!(vs.iter().any(|v| std::fs::read_to_string(v["path"].as_str().unwrap()).ok().as_deref() == Some("OLD-VIDEO")), "{r} {vs:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn legacy_output_is_adopted_once_then_tracked() {
        let d = proj();
        let ep = Ep::new(&d, "ep09", "zh-TW").unwrap();
        let c = db::open_memory().unwrap();
        let s = Settings::default();
        // a legacy timeline file newer than its inputs
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(ep.timeline_path(), json!({"ep09": {"lines": []}}).to_string()).unwrap();
        let w = workspace(&c, &ep, &s).unwrap();
        let tl = w["stages"].as_array().unwrap().iter().find(|x| x["id"] == "timeline").unwrap().clone();
        assert_eq!(tl["status"], "fresh", "{tl}");
        assert_eq!(tl["record"]["adopted"], true);
        set_text(&d, "ep09-01", "改了");
        let w = workspace(&c, &ep, &s).unwrap();
        let st: Vec<(String, String)> = w["stages"].as_array().unwrap().iter().map(|x| (x["id"].as_str().unwrap().to_string(), x["status"].as_str().unwrap().to_string())).collect();
        assert!(st.contains(&("voice".into(), "stale".into())), "{st:?}");
        assert!(st.contains(&("timeline".into(), "stale".into())), "{st:?}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
