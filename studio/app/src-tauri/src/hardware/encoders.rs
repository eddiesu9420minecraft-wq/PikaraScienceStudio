//! ffmpeg video encoders: candidate table (shared with render.mjs), try order, and real test encodes.
//!
//! "Listed by `ffmpeg -encoders`" only means the encoder was compiled in. An encoder counts as usable only after a
//! 1-second 720p60 test encode with the exact production arguments succeeds and ffprobe reads back 60 frames of
//! the right codec. Failures (no driver, no device, unsupported option, timeout) are results, never panics.

use super::adapters::Adapter;
use crate::util::run;
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, Instant};

/// Built-in copy of `scripts/hw_encoders.json`; a project's own copy (if present) wins, see [`table_for`].
const BUILTIN: &str = include_str!("../../../../../scripts/hw_encoders.json");

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncoderDef {
    pub id: String,
    pub codec: String,
    pub family: String,
    pub pix_fmt: String,
    pub hwupload: bool,
    pub pre: Vec<String>,
    pub final_args: Vec<String>,
    pub preview_args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Family {
    pub id: String,
    pub label: String,
    pub vendor_ids: Vec<String>,
    pub platforms: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Table {
    pub families: Vec<Family>,
    pub encoders: Vec<EncoderDef>,
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

pub fn parse_table(text: &str) -> Result<Table, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("hw_encoders.json：{e}"))?;
    let families = v["families"]
        .as_object()
        .ok_or("hw_encoders.json 缺少 families")?
        .iter()
        .map(|(k, f)| Family { id: k.clone(), label: f["label"].as_str().unwrap_or(k).into(), vendor_ids: strs(&f["vendorIds"]), platforms: strs(&f["platforms"]) })
        .collect();
    let encoders = v["encoders"]
        .as_array()
        .ok_or("hw_encoders.json 缺少 encoders")?
        .iter()
        .map(|e| EncoderDef {
            id: e["id"].as_str().unwrap_or("").into(),
            codec: e["codec"].as_str().unwrap_or("h264").into(),
            family: e["family"].as_str().unwrap_or("cpu").into(),
            pix_fmt: e["pixFmt"].as_str().unwrap_or("yuv420p").into(),
            hwupload: e["hwupload"].as_bool().unwrap_or(false),
            pre: strs(&e["pre"]),
            final_args: strs(&e["final"]),
            preview_args: strs(&e["preview"]),
        })
        .filter(|e| !e.id.is_empty())
        .collect();
    Ok(Table { families, encoders })
}

pub static BUILTIN_TABLE: Lazy<Table> = Lazy::new(|| parse_table(BUILTIN).expect("built-in hw_encoders.json is valid"));

/// The project's `scripts/hw_encoders.json` when it parses, else the built-in table.
pub fn table_for(root: Option<&Path>) -> Table {
    root.and_then(|r| std::fs::read_to_string(r.join("scripts").join("hw_encoders.json")).ok())
        .and_then(|t| parse_table(&t).ok())
        .unwrap_or_else(|| BUILTIN_TABLE.clone())
}

pub fn platform() -> &'static str {
    if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" }
}

impl Table {
    pub fn family(&self, id: &str) -> Option<&Family> {
        self.families.iter().find(|f| f.id == id)
    }

