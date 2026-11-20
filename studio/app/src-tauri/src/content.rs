//! v0.2.1 content control for Autonomous Production Mode.
//!
//! Three production modes (`AutoConfig.mode`):
//! - `auto`   全自主：AI researches the topic and writes the script itself (the brief, if any, is guidance).
//! - `guided` 指導：AI must follow the user's brief, chapters, must-include / must-avoid lists, opening and ending.
//! - `script` 自訂腳本：the user's complete script becomes the narration verbatim (Studio imports it deterministically);
//!            the AI may only add anchors, pronunciation (`speak`) and metadata, never change what is said.
//!
//! Output language (`AutoConfig.language`): `zh-TW`, `zh-CN` (the master script is written in Simplified Chinese
//! directly — no Traditional render, no Traditional→Simplified conversion of the script), `both`, `en`.
//!
//! Everything is part of `AutoConfig`, which is stored in `productions.state_json`; `brief_block` puts the same
//! requirements into every AI step (research, script, animation, visual review, fixes, upload text) and the
//! worktree gets `out/auto/BRIEF.md` for external agents. `check_requirements` / `fidelity` enforce what can be
//! checked mechanically (chapter titles, forbidden terms, short must-include keywords, verbatim custom script).

use crate::autopilot::AutoConfig;
use crate::narration::norm;
use serde_json::{json, Value};

pub const MODES: [&str; 3] = ["auto", "guided", "script"];
pub const LANGS: [&str; 4] = ["zh-TW", "zh-CN", "both", "en"];

/// Effective output language. Productions created before v0.2.1 have no `language`: derive it from the old
/// Bilibili switch (zh-TW master + optional zh-CN conversion = "both").
pub fn lang(c: &AutoConfig) -> &str {
    match c.language.as_str() {
        "zh-TW" | "zh-CN" | "both" | "en" => c.language.as_str(),
        _ if c.bilibili => "both",
        _ => "zh-TW",
    }
}

pub fn wants_tw(c: &AutoConfig) -> bool {
    matches!(lang(c), "zh-TW" | "both")
}

/// A Simplified-Chinese video is produced (Bilibili): converted from zh-TW in "both", written directly in "zh-CN".
pub fn wants_cn(c: &AutoConfig) -> bool {
    matches!(lang(c), "zh-CN" | "both")
}

/// zh-CN only: the master narration (src/) is Simplified; voice, timeline, stills and render use src_cn.
pub fn cn_only(c: &AutoConfig) -> bool {
    lang(c) == "zh-CN"
}

pub fn is_en(c: &AutoConfig) -> bool {
    lang(c) == "en"
}

pub fn mode(c: &AutoConfig) -> &str {
    if MODES.contains(&c.mode.as_str()) { c.mode.as_str() } else { "auto" }
}

pub fn mode_label(m: &str) -> &'static str {
    match m {
        "guided" => "指導模式",
        "script" => "自訂腳本模式",
        _ => "全自主模式",
    }
}

pub fn lang_label(l: &str) -> &'static str {
    match l {
        "zh-CN" => "僅簡體中文",
        "both" => "繁體＋簡體中文",
        "en" => "英文",
        _ => "僅繁體中文",
    }
}

/// Characters (zh) or words (en) per second of narration, for length targets.
pub fn rate(c: &AutoConfig) -> f64 {
    if is_en(c) {
        2.5 // words / s
    } else if cn_only(c) {
        5.4
    } else {
        c.tw_cps.unwrap_or(3.6)
    }
}

