//! stdout progress parsers for render.mjs, the TTS generators and `claude -p --output-format stream-json`.

use super::*;

#[derive(Default, Debug)]
pub struct ParseState {
    total: Option<u64>,
    done: u64,
    align_total: Option<u64>,
    align_done: u64,
}

#[derive(Debug, Default, PartialEq)]
pub struct ParseOut {
    pub progress: Option<f64>, // 0..1 within the step
    pub text: Option<String>,
    pub display: Option<Vec<String>>, // replaces the raw line in the log (claude stream-json)
    pub level: Option<&'static str>,
}

pub(crate) static RE_RENDER_TOTAL: Lazy<Regex> = Lazy::new(|| Regex::new(r"渲染 (\S+)：(\d+) 幀，(\d+) 段").unwrap());
pub(crate) static RE_CHUNK: Lazy<Regex> = Lazy::new(|| Regex::new(r"區段 (\d+)[–-](\d+)：(.*)").unwrap());
pub(crate) static RE_RENDERED: Lazy<Regex> = Lazy::new(|| Regex::new(r"Rendered (\d+)/(\d+)").unwrap());
pub(crate) static RE_VOICE_TOTAL: Lazy<Regex> = Lazy::new(|| Regex::new(r"共 (\d+) 句，需要產生 (\d+) 句").unwrap());
pub(crate) static RE_ALIGN: Lazy<Regex> = Lazy::new(|| Regex::new(r"對齊 (\d+) 句").unwrap());

pub fn parse_line(parser: Parser, st: &mut ParseState, line: &str) -> ParseOut {
    let t = line.trim();
    match parser {
        Parser::Plain => {
            let lower = t.to_ascii_lowercase();
            let level = if lower.starts_with("error") || lower.contains("traceback") || t.starts_with("[錯誤]") { Some("error") } else if t.starts_with('!') || t.starts_with('⚠') { Some("warn") } else { None };
            ParseOut { level, ..Default::default() }
        }
        Parser::Render => {
            if let Some(c) = RE_RENDER_TOTAL.captures(t) {
                st.total = c[2].parse().ok();
                st.done = 0;
                return ParseOut { progress: Some(0.0), text: Some(format!("渲染 {}：{} 幀", &c[1], &c[2])), ..Default::default() };
            }
            if let Some(c) = RE_CHUNK.captures(t) {
                let (a, z): (u64, u64) = (c[1].parse().unwrap_or(0), c[2].parse().unwrap_or(0));
                let failed = c[3].contains("失敗");
                if !failed {
                    st.done += z.saturating_sub(a) + 1;
                }
                let frac = st.total.map(|tot| 0.9 * st.done as f64 / tot.max(1) as f64);
                let txt = match st.total {
                    Some(tot) => format!("區段 {a}–{z}（{}/{} 幀）", st.done.min(tot), tot),
                    None => format!("區段 {a}–{z}"),
                };
                let level = if failed { Some("error") } else if c[3].contains('⚠') { Some("warn") } else { None };
                return ParseOut { progress: frac, text: Some(txt), level, ..Default::default() };
            }
            if t.contains("區段") && t.contains("失敗") {
                return ParseOut { level: Some("error"), ..Default::default() };
            }
            if let Some(c) = RE_RENDERED.captures(t) {
                let (n, m): (f64, f64) = (c[1].parse().unwrap_or(0.0), c[2].parse().unwrap_or(1.0));
                if st.total.is_none() {
                    return ParseOut { progress: Some(0.9 * n / m.max(1.0)), text: Some(format!("Rendered {n}/{m}")), ..Default::default() };
                }
                return ParseOut::default();
            }
            if t.contains("開始編碼") || t.starts_with("編碼中") {
                // render.mjs prints "編碼中：h264_nvenc" (or h264_amf / h264_qsv / libx264 …) — show the real encoder
                let enc = t.split_once('：').map(|(_, e)| e.trim()).filter(|e| !e.is_empty());
                return ParseOut { progress: Some(0.92), text: Some(enc.map(|e| format!("編碼中（{e}）")).unwrap_or_else(|| "編碼中".into())), ..Default::default() };
            }
            if t.starts_with("完成：") {
                return ParseOut { progress: Some(1.0), text: Some(t.to_string()), ..Default::default() };
            }
            if t.starts_with('⚠') || t.contains("（注意") {
                return ParseOut { level: Some("warn"), ..Default::default() };
            }
            ParseOut::default()
        }
        Parser::Voice => {
            if let Some(c) = RE_VOICE_TOTAL.captures(t) {
                let need: u64 = c[2].parse().unwrap_or(0);
                st.total = Some(need);
                st.done = 0;
                let prog = if need == 0 { 0.85 } else { 0.0 };
                return ParseOut { progress: Some(prog), text: Some(format!("共 {} 句，需產生 {need} 句", &c[1])), ..Default::default() };
            }
            if t.starts_with('✓') || t.starts_with('✗') {
                st.done += 1;
                let tot = st.total.unwrap_or(0).max(st.done);
                return ParseOut {
                    progress: Some(0.85 * st.done as f64 / tot.max(1) as f64),
                    text: Some(format!("配音 {}/{}{}", st.done, tot, if t.starts_with('✗') { "（有失敗）" } else { "" })),
                    level: if t.starts_with('✗') { Some("error") } else { None },
                    ..Default::default()
                };
            }
            if let Some(c) = RE_ALIGN.captures(t) {
                st.align_total = c[1].parse().ok();
                st.align_done = 0;
                return ParseOut { progress: Some(0.85), text: Some(format!("Whisper 對齊 {} 句", &c[1])), ..Default::default() };
            }
            if t.starts_with('≡') {
                st.align_done += 1;
                let tot = st.align_total.unwrap_or(1).max(st.align_done);
                return ParseOut { progress: Some(0.85 + 0.15 * st.align_done as f64 / tot as f64), text: Some(format!("對齊 {}/{}", st.align_done, tot)), ..Default::default() };
            }
            if t.starts_with("完成：") {
                return ParseOut { progress: Some(1.0), text: Some(t.to_string()), ..Default::default() };
            }
            if t.starts_with('…') || t.starts_with('!') {
                return ParseOut { level: Some("warn"), text: t.starts_with('…').then(|| t.trim_start_matches('…').trim().to_string()), ..Default::default() };
            }
            if t.contains("Traceback") || t.starts_with("[錯誤]") {
                return ParseOut { level: Some("error"), ..Default::default() };
            }
            ParseOut::default()
        }
        Parser::Claude => parse_claude(st, t),
    }
}

