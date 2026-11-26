//! Job kinds → real pipeline commands (scripts in <project>/scripts are spawned, never rewritten), preflight checks.

use super::*;

pub(crate) fn sp<'a>(p: &'a Value, k: &str, d: &'a str) -> &'a str {
    p.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(d)
}

/// Reject anything that could smuggle extra CLI flags or paths out of the project into script args.
pub(crate) fn safe_token(v: &str, what: &str) -> Result<String, String> {
    let ok = !v.is_empty()
        && !v.starts_with('-')
        && !v.contains("..")
        && v.chars().all(|c| c.is_alphanumeric() || "_-.+/\\ ".contains(c) || (c as u32) > 0x2E80);
    if ok { Ok(v.to_string()) } else { Err(format!("invalid {what}: {v}")) }
}

pub(crate) fn num_arg(p: &Value, k: &str) -> Option<String> {
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
        let mut v = self.base_env();
        // v0.3 DeviceSelector: render GPU / encoder / VRAM cap / AI device for every step (scripts read these)
        v.extend(crate::hardware::selector::job_env(&crate::hardware::selector::current(self.settings)));
        v
    }
    fn base_env(&self) -> Vec<(String, String)> {
        vec![
            ("PYTHONIOENCODING".into(), "utf-8".into()),
            ("PYTHONUTF8".into(), "1".into()),
            ("PATH".into(), {
                // render.mjs / mix_audio.py spawn `ffmpeg` by name: put the resolved ffmpeg folder on PATH
                let ff = crate::util::tool("ffmpeg").and_then(|p| Path::new(&p).parent().map(|d| d.to_string_lossy().to_string())).unwrap_or_default();
                crate::util::path_with(&[&self.settings.node_dir, &ff])
            }),
            ("FORCE_COLOR".into(), "0".into()),
            // render.mjs performance mode (balanced default: 1080p30 finals, start 2 tabs, then measured adjustment)
            ("PIKARA_PERF".into(), if self.settings.perf_mode.is_empty() { "balanced".into() } else { self.settings.perf_mode.clone() }),
            ("PIKARA_RENDER_START_CONC".into(), self.settings.render_start_concurrency.to_string()),
            // narration pace preset for build_timeline.py (pitch-preserving stretch of copies; originals untouched)
            ("PIKARA_VOICE_TEMPO".into(), voice_tempo_preset(self.settings.voice_tempo).to_string()),
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
            env_remove: vec![],
            stall_secs: None,
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
        s.stall_secs = super::stall_limit("voice", 600);
        s.env.push(("KMP_DUPLICATE_LIB_OK".into(), "TRUE".into()));
        for (k, v) in extra_env {
            s.env.push((k.to_string(), v.to_string()));
        }
        s
    }
    fn render(&self, label: &str, args: &[String]) -> Step {
        let mut a: Vec<&str> = vec!["scripts/render.mjs"];
        a.extend(args.iter().map(|s| s.as_str()));
        let mut s = self.step(label, &self.node(), &a, Parser::Render);
        s.stall_secs = super::stall_limit("render", 1200);
        s
    }
    /// A step that runs this Studio executable's own CLI (`--cli <cmd> … --data <data dir>`) — used for the
    /// validate-and-switch steps of re-voice / re-render, so they run inside the queue (resumable, logged).
    fn studio_cli(&self, label: &str, args: Vec<String>) -> Step {
        let exe = std::env::var("PIKARA_STUDIO_EXE").ok().or_else(|| std::env::current_exe().ok().map(|p| p.to_string_lossy().to_string())).unwrap_or_else(|| "PikaraScienceStudio.exe".into());
        let mut a: Vec<String> = vec!["--cli".into()];
        a.extend(args);
        a.extend(["--data".into(), crate::util::data_dir().to_string_lossy().to_string()]);
        let refs: Vec<&str> = a.iter().map(|s| s.as_str()).collect();
        self.step(label, &exe, &refs, Parser::Plain)
    }
}

