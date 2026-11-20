//! Job kinds → real pipeline commands (the existing scripts in <project>/scripts are spawned, never rewritten),
//! plus stdout progress parsers for render.mjs, the TTS generators and `claude -p --output-format stream-json`.

use crate::db::Settings;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Parser {
    Plain,
    Render,
    Voice,
    Claude,
}

#[derive(Debug, Clone)]
pub struct Step {
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub parser: Parser,
    pub stdin_text: Option<String>,
}

pub struct KindSpec {
    pub kind: &'static str,
    pub label: &'static str,
    pub resource: &'static str,
    pub params: Value,
}

fn p(name: &str, ty: &str, required: bool, default: Value, help: &str) -> Value {
    json!({"name": name, "type": ty, "required": required, "default": default, "help": help})
}

pub fn kinds() -> Vec<KindSpec> {
    vec![
        KindSpec { kind: "voiceover_tw", label: "配音 zh-TW（CosyVoice）", resource: "gpu", params: json!([
            p("seq", "string", false, json!("ep01"), "narration sequence"),
            p("only", "string", false, Value::Null, "只重生這些句子 ID（空白分隔）"),
            p("force", "bool", false, json!(false), "忽略快取重新產生"),
            p("speed", "number", false, Value::Null, "固定語速"),
            p("targetCps", "number", false, Value::Null, "目標字/秒（自動校準 speed）")]) },
        KindSpec { kind: "voiceover_cn", label: "配音 zh-CN（CosyVoice）", resource: "gpu", params: json!([
            p("seq", "string", false, json!("ep01"), "narration sequence"),
            p("only", "string", false, Value::Null, "只重生這些句子 ID（空白分隔）"),
            p("force", "bool", false, json!(false), "忽略快取重新產生"),
            p("targetCps", "number", false, json!(5.4), "目標字/秒")]) },
        KindSpec { kind: "timeline", label: "時間軸＋字幕", resource: "cpu", params: json!([
            p("seq", "string", false, json!("ep01"), ""), p("src", "string", false, json!("src"), "src 或 src_cn"),
            p("estimate", "bool", false, json!(false), "缺音檔時以字數估算")]) },
        KindSpec { kind: "mix", label: "混音", resource: "cpu", params: json!([
            p("seq", "string", false, json!("ep01"), ""), p("src", "string", false, json!("src"), "src 或 src_cn")]) },
        KindSpec { kind: "render", label: "渲染（render.mjs）", resource: "gpu", params: json!([
            p("comp", "string", false, json!("EP01-30fps"), "EP01 / EP01-30fps / EP01-YT15 / ArtTest"),
            p("mode", "string", false, json!("gpu"), "gpu / cpu / preview"),
            p("src", "string", false, json!("src"), "src 或 src_cn"),
            p("out", "string", false, json!("EP01_Final.mp4"), "輸出檔名（專案根目錄）"),
            p("mix", "string", false, Value::Null, "混音名稱（例：ep01_cn）"),
            p("fps", "number", false, Value::Null, "僅供顯示；fps 由 comp 決定"),
            p("frames", "string", false, Value::Null, "a-b 只渲染部分幀"),
            p("concurrency", "number", false, Value::Null, "固定並行數")]) },
        KindSpec { kind: "qa", label: "品質檢查（qa_video.py）", resource: "cpu", params: json!([
            p("video", "string", false, json!("EP01_Final.mp4"), ""), p("seq", "string", false, json!("ep01"), ""),
            p("src", "string", false, json!("src"), ""), p("speed", "number", false, Value::Null, "1.5 倍速版填 1.5")]) },
        KindSpec { kind: "make_cn", label: "產生 zh-CN 原始碼（make_cn.py，會覆寫 src_cn）", resource: "cpu", params: json!([]) },
        KindSpec { kind: "youtube_15x", label: "YouTube 1.5× 版（SRT 縮放＋EP01-YT15）", resource: "gpu", params: json!([
            p("out", "string", false, json!("EP01_YouTube_zh-TW.mp4"), "")]) },
        KindSpec { kind: "bilibili", label: "Bilibili zh-CN 全流程", resource: "gpu", params: json!([
            p("out", "string", false, json!("EP01_Bilibili_zh-CN.mp4"), "")]) },
        KindSpec { kind: "custom", label: "自訂指令（cmd /c）", resource: "cpu", params: json!([
            p("command", "string", true, Value::Null, "在專案根目錄以 cmd /c 執行"),
            p("gpu", "bool", false, json!(false), "會用到 GPU（取得 GPU 鎖）")]) },
    ]
}

