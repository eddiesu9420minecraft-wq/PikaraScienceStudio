//! Quality checks: usage limits, transient errors, pronunciation (pinyin) error rate, QA report, script rules, key frames.

use super::*;

pub(crate) fn first_line(s: &str) -> String {
    s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(300).collect()
}

/// Usage / credit limits and missing login pause the production (no retry, no billing switch).
pub fn usage_limit(text: &str) -> Option<String> {
    static RE_LIMIT: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?i)(usage limit|limit reached|limit will reset|hit your limit|out of extra usage|weekly limit|5-hour limit|credit balance is too low|insufficient credit)").unwrap()
    });
    static RE_AUTH: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(invalid api key|please run /login|not logged in|authentication_error|oauth token has expired|unauthorized|未登录|未登入|请先登录|請先登入|扫码登录)").unwrap());
    static RE_RESET: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(resets?(?: at)? [^\n|]{1,40})").unwrap());
    if RE_AUTH.is_match(text) {
        if Regex::new(r"未登录|未登入|请先登录|請先登入|扫码登录").unwrap().is_match(text) {
            return Some("豆包 CLI 尚未登入。請在終端機執行 `doubao login`，用豆包或飛書手機版掃碼登入（Studio 不會保存任何帳號資訊），完成後按「繼續」。".into());
        }
        return Some("Claude Code 尚未登入或登入已過期。請在終端機執行 `claude` 並以你的帳號登入（Studio 不會保存任何帳號資訊），完成後按「繼續」。".into());
    }
    if RE_LIMIT.is_match(text) {
        let reset = RE_RESET.captures(text).map(|c| format!("（Claude Code 回報：{}）", c[1].trim())).unwrap_or_default();
        return Some(format!(
            "已達 Claude 使用額度上限{reset}，製作已暫停並保存進度。Studio 不會改用付費 API 或額外付費用量；額度恢復後按「繼續」，會從同一步接著做。"
        ));
    }
    None
}

pub(crate) fn is_transient(text: &str) -> bool {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(overloaded|529|503 service|ECONNRESET|ETIMEDOUT|socket hang up|network error|api_error)").unwrap());
    RE.is_match(text)
}

/// Pronunciation error rate above which a line is re-voiced.
pub const MAX_PER: f64 = 0.12;

pub(crate) const DIGITS: [&str; 10] = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/// Chinese reading of a non-negative integer (0 … 9999 9999 9999): 16 → 十六, 70 → 七十, 105 → 一百零五.
/// Whisper writes digits for spoken numerals, so both sides only need one consistent reading.
pub fn cn_number(n: u64) -> String {
    fn group(g: u64) -> String {
        let units = ["千", "百", "十", ""];
        let digits = [g / 1000, g / 100 % 10, g / 10 % 10, g % 10];
        let mut out = String::new();
        let mut zero = false;
        for (i, d) in digits.iter().enumerate() {
            if *d == 0 {
                zero = !out.is_empty();
                continue;
            }
            if zero {
                out.push('零');
                zero = false;
            }
            out.push_str(DIGITS[*d as usize]);
            out.push_str(units[i]);
        }
        out
    }
    if n == 0 {
        return "零".into();
    }
    let parts = [(n / 1_0000_0000, "億"), (n / 1_0000 % 1_0000, "萬"), (n % 1_0000, "")];
    let mut out = String::new();
    for (g, unit) in parts {
        if g == 0 {
            continue;
        }
        if !out.is_empty() && g < 1000 && !out.ends_with('零') {
            out.push('零');
        }
        out.push_str(&group(g));
        out.push_str(unit);
    }
    // 10–19 are read 十X, not 一十X
    if out.starts_with("一十") {
        out = out["一".len()..].to_string();
    }
    out
}