/// Batch id of a re-voice / re-render job: its job id (stable across retries, so an interrupted job resumes into the
/// same candidate folder and only finishes what is missing).
fn batch_of(ctx: &Ctx) -> String {
    ctx.job_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(36).collect()
}

fn locale_of(p: &Value) -> Result<(&'static str, bool), String> {
    match sp(p, "locale", "zh-TW") {
        "zh-TW" => Ok(("zh-TW", false)),
        "zh-CN" => Ok(("zh-CN", true)),
        l => Err(format!("locale 必須是 zh-TW 或 zh-CN：{l}")),
    }
}

/// v0.3 re-voice: synthesize the requested lines into `.studio/revoice/<job>/` (current audio untouched), then
/// validate each candidate and switch only the ones that pass (`voice-promote`; previous audio archived first).
/// Never re-runs research or script writing; other lines are not touched.
pub(crate) fn revoice_steps(p: &Value, ctx: &Ctx) -> Result<Vec<Step>, String> {
    let ep = episode_of(p)?;
    let (locale, cn) = locale_of(p)?;
    let provider = sp(p, "provider", "cosyvoice");
    if provider != "cosyvoice" {
        return Err(format!("目前只支援 CosyVoice（收到 {provider}）"));
    }
    let lines = sp(p, "lines", "").trim().to_string();
    for id in lines.split_whitespace() {
        safe_token(id, "line id")?;
    }
    let batch = batch_of(ctx);
    let mut v = json!({"episode": ep, "only": lines});
    if let Some(s) = p.get("speed").and_then(|x| x.as_f64()) {
        v["speed"] = json!(s);
    }
    if let Some(c) = p.get("targetCps").and_then(|x| x.as_f64()) {
        v["targetCps"] = json!(c);
    }
    let mut a = voice_args(&v, cn)?;
    if let Some(r) = p.get("ref").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
        let ok = (r.starts_with("public/user/") || r.starts_with("tools/CosyVoice/reference")) && !r.contains("..");
        if !ok {
            return Err(format!("參考音訊必須在 public/user/ 或 tools/CosyVoice/reference*/ 底下：{r}"));
        }
        a.extend(["--ref".into(), safe_token(r, "ref")?]);
        let t = sp(p, "refText", "").trim();
        if t.is_empty() {
            return Err("使用自訂參考音訊時，請填寫參考音訊的逐字稿".into());
        }
        a.extend(["--ref-text".into(), t.to_string()]);
    }
    // candidates go to their own folder (argparse: the last --out-root wins over voice_args' zh-CN default)
    a.extend(["--out-root".into(), format!(".studio/revoice/{batch}")]);
    let mut env: Vec<(&str, &str)> = vec![("PIKARA_TTS_PARTIAL_OK", "1")];
    if cn {
        env.push(("PIKARA_ASR_CC", "t2s"));
    }
    let mut promote = vec!["voice-promote".into(), "--root".into(), ctx.root.to_string_lossy().to_string(), "--episode".into(), ep.clone(),
                           "--locale".into(), locale.into(), "--batch".into(), batch.clone(), "--job".into(), ctx.job_id.to_string()];
    if p["review"].as_bool().unwrap_or(false) {
        promote.push("--review".into());
    }
    Ok(vec![
        ctx.cosy(&format!("重新配音 {locale}（產生候選，不覆蓋舊音檔）"), &a, &env),
        ctx.studio_cli("驗證並切換為目前版本", promote),
    ])
}

pub(crate) const RERENDER_MODES: [&str; 3] = ["remux", "affected", "full"];