pub(crate) fn clip(s: &str, n: usize) -> String {
    let c: String = s.chars().take(n).collect();
    if s.chars().count() > n { c + "…" } else { c }
}

pub(crate) fn parse_claude(st: &mut ParseState, t: &str) -> ParseOut {
    let Ok(v) = serde_json::from_str::<Value>(t) else { return ParseOut::default() };
    let mut out = ParseOut { display: Some(vec![]), ..Default::default() };
    let d = out.display.as_mut().unwrap();
    match v["type"].as_str().unwrap_or("") {
        "system" => {
            if v["subtype"] == "init" {
                d.push(format!("[init] model={} cwd={} tools={}", v["model"].as_str().unwrap_or("?"), v["cwd"].as_str().unwrap_or("?"), v["tools"].as_array().map(|a| a.len()).unwrap_or(0)));
                out.text = Some("Claude 啟動".into());
            }
        }
        "assistant" => {
            st.done += 1;
            for c in v["message"]["content"].as_array().cloned().unwrap_or_default() {
                match c["type"].as_str() {
                    Some("text") => d.extend(c["text"].as_str().unwrap_or("").lines().map(|l| format!("Claude: {l}"))),
                    Some("tool_use") => d.push(format!("[tool] {} {}", c["name"].as_str().unwrap_or("?"), clip(&c["input"].to_string(), 200))),
                    _ => {}
                }
            }
            out.text = Some(format!("Claude 第 {} 步", st.done));
        }
        "user" => {
            for c in v["message"]["content"].as_array().cloned().unwrap_or_default() {
                if c["type"] == "tool_result" {
                    let txt = match &c["content"] {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    let is_err = c["is_error"].as_bool().unwrap_or(false);
                    d.push(format!("[result{}] {}", if is_err { " ERROR" } else { "" }, clip(&txt.replace('\n', " ⏎ "), 200)));
                }
            }
        }
        "result" => {
            d.push(format!(
                "[done] {} turns={} cost=${} {}",
                v["subtype"].as_str().unwrap_or(""),
                v["num_turns"],
                v["total_cost_usd"].as_f64().map(|c| format!("{c:.4}")).unwrap_or("?".into()),
                clip(v["result"].as_str().unwrap_or(""), 2000)
            ));
            out.progress = Some(1.0);
            out.text = Some("Claude 完成".into());
            if v["is_error"].as_bool().unwrap_or(false) {
                out.level = Some("error");
            }
        }
        _ => {}
    }
    out
}