pub fn resource_for(kind: &str, params: &Value) -> Result<&'static str, String> {
    match kind {
        "custom" => Ok(if params["gpu"].as_bool().unwrap_or(false) { "gpu" } else { "cpu" }),
        "claude" => Ok("net"),
        "doctor_fix" => Ok(if params["gpu"].as_bool().unwrap_or(false) { "gpu" } else { "net" }),
        k => kinds().into_iter().find(|s| s.kind == k).map(|s| s.resource).ok_or_else(|| format!("unknown job kind {k}")),
    }
}

pub fn label_for(kind: &str, params: &Value) -> String {
    let base = kinds().into_iter().find(|s| s.kind == kind).map(|s| s.label.to_string());
    match kind {
        "render" => format!("渲染 {} → {}", sp(params, "comp", "EP01-30fps"), sp(params, "out", "EP01_Final.mp4")),
        "qa" => format!("品質檢查 {}", sp(params, "video", "EP01_Final.mp4")),
        "custom" => format!("自訂：{}", sp(params, "command", "").chars().take(60).collect::<String>()),
        "claude" => format!("Claude：{}", sp(params, "title", "headless run")),
        "doctor_fix" => format!("修復：{}", sp(params, "fixId", "")),
        _ => base.unwrap_or_else(|| kind.to_string()),
    }
}

fn sp<'a>(p: &'a Value, k: &str, d: &'a str) -> &'a str {
    p.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(d)
}

/// Reject anything that could smuggle extra CLI flags or paths out of the project into script args.
fn safe_token(v: &str, what: &str) -> Result<String, String> {
    let ok = !v.is_empty()
        && !v.starts_with('-')
        && !v.contains("..")
        && v.chars().all(|c| c.is_alphanumeric() || "_-.+/\\ ".contains(c) || (c as u32) > 0x2E80);
    if ok { Ok(v.to_string()) } else { Err(format!("invalid {what}: {v}")) }
}

fn num_arg(p: &Value, k: &str) -> Option<String> {
    p.get(k).and_then(|v| v.as_f64()).map(|x| format!("{x}"))
}

pub struct Ctx<'a> {
    pub root: &'a Path,
    pub settings: &'a Settings,
    pub job_id: &'a str,
}

impl Ctx<'_> {
    pub fn node(&self) -> String {
        let n = Path::new(&self.settings.node_dir).join("node.exe");
        if n.exists() { n.to_string_lossy().into() } else { "node".into() }
    }
    pub fn cosy_python(&self) -> String {
        self.settings
            .cosy_python
            .clone()
            .unwrap_or_else(|| self.root.join(r"tools\CosyVoice\.venv\Scripts\python.exe").to_string_lossy().into())
    }
    fn env(&self) -> Vec<(String, String)> {
        vec![
            ("PYTHONIOENCODING".into(), "utf-8".into()),
            ("PYTHONUTF8".into(), "1".into()),
            ("PATH".into(), {
                // render.mjs / mix_audio.py spawn `ffmpeg` by name: put the resolved ffmpeg folder on PATH
                let ff = crate::util::tool("ffmpeg").and_then(|p| Path::new(&p).parent().map(|d| d.to_string_lossy().to_string())).unwrap_or_default();
                crate::util::path_with(&[&self.settings.node_dir, &ff])
            }),
            ("FORCE_COLOR".into(), "0".into()),
        ]
    }
    fn step(&self, label: &str, program: &str, args: &[&str], parser: Parser) -> Step {
        Step {
            label: label.into(),
            program: program.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: self.root.to_path_buf(),
            env: self.env(),
            parser,
            stdin_text: None,
        }
    }
    fn py(&self, label: &str, args: &[&str]) -> Step {
        let mut a = vec!["-3.11", "-u"];
        a.extend_from_slice(args);
        self.step(label, "py", &a, Parser::Plain)
    }
    fn cosy(&self, label: &str, args: &[String], extra_env: &[(&str, &str)]) -> Step {
        let mut a: Vec<&str> = vec!["-u", "scripts/generate_voiceover_cosy.py"];
        a.extend(args.iter().map(|s| s.as_str()));
        let mut s = self.step(label, &self.cosy_python(), &a, Parser::Voice);
        s.env.push(("KMP_DUPLICATE_LIB_OK".into(), "TRUE".into()));
        for (k, v) in extra_env {
            s.env.push((k.to_string(), v.to_string()));
        }
        s
    }
    fn render(&self, label: &str, args: &[String]) -> Step {
        let mut a: Vec<&str> = vec!["scripts/render.mjs"];
        a.extend(args.iter().map(|s| s.as_str()));
        self.step(label, &self.node(), &a, Parser::Render)
    }
}