/// v0.3 re-render: reuses everything still valid. remux = mix + encode with every cached frame; affected = rebuild the
/// timeline, re-render only changed scenes (render.mjs scene fingerprints, shifted scenes reused); full = --fresh.
/// Never re-voices, re-researches or rewrites the script. The new file replaces the deliverable only after it
/// rendered (and passed QA when requested); the previous video is kept in output/versions/.
pub(crate) fn rerender_steps(p: &Value, ctx: &Ctx) -> Result<Vec<Step>, String> {
    let ep = episode_of(p)?;
    let (locale, cn) = locale_of(p)?;
    let mode = sp(p, "mode", "affected");
    if !RERENDER_MODES.contains(&mode) {
        return Err(format!("mode 必須是 remux／affected／full：{mode}"));
    }
    let fps = p["fps"].as_u64().unwrap_or(30);
    if ![30, 60].contains(&fps) {
        return Err(format!("fps 必須是 30 或 60：{fps}"));
    }
    let res = sp(p, "res", "1080p");
    if !["1080p", "720p"].contains(&res) {
        return Err(format!("res 必須是 1080p 或 720p：{res}"));
    }
    let quality = sp(p, "quality", "standard");
    if !["high", "standard", "draft"].contains(&quality) {
        return Err(format!("quality 必須是 high／standard／draft：{quality}"));
    }
    let encoder = sp(p, "encoder", "auto");
    let encoders = ["auto", "h264_nvenc", "hevc_nvenc", "h264_amf", "hevc_amf", "h264_qsv", "h264_mf", "libx264", "libx265"];
    if !encoders.contains(&encoder) {
        return Err(format!("不支援的編碼器：{encoder}"));
    }
    let src = if cn { "src_cn" } else { "src" };
    let upper = ep_upper(&ep);
    let comp = if fps == 60 { upper.clone() } else { format!("{upper}-30fps") };
    let batch = batch_of(ctx);
    let out_rel = format!(".studio/rerender/{batch}/{}", if cn { format!("{upper}_Bilibili_zh-CN.mp4") } else { format!("{upper}_Final.mp4") });
    let mut steps = vec![];
    if mode != "remux" {
        let tl = timeline_args(&ep, src, false);
        steps.push(ctx.py(&format!("時間軸與字幕 {locale}"), &tl.iter().map(|s| s.as_str()).collect::<Vec<_>>()));
    }
    let mut bgm = p.clone();
    if bgm.get("bgm").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).is_none() {
        if let Ok(e) = crate::pipeline::Ep::new(ctx.root, &ep, locale) {
            if let Some(b) = e.user_bgm() {
                bgm["bgm"] = json!(b);
            }
        }
    }
    let mx = with_bgm(&bgm, mix_args(&ep, src))?;
    steps.push(ctx.py(&format!("混音 {locale}"), &mx.iter().map(|s| s.as_str()).collect::<Vec<_>>()));
    let mut ra: Vec<String> = vec![if res == "720p" { "preview".into() } else { "gpu".into() }, "--comp".into(), comp.clone()];
    if cn {
        ra.extend(["--src".into(), "src_cn".into()]);
    }
    ra.extend(["--mix".into(), if cn { format!("{ep}_cn") } else { ep.clone() }, "--encoder".into(), encoder.into(), "--quality".into(), quality.into(), "--out".into(), out_rel.clone()]);
    if mode == "full" {
        ra.push("--fresh".into());
    }
    steps.push(ctx.render(&format!("渲染 {comp}（{}）", match mode { "remux" => "沿用全部畫面", "affected" => "只渲染改變的場景", _ => "完整重新渲染" }), &ra));
    if p["qa"].as_bool().unwrap_or(true) {
        let mut q = vec!["scripts/qa_video.py".to_string(), out_rel.clone(), "--seq".into(), ep.clone()];
        if cn {
            q.extend(["--src".into(), "src_cn".into()]);
        }
        steps.push(ctx.py("品質檢查（新影片）", &q.iter().map(|s| s.as_str()).collect::<Vec<_>>()));
    }
    let enc = crate::pipeline::encode_of(p).to_string();
    steps.push(ctx.studio_cli(
        "保留舊版並切換為新影片",
        vec!["output-promote".into(), "--root".into(), ctx.root.to_string_lossy().to_string(), "--episode".into(), ep.clone(), "--locale".into(), locale.into(),
             "--file".into(), out_rel, "--job".into(), ctx.job_id.to_string(), "--encode".into(), enc],
    ));
    Ok(steps)
}

