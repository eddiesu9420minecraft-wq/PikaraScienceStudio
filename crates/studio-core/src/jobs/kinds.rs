//! Job kind table (labels, parameters, GPU/CPU/net resource) and episode helpers.

use super::*;

pub struct KindSpec {
    pub kind: &'static str,
    pub label: &'static str,
    pub resource: &'static str,
    pub params: Value,
}

pub(crate) fn p(name: &str, ty: &str, required: bool, default: Value, help: &str) -> Value {
    json!({"name": name, "type": ty, "required": required, "default": default, "help": help})
}

pub(crate) fn ep_param() -> Value {
    p("episode", "string", false, json!("ep01"), "集數 id（narration.json 的 sequences.<id>，例：ep02）")
}

pub fn kinds() -> Vec<KindSpec> {
    vec![
        KindSpec { kind: "voiceover_tw", label: "配音 zh-TW（CosyVoice）", resource: "gpu", params: json!([
            ep_param(),
            p("only", "string", false, Value::Null, "只重生這些句子 ID（空白分隔）"),
            p("force", "bool", false, json!(false), "忽略快取重新產生"),
            p("speed", "number", false, Value::Null, "固定語速"),
            p("targetCps", "number", false, Value::Null, "目標字/秒（自動校準 speed）")]) },
        KindSpec { kind: "voiceover_cn", label: "配音 zh-CN（CosyVoice）", resource: "gpu", params: json!([
            ep_param(),
            p("only", "string", false, Value::Null, "只重生這些句子 ID（空白分隔）"),
            p("force", "bool", false, json!(false), "忽略快取重新產生"),
            p("targetCps", "number", false, Value::Null, "目標字/秒（空白＝配音員自然語速；倍率限制 0.85–1.15）")]) },
        KindSpec { kind: "timeline", label: "時間軸＋字幕", resource: "cpu", params: json!([
            ep_param(), p("src", "string", false, json!("src"), "src 或 src_cn"),
            p("estimate", "bool", false, json!(false), "缺音檔時以字數估算"),
            p("voiceTempo", "number", false, Value::Null, "旁白語速 0.9 / 1.0 / 1.1 / 1.2（空白＝設定值；保留音高，不改原始配音檔）")]) },
        KindSpec { kind: "mix", label: "混音", resource: "cpu", params: json!([
            ep_param(), p("src", "string", false, json!("src"), "src 或 src_cn")]) },
        KindSpec { kind: "render", label: "渲染（render.mjs）", resource: "gpu", params: json!([
            ep_param(),
            p("comp", "string", false, Value::Null, "預設 <EP>-30fps；可填 <EP> / <EP>-30fps / <EP>-YT15 / ArtTest"),
            p("mode", "string", false, json!("gpu"), "gpu / cpu / preview"),
            p("src", "string", false, json!("src"), "src 或 src_cn"),
            p("out", "string", false, Value::Null, "輸出檔名（專案根目錄，預設 <EP>_Final.mp4）"),
            p("mix", "string", false, Value::Null, "混音名稱（例：ep02_cn）"),
            p("fps", "number", false, Value::Null, "僅供顯示；fps 由 comp 決定"),
            p("frames", "string", false, Value::Null, "a-b 只渲染部分幀"),
            p("chunk", "number", false, Value::Null, "每段幀數（預設 1800；越小越常存檔，可續傳）"),
            p("concurrency", "number", false, Value::Null, "固定並行數")]) },
        KindSpec { kind: "qa", label: "品質檢查（qa_video.py）", resource: "cpu", params: json!([
            ep_param(),
            p("video", "string", false, Value::Null, "影片檔名（預設 <EP>_Final.mp4）"),
            p("src", "string", false, json!("src"), ""), p("speed", "number", false, Value::Null, "1.5 倍速版填 1.5")]) },
        KindSpec { kind: "make_cn", label: "產生 zh-CN 原始碼（make_cn.py；保留簡體既有旁白與時間軸）", resource: "cpu", params: json!([
            p("episode", "string", false, Value::Null, "只轉換這一集的旁白（空白 = 所有尚未有簡體稿的集數）"),
            p("reconvert", "bool", false, json!(false), "用繁體稿重新轉換並覆寫這一集的簡體旁白")]) },
        KindSpec { kind: "final_tw", label: "繁中正式版（時間軸→字幕→混音→渲染 30fps→QA）", resource: "gpu", params: json!([
            ep_param(), p("out", "string", false, Value::Null, "預設 <EP>_Final.mp4")]) },
        KindSpec { kind: "youtube_15x", label: "YouTube 1.5× 版（SRT 縮放＋<EP>-YT15）", resource: "gpu", params: json!([
            ep_param(), p("out", "string", false, Value::Null, "預設 <EP>_YouTube_zh-TW.mp4")]) },
        KindSpec { kind: "bilibili", label: "Bilibili zh-CN 全流程", resource: "gpu", params: json!([
            ep_param(), p("out", "string", false, Value::Null, "預設 <EP>_Bilibili_zh-CN.mp4")]) },
        KindSpec { kind: "revoice", label: "重新配音（候選→驗證→切換）", resource: "gpu", params: json!([
            ep_param(), p("locale", "string", false, json!("zh-TW"), "zh-TW 或 zh-CN"),
            p("lines", "string", false, Value::Null, "句子 ID（空白分隔；空白＝整個語言版本）"),
            p("speed", "number", false, Value::Null, "CosyVoice 語速（0.85–1.15）"),
            p("targetCps", "number", false, Value::Null, "目標字/秒"),
            p("ref", "string", false, Value::Null, "參考音訊（public/user/ 或 tools/CosyVoice/reference*/）"),
            p("refText", "string", false, Value::Null, "參考音訊逐字稿"),
            p("review", "bool", false, json!(false), "不自動切換，留給語音工作室試聽決定")]) },
        KindSpec { kind: "rerender", label: "重新渲染（沿用有效的畫面與音訊）", resource: "gpu", params: json!([
            ep_param(), p("locale", "string", false, json!("zh-TW"), "zh-TW 或 zh-CN"),
            p("mode", "string", false, json!("affected"), "remux／affected／full"),
            p("fps", "number", false, json!(30), "30 或 60"), p("res", "string", false, json!("1080p"), "1080p 或 720p"),
            p("encoder", "string", false, json!("auto"), "auto／h264_nvenc／h264_amf／libx264…"),
            p("quality", "string", false, json!("standard"), "high／standard／draft"),
            p("qa", "bool", false, json!(true), "切換前先跑品質檢查")]) },
        KindSpec { kind: "custom", label: "自訂指令（cmd /c）", resource: "cpu", params: json!([
            p("command", "string", true, Value::Null, "在專案根目錄以 cmd /c 執行"),
            p("gpu", "bool", false, json!(false), "會用到 GPU（取得 GPU 鎖）")]) },
    ]
}