fn voice_args(p: &Value, cn: bool) -> Result<Vec<String>, String> {
    let mut a = vec!["--seq".to_string(), safe_token(sp(p, "seq", "ep01"), "seq")?];
    if cn {
        a.extend(
            [
                "--narration", "src_cn/data/narration.json",
                "--out-root", "public/assets/audio/voiceover_cosy_cn",
                "--ref", "tools/CosyVoice/reference_cn/reference.wav",
                "--ref-text-file", "tools/CosyVoice/reference_cn/reference.txt",
            ]
            .map(String::from),
        );
    }
    if let Some(only) = p.get("only").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
        a.push("--only".into());
        for id in only.split_whitespace() {
            a.push(safe_token(id, "line id")?);
        }
    }
    if p["force"].as_bool().unwrap_or(false) {
        a.push("--force".into());
    }
    if let Some(s) = num_arg(p, "speed") {
        a.extend(["--speed".into(), s]);
    }
    let cps = num_arg(p, "targetCps").or(if cn { Some("5.4".into()) } else { None });
    if let Some(c) = cps {
        a.extend(["--target-cps".into(), c]);
    }
    Ok(a)
}

fn timeline_args(seq: &str, src: &str, estimate: bool) -> Vec<String> {
    let mut a = vec!["scripts/build_timeline.py".into(), "--seq".into(), seq.into()];
    if src == "src_cn" {
        a.extend(["--src", "src_cn", "--voice-dir", "public/assets/audio/voiceover_cosy_cn", "--srt-name", &format!("{seq}_cn")].map(String::from));
    }
    if estimate {
        a.push("--estimate".into());
    }
    a
}

fn src_of(p: &Value) -> Result<String, String> {
    match sp(p, "src", "src") {
        s @ ("src" | "src_cn") => Ok(s.into()),
        s => Err(format!("src must be src or src_cn, got {s}")),
    }
}

fn out_name(p: &Value, d: &str) -> Result<String, String> {
    let o = sp(p, "out", d);
    if o.contains('/') || o.contains('\\') || o.contains("..") || !o.to_ascii_lowercase().ends_with(".mp4") {
        return Err(format!("out must be a plain .mp4 file name in the project root: {o}"));
    }
    safe_token(o, "out")
}

pub fn claude_tools(allow_edits: bool) -> String {
    let mut t = vec!["Read", "Glob", "Grep", "Bash(git diff *)", "Bash(git status *)", "Bash(git log *)"];
    if allow_edits {
        t.extend(["Edit", "Write"]);
    }
    t.join(",")
}

pub fn worktree_dir(root: &Path, wid: &str) -> PathBuf {
    root.join(".studio").join("worktrees").join(wid)
}