pub(crate) fn voice_args(p: &Value, cn: bool) -> Result<Vec<String>, String> {
    let mut a = vec!["--seq".to_string(), episode_of(p)?];
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
    // no default target for zh-CN any more: the old 5.4 chars/s forced CosyVoice speed ≈ 1.6, which compresses the
    // mel spectrogram and smears syllables (EP10). The generator also caps speed at 0.85–1.15.
    let cps = num_arg(p, "targetCps");
    if let Some(c) = cps {
        a.extend(["--target-cps".into(), c]);
    }
    Ok(a)
}

/// Narration pace presets offered in the UI. Anything else (old settings, typos) falls back to the nearest preset.
pub const VOICE_TEMPO_PRESETS: [f64; 4] = [0.9, 1.0, 1.1, 1.2];

pub fn voice_tempo_preset(v: f64) -> f64 {
    if !v.is_finite() || v <= 0.0 {
        return 1.0;
    }
    VOICE_TEMPO_PRESETS.iter().copied().min_by(|a, b| (a - v).abs().total_cmp(&(b - v).abs())).unwrap_or(1.0)
}

pub(crate) fn timeline_args(seq: &str, src: &str, estimate: bool) -> Vec<String> {
    let mut a = vec!["scripts/build_timeline.py".into(), "--seq".into(), seq.into()];
    if src == "src_cn" {
        a.extend(["--src", "src_cn", "--voice-dir", "public/assets/audio/voiceover_cosy_cn", "--srt-name", &format!("{seq}_cn")].map(String::from));
    }
    if estimate {
        a.push("--estimate".into());
    }
    a
}

pub(crate) fn mix_args(seq: &str, src: &str) -> Vec<String> {
    let mut a = vec!["scripts/mix_audio.py".to_string(), "--seq".into(), seq.into()];
    if src == "src_cn" {
        a.extend(["--src".into(), "src_cn".into(), "--mix-name".into(), format!("{seq}_cn")]);
    }
    a
}

/// `bgm`: user-supplied background music inside the job directory (`public/user/<ep>/…`), passed to mix_audio.py.
pub(crate) fn with_bgm(p: &Value, mut a: Vec<String>) -> Result<Vec<String>, String> {
    if let Some(b) = p.get("bgm").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        if !b.starts_with("public/user/") || b.contains("..") {
            return Err(format!("bgm 必須是 public/user/ 底下的素材：{b}"));
        }
        a.extend(["--bgm".into(), safe_token(b, "bgm")?]);
    }
    Ok(a)
}

/// `fresh: true` → render.mjs --fresh (drop cached frame chunks; used after code was changed by a fix).
pub(crate) fn fresh(p: &Value, mut a: Vec<String>) -> Vec<String> {
    if p["fresh"].as_bool().unwrap_or(false) {
        a.push("--fresh".into());
    }
    a
}

/// Directory a job runs in: the project root, or — with `workdir` — one of the project's Studio worktrees
/// (`.studio/worktrees/<id>`, used by Autonomous Production Mode). Anything else is refused.
pub fn job_root(project_root: &Path, params: &Value) -> Result<PathBuf, String> {
    match params.get("workdir").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        None => Ok(project_root.to_path_buf()),
        Some(w) => {
            if w.len() > 64 || !w.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return Err(format!("workdir 不正確：{w}"));
            }
            let d = worktree_dir(project_root, w);
            if !d.join(".git").exists() {
                return Err(format!("找不到工作樹 {w}（可能已被捨棄）"));
            }
            Ok(d)
        }
    }
}