/// Split a user list: one item per line, or separated by 、，,；; (Markdown bullets removed).
pub fn split_list(s: &str) -> Vec<String> {
    s.split(|c| c == '\n' || c == '、' || c == '，' || c == ',' || c == '；' || c == ';')
        .map(|x| x.trim().trim_start_matches(|c: char| c == '-' || c == '*' || c == '•' || c.is_ascii_digit() || c == '.' || c == '、' || c == ')').trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

fn opt(label: &str, v: &str) -> String {
    if v.trim().is_empty() { String::new() } else { format!("{label}：{}\n", v.trim()) }
}

/// Requirements given to every AI step. `stage` tailors the lead sentence; the content is identical everywhere so
/// a fix job cannot "forget" a constraint the script writer had.
pub fn brief_block(c: &AutoConfig, stage: &str) -> String {
    let m = mode(c);
    let mut s = String::new();
    s.push_str(&format!("【使用者的製作要求｜{}｜輸出語言：{}】\n", mode_label(m), lang_label(lang(c))));
    s.push_str(match m {
        "guided" => "這是「指導模式」：必須遵循下面的內容與製作要求（章節、必須介紹、禁止出現、開場、片尾）。要求與你的判斷衝突時以要求為準；要求本身有事實錯誤時不要照寫，改在完成說明中指出。\n",
        "script" => "這是「自訂腳本模式」：旁白必須逐字使用使用者提供的腳本，不得增刪、改寫、重排或「潤飾」任何句子的內容（只可以加錨點、朗讀念法 speak、標題與封面文字）。\n",
        _ => "這是「全自主模式」：由你研究並撰寫；下面若有要求，視為必須尊重的方向。\n",
    });
    if stage != "script" {
        s.push_str("（這些要求同樣適用於本步驟：畫面、配音念法、修正與上架文字都不得違反。）\n");
    }
    if !c.brief.trim().is_empty() {
        s.push_str("\n影片內容與製作要求（Markdown，使用者原文）：\n<<<\n");
        s.push_str(c.brief.trim());
        s.push_str("\n>>>\n");
    }
    let ch: Vec<String> = c.chapters.iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
    if !ch.is_empty() {
        s.push_str(&format!(
            "\n指定章節（依序，每個章節＝一個 scene，scene 的 title 使用這些名稱）：\n{}\n",
            ch.iter().enumerate().map(|(i, t)| format!("{}. {t}", i + 1)).collect::<Vec<_>>().join("\n")
        ));
    }
    s.push_str(&opt("\n必須介紹的內容", &c.must_include));
    s.push_str(&opt("禁止出現的內容（旁白、字幕、畫面文字、上架文字都不得出現）", &c.must_avoid));
    s.push_str(&opt("開場要求", &c.opening));
    s.push_str(&opt("片尾要求", &c.ending));
    s.push_str(&opt("配音語氣", &c.voice_tone));
    s.push_str(&opt("動畫風格", &c.animation_style));
    s.push_str(&opt("節奏", &c.pacing));
    if m == "script" && stage != "script" {
        s.push_str("旁白就是使用者的腳本：不得改寫 subtitle 的內容。\n");
    }
    s
}

/// The brief as a Markdown file for the worktree (`out/auto/BRIEF.md`) and the per-video folder.
pub fn brief_markdown(c: &AutoConfig, ep: &str) -> String {
    let mut s = format!("# {} 製作要求\n\n- 主題：{}\n- 模式：{}\n- 輸出語言：{}\n- 目標長度：約 {} 分鐘\n\n", ep.to_uppercase(), c.topic, mode_label(mode(c)), lang_label(lang(c)), c.minutes);
    s.push_str(&brief_block(c, "script"));
    if mode(c) == "script" {
        s.push_str("\n## 使用者腳本（原文）\n\n");
        s.push_str(c.script_text.trim());
        s.push('\n');
    }
    s
}

// ------------------------------------------------------------------ custom script import

fn strip_md(line: &str) -> String {
    let mut t = line.trim().to_string();
    for p in ["- ", "* ", "+ ", "> "] {
        if let Some(r) = t.strip_prefix(p) {
            t = r.to_string();
        }
    }
    // numbered list "1. " / "1、"
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() {
        let rest = &t[digits.len()..];
        if let Some(r) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix("、")) {
            t = r.to_string();
        }
    }
    t.replace("**", "").replace("__", "").replace('`', "").trim().to_string()
}

fn is_sentence_end(c: char, en: bool) -> bool {
    if en { matches!(c, '.' | '?' | '!') } else { matches!(c, '。' | '？' | '！' | '?' | '!') }
}

/// Split one paragraph into narration lines: at sentence ends, then long sentences at clause punctuation.
pub fn split_sentences(text: &str, en: bool) -> Vec<String> {
    let max = if en { 160 } else { 36 };
    let chars: Vec<char> = text.chars().collect();
    let mut sentences = vec![];
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        cur.push(c);
        let next_space = chars.get(i + 1).map(|n| n.is_whitespace()).unwrap_or(true);
        if is_sentence_end(c, en) && (!en || next_space) {
            // keep closing quotes with the sentence
            sentences.push(std::mem::take(&mut cur));
        } else if (c == '」' || c == '』' || c == '"') && sentences.last().is_some() && cur.trim().chars().count() == 1 {
            let q = std::mem::take(&mut cur);
            if let Some(l) = sentences.last_mut() {
                l.push_str(q.trim());
            }
        }
    }
    if !cur.trim().is_empty() {
        sentences.push(cur);
    }
    let mut out = vec![];
    for s in sentences {
        let s = s.trim().to_string();
        if s.is_empty() {
            continue;
        }
        if s.chars().count() <= max {
            out.push(s);
            continue;
        }
        // long sentence: break after clause punctuation, keeping pieces ≤ max where possible
        let clause = |c: char| if en { matches!(c, ',' | ';' | ':') } else { matches!(c, '，' | '；' | '：' | '、' | ',') };
        let mut piece = String::new();
        for c in s.chars() {
            piece.push(c);
            if clause(c) && piece.chars().count() >= max / 2 {
                out.push(piece.trim().to_string());
                piece.clear();
            }
        }
        if !piece.trim().is_empty() {
            out.push(piece.trim().to_string());
        }
    }
    out
}