/// Pronunciation tokens: digits → Chinese reading, CJK → toneless pinyin, latin letters lower-cased, rest dropped.
pub fn pron_tokens(s: &str) -> Vec<String> {
    use pinyin::ToPinyin;
    let chars: Vec<char> = s.chars().collect();
    let mut out = vec![];
    let push_reading = |r: &str, out: &mut Vec<String>| {
        for rc in r.chars() {
            if let Some(p) = rc.to_pinyin() {
                out.push(p.plain().to_string());
            }
        }
    };
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_digit() {
            let mut j = i;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            let int: String = chars[i..j].iter().collect();
            let mut reading = int.parse::<u64>().map(cn_number).unwrap_or_else(|_| int.chars().map(|d| DIGITS[d as usize - '0' as usize]).collect());
            if j + 1 < chars.len() && chars[j] == '.' && chars[j + 1].is_ascii_digit() {
                reading.push('點');
                j += 1;
                while j < chars.len() && chars[j].is_ascii_digit() {
                    reading.push_str(DIGITS[chars[j] as usize - '0' as usize]);
                    j += 1;
                }
            }
            push_reading(&reading, &mut out);
            i = j;
            continue;
        }
        if let Some(p) = c.to_pinyin() {
            out.push(p.plain().to_string());
        } else if c.is_ascii_alphabetic() {
            out.push(c.to_ascii_lowercase().to_string());
        }
        i += 1;
    }
    out
}

/// Levenshtein distance between the pronunciation tokens of the intended text and the ASR text, ÷ intended length.
pub fn pron_error(speak: &str, asr: &str) -> f64 {
    let a = pron_tokens(speak);
    let b = pron_tokens(asr);
    if a.is_empty() {
        return 0.0;
    }
    let mut d: Vec<usize> = (0..=b.len()).collect();
    for (i, x) in a.iter().enumerate() {
        let mut prev = d[0];
        d[0] = i + 1;
        for (j, y) in b.iter().enumerate() {
            let cur = (d[j + 1] + 1).min(d[j] + 1).min(prev + usize::from(x != y));
            prev = d[j + 1];
            d[j + 1] = cur;
        }
    }
    d[b.len()] as f64 / a.len() as f64
}

/// `≡ <id> 對上 a/b 字  CER x` lines printed by generate_voiceover_cosy.py → lines above the threshold.
pub fn bad_pronunciations<'a>(lines: impl Iterator<Item = &'a str>, max_cer: f64) -> Vec<(String, f64, String)> {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"≡\s+(\S+)\s.*CER\s+([0-9.]+)").unwrap());
    let mut out: Vec<(String, f64, String)> = vec![];
    for l in lines {
        if let Some(c) = RE.captures(l) {
            let cer: f64 = c[2].parse().unwrap_or(0.0);
            out.retain(|x| x.0 != c[1]); // latest result per line wins
            if cer > max_cer {
                out.push((c[1].to_string(), cer, l.trim().to_string()));
            }
        }
    }
    out
}

/// `自動檢出需注意的問題：**N**` (qa_video.py). The last QA in the job wins.
pub fn qa_problems<'a>(lines: impl Iterator<Item = &'a str>) -> Option<u32> {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"自動檢出需注意的問題：\*\*(\d+)\*\*").unwrap());
    lines.filter_map(|l| RE.captures(l).and_then(|c| c[1].parse().ok())).last()
}

pub(crate) fn latest_qa_report(wt: &Path) -> String {
    let dir = wt.join("out/qa");
    let newest = std::fs::read_dir(&dir).ok().and_then(|rd| rd.flatten().filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false)).max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok()));
    newest.and_then(|e| std::fs::read_to_string(e.path()).ok()).map(|s| clip(&s, 4000)).unwrap_or_default()
}

pub struct ScriptRules {
    /// target narration length in characters (zh) or words (en)
    pub target_units: f64,
    pub words: bool,
    /// false in custom-script mode (the user's script is as long as it is)
    pub check_length: bool,
    pub min_sources: u32,
}