/// Environment variables that would switch Claude Code from the signed-in subscription to pay-as-you-go API billing.
pub const API_KEY_VARS: [&str; 2] = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/// `claude -p` in the job's directory (no worktree of its own). Subscription mode (default): API-key variables are
/// removed from the child so the signed-in Claude Code login is used, and no USD cap is passed. API mode: the key must
/// already be in the user's environment (Studio never stores it) and `budgetUsd` is passed as --max-budget-usd.
pub(crate) fn claude_in_steps(p: &Value, ctx: &Ctx) -> Result<Vec<Step>, String> {
    let claude = crate::claude::claude_path().ok_or("找不到 claude CLI（請先安裝 Claude Code 並登入）")?;
    let tools = sp(p, "tools", "Read,Glob,Grep,Edit,Write");
    if !tools.chars().all(|c| c.is_ascii_alphanumeric() || " ,()*:-_./".contains(c)) {
        return Err(format!("tools 不正確：{tools}"));
    }
    let turns = p["maxTurns"].as_u64().unwrap_or(ctx.settings.claude_max_turns as u64).clamp(1, 400);
    let mut args = vec![
        "-p".to_string(),
        "--output-format".into(), "stream-json".into(), "--verbose".into(),
        "--permission-mode".into(), "dontAsk".into(),
        "--allowedTools".into(), tools.to_string(),
        "--max-turns".into(), turns.to_string(),
    ];
    let api = sp(p, "billing", "subscription") == "api";
    if api {
        if let Some(b) = p["budgetUsd"].as_f64().filter(|b| *b > 0.0) {
            args.extend(["--max-budget-usd".into(), format!("{b}")]);
        }
    }
    let mut run = ctx.step(&format!("claude -p（{}）", sp(p, "title", "自動製作")), &claude, &args.iter().map(|s| s.as_str()).collect::<Vec<_>>(), Parser::Claude);
    run.stdin_text = Some(sp(p, "prompt", "").to_string());
    if !api {
        run.env_remove = API_KEY_VARS.iter().map(|s| s.to_string()).collect();
    }
    Ok(vec![run])
}

/// Official 豆包 CLI (`npm install -g @bytedance/doubao-cli`, `doubao login`) in the job directory, non-interactive.
/// The prompt is written to `out/auto/AGENT_TASK.md` (multi-line Chinese text is not safe as a .cmd argument);
/// `-p` only points at it. Its own login is used — Studio passes no credentials and removes Claude / Anthropic
/// variables from the child so the two providers stay isolated.
pub(crate) fn agent_cli_steps(p: &Value, ctx: &Ctx) -> Result<Vec<Step>, String> {
    if sp(p, "provider", "doubao") != "doubao" {
        return Err("目前只支援 provider=doubao".into());
    }
    let exe = crate::agents::doubao_path().ok_or("找不到豆包 CLI（doubao）。安裝：npm install -g @bytedance/doubao-cli，再執行 doubao login")?;
    let task = ctx.root.join("out").join("auto").join("AGENT_TASK.md");
    if ctx.job_id != "validate" {
        std::fs::create_dir_all(task.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&task, format!("# {}\n\n{}\n", sp(p, "title", "自動製作"), sp(p, "prompt", ""))).map_err(|e| e.to_string())?;
    }
    let root = ctx.root.to_string_lossy().to_string();
    let mut args = vec!["-C".to_string(), root, "--permission-mode".into(), "always_allow".into()];
    if let Some(m) = p.get("model").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        args.extend(["--model".into(), safe_token(m, "model")?]);
    }
    args.extend(["-p".into(), "請完整讀取目前目錄下的 out/auto/AGENT_TASK.md，那是這次的完整任務說明，依照說明直接修改檔案完成任務；完成後用一段繁體中文簡短回報做了什麼。".into()]);
    let mut run = ctx.step(&format!("doubao -p（{}）", sp(p, "title", "自動製作")), &exe, &args.iter().map(|s| s.as_str()).collect::<Vec<_>>(), Parser::Plain);
    run.env_remove = API_KEY_VARS.iter().map(|s| s.to_string()).collect();
    Ok(vec![run])
}

pub(crate) fn src_of(p: &Value) -> Result<String, String> {
    match sp(p, "src", "src") {
        s @ ("src" | "src_cn") => Ok(s.into()),
        s => Err(format!("src must be src or src_cn, got {s}")),
    }
}

pub(crate) fn out_name(p: &Value, d: &str) -> Result<String, String> {
    let o = sp(p, "out", d);
    if o.contains('/') || o.contains('\\') || o.contains("..") || !o.to_ascii_lowercase().ends_with(".mp4") {
        return Err(format!("out must be a plain .mp4 file name in the project root: {o}"));
    }
    safe_token(o, "out")
}