pub fn build_steps(kind: &str, params: &Value, ctx: &Ctx) -> Result<Vec<Step>, String> {
    let p = params;
    Ok(match kind {
        "voiceover_tw" => vec![ctx.cosy("配音 zh-TW", &voice_args(p, false)?, &[])],
        "voiceover_cn" => vec![ctx.cosy("配音 zh-CN", &voice_args(p, true)?, &[("PIKARA_ASR_CC", "t2s")])],
        "timeline" => {
            let seq = safe_token(sp(p, "seq", "ep01"), "seq")?;
            let a = timeline_args(&seq, &src_of(p)?, p["estimate"].as_bool().unwrap_or(false));
            vec![ctx.py("時間軸", &a.iter().map(|s| s.as_str()).collect::<Vec<_>>())]
        }
        "mix" => {
            let seq = safe_token(sp(p, "seq", "ep01"), "seq")?;
            let mut a = vec!["scripts/mix_audio.py".to_string(), "--seq".into(), seq.clone()];
            if src_of(p)? == "src_cn" {
                a.extend(["--src".into(), "src_cn".into(), "--mix-name".into(), format!("{seq}_cn")]);
            }
            vec![ctx.py("混音", &a.iter().map(|s| s.as_str()).collect::<Vec<_>>())]
        }
        "render" => {
            let mode = sp(p, "mode", "gpu");
            if !["gpu", "cpu", "preview"].contains(&mode) {
                return Err(format!("mode must be gpu/cpu/preview, got {mode}"));
            }
            let mut a = vec![mode.to_string(), "--comp".into(), safe_token(sp(p, "comp", "EP01-30fps"), "comp")?];
            a.extend(["--out".into(), out_name(p, "EP01_Final.mp4")?]);
            let src = src_of(p)?;
            if src != "src" {
                a.extend(["--src".into(), src]);
            }
            if let Some(m) = p.get("mix").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                a.extend(["--mix".into(), safe_token(m, "mix")?]);
            }
            if let Some(f) = p.get("frames").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                if !Regex::new(r"^\d+-\d+$").unwrap().is_match(f) {
                    return Err("frames must look like 0-1799".into());
                }
                a.extend(["--frames".into(), f.into()]);
            }
            if let Some(c) = p.get("concurrency").and_then(|v| v.as_u64()) {
                a.extend(["--concurrency".into(), c.clamp(1, 16).to_string()]);
            }
            vec![ctx.render("渲染", &a)]
        }
        "qa" => {
            let video = safe_token(sp(p, "video", "EP01_Final.mp4"), "video")?;
            let mut a = vec!["scripts/qa_video.py".to_string(), video, "--seq".into(), safe_token(sp(p, "seq", "ep01"), "seq")?];
            let src = src_of(p)?;
            if src != "src" {
                a.extend(["--src".into(), src]);
            }
            if let Some(s) = num_arg(p, "speed") {
                a.extend(["--speed".into(), s]);
            }
            vec![ctx.py("品質檢查", &a.iter().map(|s| s.as_str()).collect::<Vec<_>>())]
        }
        "make_cn" => vec![ctx.py("make_cn", &["scripts/make_cn.py"])],
        "youtube_15x" => {
            let out = out_name(p, "EP01_YouTube_zh-TW.mp4")?;
            let srt = out.trim_end_matches(".mp4").to_string() + ".srt";
            vec![
                ctx.py("SRT 1.5× 縮放", &["scripts/scale_srt.py", "EP01.srt", &srt, "1.5"]),
                ctx.render("渲染 EP01-YT15", &["gpu".into(), "--comp".into(), "EP01-YT15".into(), "--out".into(), out]),
            ]
        }
        "bilibili" => {
            let out = out_name(p, "EP01_Bilibili_zh-CN.mp4")?;
            let srt = out.trim_end_matches(".mp4").to_string() + ".srt";
            let tl = timeline_args("ep01", "src_cn", false);
            vec![
                ctx.py("make_cn（src → src_cn）", &["scripts/make_cn.py"]),
                ctx.cosy("配音 zh-CN", &voice_args(&json!({}), true)?, &[("PIKARA_ASR_CC", "t2s")]),
                ctx.py("時間軸 zh-CN", &tl.iter().map(|s| s.as_str()).collect::<Vec<_>>()),
                ctx.step("複製字幕", "cmd", &["/c", "copy", "/Y", r"out\subtitles\ep01_cn.srt", &srt], Parser::Plain),
                ctx.py("混音 zh-CN", &["scripts/mix_audio.py", "--seq", "ep01", "--src", "src_cn", "--mix-name", "ep01_cn"]),
                ctx.render(
                    "渲染 EP01-30fps（src_cn）",
                    &["gpu", "--comp", "EP01-30fps", "--src", "src_cn", "--mix", "ep01_cn", "--out", &out].map(String::from),
                ),
                ctx.py("品質檢查 zh-CN", &["scripts/qa_video.py", &out, "--seq", "ep01", "--src", "src_cn"]),
            ]
        }
        "custom" => {
            let c = sp(p, "command", "");
            if c.trim().is_empty() {
                return Err("command is required".into());
            }
            vec![ctx.step("自訂指令", "cmd", &["/d", "/s", "/c", c], Parser::Plain)]
        }
        "claude" => {
            let wid = sp(p, "worktreeId", ctx.job_id).to_string();
            let wt = worktree_dir(ctx.root, &wid);
            let wts = wt.to_string_lossy().to_string();
            let branch = format!("studio/claude/{wid}");
            let claude = crate::claude::claude_path().ok_or("找不到 claude CLI（請先安裝 Claude Code）")?;
            let mut args = vec![
                "-p".to_string(),
                "--output-format".into(), "stream-json".into(), "--verbose".into(),
                "--permission-mode".into(), "dontAsk".into(),
                "--allowedTools".into(), claude_tools(p["allowEdits"].as_bool().unwrap_or(true)),
                "--max-turns".into(), ctx.settings.claude_max_turns.to_string(),
            ];
            if let Some(b) = ctx.settings.claude_max_budget_usd {
                args.extend(["--max-budget-usd".into(), format!("{b}")]);
            }
            let mut add = ctx.step("建立 git worktree", "git", &["worktree", "add", "--quiet", &wts, "-b", &branch, "HEAD"], Parser::Plain);
            add.env.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
            let mut run = ctx.step("claude -p（headless）", &claude, &args.iter().map(|s| s.as_str()).collect::<Vec<_>>(), Parser::Claude);
            run.cwd = wt.clone();
            run.stdin_text = Some(sp(p, "prompt", "").to_string());
            let msg = format!("Studio: Claude run {wid}");
            let mut commit = ctx.step(
                "提交 worktree 變更（不合併）",
                "cmd",
                &["/d", "/c", &format!("git add -A && (git diff --cached --quiet || git commit -q -m \"{msg}\")")],
                Parser::Plain,
            );
            commit.cwd = wt;
            for (k, v) in [("GIT_AUTHOR_NAME", "Pikara Studio (Claude)"), ("GIT_AUTHOR_EMAIL", "studio@pikara.local"), ("GIT_COMMITTER_NAME", "Pikara Studio"), ("GIT_COMMITTER_EMAIL", "studio@pikara.local")] {
                commit.env.push((k.into(), v.into()));
            }
            vec![add, run, commit]
        }
        "doctor_fix" => {
            let fix = sp(p, "fixId", "");
            match fix {
                "npm_install" => vec![ctx.step("npm install", "cmd", &["/d", "/c", "npm", "install", "--no-fund", "--no-audit"], Parser::Plain)],
                "remotion_browser_ensure" => vec![ctx.step(
                    "remotion browser ensure",
                    &ctx.node(),
                    &["node_modules/@remotion/cli/remotion-cli.js", "browser", "ensure"],
                    Parser::Plain,
                )],
                f if f.starts_with("pip_install:") => {
                    let pkg = &f["pip_install:".len()..];
                    if !Regex::new(r"^[A-Za-z0-9_.\-]+(==[A-Za-z0-9_.\-]+)?$").unwrap().is_match(pkg) {
                        return Err(format!("invalid package {pkg}"));
                    }
                    vec![ctx.step(&format!("pip install {pkg}"), &ctx.cosy_python(), &["-m", "pip", "install", pkg], Parser::Plain)]
                }
                f => return Err(format!("fix {f} is not a job")),
            }
        }
        k => return Err(format!("unknown job kind {k}")),
    })
}