/// A user script → (title, scenes[(scene title, lines)]). `## heading` starts a scene; `# heading` is the episode
/// title. Without headings, blank-line separated paragraphs become scenes (titled by `chapters` when given).
pub fn parse_script(text: &str, en: bool, chapters: &[String]) -> (Option<String>, Vec<(String, Vec<String>)>) {
    let mut title = None;
    let mut scenes: Vec<(String, Vec<String>)> = vec![];
    let mut para = String::new();
    let mut has_headings = false;
    let flush = |para: &mut String, scenes: &mut Vec<(String, Vec<String>)>, new_scene_per_para: bool| {
        let p = para.trim().to_string();
        para.clear();
        if p.is_empty() {
            return;
        }
        let lines = split_sentences(&p, en);
        if new_scene_per_para || scenes.is_empty() {
            scenes.push((String::new(), lines));
        } else if let Some(last) = scenes.last_mut() {
            last.1.extend(lines);
        }
    };
    for raw in text.lines() {
        let l = raw.trim();
        if l.starts_with("<!--") || l.starts_with('|') || l.starts_with("![") || l.starts_with("```") || l == "---" {
            continue;
        }
        if let Some(h) = l.strip_prefix("# ") {
            flush(&mut para, &mut scenes, !has_headings);
            if title.is_none() {
                title = Some(strip_md(h));
            }
            continue;
        }
        if let Some(h) = l.strip_prefix("### ").or_else(|| l.strip_prefix("## ")) {
            flush(&mut para, &mut scenes, !has_headings);
            has_headings = true;
            scenes.push((strip_md(h), vec![]));
            continue;
        }
        if l.is_empty() {
            flush(&mut para, &mut scenes, !has_headings);
            continue;
        }
        let t = strip_md(l);
        if !para.is_empty() {
            para.push(if en { ' ' } else { '\n' });
        }
        para.push_str(&t);
    }
    flush(&mut para, &mut scenes, !has_headings);
    scenes.retain(|(_, l)| !l.is_empty());
    for (i, s) in scenes.iter_mut().enumerate() {
        if s.0.is_empty() {
            s.0 = chapters.get(i).cloned().unwrap_or_else(|| if en { format!("Part {}", i + 1) } else { format!("第 {} 段", i + 1) });
        }
    }
    // Chinese lines joined across line breaks inside a paragraph: drop the break
    if !en {
        for s in scenes.iter_mut() {
            for l in s.1.iter_mut() {
                *l = l.replace('\n', "");
            }
        }
    }
    (title, scenes)
}