/// Script checks: valid narration, the episode exists with ≥ 2 scenes, length near target, sources file with URLs.
pub fn check_script(wt: &Path, ep: &str, rules: &ScriptRules) -> Result<String, String> {
    let r = crate::narration::read(wt, "zh-TW")?;
    let doc = &r["doc"];
    let v = crate::narration::validate(doc);
    let errs: Vec<String> = v.errors.iter().filter(|e| e.seq_key == ep || e.seq_key.is_empty()).map(|e| format!("{} {} {}：{}", e.scene_id.clone().unwrap_or_default(), e.line_id.clone().unwrap_or_default(), e.field, e.message)).collect();
    if !errs.is_empty() {
        return Err(format!("narration.json 驗證失敗：\n{}", errs.join("\n")));
    }
    let seq = doc["sequences"].get(ep).ok_or(format!("narration.json 裡沒有 sequences.{ep}"))?;
    let scenes = seq["scenes"].as_array().cloned().unwrap_or_default();
    if scenes.is_empty() || (scenes.len() < 2 && rules.check_length) {
        return Err(format!("{ep} 只有 {} 個場景，至少需要 2 個", scenes.len()));
    }
    let texts: Vec<String> = scenes
        .iter()
        .flat_map(|s| s["lines"].as_array().cloned().unwrap_or_default())
        .map(|l| l["speak"].as_str().filter(|s| !s.trim().is_empty()).or(l["subtitle"].as_str()).unwrap_or("").to_string())
        .collect();
    let chars: usize = if rules.words { texts.iter().map(|t| t.split_whitespace().count()).sum() } else { texts.iter().map(|t| crate::narration::norm(t).chars().count()).sum() };
    let unit = if rules.words { "words" } else { "字" };
    let target = rules.target_units;
    let ratio = chars as f64 / target.max(1.0);
    if rules.check_length && !(0.6..=1.5).contains(&ratio) {
        return Err(format!("旁白共 {chars} {unit}，目標約 {:.0} {unit}。請{}到目標的 ±15% 內。", target, if ratio < 1.0 { "增加內容" } else { "精簡" }));
    }
    for k in ["title"] {
        if seq[k].as_str().map(|s| s.trim().is_empty()).unwrap_or(true) {
            return Err(format!("sequences.{ep}.{k} 是空的"));
        }
    }
    let src = wt.join(format!("{}_SOURCES.md", ep_upper(ep)));
    let s = match std::fs::read_to_string(&src) {
        Ok(s) => s,
        Err(_) if rules.min_sources == 0 => String::new(),
        Err(_) => return Err(format!("沒有 {}（資料來源清單）", clean_path(&src))),
    };
    let urls = Regex::new(r"https?://[^\s)>\]]+").unwrap().find_iter(&s).count();
    if (urls as u32) < rules.min_sources {
        return Err(format!("{} 只有 {urls} 個網址，至少需要 {} 個真實來源", ep_upper(ep) + "_SOURCES.md", rules.min_sources));
    }
    Ok(format!(
        "劇本檢查通過：{} 個場景、{chars} {unit}{}、{urls} 個來源網址",
        scenes.len(),
        if rules.check_length { format!("（目標 {target:.0}）") } else { "（自訂腳本，不檢查長度）".into() }
    ))
}

/// One 30 fps frame per scene: just after the scene's last anchor fires (all cards on screen), else mid-scene.
pub fn still_frames(wt: &Path, ep: &str, src: &str) -> Result<Vec<u64>, String> {
    let tl: Value = serde_json::from_str(&std::fs::read_to_string(wt.join(src).join("data/timeline.generated.json")).map_err(|e| format!("讀不到時間軸：{e}"))?)
        .map_err(|e| e.to_string())?;
    let t = tl.get(ep).ok_or(format!("時間軸沒有 {ep}"))?;
    let total = t["totalFrames"].as_u64().unwrap_or(0);
    let scenes = t["scenes"].as_array().cloned().unwrap_or_default();
    let mut frames = vec![];
    for s in &scenes {
        let a = s["startFrame"].as_u64().unwrap_or(0);
        let b = s["endFrame"].as_u64().unwrap_or(total).max(a + 1);
        let last_anchor = s["anchors"].as_object().and_then(|m| m.values().filter_map(|v| v["frame"].as_u64()).max());
        let f60 = match last_anchor {
            Some(f) if f + 90 < b => f + 90,
            _ => (a + b) / 2,
        };
        frames.push(f60 / 2);
    }
    frames.dedup();
    if frames.is_empty() {
        frames.push(total / 4);
    }
    Ok(frames.into_iter().take(12).collect())
}