// ------------------------------------------------------------------ progress parsing

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

static RE_RENDER_TOTAL: Lazy<Regex> = Lazy::new(|| Regex::new(r"渲染 (\S+)：(\d+) 幀，(\d+) 段").unwrap());
static RE_CHUNK: Lazy<Regex> = Lazy::new(|| Regex::new(r"區段 (\d+)[–-](\d+)：(.*)").unwrap());
static RE_RENDERED: Lazy<Regex> = Lazy::new(|| Regex::new(r"Rendered (\d+)/(\d+)").unwrap());
static RE_VOICE_TOTAL: Lazy<Regex> = Lazy::new(|| Regex::new(r"共 (\d+) 句，需要產生 (\d+) 句").unwrap());
static RE_ALIGN: Lazy<Regex> = Lazy::new(|| Regex::new(r"對齊 (\d+) 句").unwrap());

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
                return ParseOut { progress: Some(0.92), text: Some("編碼中（NVENC）".into()), ..Default::default() };
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

fn clip(s: &str, n: usize) -> String {
    let c: String = s.chars().take(n).collect();
    if s.chars().count() > n { c + "…" } else { c }
}

fn parse_claude(st: &mut ParseState, t: &str) -> ParseOut {
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

#[cfg(test)]
mod tests {
    use super::*;

    const RENDER_LOG: &str = "GPU：ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)
渲染 EP01-30fps：25257 幀，15 段（每段 1800 幀），GPU：ANGLE / D3D11；VRAM 基準 1120 MiB，上限 5300 MiB
  區段 0–1799：已完成，略過
  區段 1800–3599：61s，29.5 fps，並行 6，GPU 平均 96%，VRAM 峰值 5012 MiB，最高 49°C
  區段 3600–5399：58s，31.0 fps，並行 6，GPU 平均 97%，VRAM 峰值 5101 MiB，最高 49°C，⚠ 熱降頻
混音已完成，開始編碼

完成：EP01_Final.mp4（812.3 MB）";

    #[test]
    fn render_progress_from_real_log_format() {
        let mut st = ParseState::default();
        let outs: Vec<ParseOut> = RENDER_LOG.lines().map(|l| parse_line(Parser::Render, &mut st, l)).collect();
        assert_eq!(outs[1].progress, Some(0.0));
        let p2 = outs[2].progress.unwrap();
        assert!((p2 - 0.9 * 1800.0 / 25257.0).abs() < 1e-9);
        let p4 = outs[4].progress.unwrap();
        assert!((p4 - 0.9 * 5400.0 / 25257.0).abs() < 1e-9);
        assert_eq!(outs[4].level, Some("warn"));
        assert_eq!(outs[4].text.as_deref(), Some("區段 3600–5399（5400/25257 幀）"));
        assert_eq!(outs[5].progress, Some(0.92));
        assert_eq!(outs[7].progress, Some(1.0));
        let mut st2 = ParseState::default();
        assert_eq!(parse_line(Parser::Render, &mut st2, "區段 0–1799 失敗。已完成的區段都保留").level, Some("error"));
        assert!(parse_line(Parser::Render, &mut st2, "Rendered 450/1800").progress.unwrap() > 0.2);
    }

    #[test]
    fn voice_progress() {
        let mut st = ParseState::default();
        let l = ["共 75 句，需要產生 2 句 → public/assets/audio/voiceover_cosy/ep01",
            "模型載入 31.2s，precision=fp16，VRAM 2100 MiB",
            "  ✓ 10:01:02 a1-00 audio=5.70s wall=6.1s RTF=1.07 peakVRAM=3300MiB gpu[util,mem,temp]=90 %, 3300 MiB, 60",
            "  ✗ a1-01 失敗：RuntimeError: boom",
            "對齊 2 句（faster-whisper large-v3-turbo，CPU int8）",
            "  ≡ a1-00 對上 20/20 字  CER 0.000",
            "  ≡ a1-01 對上 18/20 字  CER 0.100",
            "完成：75/75 句有音檔，0 句缺少邊界。"];
        let o: Vec<ParseOut> = l.iter().map(|x| parse_line(Parser::Voice, &mut st, x)).collect();
        assert_eq!(o[0].progress, Some(0.0));
        assert_eq!(o[2].progress, Some(0.425));
        assert_eq!(o[3].level, Some("error"));
        assert_eq!(o[4].progress, Some(0.85));
        assert!((o[6].progress.unwrap() - 1.0).abs() < 1e-9);
        assert_eq!(o[7].progress, Some(1.0));
    }

    #[test]
    fn claude_stream_json_summaries() {
        let mut st = ParseState::default();
        let a = parse_line(Parser::Claude, &mut st, r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Looking at act 3"},{"type":"tool_use","name":"Read","input":{"file_path":"src/data/narration.json"}}]}}"#);
        let d = a.display.unwrap();
        assert_eq!(d[0], "Claude: Looking at act 3");
        assert!(d[1].starts_with("[tool] Read"));
        let r = parse_line(Parser::Claude, &mut st, r#"{"type":"result","subtype":"success","is_error":false,"num_turns":3,"total_cost_usd":0.0123,"result":"Done."}"#);
        assert_eq!(r.progress, Some(1.0));
        assert!(r.display.unwrap()[0].contains("cost=$0.0123"));
        assert_eq!(parse_line(Parser::Claude, &mut st, "not json"), ParseOut::default());
    }

    #[test]
    fn steps_map_to_real_pipeline_commands() {
        let s = Settings::default();
        let tmp = std::env::temp_dir();
        let root = tmp.as_path();
        let ctx = Ctx { root, settings: &s, job_id: "j1" };
        let b = build_steps("bilibili", &json!({}), &ctx).unwrap();
        let labels: Vec<&str> = b.iter().map(|x| x.label.as_str()).collect();
        assert_eq!(labels.len(), 7, "{labels:?}");
        assert!(b[0].args.contains(&"scripts/make_cn.py".to_string()));
        assert!(b[1].args.iter().any(|a| a == "src_cn/data/narration.json"));
        assert!(b[1].env.iter().any(|(k, v)| k == "PIKARA_ASR_CC" && v == "t2s"));
        assert!(b[5].args.windows(2).any(|w| w[0] == "--src" && w[1] == "src_cn"));
        assert_eq!(b[5].parser, Parser::Render);
        assert!(b[6].args.contains(&"EP01_Bilibili_zh-CN.mp4".to_string()));
        let y = build_steps("youtube_15x", &json!({}), &ctx).unwrap();
        assert_eq!(y[0].args, vec!["-3.11", "-u", "scripts/scale_srt.py", "EP01.srt", "EP01_YouTube_zh-TW.srt", "1.5"]);
        assert!(y[1].args.contains(&"EP01-YT15".to_string()));
        let r = build_steps("render", &json!({"comp": "EP01-30fps", "out": "X.mp4", "src": "src_cn", "frames": "0-99"}), &ctx).unwrap();
        assert_eq!(r[0].args, vec!["scripts/render.mjs", "gpu", "--comp", "EP01-30fps", "--out", "X.mp4", "--src", "src_cn", "--frames", "0-99"]);
        // injection guards
        assert!(build_steps("render", &json!({"out": "..\\evil.mp4"}), &ctx).is_err());
        assert!(build_steps("render", &json!({"comp": "--browser-executable=x"}), &ctx).is_err());
        assert!(build_steps("voiceover_tw", &json!({"only": "a1-00 --ref x"}), &ctx).is_err());
        assert!(build_steps("doctor_fix", &json!({"fixId": "pip_install:evil;rm"}), &ctx).is_err());
        let v = build_steps("voiceover_tw", &json!({"only": "a1-00 a4-15", "force": true}), &ctx).unwrap();
        assert!(v[0].args.ends_with(&["--only".into(), "a1-00".into(), "a4-15".into(), "--force".into()]));
        assert_eq!(resource_for("render", &json!({})).unwrap(), "gpu");
        assert_eq!(resource_for("qa", &json!({})).unwrap(), "cpu");
        assert_eq!(resource_for("custom", &json!({"gpu": true})).unwrap(), "gpu");
    }
}