    /// Encoders for `codec` on `platform`, in try order. Adapter vendors only move their own family to the front
    /// (NVIDIA → NVENC, AMD → AMF, Intel → QSV); every candidate is still tested. CPU is always last.
    pub fn candidates(&self, codec: &str, platform: &str, adapters: &[Adapter]) -> Vec<EncoderDef> {
        let vendors: Vec<&str> = adapters.iter().map(|a| a.vendor_id.as_str()).collect();
        let rank = |e: &EncoderDef| -> u32 {
            let pref = match e.family.as_str() { "nvenc" => 0, "amf" => 1, "qsv" => 2, "vaapi" => 3, _ => 5 };
            match e.family.as_str() {
                "cpu" => 1000,
                "mf" => 900,
                "videotoolbox" => 0,
                f => {
                    let has = self.family(f).map(|fam| fam.vendor_ids.iter().any(|v| vendors.contains(&v.as_str()))).unwrap_or(false);
                    if has { 10 + pref } else { 100 + pref }
                }
            }
        };
        let mut v: Vec<EncoderDef> = self
            .encoders
            .iter()
            .filter(|e| e.codec == codec && self.family(&e.family).map(|f| f.platforms.iter().any(|p| p == platform)).unwrap_or(false))
            .cloned()
            .collect();
        v.sort_by_key(|e| rank(e));
        v
    }
}

/// Names of the video encoders compiled into this ffmpeg (`ffmpeg -hide_banner -encoders`).
pub fn parse_encoder_list(stdout: &str) -> HashSet<String> {
    stdout
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let flags = it.next()?;
            let name = it.next()?;
            (flags.starts_with('V') && flags.len() == 6 && !name.starts_with('=')).then(|| name.to_string())
        })
        .collect()
}