/// Checks done right before a job starts (not at enqueue: earlier jobs in the queue may create the files).
/// Errors are complete Traditional-Chinese sentences shown as the job's failure message; nothing is spawned.
pub fn preflight(kind: &str, p: &Value, root: &Path, settings: &Settings) -> Result<(), String> {
    preflight_with(kind, p, root, settings, &|t| crate::util::tool(t).is_some())
}

pub fn preflight_with(kind: &str, p: &Value, root: &Path, settings: &Settings, has_tool: &dyn Fn(&str) -> bool) -> Result<(), String> {
    let media = ["qa", "render", "final_tw", "youtube_15x", "bilibili", "mix", "timeline", "voiceover_tw", "voiceover_cn", "revoice", "rerender"];
    if media.contains(&kind) {
        for t in ["ffmpeg", "ffprobe"] {
            if !has_tool(t) {
                return Err(format!(
                    "找不到 {t}，工作沒有開始。請安裝 ffmpeg（含 ffprobe）並加入 PATH（例如：winget install Gyan.FFmpeg），安裝後在「環境醫生」重新檢查，再按「重試」。"
                ));
            }
        }
    }
    if ["voiceover_tw", "voiceover_cn", "bilibili"].contains(&kind) {
        let py = Ctx { root, settings, job_id: "preflight" }.cosy_python();
        if !Path::new(&py).exists() {
            return Err(format!("找不到 CosyVoice 的 Python：{py}。請在「環境醫生」查看 CosyVoice 安裝說明，或在設定中指定 cosyPython。"));
        }
    }
    let uses_cn = (["timeline", "mix", "render", "qa"].contains(&kind) && sp(p, "src", "src") == "src_cn") || kind == "voiceover_cn";
    if uses_cn && !root.join("src_cn").join("data").join("narration.json").exists() {
        return Err("還沒有簡體版原始碼（src_cn）。請先執行「產生 zh-CN 原始碼」（make_cn），再執行這個工作。".into());
    }
    if kind == "qa" {
        let seq = episode_of(p)?;
        let video = sp(p, "video", &format!("{}_Final.mp4", ep_upper(&seq))).to_string();
        if !root.join(&video).is_file() {
            return Err(format!("找不到影片檔：{video}（專案資料夾 {}）。請先完成渲染，或確認檔名是否正確。", crate::util::clean_path(root)));
        }
    }
    if ["timeline", "mix", "render", "final_tw", "youtube_15x", "voiceover_tw"].contains(&kind) && sp(p, "src", "src") == "src" {
        let seq = episode_of(p)?;
        if seq != "arttest" && !crate::episodes::exists(root, "zh-TW", &seq) {
            return Err(format!("src/data/narration.json 裡沒有 {seq} 這一集。請先在「劇本編輯」建立新集數。"));
        }
    }
    Ok(())
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
    let mut steps = build_steps_inner(kind, params, ctx)?;
    // English narration (Studio output language "en"): Whisper / subtitle splitting in English
    if sp(params, "lang", "") == "en" {
        for s in &mut steps {
            s.env.push(("PIKARA_LANG".into(), "en".into()));
        }
    }
    Ok(steps)
}