/// Episode id of a job: `seq` (v1 name, still accepted) → `episode` → "ep01". Only `epNN`/`epNNN` (or `arttest`).
pub fn episode_of(p: &Value) -> Result<String, String> {
    let e = sp(p, "seq", sp(p, "episode", "ep01"));
    if crate::episodes::valid_id(e) || e == "arttest" {
        Ok(e.to_string())
    } else {
        Err(format!("集數 id 不正確：「{e}」（格式為 ep 加 2–3 位數字，例如 ep02）"))
    }
}

/// Composition prefix / output file prefix: ep02 → EP02.
pub fn ep_upper(ep: &str) -> String {
    ep.to_ascii_uppercase()
}

pub fn resource_for(kind: &str, params: &Value) -> Result<&'static str, String> {
    match kind {
        "custom" => Ok(if params["gpu"].as_bool().unwrap_or(false) { "gpu" } else { "cpu" }),
        "claude" | "claude_in" | "agent_cli" => Ok("net"),
        "stills" => Ok("gpu"),
        "typecheck" => Ok("cpu"),
        "doctor_fix" => Ok(if params["gpu"].as_bool().unwrap_or(false) { "gpu" } else { "net" }),
        k => kinds().into_iter().find(|s| s.kind == k).map(|s| s.resource).ok_or_else(|| format!("unknown job kind {k}")),
    }
}

pub fn label_for(kind: &str, params: &Value) -> String {
    let base = kinds().into_iter().find(|s| s.kind == kind).map(|s| s.label.to_string());
    match kind {
        "render" => {
            let e = ep_upper(&episode_of(params).unwrap_or_else(|_| "ep01".into()));
            format!("渲染 {} → {}", sp(params, "comp", &format!("{e}-30fps")), sp(params, "out", &format!("{e}_Final.mp4")))
        }
        "qa" => {
            let e = ep_upper(&episode_of(params).unwrap_or_else(|_| "ep01".into()));
            format!("品質檢查 {}", sp(params, "video", &format!("{e}_Final.mp4")))
        }
        "youtube_15x" => {
            let e = ep_upper(&episode_of(params).unwrap_or_else(|_| "ep01".into()));
            format!("{e} · YouTube 1.5× 版（SRT 縮放＋{e}-YT15）")
        }
        "revoice" => {
            let e = ep_upper(&episode_of(params).unwrap_or_else(|_| "ep01".into()));
            let n = sp(params, "lines", "").split_whitespace().count();
            format!("{e} · 重新配音 {}（{}）", sp(params, "locale", "zh-TW"), if n == 0 { "整個語言版本".to_string() } else { format!("{n} 句") })
        }
        "rerender" => {
            let e = ep_upper(&episode_of(params).unwrap_or_else(|_| "ep01".into()));
            let m = match sp(params, "mode", "affected") { "remux" => "僅重新混音與封裝", "full" => "完整重新渲染", _ => "重新渲染受影響片段" };
            format!("{e} · {m} {}", sp(params, "locale", "zh-TW"))
        }
        "claude_in" => format!("Claude：{}", sp(params, "title", "自動製作")),
        "agent_cli" => format!("豆包：{}", sp(params, "title", "自動製作")),
        "stills" => format!("關鍵幀 {}（{}）", sp(params, "comp", "?"), sp(params, "frames", "0")),
        "typecheck" => "TypeScript 型別檢查".into(),
        "custom" | "claude" | "doctor_fix" | "make_cn" => match kind {
            "custom" => format!("自訂：{}", sp(params, "command", "").chars().take(60).collect::<String>()),
            "claude" => format!("Claude：{}", sp(params, "title", "headless run")),
            "make_cn" => match params.get("episode").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                Some(e) => format!("產生 zh-CN 原始碼（{}{}）", ep_upper(e), if params["reconvert"].as_bool().unwrap_or(false) { "，重新轉換旁白" } else { "" }),
                None => base.unwrap_or_else(|| kind.to_string()),
            },
            _ => format!("修復：{}", sp(params, "fixId", "")),
        },
        _ => match (base, episode_of(params)) {
            (Some(b), Ok(e)) if params.get("episode").is_some() || params.get("seq").is_some() => format!("{} · {}", ep_upper(&e), b),
            (Some(b), _) => b,
            (None, _) => kind.to_string(),
        },
    }
}