/// narration.json sequence for an imported script (no anchors yet; the AI adds them).
pub fn script_to_seq(ep: &str, title: &str, scenes: &[(String, Vec<String>)]) -> Value {
    let sc: Vec<Value> = scenes
        .iter()
        .enumerate()
        .map(|(i, (t, lines))| {
            let sid = format!("s{:02}", i + 1);
            json!({
                "id": sid,
                "title": t,
                "lines": lines.iter().enumerate().map(|(j, l)| json!({"id": format!("{ep}-{sid}-{:02}", j + 1), "subtitle": l})).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({"voiceEngine": "cosyvoice", "title": title, "scenes": sc})
}

fn seq_text(seq: &Value, field_speak: bool) -> String {
    seq["scenes"]
        .as_array()
        .map(|a| {
            a.iter()
                .flat_map(|s| s["lines"].as_array().cloned().unwrap_or_default())
                .map(|l| {
                    let sub = l["subtitle"].as_str().unwrap_or("").to_string();
                    if field_speak { l["speak"].as_str().filter(|s| !s.trim().is_empty()).map(String::from).unwrap_or(sub) } else { sub }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Custom-script mode: the subtitles, read in order, must be the user's script (punctuation / spacing / Markdown
/// ignored). Returns a short description of the first difference.
pub fn fidelity(user_script: &str, seq: &Value, en: bool) -> Result<(), String> {
    let (_, scenes) = parse_script(user_script, en, &[]);
    let want: String = scenes.iter().flat_map(|s| s.1.iter()).map(|l| norm(l)).collect();
    let got = norm(&seq_text(seq, false));
    if want == got {
        return Ok(());
    }
    let w: Vec<char> = want.chars().collect();
    let g: Vec<char> = got.chars().collect();
    let i = w.iter().zip(g.iter()).take_while(|(a, b)| a == b).count();
    let ctx = |v: &[char]| v[i.saturating_sub(8)..(i + 16).min(v.len())].iter().collect::<String>();
    Err(format!(
        "字幕內容與使用者腳本不一致（自訂腳本模式不得改寫內容）。腳本共 {} 字、字幕 {} 字；第 {} 字開始不同：\n  腳本：…{}…\n  字幕：…{}…\n請把 subtitle 改回腳本原文（只能用 speak 調整念法）。",
        w.len(),
        g.len(),
        i + 1,
        ctx(&w),
        ctx(&g)
    ))
}

/// Mechanical checks of the brief against the written narration. Ok(notes) lists what was verified and what can
/// only be judged by a person (long must-include items).
pub fn check_requirements(c: &AutoConfig, seq: &Value) -> Result<Vec<String>, String> {
    let mut notes = vec![];
    let mut errs = vec![];
    let scenes = seq["scenes"].as_array().cloned().unwrap_or_default();
    let ch: Vec<String> = c.chapters.iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
    if !ch.is_empty() && mode(c) != "auto" {
        if scenes.len() != ch.len() {
            errs.push(format!("指定了 {} 個章節，但旁白有 {} 個場景。每個指定章節必須是一個 scene，依序排列。", ch.len(), scenes.len()));
        } else {
            for (i, (want, sc)) in ch.iter().zip(scenes.iter()).enumerate() {
                let got = sc["title"].as_str().unwrap_or("");
                let (a, b) = (norm(want), norm(got));
                if !(a == b || b.contains(&a) || a.contains(&b) && !b.is_empty()) {
                    errs.push(format!("第 {} 個場景的標題應為「{want}」，目前是「{got}」。", i + 1));
                }
            }
            if errs.is_empty() {
                notes.push(format!("章節 {} 個，名稱與順序相符", ch.len()));
            }
        }
    }
    let spoken = format!("{}\n{}\n{}", seq_text(seq, false), seq_text(seq, true), seq["title"].as_str().unwrap_or(""));
    let ns = norm(&spoken);
    let avoid = split_list(&c.must_avoid);
    let short_avoid: Vec<&String> = avoid.iter().filter(|t| t.chars().count() <= 16).collect();
    let hits: Vec<&String> = short_avoid.iter().copied().filter(|t| !norm(t).is_empty() && ns.contains(&norm(t))).collect();
    if !hits.is_empty() {
        errs.push(format!("旁白／字幕出現了禁止的內容：{}。請改寫這些句子，避免提及。", hits.iter().map(|s| format!("「{s}」")).collect::<Vec<_>>().join("、")));
    } else if !short_avoid.is_empty() {
        notes.push(format!("禁止詞 {} 個都沒有出現", short_avoid.len()));
    }
    if avoid.len() > short_avoid.len() {
        notes.push(format!("{} 項較長的禁止事項無法自動比對，已交給 AI 遵守、請人工確認", avoid.len() - short_avoid.len()));
    }
    let include = split_list(&c.must_include);
    let kw: Vec<&String> = include.iter().filter(|t| t.chars().count() <= 12).collect();
    let missing: Vec<&String> = kw.iter().copied().filter(|t| !ns.contains(&norm(t))).collect();
    if mode(c) != "auto" && !missing.is_empty() {
        errs.push(format!("必須介紹的關鍵詞沒有出現在旁白中：{}。", missing.iter().map(|s| format!("「{s}」")).collect::<Vec<_>>().join("、")));
    } else if !kw.is_empty() {
        notes.push(format!("必須介紹的關鍵詞 {}/{} 出現", kw.len() - missing.len(), kw.len()));
    }
    if include.len() > kw.len() {
        notes.push(format!("{} 項較長的必須介紹內容無法自動比對，請人工確認", include.len() - kw.len()));
    }
    if errs.is_empty() { Ok(notes) } else { Err(format!("沒有符合使用者的製作要求：\n- {}", errs.join("\n- "))) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> AutoConfig {
        AutoConfig { topic: "測試".into(), ..Default::default() }
    }

    #[test]
    fn language_defaults_and_legacy() {
        let mut c = cfg();
        c.language = String::new();
        c.bilibili = true;
        assert_eq!(lang(&c), "both");
        c.bilibili = false;
        assert_eq!(lang(&c), "zh-TW");
        c.language = "zh-CN".into();
        assert!(cn_only(&c) && wants_cn(&c) && !wants_tw(&c));
        c.language = "en".into();
        assert!(is_en(&c) && !wants_cn(&c) && !wants_tw(&c));
    }

    #[test]
    fn script_parsing_headings_and_sentences() {
        let s = "# 安裝教學\n\n## 下載\n到 GitHub 的 Releases 頁面下載安裝程式。下載完成後，**雙擊**執行。\n\n## 第一次啟動\n- 開啟 Studio，會看到快速導覽。\n- 按「環境」檢查。";
        let (t, sc) = parse_script(s, false, &[]);
        assert_eq!(t.as_deref(), Some("安裝教學"));
        assert_eq!(sc.len(), 2);
        assert_eq!(sc[0].0, "下載");
        assert_eq!(sc[0].1, vec!["到 GitHub 的 Releases 頁面下載安裝程式。", "下載完成後，雙擊執行。"]);
        assert_eq!(sc[1].1.len(), 2);
        let seq = script_to_seq("test001", "安裝教學", &sc);
        assert_eq!(seq["scenes"][1]["lines"][0]["id"], "test001-s02-01");
        assert!(fidelity(s, &seq, false).is_ok());
        let mut changed = seq.clone();
        changed["scenes"][0]["lines"][1]["subtitle"] = json!("下載後，雙擊執行它。");
        let e = fidelity(s, &changed, false).unwrap_err();
        assert!(e.contains("不一致"), "{e}");
    }

    #[test]
    fn script_without_headings_uses_chapters_and_long_lines_split() {
        let s = "第一段的第一句話。第二句話比較長，需要在逗號的地方切開，因為字幕一行不能超過三十六個字，否則會太長，所以要切。\n\nSecond paragraph.";
        let (_, sc) = parse_script(s, false, &["開場".into(), "結尾".into()]);
        assert_eq!(sc.len(), 2);
        assert_eq!(sc[0].0, "開場");
        assert!(sc[0].1.iter().all(|l| l.chars().count() <= 36), "{:?}", sc[0].1);
        let (_, en) = parse_script("## Intro\nThe internet is a network. It has 3.5 billion users! Really?", true, &[]);
        assert_eq!(en[0].1, vec!["The internet is a network.", "It has 3.5 billion users!", "Really?"]);
    }

    #[test]
    fn requirement_checks() {
        let mut c = cfg();
        c.mode = "guided".into();
        c.chapters = vec!["什麼是封包".into(), "路由器".into()];
        c.must_avoid = "政治\n比特幣".into();
        c.must_include = "IP 位址、TCP".into();
        let seq = json!({"title": "網路", "scenes": [
            {"id": "s01", "title": "什麼是封包", "lines": [{"id": "a", "subtitle": "資料被切成封包，每個都有 IP 位址。"}]},
            {"id": "s02", "title": "路由器", "lines": [{"id": "b", "subtitle": "TCP 確保不遺失。"}]}]});
        let notes = check_requirements(&c, &seq).unwrap();
        assert!(notes.iter().any(|n| n.contains("章節 2 個")), "{notes:?}");
        let mut bad = seq.clone();
        bad["scenes"][1]["lines"][0]["subtitle"] = json!("就像比特幣一樣。");
        bad["scenes"][1]["title"] = json!("交換器");
        let e = check_requirements(&c, &bad).unwrap_err();
        assert!(e.contains("比特幣") && e.contains("路由器") && e.contains("TCP"), "{e}");
        assert_eq!(split_list("- 一\n- 二、三, 四"), vec!["一", "二", "三", "四"]);
    }

    #[test]
    fn brief_reaches_every_stage() {
        let mut c = cfg();
        c.mode = "script".into();
        c.brief = "## 重點\n用真實截圖".into();
        c.must_avoid = "虛構 UI".into();
        for st in ["script", "animate", "visual", "fix", "publish"] {
            let b = brief_block(&c, st);
            assert!(b.contains("用真實截圖") && b.contains("虛構 UI") && b.contains("自訂腳本模式"), "{st}: {b}");
        }
        assert!(brief_block(&c, "animate").contains("不得改寫 subtitle"));
    }
}