pub(crate) fn build_steps_inner(kind: &str, params: &Value, ctx: &Ctx) -> Result<Vec<Step>, String> {
    let p = params;
    Ok(match kind {
        "revoice" => revoice_steps(p, ctx)?,
        "rerender" => rerender_steps(p, ctx)?,
        "voiceover_tw" => vec![ctx.cosy("配音 zh-TW", &voice_args(p, false)?, &[])],
        "voiceover_cn" => vec![ctx.cosy("配音 zh-CN", &voice_args(p, true)?, &[("PIKARA_ASR_CC", "t2s")])],
        "timeline" => {
            let seq = episode_of(p)?;
            let mut a = timeline_args(&seq, &src_of(p)?, p["estimate"].as_bool().unwrap_or(false));
            if let Some(t) = p.get("voiceTempo").and_then(|v| v.as_f64()) {
                a.extend(["--voice-tempo".into(), voice_tempo_preset(t).to_string()]);
            }
            vec![ctx.py("時間軸", &a.iter().map(|s| s.as_str()).collect::<Vec<_>>())]
        }
        "mix" => {
            let seq = episode_of(p)?;
            let a = with_bgm(p, mix_args(&seq, &src_of(p)?))?;
            vec![ctx.py("混音", &a.iter().map(|s| s.as_str()).collect::<Vec<_>>())]
        }
        "render" => {
            let ep = ep_upper(&episode_of(p)?);
            let mode = sp(p, "mode", "gpu");
            if !["gpu", "cpu", "preview"].contains(&mode) {
                return Err(format!("mode must be gpu/cpu/preview, got {mode}"));
            }
            let mut a = vec![mode.to_string(), "--comp".into(), safe_token(sp(p, "comp", &format!("{ep}-30fps")), "comp")?];
            a.extend(["--out".into(), out_name(p, &format!("{ep}_Final.mp4"))?]);
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
            if let Some(c) = p.get("chunk").and_then(|v| v.as_u64()) {
                a.extend(["--chunk".into(), c.clamp(30, 100_000).to_string()]);
            }
            if let Some(c) = p.get("concurrency").and_then(|v| v.as_u64()) {
                a.extend(["--concurrency".into(), c.clamp(1, 16).to_string()]);
            }
            vec![ctx.render("渲染", &a)]
        }
        "qa" => {
            let seq = episode_of(p)?;
            let video = safe_token(sp(p, "video", &format!("{}_Final.mp4", ep_upper(&seq))), "video")?;
            let mut a = vec!["scripts/qa_video.py".to_string(), video, "--seq".into(), seq];
            let src = src_of(p)?;
            if src != "src" {
                a.extend(["--src".into(), src]);
            }
            if let Some(s) = num_arg(p, "speed") {
                a.extend(["--speed".into(), s]);
            }
            vec![ctx.py("品質檢查", &a.iter().map(|s| s.as_str()).collect::<Vec<_>>())]
        }
        "make_cn" => {
            let mut a = vec!["scripts/make_cn.py".to_string()];
            if p.get("episode").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).is_some() {
                a.extend(["--seq".into(), episode_of(&json!({"episode": p["episode"]}))?]);
            }
            if p["reconvert"].as_bool().unwrap_or(false) {
                a.push("--reconvert".into());
            }
            vec![ctx.py("make_cn", &a.iter().map(|s| s.as_str()).collect::<Vec<_>>())]
        }
        "final_tw" => {
            let seq = episode_of(p)?;
            let ep = ep_upper(&seq);
            let out = out_name(p, &format!("{ep}_Final.mp4"))?;
            let tl = timeline_args(&seq, "src", false);
            let mx = with_bgm(p, mix_args(&seq, "src"))?;
            vec![
                ctx.py(&format!("時間軸 {ep}"), &tl.iter().map(|s| s.as_str()).collect::<Vec<_>>()),
                ctx.step("複製字幕", "cmd", &["/d", "/c", "copy", "/Y", &format!(r"out\subtitles\{seq}.srt"), &format!("{ep}.srt")], Parser::Plain),
                ctx.py(&format!("混音 {ep}"), &mx.iter().map(|s| s.as_str()).collect::<Vec<_>>()),
                ctx.render(&format!("渲染 {ep}-30fps"), &fresh(p, ["gpu", "--comp", &format!("{ep}-30fps"), "--out", &out].map(String::from).to_vec())),
                ctx.py(&format!("品質檢查 {ep}"), &["scripts/qa_video.py", &out, "--seq", &seq]),
            ]
        }
        "youtube_15x" => {
            let seq = episode_of(p)?;
            let ep = ep_upper(&seq);
            let out = out_name(p, &format!("{ep}_YouTube_zh-TW.mp4"))?;
            let srt = out.trim_end_matches(".mp4").to_string() + ".srt";
            vec![
                ctx.py("SRT 1.5× 縮放", &["scripts/scale_srt.py", &format!("{ep}.srt"), &srt, "1.5"]),
                ctx.render(&format!("渲染 {ep}-YT15"), &fresh(p, vec!["gpu".into(), "--comp".into(), format!("{ep}-YT15"), "--out".into(), out])),
            ]
        }
        "bilibili" => {
            let seq = episode_of(p)?;
            let ep = ep_upper(&seq);
            let out = out_name(p, &format!("{ep}_Bilibili_zh-CN.mp4"))?;
            let srt = out.trim_end_matches(".mp4").to_string() + ".srt";
            let tl = timeline_args(&seq, "src_cn", false);
            let mx = with_bgm(p, mix_args(&seq, "src_cn"))?;
            let mix_name = format!("{seq}_cn");
            let mut make = vec!["scripts/make_cn.py", "--seq", &seq];
            if p["reconvert"].as_bool().unwrap_or(false) {
                make.push("--reconvert");
            }
            let mut v = vec![ctx.py("make_cn（src → src_cn）", &make)];
            // zh-CN only: the Simplified narration was already voiced (and pronunciation-checked) in the voice stage
            if !p["skipVoice"].as_bool().unwrap_or(false) {
                v.push(ctx.cosy("配音 zh-CN", &voice_args(&json!({"episode": seq}), true)?, &[("PIKARA_ASR_CC", "t2s")]));
            }
            v.extend([
                ctx.py("時間軸 zh-CN", &tl.iter().map(|s| s.as_str()).collect::<Vec<_>>()),
                ctx.step("複製字幕", "cmd", &["/d", "/c", "copy", "/Y", &format!(r"out\subtitles\{seq}_cn.srt"), &srt], Parser::Plain),
                ctx.py("混音 zh-CN", &mx.iter().map(|s| s.as_str()).collect::<Vec<_>>()),
                ctx.render(
                    &format!("渲染 {ep}-30fps（src_cn）"),
                    &fresh(p, ["gpu", "--comp", &format!("{ep}-30fps"), "--src", "src_cn", "--mix", &mix_name, "--out", &out].map(String::from).to_vec()),
                ),
                ctx.py("品質檢查 zh-CN", &["scripts/qa_video.py", &out, "--seq", &seq, "--src", "src_cn"]),
            ]);
            v
        }
        "claude_in" => claude_in_steps(p, ctx)?,
        "agent_cli" => agent_cli_steps(p, ctx)?,
        "stills" => {
            let frames = sp(p, "frames", "0");
            if !Regex::new(r"^\d+(,\d+){0,23}$").unwrap().is_match(frames) {
                return Err(format!("frames 必須是以逗號分隔的幀號：{frames}"));
            }
            let comp = safe_token(sp(p, "comp", ""), "comp")?;
            let entry = match sp(p, "src", "src") {
                "src" => "src/index.ts",
                "src_cn" => "src_cn/index.ts",
                s => return Err(format!("src must be src or src_cn, got {s}")),
            };
            let mut s = ctx.step(&format!("關鍵幀 {comp}"), &ctx.node(), &["scripts/stills.mjs", frames, &comp, entry], Parser::Plain);
            if let Some(sc) = p.get("scale").and_then(|v| v.as_f64()).filter(|s| *s > 0.05 && *s < 1.0) {
                s.label = format!("低解析度預覽 {comp}");
                s.env.push(("PIKARA_STILL_SCALE".into(), format!("{sc:.4}")));
            }
            vec![s]
        }
        "typecheck" => vec![ctx.step("tsc --noEmit", &ctx.node(), &["node_modules/typescript/bin/tsc", "--noEmit", "--pretty", "false"], Parser::Plain)],
        "custom" => {
            let c = sp(p, "command", "");
            if c.trim().is_empty() {
                return Err("command is required".into());
            }
            let mut s = ctx.step("自訂指令", "cmd", &["/d", "/s", "/c", c], Parser::Plain);
            s.stall_secs = p["stallSecs"].as_u64().filter(|v| *v > 0);
            vec![s]
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