/// ffmpeg arguments of the test encode (1 s 720p60 test pattern → `out`), same encoder options as production.
pub fn test_args(e: &EncoderDef, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y"].iter().map(|s| s.to_string()).collect();
    a.extend(e.pre.iter().cloned());
    a.extend(["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=60", "-t", "1", "-vf"].iter().map(|s| s.to_string()));
    a.push(format!("format={}{}", e.pix_fmt, if e.hwupload { ",hwupload" } else { "" }));
    a.extend(["-c:v".to_string(), e.id.clone()]);
    a.extend(e.final_args.iter().cloned());
    a.extend(["-an".to_string(), out.to_string_lossy().into_owned()]);
    a
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncResult {
    pub id: String,
    pub family: String,
    pub label: String,
    pub listed: bool,
    /// Some(true) works, Some(false) failed, None not tested.
    pub works: Option<bool>,
    pub ms: u64,
    pub error: Option<String>,
}

fn last_lines(s: &str, n: usize) -> String {
    let l: Vec<&str> = s.lines().map(|x| x.trim()).filter(|x| !x.is_empty()).collect();
    l[l.len().saturating_sub(n)..].join(" | ")
}

/// Real test encode, verified with ffprobe (codec + exactly 60 frames).
pub fn test_encoder(ffmpeg: &str, e: &EncoderDef, dir: &Path) -> (bool, u64, Option<String>) {
    if std::fs::create_dir_all(dir).is_err() {
        return (false, 0, Some(format!("無法建立暫存資料夾 {}", dir.display())));
    }
    let out = dir.join(format!("{}.mp4", e.id));
    let _ = std::fs::remove_file(&out);
    let args = test_args(e, &out);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let t0 = Instant::now();
    let r = run(ffmpeg, &refs, None, Duration::from_secs(45));
    let ms = t0.elapsed().as_millis() as u64;
    let err = match r {
        Err(e) => Some(format!("無法執行 ffmpeg：{e}")),
        Ok(o) if !o.ok() => Some(last_lines(&o.combined(), 3)).filter(|s| !s.is_empty()).or(Some(format!("ffmpeg 結束代碼 {}", o.code))),
        Ok(_) => {
            // ffprobe next to this ffmpeg (only the file name changes: install folders are often named "ffmpeg-…")
            let fp = Path::new(ffmpeg);
            let exe = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
            let ffprobe = match fp.parent().filter(|p| !p.as_os_str().is_empty()) {
                Some(dir) if dir.join(exe).exists() => dir.join(exe).to_string_lossy().into_owned(),
                _ => "ffprobe".to_string(),
            };
            let pr = run(&ffprobe, &["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,nb_read_frames", "-of", "json", &out.to_string_lossy()], None, Duration::from_secs(30));
            let want = if e.codec == "hevc" { "hevc" } else { "h264" };
            match pr.ok().and_then(|o| serde_json::from_str::<Value>(&o.stdout).ok()) {
                Some(v) => {
                    let s = &v["streams"][0];
                    let codec = s["codec_name"].as_str().unwrap_or("");
                    let frames = s["nb_read_frames"].as_str().and_then(|x| x.parse::<u32>().ok()).unwrap_or(0);
                    (codec != want || frames != 60).then(|| format!("輸出檢查失敗：codec={codec}，幀數={frames}（應為 {want}／60）"))
                }
                None => Some("輸出檢查失敗：ffprobe 無法讀取試編碼檔".into()),
            }
        }
    };
    let _ = std::fs::remove_file(&out);
    (err.is_none(), ms, err)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub codec: String,
    pub selected: Option<String>,
    pub selected_hardware: bool,
    pub results: Vec<EncResult>,
}

/// Probe encoders. `test`: run real test encodes (otherwise only "listed" + results cached by render.mjs in
/// `<root>/out/hwenc-cache.json`). `all`: keep testing after the first working one.
pub fn probe(root: Option<&Path>, ffmpeg: &str, listed: &HashSet<String>, adapters: &[Adapter], codec: &str, test: bool, all: bool) -> Probe {
    let table = table_for(root);
    let cache: Value = root
        .and_then(|r| std::fs::read_to_string(r.join("out").join("hwenc-cache.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let dir = root.map(|r| r.join("out").join("hwenc-test")).unwrap_or_else(|| std::env::temp_dir().join("pikara-hwenc-test"));
    let mut results = vec![];
    let mut selected: Option<String> = None;
    for e in table.candidates(codec, platform(), adapters) {
        let label = table.family(&e.family).map(|f| f.label.clone()).unwrap_or_default();
        let mut r = EncResult { id: e.id.clone(), family: e.family.clone(), label, listed: listed.contains(&e.id), works: None, ms: 0, error: None };
        if !r.listed {
            r.works = Some(false);
            r.error = Some("這個 ffmpeg 沒有編譯此編碼器".into());
        } else if test && (all || selected.is_none()) {
            let (ok, ms, err) = test_encoder(ffmpeg, &e, &dir);
            (r.works, r.ms, r.error) = (Some(ok), ms, err);
        } else if let Some(c) = cache["results"].get(&e.id) {
            r.works = c["works"].as_bool();
            r.ms = c["ms"].as_u64().unwrap_or(0);
            r.error = c["error"].as_str().map(|s| format!("（上次實測）{s}"));
        }
        if r.works == Some(true) && selected.is_none() {
            selected = Some(e.id.clone());
        }
        results.push(r);
    }
    let selected_hardware = selected.as_ref().map(|s| results.iter().any(|r| &r.id == s && r.family != "cpu")).unwrap_or(false);
    Probe { codec: codec.into(), selected, selected_hardware, results }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ad(v: &str) -> Adapter {
        Adapter { name: v.into(), vendor_id: v.into(), driver: String::new() }
    }

    fn ids(v: &[EncoderDef]) -> Vec<&str> {
        v.iter().map(|e| e.id.as_str()).collect()
    }

    #[test]
    fn builtin_table_is_complete() {
        let t = &*BUILTIN_TABLE;
        for p in ["win32", "linux", "darwin"] {
            for c in ["h264", "hevc"] {
                let v = t.candidates(c, p, &[]);
                assert_eq!(v.last().map(|e| e.family.as_str()), Some("cpu"), "{p}/{c} must end with the CPU fallback");
            }
        }
        for e in &t.encoders {
            assert!(t.family(&e.family).is_some(), "{} has unknown family", e.id);
            assert!(!e.final_args.is_empty() && !e.preview_args.is_empty(), "{} needs final+preview args", e.id);
        }
    }

    #[test]
    fn vendor_only_changes_order() {
        let t = &*BUILTIN_TABLE;
        assert_eq!(ids(&t.candidates("h264", "win32", &[ad("10de")]))[0], "h264_nvenc");
        assert_eq!(ids(&t.candidates("h264", "win32", &[ad("1002")]))[0], "h264_amf");
        assert_eq!(ids(&t.candidates("h264", "win32", &[ad("8086")]))[0], "h264_qsv");
        // hybrid laptop: the discrete NVIDIA first, then AMD iGPU; QSV still tried (capability, not brand)
        let hy = t.candidates("h264", "win32", &[ad("1002"), ad("10de")]);
        assert_eq!(ids(&hy), vec!["h264_nvenc", "h264_amf", "h264_qsv", "h264_mf", "libx264"]);
        assert_eq!(ids(&t.candidates("h264", "darwin", &[ad("apple")])), vec!["h264_videotoolbox", "libx264"]);
        let lx = ids(&t.candidates("hevc", "linux", &[ad("8086")])).join(",");
        assert!(lx.starts_with("hevc_qsv,") && lx.contains("hevc_vaapi") && lx.ends_with("libx265"), "{lx}");
        // no adapters detected at all → every hardware family is still tested
        assert_eq!(t.candidates("h264", "win32", &[]).len(), 5);
    }

    #[test]
    fn parses_encoder_list() {
        let s = " V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)\n V..... h264_qsv  QSV\n A....D aac   AAC\n ------\n V..... = Video\n";
        let l = parse_encoder_list(s);
        assert!(l.contains("h264_nvenc") && l.contains("h264_qsv") && !l.contains("aac") && l.len() == 2);
    }

    #[test]
    fn test_args_match_render_args() {
        let t = &*BUILTIN_TABLE;
        let amf = t.encoders.iter().find(|e| e.id == "h264_amf").unwrap();
        let a = test_args(amf, Path::new("x.mp4")).join(" ");
        assert!(a.contains("-vf format=nv12 -c:v h264_amf -usage transcoding -quality quality"), "{a}");
        let va = t.encoders.iter().find(|e| e.id == "h264_vaapi").unwrap();
        let a = test_args(va, Path::new("x.mp4")).join(" ");
        assert!(a.contains("-vaapi_device /dev/dri/renderD128 -f lavfi") && a.contains("format=nv12,hwupload"), "{a}");
    }

    #[test]
    fn missing_ffmpeg_is_a_result_not_a_panic() {
        let t = &*BUILTIN_TABLE;
        let e = t.encoders.iter().find(|e| e.id == "libx264").unwrap();
        let (ok, _, err) = test_encoder("definitely-not-ffmpeg-xyz", e, &std::env::temp_dir().join("pss-hwenc-missing"));
        assert!(!ok && err.is_some());
        let listed: HashSet<String> = HashSet::new();
        let p = probe(None, "definitely-not-ffmpeg-xyz", &listed, &[], "h264", true, true);
        assert!(p.selected.is_none() && p.results.iter().all(|r| r.works == Some(false)));
    }

    /// Real test encodes on this machine (uses the GPU for a few seconds): `cargo test -- --ignored real_probe`
    #[test]
    #[ignore]
    fn real_probe_on_this_machine() {
        let ff = crate::util::tool("ffmpeg").expect("ffmpeg");
        let o = run(&ff, &["-hide_banner", "-encoders"], None, Duration::from_secs(20)).unwrap();
        let listed = parse_encoder_list(&o.stdout);
        let ad = super::super::adapters::detect();
        for codec in ["h264", "hevc"] {
            let p = probe(None, &ff, &listed, ad, codec, true, true);
            for r in &p.results {
                eprintln!("{codec} {:<18} works={:?} {}ms {}", r.id, r.works, r.ms, r.error.clone().unwrap_or_default());
            }
            eprintln!("{codec} selected {:?} hardware={}", p.selected, p.selected_hardware);
            assert!(p.selected.is_some(), "CPU fallback must always work");
        }
    }
}
