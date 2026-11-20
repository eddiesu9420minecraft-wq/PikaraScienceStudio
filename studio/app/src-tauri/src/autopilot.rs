//! Autonomous Production Mode: topic in → finished, checked episode out.
//!
//! A *production* is a persistent state machine (SQLite `productions`) that drives the existing job queue:
//! every heavy step is an ordinary queued job (so the GPU lock, heartbeats, crash recovery and logs all apply),
//! run inside an isolated git worktree `.studio/worktrees/<wid>` on branch `studio/auto/<wid>`.
//!
//! Stages: prepare → script (research + narration) → animate (optional, Claude writes React acts) → voice (CosyVoice,
//! Whisper pronunciation check) → timeline → visual (stills + AI review) → final (zh-TW 30fps + QA) → youtube (1.5×)
//! → bilibili (zh-CN) → thumbnail → publish (metadata text) → deliver (move outputs, merge, clean up).
//!
//! Every finished stage is a git checkpoint in the worktree. A failed check sends the error to a Claude *fix* job and
//! the stage runs again, at most `maxAttempts` times. Soft checks (pronunciation, visual review, QA, thumbnail,
//! metadata) continue with a warning when attempts run out; hard failures stop the production and leave the project
//! untouched (the worktree stays for inspection or is discarded = rollback). Nothing is ever published or uploaded.
//!
//! Claude Code billing: subscription (default) removes API-key variables from the child so the signed-in login is used
//! and sets no USD cap; costs Claude Code reports are shown as *model-equivalent estimates*, not charges. API mode
//! requires the user's own key in the environment and passes `--max-budget-usd`. A usage/credit limit pauses the
//! production (progress kept); Studio never switches billing, never retries around a limit, never stores credentials.

#![allow(non_snake_case)]

use crate::db::{self, Db};
use crate::gitops::{self, git};
use crate::jobs::worktree_dir;
use crate::queue::Queue;
use crate::util::{clean_path, now_iso, now_ms, run};
use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const MIGRATION: &str = r#"
    CREATE TABLE productions (
      id          TEXT PRIMARY KEY,
      project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
      episode     TEXT NOT NULL,
      status      TEXT NOT NULL,
      state_json  TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_ms  INTEGER NOT NULL
    );
    CREATE INDEX idx_productions_status ON productions(status, created_at);
    CREATE TABLE production_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
      ts            INTEGER NOT NULL,
      level         TEXT NOT NULL,
      stage         TEXT NOT NULL,
      line          TEXT NOT NULL
    );
    CREATE INDEX idx_pevents ON production_events(production_id, id);
"#;

// ------------------------------------------------------------------ config & state

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoConfig {
    /// What the episode explains (free text, zh-TW).
    pub topic: String,
    /// Target length in minutes (narration drives the real length).
    pub minutes: f64,
    /// "ai" = Claude writes custom React animation; "generic" = narration template (faster, simpler visuals).
    pub style: String,
    /// Tone / audience notes passed to the script writer.
    pub tone: String,
    pub audience: String,
    pub notes: String,
    pub youtube: bool,
    pub bilibili: bool,
    pub thumbnail: bool,
    pub publish_info: bool,
    pub visual_review: bool,
    pub pronunciation_check: bool,
    /// zh-TW narration speed in characters per second (CosyVoice is calibrated to it); None = the voice's natural pace.
    pub tw_cps: Option<f64>,
    /// Attempts per stage (first run included).
    pub max_attempts: u32,
    /// Wall-clock limit for the whole production while running (paused time excluded).
    pub max_minutes: u32,
    /// --max-turns for each Claude run.
    pub max_turns: u32,
    /// "subscription" (default, signed-in Claude Code) or "api" (user's own ANTHROPIC_API_KEY, USD cap).
    pub billing: String,
    /// API mode only: --max-budget-usd per Claude run.
    pub budget_usd: Option<f64>,
    /// Who does the AI work (research, script, animation code, reviews, fixes):
    /// "claude" (default: signed-in Claude Code CLI), "doubao" (official 豆包 CLI, signed in with a Doubao account),
    /// "external" (an outside agent such as the 豆包工作 desktop client drives Studio through `--cli agent-task/agent-done`).
    pub agent: String,
    /// Optional model name for the agent CLI (豆包 CLI `--model`; empty = the provider's default).
    pub agent_model: String,
}

impl Default for AutoConfig {
    fn default() -> Self {
        AutoConfig {
            topic: String::new(),
            minutes: 3.0,
            style: "ai".into(),
            tone: "清楚、生活化的比喻，像朋友在解釋".into(),
            audience: "對科技有興趣的一般觀眾".into(),
            notes: String::new(),
            youtube: true,
            bilibili: true,
            thumbnail: true,
            publish_info: true,
            visual_review: true,
            pronunciation_check: true,
            tw_cps: None,
            max_attempts: 3,
            max_minutes: 480,
            max_turns: 80,
            billing: "subscription".into(),
            budget_usd: None,
            agent: "claude".into(),
            agent_model: String::new(),
        }
    }
}

impl AutoConfig {
    pub fn validate(&mut self) -> Result<(), String> {
        self.topic = self.topic.trim().to_string();
        if self.topic.chars().count() < 2 {
            return Err("請輸入主題（至少 2 個字）".into());
        }
        if self.topic.chars().count() > 300 {
            return Err("主題太長（最多 300 字；細節請寫在「補充說明」）".into());
        }
        if !(0.5..=20.0).contains(&self.minutes) {
            return Err("影片長度必須在 0.5–20 分鐘之間".into());
        }
        if !["ai", "generic"].contains(&self.style.as_str()) {
            return Err(format!("style 必須是 ai 或 generic：{}", self.style));
        }
        if !["claude", "doubao", "external"].contains(&self.agent.as_str()) {
            return Err(format!("agent 必須是 claude、doubao 或 external：{}", self.agent));
        }
        if !self.agent_model.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/".contains(c)) {
            return Err(format!("模型名稱不正確：{}", self.agent_model));
        }
        if !["subscription", "api"].contains(&self.billing.as_str()) {
            return Err(format!("billing 必須是 subscription 或 api：{}", self.billing));
        }
        if self.billing == "api" {
            match self.budget_usd {
                Some(b) if b > 0.0 && b <= 500.0 => {}
                _ => return Err("API 付費模式必須設定每次 Claude 執行的美元上限（0–500）".into()),
            }
        } else {
            self.budget_usd = None; // subscription: no USD cap by default
        }
        if let Some(c) = self.tw_cps {
            if !(2.5..=7.0).contains(&c) {
                return Err("語速必須在每秒 2.5–7 字之間".into());
            }
        }
        self.max_attempts = self.max_attempts.clamp(1, 10);
        self.max_minutes = self.max_minutes.clamp(10, 24 * 60);
        self.max_turns = self.max_turns.clamp(10, 400);
        for s in [&mut self.tone, &mut self.audience, &mut self.notes] {
            *s = s.chars().take(2000).collect();
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Production {
    pub id: String,
    pub project_id: Option<String>,
    pub episode: String,
    pub config: AutoConfig,
    /// queued | running | waiting_agent | paused | paused_limit | needs_merge | succeeded | failed | canceled
    pub status: String,
    pub stage: String,
    pub action: usize,
    pub attempt: u32,
    /// "main" (stage actions) or "fix" (a Claude fix job is running for this stage)
    pub mode: String,
    pub job_id: Option<String>,
    pub worktree: Option<String>,
    pub branch: Option<String>,
    pub message: Option<String>,
    pub warnings: Vec<String>,
    /// Per-stage scratch: last job ids, files to re-voice, still frames, checkpoints …
    pub data: Value,
    pub active_ms: i64,
    pub last_tick_ms: i64,
    /// Sum of `total_cost_usd` reported by Claude Code. Subscription: model-equivalent estimate, not a charge.
    pub claude_cost_usd: f64,
    pub claude_runs: u32,
    pub outputs: Vec<String>,
    pub stages: Vec<StageInfo>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// Earliest time (ms) the next action may start (transient-error back-off).
    pub not_before_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StageInfo {
    pub id: String,
    pub label: String,
    /// pending | running | done | warned | failed | skipped
    pub status: String,
    pub attempts: u32,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub checkpoint: Option<String>,
    pub note: Option<String>,
}

const ACTIVE: [&str; 5] = ["queued", "running", "paused", "paused_limit", "waiting_agent"];

// ------------------------------------------------------------------ stages

pub const STAGES: [(&str, &str); 12] = [
    ("prepare", "準備（分配集數、建立隔離工作樹）"),
    ("script", "資料研究與劇本"),
    ("animate", "動畫程式（Claude 撰寫）"),
    ("voice", "配音與發音檢查"),
    ("timeline", "時間軸與字幕"),
    ("visual", "畫面檢查（關鍵幀＋AI 審查）"),
    ("final", "繁中正式版渲染＋QA"),
    ("youtube", "YouTube 1.5× 版"),
    ("bilibili", "Bilibili 簡中版"),
    ("thumbnail", "封面"),
    ("publish", "上架資訊"),
    ("deliver", "交付（合併、移出成品）"),
];

fn stage_enabled(id: &str, c: &AutoConfig) -> bool {
    match id {
        "animate" => c.style == "ai",
        "visual" => c.visual_review,
        "youtube" => c.youtube,
        "bilibili" => c.bilibili,
        "thumbnail" => c.thumbnail,
        "publish" => c.publish_info,
        _ => true,
    }
}

fn stage_label(id: &str) -> &'static str {
    STAGES.iter().find(|s| s.0 == id).map(|s| s.1).unwrap_or("?")
}

#[derive(Debug, Clone)]
enum Action {
    Job { kind: &'static str, params: Value },
    Inline(&'static str),
    /// AI work for an external agent (agent = "external"): Studio waits in `waiting_agent` until `agent_done`.
    Agent { title: String, prompt: String },
}

/// The AI step of a stage, for the configured provider. Claude Code and the 豆包 CLI run as queue jobs inside the
/// worktree; an external agent gets the same instructions as a task file and reports back through the CLI.
fn ai(p: &Production, title: &str, prompt: &str, tools: &str) -> Action {
    match p.config.agent.as_str() {
        "external" => Action::Agent { title: format!("{} {}", ep_upper(&p.episode), title), prompt: prompt.to_string() },
        "doubao" => Action::Job {
            kind: "agent_cli",
            params: json!({"provider": "doubao", "title": format!("{} {}", ep_upper(&p.episode), title), "prompt": prompt, "model": p.config.agent_model}),
        },
        _ => Action::Job { kind: "claude_in", params: claude_params(p, title, prompt, tools) },
    }
}

fn with_base(a: Action, p: &Production) -> Action {
    match a {
        Action::Job { kind, mut params } => {
            params["workdir"] = json!(p.worktree.clone().unwrap_or_default());
            params["episode"] = json!(p.episode);
            Action::Job { kind, params }
        }
        other => other,
    }
}

pub fn agent_name(agent: &str) -> &'static str {
    match agent {
        "doubao" => "豆包 CLI",
        "external" => "外部 Agent",
        _ => "Claude",
    }
}

/// What a failed stage gets: a Claude fix job (then the stage re-runs) or a plain re-run.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Fixer {
    None,
    Script,
    Code,
    Pronunciation,
    Qa,
}

/// Soft stages continue with a warning when attempts run out; hard stages stop the production.
fn stage_meta(id: &str) -> (Fixer, bool) {
    match id {
        "script" | "timeline" => (Fixer::Script, false),
        "animate" => (Fixer::Code, true), // soft: falls back to the generic template
        "voice" => (Fixer::Pronunciation, true),
        "visual" => (Fixer::None, true),
        "final" | "youtube" | "bilibili" => (Fixer::Qa, true),
        "thumbnail" | "publish" => (Fixer::None, true),
        _ => (Fixer::None, false),
    }
}

fn ep_upper(ep: &str) -> String {
    ep.to_ascii_uppercase()
}

fn actions(p: &Production) -> Vec<Action> {
    let ep = p.episode.clone();
    let wid = p.worktree.clone().unwrap_or_default();
    let base = |mut v: Value| {
        v["workdir"] = json!(wid);
        v["episode"] = json!(ep);
        v
    };
    let refresh = p.attempt > 1 || p.data["fresh"].as_bool().unwrap_or(false);
    let E = ep_upper(&p.episode);
    match p.stage.as_str() {
        "prepare" => vec![Action::Inline("prepare")],
        "script" => vec![with_base(ai(p, "劇本", &prompt_script(p), TOOLS_RESEARCH), p), Action::Inline("check_script")],
        "animate" => vec![
            with_base(ai(p, "動畫程式", &prompt_animate(p), TOOLS_CODE), p),
            Action::Job { kind: "typecheck", params: base(json!({})) },
            Action::Inline("check_animate"),
        ],
        "voice" => {
            let mut v = json!({});
            if let Some(only) = p.data["voiceOnly"].as_str().filter(|s| !s.is_empty()) {
                v = json!({"only": only, "force": true});
            }
            if let Some(c) = p.config.tw_cps {
                v["targetCps"] = json!(c);
            }
            vec![Action::Job { kind: "voiceover_tw", params: base(v) }, Action::Inline("check_voice")]
        }
        "timeline" => vec![Action::Job { kind: "timeline", params: base(json!({})) }],
        "visual" => vec![
            Action::Inline("plan_stills"),
            Action::Job { kind: "stills", params: base(json!({"comp": format!("{E}-30fps"), "frames": p.data["stillFrames"].as_str().unwrap_or("0")})) },
            with_base(ai(p, "畫面審查", &prompt_visual(p), TOOLS_CODE), p),
            Action::Job { kind: "typecheck", params: base(json!({})) },
            Action::Inline("check_visual"),
        ],
        "final" => vec![Action::Job { kind: "typecheck", params: base(json!({})) }, Action::Job { kind: "final_tw", params: base(json!({"fresh": refresh})) }, Action::Inline("check_qa")],
        "youtube" => vec![
            Action::Job { kind: "typecheck", params: base(json!({})) },
            Action::Job { kind: "youtube_15x", params: base(json!({"fresh": refresh})) },
            Action::Job { kind: "qa", params: base(json!({"video": format!("{E}_YouTube_zh-TW.mp4"), "speed": 1.5})) },
            Action::Inline("check_qa"),
        ],
        "bilibili" => vec![Action::Job { kind: "typecheck", params: base(json!({})) }, Action::Job { kind: "bilibili", params: base(json!({"fresh": refresh})) }, Action::Inline("check_qa")],
        "thumbnail" => {
            let mut v = vec![
                Action::Job { kind: "stills", params: base(json!({"comp": format!("{E}-Thumbnail"), "frames": "0"})) },
                Action::Inline("copy_thumb_tw"),
            ];
            if p.config.bilibili {
                v.push(Action::Job { kind: "stills", params: base(json!({"comp": format!("{E}-Thumbnail"), "frames": "0", "src": "src_cn"})) });
                v.push(Action::Inline("copy_thumb_cn"));
            }
            v
        }
        "publish" => vec![with_base(ai(p, "上架資訊", &prompt_publish(p), TOOLS_CODE), p), Action::Inline("check_publish")],
        "deliver" => vec![Action::Inline("deliver")],
        _ => vec![],
    }
}

const TOOLS_RESEARCH: &str = "Read,Glob,Grep,Edit,Write,WebSearch,WebFetch";
const TOOLS_CODE: &str = "Read,Glob,Grep,Edit,Write,Bash(node node_modules/typescript/bin/tsc *)";

fn claude_params(p: &Production, title: &str, prompt: &str, tools: &str) -> Value {
    json!({
        "title": format!("{} {}", ep_upper(&p.episode), title),
        "prompt": prompt,
        "tools": tools,
        "maxTurns": p.config.max_turns,
        "billing": p.config.billing,
        "budgetUsd": p.config.budget_usd,
    })
}

// ------------------------------------------------------------------ prompts (zh-TW; the project Skill has the pipeline details)

const COMMON_RULES: &str = "\
共同規則：
- 你在 Pikara Science Studio 的「自動製作」隔離工作樹中執行（目前目錄；外部 Agent 請以任務說明開頭的工作目錄為準）。這是一個 Remotion 科普影片專案；先讀 .claude/skills/pikara-video/SKILL.md 了解管線。
- 不要執行任何 GPU 指令（渲染、stills、CosyVoice、gpu:check），Studio 會排程執行。不要 git commit、不要切換分支、不要安裝套件、不要上傳或發布任何東西。
- 只修改與本集有關的檔案；不要動其他集數的旁白、程式或成品。
- 科學正確性優先：不得虛構數據、規格、測試結果或引文；不確定的內容寧可不寫。
- narration.json 保持 2 空格縮排、UTF-8、不轉義中文，其他鍵的順序不變。
- 完成後用一段簡短的繁體中文說明你做了什麼。";

fn prompt_script(p: &Production) -> String {
    let c = &p.config;
    let ep = &p.episode;
    let E = ep_upper(ep);
    let chars = (c.minutes * 60.0 * c.tw_cps.unwrap_or(3.6)).round() as i64;
    format!(
        "任務：為新的一集 {ep} 完成「資料研究＋劇本」。\n\n\
主題：{topic}\n目標長度：約 {min} 分鐘（繁中旁白約 {chars} 字，CosyVoice 約每秒 3.6 字；允許 ±15%）\n語氣：{tone}\n觀眾：{aud}\n補充說明：{notes}\n\n\
步驟：\n\
1. 用網路搜尋與讀取網頁的工具研究主題，優先官方文件、論文、教科書、權威機構。建立 {E}_SOURCES.md：每個來源列出標題、網址、支持影片中的哪些說法。至少 3 個真實可開啟的來源，不得編造網址。\n\
2. 在 src/data/narration.json 的 sequences 加入 \"{ep}\"（不要修改其他集數）：\n\
   {{\"voiceEngine\": \"cosyvoice\", \"title\": \"<集名，12 字內>\", \"thumbnail\": {{\"lines\": [\"<封面主標第一行，≤8 字>\", \"<第二行，≤8 字>\"], \"highlight\": \"<黃色強調條，≤12 字>\", \"tags\": [\"<2–5 個短關鍵詞>\"]}},\n\
    \"scenes\": [{{\"id\": \"s01\", \"title\": \"<章節標題>\", \"lines\": [{{\"id\": \"{ep}-s01-01\", \"subtitle\": \"<字幕>\", \"speak\": \"<朗讀文字，可省略>\", \"anchors\": {{\"<英文名稱>\": \"<旁白中的詞>\"}}}}]}}]}}\n\
   - 3–7 個場景（章節），每個場景 3–10 句。第一句在 5 秒內提出引人好奇的問題（hook），最後一個場景收尾並回扣開頭。\n\
   - 每句字幕 ≤ 36 字，口語、短句。英文縮寫、數字、單位若 TTS 可能念錯，用 speak 寫出中文念法（例：subtitle「GPU」→ speak「G P U」；「4GB」→「四 GB」）。\n\
   - anchors：動畫在旁白念到該詞時觸發。詞必須逐字出現在 speak（沒有 speak 則 subtitle）中；每個場景 2–6 個錨點，名稱用英文小寫，場景內不重複；錨點詞簡短（≤ 8 字），會顯示成畫面上的關鍵詞卡片。\n\
3. 確認 JSON 正確且所有錨點詞都在朗讀文字中。\n\n{COMMON_RULES}",
        topic = c.topic,
        min = c.minutes,
        tone = c.tone,
        aud = c.audience,
        notes = if c.notes.is_empty() { "（無）" } else { &c.notes },
    )
}

fn prompt_animate(p: &Production) -> String {
    let ep = &p.episode;
    format!(
        "任務：為 {ep} 撰寫每個場景的動畫元件（React + TypeScript，Remotion）。\n\n\
- 旁白在 src/data/narration.json 的 sequences.{ep}（先讀完）。每個 scene 對應一個元件，建立在 src/acts/{ep}/（例：S01.tsx），型別是 src/acts/types.ts 的 ActComponent（props：frame 本幕本地影格、anchors 錨點名稱→影格、lines、fps 等）。\n\
- 在 src/episode/registry.ts 的 CUSTOM_ACTS 標記區塊內加入 {ep}: [{{id: '<scene id>', component: S01, transitionIn: 'self'}}, {{id: …, transitionIn: 'iris'}} …]（第一幕 'self'，其餘 'iris'），id 必須與 scene id 完全相同，順序一致。\n\
- 參考：src/episode/GenericAct.tsx（最簡單、由錨點驅動的寫法）、src/acts/Act02.tsx 等 EP01 手工幕（較豐富的畫面）、src/theme/palette.ts、src/theme/fonts.ts、src/lib/anim.ts。沿用相同的配色、字型與質感。\n\
- 畫面要「解釋」概念：圖解、示意動畫、比例、流程，而不只是文字卡片；動畫在對應錨點的影格開始（anchors.xxx），沒有寫死的秒數（錨點不存在時要有合理的預設）。\n\
- 1920×1080；畫面下方 300px 保留給字幕，不放重要內容；所有文字不得超出畫面或互相重疊；中文字級 ≥ 36px。\n\
- 必須是決定性的：不得使用 Math.random()（請用 src/lib/anim.ts 的 rng(seed)）、Date、網路資源或外部圖片。\n\
- 完成後執行 `node node_modules/typescript/bin/tsc --noEmit --pretty false`（在目前目錄直接執行這一行，不要加 cd 或 &&） 直到沒有錯誤。\n\n{COMMON_RULES}"
    )
}

fn prompt_visual(p: &Production) -> String {
    let ep = &p.episode;
    let files = p.data["stillFiles"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join("\n- ")).unwrap_or_default();
    format!(
        "任務：審查 {ep} 的畫面，必要時修正。\n\n用 Read 逐一查看這些關鍵幀（1920×1080 PNG，每個場景至少一張；檔名中的數字是 30fps 影格）：\n- {files}\n\n\
檢查：文字是否超出畫面或被裁切、元素互相重疊、內容是否進入下方 300px 字幕區、文字可讀性與對比、空白或破圖、整體美感與風格一致、圖解是否與旁白內容相符（旁白在 src/data/narration.json 的 sequences.{ep}）。\n\n\
把結果寫成 JSON 到 out/auto/review.json：{{\"pass\": <沒有 major 問題時 true>, \"issues\": [{{\"file\": \"…\", \"severity\": \"major|minor\", \"problem\": \"…\"}}], \"fixed\": <是否已修改程式或旁白>}}。\n\
如果有 major 問題：修改 src/acts/{ep}/、src/episode/GenericAct.tsx 不可修改（會影響其他集），可以改 narration.json 中 {ep} 的錨點詞讓卡片變短；修改後執行 `node node_modules/typescript/bin/tsc --noEmit --pretty false`（在目前目錄直接執行這一行，不要加 cd 或 &&） 確認沒有錯誤，並把 fixed 設為 true。minor 問題可以順手修正，但不影響 pass。\n\n{COMMON_RULES}"
    )
}

fn prompt_publish(p: &Production) -> String {
    let ep = &p.episode;
    let E = ep_upper(ep);
    let mut thumbs = vec![format!("{E}_YouTube_zh-TW_Thumbnail.png")];
    if p.config.bilibili {
        thumbs.push(format!("{E}_Bilibili_zh-CN_Thumbnail.png"));
    }
    format!(
        "任務：為 {ep} 撰寫上架資訊（只寫文字檔，不上傳、不發布）。\n\n\
讀 src/data/narration.json 的 sequences.{ep}、{E}_SOURCES.md、字幕 {E}.srt{cn}。用 Read 查看封面 {thumbs}，若主標在 320px 寬縮圖下難以辨識，在檔案最後的「封面檢查」段落說明。\n\n\
建立 {E}_PUBLISH_METADATA.md，包含：\n\
## YouTube（繁體中文）：3 個標題候選（≤ 60 字）、說明欄（含章節時間軸，時間依 {E}_YouTube_zh-TW.srt 的 1.5× 版本）、參考資料連結（取自 {E}_SOURCES.md）、10–15 個標籤。\n\
{bili}## 封面檢查：一兩句。\n\n內容必須與影片實際旁白一致，不誇大、不使用聳動但不實的標題。\n\n{COMMON_RULES}",
        cn = if p.config.bilibili { format!("、src_cn/data/narration.json 的 sequences.{ep}") } else { String::new() },
        thumbs = thumbs.join("、"),
        bili = if p.config.bilibili {
            format!("## Bilibili（简体中文，使用大陆用语）：3 个标题候选、简介（含章节时间，依 {E}_Bilibili_zh-CN.srt）、参考资料、分区建议、10–15 个标签。\n")
        } else {
            String::new()
        },
    )
}

fn prompt_fix(p: &Production, fixer: Fixer, err: &str) -> String {
    let ep = &p.episode;
    let what = match fixer {
        Fixer::Script => format!("旁白（src/data/narration.json 的 sequences.{ep}）或 {}_SOURCES.md 沒有通過檢查。依錯誤修正，保持其他內容不變。", ep_upper(ep)),
        Fixer::Code => format!("{ep} 的動畫程式（src/acts/{ep}/、src/episode/registry.ts 的 CUSTOM_ACTS）沒有通過檢查。修正到 `node node_modules/typescript/bin/tsc --noEmit --pretty false`（在目前目錄直接執行這一行，不要加 cd 或 &&） 沒有錯誤。"),
        Fixer::Pronunciation => format!(
            "CosyVoice 合成後，Whisper 聽到的讀音與朗讀文字不符（已排除數字寫法與同音字的差異），代表可能念錯或吞字。下面列出每句「應念」與「聽到」。只修正念法：在 src/data/narration.json 的 sequences.{ep} 對這些句子設定或調整 speak 欄位，例如把英文縮寫、數字、符號改寫成中文念法，或把容易念錯的多音字換成同音字。不要增減或改寫句子的內容，字幕 subtitle 必須仍與實際念出的內容一致；如果非改寫不可，subtitle 也要改成相同的意思與字數。錨點詞仍必須出現在 speak 中（必要時一併調整 anchors 的詞）。"
        ),
        Fixer::Qa => format!(
            "{ep} 的成品沒有通過自動 QA（黑畫面、音量、靜音、字幕重疊等）。讀 out/qa/ 下的報告，找出原因並修正 src/acts/{ep}/ 或 narration.json 的 sequences.{ep}（例如調整 pauseAfter、拆句）。簡體版的旁白在 src_cn/data/narration.json（src_cn 的程式會由 make_cn 從 src 重新產生，不要改 src_cn 的程式碼）。若問題無法以修改內容解決，說明原因即可。"
        ),
        Fixer::None => String::new(),
    };
    format!("任務：修正自動製作中失敗的步驟「{}」（第 {} 次嘗試失敗）。\n\n{what}\n\n錯誤與日誌摘錄：\n```\n{}\n```\n\n{COMMON_RULES}", stage_label(&p.stage), p.attempt.saturating_sub(1).max(1), clip(err, 6000))
}

fn clip(s: &str, n: usize) -> String {
    let c: Vec<char> = s.chars().collect();
    if c.len() <= n { s.to_string() } else { c[c.len() - n..].iter().collect() }
}

// ------------------------------------------------------------------ persistence

fn row_to_prod(state: String) -> Result<Production, String> {
    serde_json::from_str(&state).map_err(|e| e.to_string())
}

pub fn save(conn: &rusqlite::Connection, p: &Production) -> Result<(), String> {
    let s = serde_json::to_string(p).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO productions (id, project_id, episode, status, state_json, created_at, updated_ms) VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, state_json=excluded.state_json, updated_ms=excluded.updated_ms",
        params![p.id, p.project_id, p.episode, p.status, s, p.created_at, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// By full id, or by a unique prefix of at least 6 characters (convenient for CLI users and agents).
pub fn get(conn: &rusqlite::Connection, id: &str) -> Result<Production, String> {
    let s: Option<String> = conn
        .query_row("SELECT state_json FROM productions WHERE id=?1", [id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(s) = s {
        return row_to_prod(s);
    }
    if id.len() >= 6 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        let mut st = conn.prepare("SELECT state_json FROM productions WHERE id LIKE ?1 || '%' LIMIT 2").map_err(|e| e.to_string())?;
        let rows: Vec<String> = st.query_map([id], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        match rows.len() {
            1 => return row_to_prod(rows.into_iter().next().unwrap()),
            2 => return Err(format!("id 開頭 {id} 對應到不只一個製作，請輸入完整 id")),
            _ => {}
        }
    }
    Err(format!("找不到製作 {id}"))
}

pub fn list(conn: &rusqlite::Connection, limit: i64) -> Result<Vec<Production>, String> {
    let mut st = conn.prepare("SELECT state_json FROM productions ORDER BY created_at DESC LIMIT ?1").map_err(|e| e.to_string())?;
    let rows = st.query_map([limit], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.filter_map(|r| r.ok()).map(row_to_prod).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PEvent {
    pub id: i64,
    pub ts: i64,
    pub level: String,
    pub stage: String,
    pub line: String,
}

pub fn events(conn: &rusqlite::Connection, id: &str, after: i64, limit: i64) -> Result<Vec<PEvent>, String> {
    let mut st = conn
        .prepare("SELECT id, ts, level, stage, line FROM production_events WHERE production_id=?1 AND id>?2 ORDER BY id ASC LIMIT ?3")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![id, after, limit], |r| Ok(PEvent { id: r.get(0)?, ts: r.get(1)?, level: r.get(2)?, stage: r.get(3)?, line: r.get(4)? }))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn event(conn: &rusqlite::Connection, p: &Production, level: &str, line: &str) {
    let _ = conn.execute(
        "INSERT INTO production_events (production_id, ts, level, stage, line) VALUES (?1,?2,?3,?4,?5)",
        params![p.id, now_ms(), level, p.stage, line],
    );
}

// ------------------------------------------------------------------ episode allocation

/// Next episode id that is not used anywhere: zh-TW / zh-CN narration, output files in the project root,
/// other productions (active or not) and `studio/auto/*` branches. Never overwrites an existing episode.
pub fn allocate_episode(conn: &rusqlite::Connection, root: &Path) -> Result<String, String> {
    let mut used: Vec<u32> = vec![];
    for loc in ["zh-TW", "zh-CN"] {
        if let Ok(r) = crate::narration::read(root, loc) {
            if let Some(m) = r["doc"]["sequences"].as_object() {
                used.extend(m.keys().filter_map(|k| crate::episodes::number(k)));
            }
        }
    }
    static RE_OUT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^EP(\d{2,3})[_.]").unwrap());
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            if let Some(c) = RE_OUT.captures(&e.file_name().to_string_lossy()) {
                used.extend(c[1].parse::<u32>().ok());
            }
        }
    }
    let mut st = conn.prepare("SELECT episode FROM productions").map_err(|e| e.to_string())?;
    let eps: Vec<String> = st.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    used.extend(eps.iter().filter_map(|e| crate::episodes::number(e)));
    if let Ok(o) = git(root, &["branch", "--list", "studio/auto/*", "--format=%(refname:short)"]) {
        static RE_BR: Lazy<Regex> = Lazy::new(|| Regex::new(r"studio/auto/ep(\d{2,3})-").unwrap());
        for l in o.stdout.lines() {
            if let Some(c) = RE_BR.captures(l) {
                used.extend(c[1].parse::<u32>().ok());
            }
        }
    }
    let n = used.into_iter().max().unwrap_or(0) + 1;
    if n > 999 {
        return Err("集數已達上限 ep999".into());
    }
    Ok(format!("ep{n:02}"))
}

// ------------------------------------------------------------------ public API

pub struct Autopilot {
    pub db: Db,
    pub queue: Arc<Queue>,
    pub notify: Arc<dyn Fn(&str, &str) + Send + Sync>,
    pub emit: Arc<dyn Fn(&str, Value) + Send + Sync>,
    busy: Mutex<()>,
}

impl Autopilot {
    pub fn new(db: Db, queue: Arc<Queue>, notify: Arc<dyn Fn(&str, &str) + Send + Sync>, emit: Arc<dyn Fn(&str, Value) + Send + Sync>) -> Arc<Self> {
        Arc::new(Autopilot { db, queue, notify, emit, busy: Mutex::new(()) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn root(&self, p: &Production) -> Result<PathBuf, String> {
        let pid = p.project_id.as_deref().ok_or("製作沒有專案")?;
        Ok(PathBuf::from(db::project_get(&self.conn(), pid)?.root_path))
    }

    fn store(&self, p: &Production) {
        let _ = save(&self.conn(), p);
        (self.emit)("production://update", serde_json::to_value(p).unwrap_or(Value::Null));
    }

    fn log(&self, p: &Production, level: &str, line: &str) {
        event(&self.conn(), p, level, line);
        (self.emit)("production://event", json!({"id": p.id, "level": level, "stage": p.stage, "line": line}));
    }

    /// Create a production (status queued). The episode id is reserved immediately.
    pub fn start(&self, project_id: &str, mut cfg: AutoConfig) -> Result<Production, String> {
        cfg.validate()?;
        let root = PathBuf::from(db::project_get(&self.conn(), project_id)?.root_path);
        if !root.join(".git").exists() {
            return Err("專案資料夾不是 git 倉庫，無法建立隔離工作樹".into());
        }
        match cfg.agent.as_str() {
            "claude" if crate::claude::claude_path().is_none() => {
                return Err("找不到 Claude Code CLI。請先安裝 Claude Code，並在終端機執行 claude 完成登入。".into());
            }
            "doubao" if crate::agents::doubao_path().is_none() => {
                return Err("找不到豆包 CLI（doubao）。請依豆包工作官方說明安裝：npm install -g @bytedance/doubao-cli，再執行 doubao login 掃碼登入。".into());
            }
            _ => {}
        }
        let c = self.conn();
        let episode = allocate_episode(&c, &root)?;
        let id = uuid::Uuid::new_v4().to_string();
        let stages = STAGES
            .iter()
            .map(|(sid, label)| StageInfo {
                id: sid.to_string(),
                label: label.to_string(),
                status: if stage_enabled(sid, &cfg) { "pending".into() } else { "skipped".into() },
                ..Default::default()
            })
            .collect();
        let p = Production {
            id,
            project_id: Some(project_id.into()),
            episode,
            config: cfg,
            status: "queued".into(),
            stage: "prepare".into(),
            action: 0,
            attempt: 1,
            mode: "main".into(),
            data: json!({}),
            stages,
            created_at: now_iso(),
            ..Default::default()
        };
        save(&c, &p)?;
        event(&c, &p, "info", &format!("建立自動製作：{}（{}，約 {} 分鐘）", p.episode.to_uppercase(), p.config.topic, p.config.minutes));
        drop(c);
        (self.emit)("production://update", serde_json::to_value(&p).unwrap());
        Ok(p)
    }

    /// Stop at an AI step for an external agent: write the task file into the worktree and wait.
    fn wait_for_agent(&self, mut p: Production, title: &str, prompt: &str) {
        let file = match (self.root(&p), p.worktree.clone()) {
            (Ok(root), Some(w)) => {
                let wt = worktree_dir(&root, &w);
                let f = wt.join("out").join("auto").join("AGENT_TASK.md");
                let _ = std::fs::create_dir_all(f.parent().unwrap());
                let body = format!(
                    "# {title}\n\n工作目錄（所有檔案操作都在這裡）：{}\n\n{prompt}\n\n---\n完成後執行：PikaraScienceStudio.exe --cli agent-done --id {}\n無法完成時執行：PikaraScienceStudio.exe --cli agent-done --id {} --failed --note \"原因\"\n",
                    clean_path(&wt),
                    p.id,
                    p.id
                );
                let _ = std::fs::write(&f, body);
                Some(clean_path(&f))
            }
            _ => None,
        };
        p.status = "waiting_agent".into();
        p.data["agentTask"] = json!({"title": title, "prompt": prompt, "file": file, "since": now_iso(), "mode": p.mode});
        p.message = Some(format!("等待外部 Agent 完成：{title}（任務說明：{}）", file.clone().unwrap_or_default()));
        self.mark_stage(&mut p, "running", None);
        self.log(&p, "info", &format!("⏸ 等待外部 Agent：{title}"));
        (self.notify)(&format!("Pikara Science Studio：{} 等待 Agent", ep_upper(&p.episode)), title);
        self.store(&p);
    }

    /// The external agent finished (or gave up on) the current AI step. Studio continues with the stage's checks.
    pub fn agent_done(&self, id: &str, failed: bool, note: Option<&str>) -> Result<Production, String> {
        let mut p = get(&self.conn(), id)?;
        if p.status != "waiting_agent" {
            return Err(format!("這次製作目前不是在等待 Agent（狀態：{}）", p.status));
        }
        let title = p.data["agentTask"]["title"].as_str().unwrap_or("").to_string();
        p.data.as_object_mut().map(|m| m.remove("agentTask"));
        p.status = "running".into();
        p.message = None;
        p.last_tick_ms = now_ms();
        if let Some(n) = note.filter(|n| !n.trim().is_empty()) {
            self.log(&p, "info", &format!("Agent 回報：{}", n.chars().take(1000).collect::<String>()));
        }
        if failed {
            self.log(&p, "warn", &format!("Agent 無法完成：{title}"));
            let mode_fix = p.mode == "fix";
            p.mode = "main".into();
            self.store(&p);
            let reason = format!("外部 Agent 回報無法完成「{title}」：{}", note.unwrap_or(""));
            self.stage_failed(p.clone(), &reason, !mode_fix, false);
            return get(&self.conn(), id);
        }
        self.log(&p, "info", &format!("✓ Agent 完成：{title}"));
        if p.mode == "fix" {
            p.mode = "main".into();
            p.action = 0;
            p.data["fresh"] = json!(true);
        } else {
            p.action += 1;
        }
        self.store(&p);
        Ok(p)
    }

    pub fn pause(&self, id: &str) -> Result<Production, String> {
        let mut p = get(&self.conn(), id)?;
        if !["queued", "running", "waiting_agent"].contains(&p.status.as_str()) {
            return Err(format!("目前狀態「{}」不能暫停", p.status));
        }
        p.status = "paused".into();
        p.message = Some("已暫停：正在執行的工作會做完，之後不會開始新的步驟。按「繼續」恢復。".into());
        self.log(&p, "info", "使用者暫停");
        self.store(&p);
        Ok(p)
    }

    /// Resume a paused / limit-paused / failed production. A failed stage gets a fresh set of attempts.
    pub fn resume(&self, id: &str) -> Result<Production, String> {
        let mut p = get(&self.conn(), id)?;
        match p.status.as_str() {
            "paused" | "paused_limit" => {}
            "failed" => {
                p.attempt = 1;
                p.mode = "main".into();
                p.action = 0;
                p.job_id = None;
            }
            "needs_merge" => return self.retry_deliver(p),
            s => return Err(format!("目前狀態「{s}」不能繼續")),
        }
        let root = self.root(&p)?;
        if p.worktree.as_deref().map(|w| !worktree_dir(&root, w).exists()).unwrap_or(false) {
            return Err("這次製作的工作樹已被刪除，無法繼續。".into());
        }
        p.status = "running".into();
        p.message = None;
        p.not_before_ms = 0;
        p.last_tick_ms = now_ms();
        self.log(&p, "info", "繼續製作");
        self.store(&p);
        Ok(p)
    }

    /// Stop: cancel the running job; keep the worktree (inspect or discard later). The project is untouched.
    pub fn stop(&self, id: &str) -> Result<Production, String> {
        let mut p = get(&self.conn(), id)?;
        if !ACTIVE.contains(&p.status.as_str()) && p.status != "needs_merge" {
            return Err(format!("目前狀態「{}」不能停止", p.status));
        }
        if let Some(j) = p.job_id.take() {
            let _ = self.queue.cancel(&j);
        }
        p.status = "canceled".into();
        p.finished_at = Some(now_iso());
        p.message = Some("已停止。專案本身沒有任何改變；工作樹保留，可檢視或按「捨棄」刪除。".into());
        self.log(&p, "warn", "使用者停止");
        self.store(&p);
        Ok(p)
    }

    /// Discard = rollback: remove the worktree and its branch. Only for finished / stopped productions.
    pub fn discard(&self, id: &str) -> Result<Production, String> {
        let mut p = get(&self.conn(), id)?;
        if ACTIVE.contains(&p.status.as_str()) {
            return Err("請先停止這次製作".into());
        }
        let root = self.root(&p)?;
        if let Some(w) = p.worktree.clone() {
            remove_worktree(&root, &w, true)?;
        }
        p.message = Some(format!("{}（工作樹與分支已刪除）", p.message.clone().unwrap_or_default()));
        p.worktree = None;
        self.log(&p, "info", "已捨棄工作樹與分支");
        self.store(&p);
        Ok(p)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let p = get(&self.conn(), id)?;
        if ACTIVE.contains(&p.status.as_str()) || p.worktree.is_some() {
            return Err("請先停止並捨棄工作樹，再從清單移除".into());
        }
        self.conn().execute("DELETE FROM productions WHERE id=?1", [&p.id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    // -------------------------------------------------------------- scheduler

    /// One orchestration pass over all productions. At most one production runs at a time (they share the GPU).
    pub fn tick(&self) {
        let Ok(_g) = self.busy.try_lock() else { return };
        let all = list(&self.conn(), 200).unwrap_or_default();
        let mut running = all.iter().filter(|p| ["running", "paused", "paused_limit"].contains(&p.status.as_str()) && p.job_id.is_some() || ["running", "waiting_agent"].contains(&p.status.as_str())).count();
        for mut p in all.into_iter().rev() {
            match p.status.as_str() {
                "queued" if running == 0 => {
                    p.status = "running".into();
                    p.started_at = Some(now_iso());
                    p.last_tick_ms = now_ms();
                    self.store(&p);
                    running += 1;
                    self.advance(p);
                }
                "running" => self.advance(p),
                "paused" | "paused_limit" => {
                    // a job that was already running keeps going; record its result without starting anything new
                    if let Some(j) = p.job_id.clone() {
                        let job = db::job_get(&self.conn(), &j);
                        if let Ok(job) = job {
                            if !["queued", "waiting_resource", "running", "interrupted"].contains(&job.status.as_str()) {
                                self.log(&p, "info", &format!("暫停期間完成的工作：{}（{}）", job.label, job.status));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn advance(&self, mut p: Production) {
        let now = now_ms();
        if p.last_tick_ms > 0 {
            p.active_ms += (now - p.last_tick_ms).clamp(0, 60_000);
        }
        p.last_tick_ms = now;
        if p.active_ms > p.config.max_minutes as i64 * 60_000 {
            if let Some(j) = p.job_id.take() {
                let _ = self.queue.cancel(&j);
            }
            let m = format!("超過時間上限 {} 分鐘，已停止。完成的部分保留在工作樹中，可調整上限後按「繼續」。", p.config.max_minutes);
            return self.fail(p, &m);
        }
        // 1. a job is in flight
        if let Some(jid) = p.job_id.clone() {
            let job = match db::job_get(&self.conn(), &jid) {
                Ok(j) => j,
                Err(_) => {
                    p.job_id = None;
                    return self.store(&p);
                }
            };
            match job.status.as_str() {
                "queued" | "waiting_resource" | "running" | "interrupted" => {
                    // keep the UI's view fresh (active time) at most every 5 s
                    if now - p.data["lastSave"].as_i64().unwrap_or(0) > 5000 {
                        p.data["lastSave"] = json!(now);
                        self.store(&p);
                    }
                    return;
                }
                "succeeded" => {
                    p.job_id = None;
                    self.account_claude(&mut p, &job);
                    p.data["lastJob"] = json!(jid);
                    if p.mode == "fix" {
                        self.log(&p, "info", "修正完成，重新執行這個階段");
                        p.mode = "main".into();
                        p.action = 0;
                        p.data["fresh"] = json!(true);
                    } else {
                        p.action += 1;
                    }
                    self.store(&p);
                }
                "canceled" => {
                    p.job_id = None;
                    return self.fail(p, "工作被取消");
                }
                _ => {
                    // failed
                    p.job_id = None;
                    self.account_claude(&mut p, &job);
                    let text = self.job_failure_text(&job);
                    if let Some(limit) = (job.kind == "claude_in" || job.kind == "agent_cli").then(|| usage_limit(&text)).flatten() {
                        p.status = "paused_limit".into();
                        p.message = Some(limit);
                        self.log(&p, "warn", p.message.as_deref().unwrap_or(""));
                        (self.notify)("Pikara Science Studio：已暫停", p.message.as_deref().unwrap_or(""));
                        // the same action re-runs after the user resumes (not counted as an attempt)
                        if p.mode == "fix" {
                            p.data["pendingFix"] = json!(text);
                        }
                        return self.store(&p);
                    }
                    if (job.kind == "claude_in" || job.kind == "agent_cli") && is_transient(&text) && p.data["transient"].as_u64().unwrap_or(0) < 6 {
                        p.data["transient"] = json!(p.data["transient"].as_u64().unwrap_or(0) + 1);
                        p.not_before_ms = now + 5 * 60_000;
                        self.log(&p, "warn", "Claude 服務暫時忙碌，5 分鐘後重試（不計入嘗試次數）");
                        if p.mode == "fix" {
                            p.mode = "main".into();
                            p.data["pendingFix"] = json!(text);
                        }
                        return self.store(&p);
                    }
                    if p.mode == "fix" {
                        p.mode = "main".into();
                        return self.stage_failed(p, &format!("修正工作失敗：{text}"), true, false);
                    }
                    return self.stage_failed(p, &text, true, false);
                }
            }
        }
        if now < p.not_before_ms {
            return;
        }
        if let Some(text) = p.data.get("pendingFix").and_then(|v| v.as_str()).map(String::from) {
            p.data.as_object_mut().map(|m| m.remove("pendingFix"));
            return self.start_fix(p, &text);
        }
        // 2. next action of the current stage, or the next stage
        let acts = actions(&p);
        if p.action >= acts.len() {
            return self.next_stage(p);
        }
        match acts[p.action].clone() {
            Action::Job { kind, params } => {
                let root = match self.root(&p).and_then(|r| crate::jobs::job_root(&r, &params)) {
                    Ok(r) => r,
                    Err(e) => return self.stage_failed(p, &e, false, false),
                };
                match self.queue.enqueue(p.project_id.as_deref(), kind, &params, &root) {
                    Ok(j) => {
                        self.log(&p, "info", &format!("▶ {}", j.label));
                        p.job_id = Some(j.id);
                        self.mark_stage(&mut p, "running", None);
                        self.store(&p);
                    }
                    Err(e) => self.stage_failed(p, &e, false, false),
                }
            }
            Action::Agent { title, prompt } => self.wait_for_agent(p, &title, &prompt),
            Action::Inline(name) => {
                self.mark_stage(&mut p, "running", None);
                match self.inline(&mut p, name) {
                    Ok(()) => {
                        p.action += 1;
                        self.store(&p);
                    }
                    Err(Check::Fail(e)) => self.stage_failed(p, &e, true, true),
                    Err(Check::Hard(e)) => self.stage_failed(p, &e, false, false),
                    Err(Check::Retry(e)) => {
                        // revised by the reviewer itself: run the stage again (counts as an attempt, no fix job)
                        self.log(&p, "info", &e);
                        self.retry_or_give_up(p, &e, false, true)
                    }
                    Err(Check::Done(merged)) => self.finish(p, merged),
                }
            }
        }
    }

    fn account_claude(&self, p: &mut Production, job: &db::Job) {
        if job.kind != "claude_in" && job.kind != "agent_cli" {
            return;
        }
        p.claude_runs += 1;
        static RE_COST: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\[done\].*cost=\$([0-9.]+)").unwrap());
        if let Ok(evs) = db::events_list(&self.conn(), &job.id, 0, 1_000_000) {
            for e in evs.iter().rev() {
                if let Some(c) = RE_COST.captures(&e.line) {
                    p.claude_cost_usd += c[1].parse::<f64>().unwrap_or(0.0);
                    break;
                }
            }
        }
    }

    fn job_failure_text(&self, job: &db::Job) -> String {
        let evs = db::events_list(&self.conn(), &job.id, 0, 1_000_000).unwrap_or_default();
        let tail: Vec<String> = evs.iter().filter(|e| e.stream != "system" || e.level == "error").rev().take(60).map(|e| e.line.clone()).collect::<Vec<_>>().into_iter().rev().collect();
        format!("{}\n--- 日誌最後 {} 行 ---\n{}", job.error.clone().unwrap_or_default(), tail.len(), tail.join("\n"))
    }

    fn mark_stage(&self, p: &mut Production, status: &str, note: Option<String>) {
        let stage = p.stage.clone();
        let attempt = p.attempt;
        if let Some(s) = p.stages.iter_mut().find(|s| s.id == stage) {
            if s.status != status {
                if status == "running" && s.started_at.is_none() {
                    s.started_at = Some(now_iso());
                }
                if ["done", "warned", "failed"].contains(&status) {
                    s.finished_at = Some(now_iso());
                }
                s.status = status.into();
            }
            s.attempts = attempt;
            if note.is_some() {
                s.note = note;
            }
        }
    }

    fn next_stage(&self, mut p: Production) {
        // checkpoint
        if let (Ok(root), Some(w)) = (self.root(&p), p.worktree.clone()) {
            let wt = worktree_dir(&root, &w);
            if wt.exists() && p.stage != "deliver" {
                if let Some(sha) = checkpoint(&wt, &format!("auto({}): {} ✓", ep_upper(&p.episode), stage_label(&p.stage))) {
                    let st = p.stage.clone();
                    if let Some(s) = p.stages.iter_mut().find(|s| s.id == st) {
                        s.checkpoint = Some(sha);
                    }
                }
            }
        }
        let warned = p.stages.iter().find(|s| s.id == p.stage).map(|s| s.status == "warned").unwrap_or(false);
        if !warned {
            self.mark_stage(&mut p, "done", None);
        }
        self.log(&p, "info", &format!("✓ {}", stage_label(&p.stage)));
        let idx = STAGES.iter().position(|s| s.0 == p.stage).unwrap_or(0);
        let next = STAGES.iter().skip(idx + 1).find(|s| stage_enabled(s.0, &p.config)).map(|s| s.0);
        match next {
            Some(n) => {
                p.stage = n.into();
                p.action = 0;
                p.attempt = 1;
                p.mode = "main".into();
                p.data["fresh"] = json!(false);
                p.data["transient"] = json!(0);
                p.data.as_object_mut().map(|m| m.remove("voiceOnly"));
                self.store(&p);
            }
            None => self.finish(p, true),
        }
    }

    /// A stage failed: fix job (when the stage has a fixer and `fixable`), else re-run; give up after max attempts.
    fn stage_failed(&self, p: Production, err: &str, fixable: bool, from_check: bool) {
        self.log(&p, "error", &format!("✗ {}（第 {}/{} 次）：{}", stage_label(&p.stage), p.attempt, p.config.max_attempts, first_line(err)));
        let detail: String = err.lines().skip(1).filter(|l| !l.trim().is_empty()).take(24).collect::<Vec<_>>().join("\n");
        if !detail.is_empty() {
            self.log(&p, "info", &detail.chars().take(2000).collect::<String>());
        }
        self.retry_or_give_up(p, err, fixable, from_check)
    }

    /// `from_check`: the stage's own work succeeded but a quality check did not (QA, pronunciation, review).
    fn retry_or_give_up(&self, mut p: Production, err: &str, fixable: bool, from_check: bool) {
        let (fixer, soft) = stage_meta(&p.stage);
        // checks may end with a warning; a crashed render / TTS stops the production (there would be no output)
        let soft_here = soft && (from_check || ["animate", "visual", "thumbnail", "publish"].contains(&p.stage.as_str()));
        if p.attempt >= p.config.max_attempts {
            if soft_here {
                return self.give_up_soft(p, err);
            }
            let m = format!("「{}」重試 {} 次仍失敗：{}", stage_label(&p.stage), p.config.max_attempts, first_line(err));
            return self.fail(p, &m);
        }
        p.attempt += 1;
        if fixable && fixer != Fixer::None {
            return self.start_fix(p, err);
        }
        p.action = 0;
        p.mode = "main".into();
        p.data["fresh"] = json!(true);
        self.mark_stage(&mut p, "running", None);
        self.store(&p);
    }

    fn start_fix(&self, mut p: Production, err: &str) {
        let (fixer, _) = stage_meta(&p.stage);
        if p.stage == "voice" {
            // re-voice only the lines that were flagged
            if let Some(ids) = p.data["badLines"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" ")) {
                p.data["voiceOnly"] = json!(ids);
            }
        }
        let action = with_base(ai(&p, &format!("修正：{}", stage_label(&p.stage)), &prompt_fix(&p, fixer, err), TOOLS_CODE), &p);
        let (kind, params) = match action {
            Action::Job { kind, params } => (kind, params),
            Action::Agent { title, prompt } => {
                p.mode = "fix".into();
                return self.wait_for_agent(p, &title, &prompt);
            }
            Action::Inline(_) => unreachable!(),
        };
        let root = match self.root(&p).and_then(|r| crate::jobs::job_root(&r, &params)) {
            Ok(r) => r,
            Err(e) => return self.fail(p, &e),
        };
        match self.queue.enqueue(p.project_id.as_deref(), kind, &params, &root) {
            Ok(j) => {
                self.log(&p, "info", &format!("▶ 交給 {} 修正（{}）", agent_name(&p.config.agent), j.label));
                p.mode = "fix".into();
                p.job_id = Some(j.id);
                self.store(&p);
            }
            Err(e) => self.fail(p, &e),
        }
    }

    fn give_up_soft(&self, mut p: Production, err: &str) {
        let msg = format!("「{}」在 {} 次嘗試後仍未完全通過，繼續製作：{}", stage_label(&p.stage), p.config.max_attempts, first_line(err));
        self.log(&p, "warn", &msg);
        if ["animate", "visual"].contains(&p.stage.as_str()) {
            // code changed by this stage may be broken: go back to the previous checkpoint
            // (animate → generic narration template; visual → the code as it was before the review)
            if let (Ok(root), Some(w)) = (self.root(&p), p.worktree.clone()) {
                let wt = worktree_dir(&root, &w);
                let idx = p.stages.iter().position(|s| s.id == p.stage).unwrap_or(0);
                let cp = p.stages[..idx].iter().rev().find_map(|s| s.checkpoint.clone());
                if let Some(cp) = cp {
                    let _ = git(&wt, &["reset", "--hard", "-q", &cp]);
                    let _ = git(&wt, &["clean", "-fdq", "--", "src"]);
                    self.log(&p, "warn", &format!("已還原到上一個檢查點 {cp}{}", if p.stage == "animate" { "，改用通用旁白樣板" } else { "" }));
                }
            }
        }
        p.warnings.push(msg.clone());
        self.mark_stage(&mut p, "warned", Some(first_line(err)));
        p.action = usize::MAX; // stage over → next_stage
        self.store(&p);
    }

    fn fail(&self, mut p: Production, msg: &str) {
        p.status = "failed".into();
        p.finished_at = Some(now_iso());
        p.message = Some(format!("{msg}\n專案本身沒有任何改變（所有修改都在隔離工作樹 {}）。可按「繼續」重試這個階段，或按「捨棄」回復。", p.worktree.clone().unwrap_or_default()));
        self.mark_stage(&mut p, "failed", Some(first_line(msg)));
        self.log(&p, "error", msg);
        (self.notify)(&format!("Pikara Science Studio：{} 製作失敗", ep_upper(&p.episode)), &first_line(msg));
        self.store(&p);
    }

    fn finish(&self, mut p: Production, merged: bool) {
        p.finished_at = Some(now_iso());
        if merged {
            p.status = "succeeded".into();
            self.mark_stage(&mut p, "done", None);
            let w = if p.warnings.is_empty() { String::new() } else { format!("（{} 項警告，請檢視）", p.warnings.len()) };
            p.message = Some(format!("完成{w}。成品：{}。發布請自行到各平台手動上傳。", p.outputs.join("、")));
            (self.notify)(&format!("Pikara Science Studio：{} 製作完成", ep_upper(&p.episode)), &format!("{}{w}", p.config.topic));
        } else {
            p.status = "needs_merge".into();
            (self.notify)(&format!("Pikara Science Studio：{} 需要手動合併", ep_upper(&p.episode)), "成品已移到專案資料夾；原始碼合併時發生衝突。");
        }
        self.log(&p, "info", p.message.clone().unwrap_or_default().as_str());
        self.store(&p);
    }

    fn retry_deliver(&self, mut p: Production) -> Result<Production, String> {
        p.status = "running".into();
        p.stage = "deliver".into();
        p.action = 0;
        p.message = None;
        p.last_tick_ms = now_ms();
        self.store(&p);
        Ok(p)
    }

    // -------------------------------------------------------------- inline actions

    fn inline(&self, p: &mut Production, name: &str) -> Result<(), Check> {
        let root = self.root(p).map_err(Check::Hard)?;
        let wt = p.worktree.as_deref().map(|w| worktree_dir(&root, w));
        let E = ep_upper(&p.episode);
        match name {
            "prepare" => {
                let w = p.worktree.clone().unwrap_or_else(|| format!("auto-{}-{}", p.episode, &p.id[..8]));
                let br = format!("studio/auto/{}-{}", p.episode, &p.id[..8]);
                let info = prepare_worktree(&root, &w, &br).map_err(Check::Hard)?;
                p.worktree = Some(w);
                p.branch = Some(br);
                self.log(p, "info", &info);
                Ok(())
            }
            "check_script" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let r = check_script(&wt, &p.episode, p.config.minutes * p.config.tw_cps.unwrap_or(3.6) / 3.6).map_err(Check::Fail)?;
                self.log(p, "info", &r);
                Ok(())
            }
            "check_animate" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let reg = std::fs::read_to_string(wt.join("src/episode/registry.ts")).unwrap_or_default();
                if !Regex::new(&format!(r"(?m)^\s*{}\s*:", p.episode)).unwrap().is_match(&reg) {
                    return Err(Check::Fail(format!("src/episode/registry.ts 的 CUSTOM_ACTS 裡沒有 {}。", p.episode)));
                }
                Ok(())
            }
            "check_voice" => {
                if !p.config.pronunciation_check {
                    return Ok(());
                }
                let jid = p.data["lastJob"].as_str().unwrap_or("").to_string();
                let evs = db::events_list(&self.conn(), &jid, 0, 1_000_000).unwrap_or_default();
                let raw = bad_pronunciations(evs.iter().map(|e| e.line.as_str()), 0.15);
                // Raw CER also counts digits vs Chinese numerals and homophones written with other characters
                // ("16" vs 十六, 他/它, 占/站). Re-check those lines by pronunciation: pinyin error rate.
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let dir = wt.join("public/assets/audio/voiceover_cosy").join(&p.episode);
                let mut bad = vec![];
                let mut ok_after = 0;
                for (id, cer, _) in &raw {
                    let v: Value = std::fs::read_to_string(dir.join(format!("{id}.json"))).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
                    let speak = v["speak"].as_str().unwrap_or("");
                    let asr = v["alignment"]["asr"].as_str().unwrap_or("");
                    if speak.is_empty() || asr.is_empty() {
                        bad.push(format!("{id}  CER {cer:.3}（沒有辨識結果可比對）"));
                        continue;
                    }
                    let per = pron_error(speak, asr);
                    if per > MAX_PER {
                        bad.push(format!("{id}  讀音錯誤率 {per:.3}（CER {cer:.3}）\n    應念：{speak}\n    聽到：{asr}"));
                    } else {
                        ok_after += 1;
                    }
                }
                let ids: Vec<String> = bad.iter().map(|b| b.split_whitespace().next().unwrap_or("").to_string()).collect();
                if bad.is_empty() {
                    self.log(p, "info", &format!("發音檢查通過（{ok_after} 句的字元差異只是數字寫法或同音字，讀音相符）"));
                    return Ok(());
                }
                p.data["badLines"] = json!(ids);
                Err(Check::Fail(format!("{} 句讀音可能有誤（拼音比對錯誤率 > {MAX_PER}）：\n{}", bad.len(), bad.join("\n"))))
            }
            "plan_stills" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let frames = still_frames(&wt, &p.episode).map_err(Check::Hard)?;
                let comp = format!("{E}-30fps");
                let _ = std::fs::remove_dir_all(wt.join("out/stills"));
                let _ = std::fs::remove_file(wt.join("out/auto/review.json"));
                p.data["stillFrames"] = json!(frames.iter().map(|f| f.to_string()).collect::<Vec<_>>().join(","));
                p.data["stillFiles"] = json!(frames.iter().map(|f| format!("out/stills/{comp}-{f:05}.png")).collect::<Vec<_>>());
                Ok(())
            }
            "check_visual" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let v: Value = std::fs::read_to_string(wt.join("out/auto/review.json"))
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .ok_or(Check::Retry("審查沒有寫出 out/auto/review.json，重新審查".into()))?;
                let issues: Vec<String> = v["issues"].as_array().cloned().unwrap_or_default().iter().map(|i| format!("[{}] {} {}", i["severity"].as_str().unwrap_or("?"), i["file"].as_str().unwrap_or(""), i["problem"].as_str().unwrap_or(""))).collect();
                let _ = std::fs::create_dir_all(wt.join("out/auto"));
                let _ = std::fs::copy(wt.join("out/auto/review.json"), wt.join(format!("out/auto/review_{}.json", p.attempt)));
                let major = v["issues"].as_array().map(|a| a.iter().any(|i| i["severity"] == "major")).unwrap_or(false);
                let fixed = v["fixed"].as_bool().unwrap_or(false);
                // a major issue that was fixed in code must be looked at again on freshly rendered stills
                if v["pass"].as_bool().unwrap_or(false) && !(major && fixed) {
                    self.log(p, "info", &format!("畫面審查通過（{} 個次要問題）", issues.len()));
                    return Ok(());
                }
                let msg = format!("畫面審查發現問題{}：{}", if v["fixed"].as_bool().unwrap_or(false) { "，已修改程式，重新檢查" } else { "" }, issues.join("；"));
                if v["fixed"].as_bool().unwrap_or(false) {
                    Err(Check::Retry(msg))
                } else {
                    Err(Check::Fail(msg))
                }
            }
            "check_qa" => {
                let jid = p.data["lastJob"].as_str().unwrap_or("").to_string();
                let evs = db::events_list(&self.conn(), &jid, 0, 1_000_000).unwrap_or_default();
                match qa_problems(evs.iter().map(|e| e.line.as_str())) {
                    Some(0) => {
                        self.log(p, "info", "自動 QA：0 項問題");
                        Ok(())
                    }
                    Some(n) => {
                        let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                        let report = latest_qa_report(&wt);
                        Err(Check::Fail(format!("自動 QA 檢出 {n} 項問題。\n{report}")))
                    }
                    None => Err(Check::Fail("找不到 QA 結果（qa_video.py 沒有輸出問題數）".into())),
                }
            }
            "copy_thumb_tw" | "copy_thumb_cn" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let src = wt.join(format!("out/stills/{E}-Thumbnail-00000.png"));
                let dst = wt.join(if name == "copy_thumb_tw" { format!("{E}_YouTube_zh-TW_Thumbnail.png") } else { format!("{E}_Bilibili_zh-CN_Thumbnail.png") });
                std::fs::copy(&src, &dst).map_err(|e| Check::Fail(format!("封面沒有產生（{}）：{e}", clean_path(&src))))?;
                if name == "copy_thumb_tw" && !p.config.bilibili {
                    let _ = std::fs::copy(&src, wt.join(format!("{E}_Thumbnail.png")));
                }
                Ok(())
            }
            "check_publish" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let f = wt.join(format!("{E}_PUBLISH_METADATA.md"));
                match std::fs::read_to_string(&f) {
                    Ok(s) if s.contains("YouTube") && s.chars().count() > 200 => Ok(()),
                    _ => Err(Check::Fail(format!("{E}_PUBLISH_METADATA.md 沒有寫出或內容不完整"))),
                }
            }
            "deliver" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let (outputs, merged, note) = deliver(&root, &wt, p).map_err(Check::Hard)?;
                p.outputs = outputs;
                self.log(p, if merged { "info" } else { "warn" }, &note);
                if merged {
                    let w = p.worktree.clone().unwrap_or_default();
                    match remove_worktree(&root, &w, true) {
                        Ok(()) => p.worktree = None,
                        Err(e) => self.log(p, "warn", &format!("工作樹清除失敗（可稍後按「捨棄」）：{e}")),
                    }
                } else {
                    p.message = Some(note);
                }
                Err(Check::Done(merged))
            }
            other => Err(Check::Hard(format!("unknown inline action {other}"))),
        }
    }
}

enum Check {
    /// fixable failure (fix job, then the stage re-runs)
    Fail(String),
    /// environment / internal failure (re-run without a fix job)
    Hard(String),
    /// the reviewer already changed files: re-run the stage
    Retry(String),
    /// production finished (merged or needs manual merge)
    Done(bool),
}

fn first_line(s: &str) -> String {
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

fn is_transient(text: &str) -> bool {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)(overloaded|529|503 service|ECONNRESET|ETIMEDOUT|socket hang up|network error|api_error)").unwrap());
    RE.is_match(text)
}

/// Pronunciation error rate above which a line is re-voiced.
pub const MAX_PER: f64 = 0.12;

const DIGITS: [&str; 10] = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

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

fn latest_qa_report(wt: &Path) -> String {
    let dir = wt.join("out/qa");
    let newest = std::fs::read_dir(&dir).ok().and_then(|rd| rd.flatten().filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false)).max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok()));
    newest.and_then(|e| std::fs::read_to_string(e.path()).ok()).map(|s| clip(&s, 4000)).unwrap_or_default()
}

/// Script checks: valid narration, the episode exists with ≥ 2 scenes, length near target, sources file with URLs.
pub fn check_script(wt: &Path, ep: &str, minutes: f64) -> Result<String, String> {
    let r = crate::narration::read(wt, "zh-TW")?;
    let doc = &r["doc"];
    let v = crate::narration::validate(doc);
    let errs: Vec<String> = v.errors.iter().filter(|e| e.seq_key == ep || e.seq_key.is_empty()).map(|e| format!("{} {} {}：{}", e.scene_id.clone().unwrap_or_default(), e.line_id.clone().unwrap_or_default(), e.field, e.message)).collect();
    if !errs.is_empty() {
        return Err(format!("narration.json 驗證失敗：\n{}", errs.join("\n")));
    }
    let seq = doc["sequences"].get(ep).ok_or(format!("narration.json 裡沒有 sequences.{ep}"))?;
    let scenes = seq["scenes"].as_array().cloned().unwrap_or_default();
    if scenes.len() < 2 {
        return Err(format!("{ep} 只有 {} 個場景，至少需要 2 個", scenes.len()));
    }
    let chars: usize = scenes
        .iter()
        .flat_map(|s| s["lines"].as_array().cloned().unwrap_or_default())
        .map(|l| crate::narration::norm(l["speak"].as_str().filter(|s| !s.trim().is_empty()).or(l["subtitle"].as_str()).unwrap_or("")).chars().count())
        .sum();
    let target = minutes * 60.0 * 3.6;
    let ratio = chars as f64 / target;
    if !(0.6..=1.5).contains(&ratio) {
        return Err(format!("旁白共 {chars} 字，目標約 {:.0} 字（{minutes} 分鐘）。請{}到目標的 ±15% 內。", target, if ratio < 1.0 { "增加內容" } else { "精簡" }));
    }
    for k in ["title"] {
        if seq[k].as_str().map(|s| s.trim().is_empty()).unwrap_or(true) {
            return Err(format!("sequences.{ep}.{k} 是空的"));
        }
    }
    let src = wt.join(format!("{}_SOURCES.md", ep_upper(ep)));
    let s = std::fs::read_to_string(&src).map_err(|_| format!("沒有 {}（資料來源清單）", clean_path(&src)))?;
    let urls = Regex::new(r"https?://[^\s)>\]]+").unwrap().find_iter(&s).count();
    if urls < 3 {
        return Err(format!("{} 只有 {urls} 個網址，至少需要 3 個真實來源", ep_upper(ep) + "_SOURCES.md"));
    }
    Ok(format!("劇本檢查通過：{} 個場景、{chars} 字（目標 {:.0}）、{urls} 個來源網址", scenes.len(), target))
}

/// One 30 fps frame per scene: just after the scene's last anchor fires (all cards on screen), else mid-scene.
pub fn still_frames(wt: &Path, ep: &str) -> Result<Vec<u64>, String> {
    let tl: Value = serde_json::from_str(&std::fs::read_to_string(wt.join("src/data/timeline.generated.json")).map_err(|e| format!("讀不到時間軸：{e}"))?)
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

// ------------------------------------------------------------------ git / filesystem

fn checkpoint(wt: &Path, msg: &str) -> Option<String> {
    let _ = git(wt, &["add", "-A"]);
    let staged = git(wt, &["diff", "--cached", "--quiet"]).map(|o| !o.ok()).unwrap_or(false);
    if staged {
        let _ = studio_commit(wt, msg);
    }
    git(wt, &["rev-parse", "--short", "HEAD"]).ok().filter(|o| o.ok()).map(|o| o.stdout.trim().to_string())
}

fn studio_commit(dir: &Path, msg: &str) -> Result<crate::util::RunOut, String> {
    crate::util::run_env(
        "git",
        &["commit", "-q", "-m", msg],
        Some(dir),
        &[("GIT_AUTHOR_NAME", "Pikara Studio (Auto)"), ("GIT_AUTHOR_EMAIL", "studio@pikara.local"), ("GIT_COMMITTER_NAME", "Pikara Studio"), ("GIT_COMMITTER_EMAIL", "studio@pikara.local")],
        Duration::from_secs(120),
    )
}

/// Paths inside a worktree that are linked (directory junctions) to the main project instead of copied.
const LINKS: [&str; 2] = ["node_modules", r"tools\CosyVoice"];

fn prepare_worktree(root: &Path, wid: &str, branch: &str) -> Result<String, String> {
    let wt = worktree_dir(root, wid);
    crate::claude::ensure_excluded(root)?;
    let dirty = gitops::status(root).dirty;
    if !wt.join(".git").exists() {
        let o = git(root, &["worktree", "add", "--quiet", &wt.to_string_lossy(), "-b", branch, "HEAD"])?;
        if !o.ok() {
            return Err(format!("建立工作樹失敗：{}", o.combined()));
        }
    }
    let mut linked = vec![];
    for rel in LINKS {
        let target = root.join(rel);
        let link = wt.join(rel);
        if target.exists() && !link.exists() {
            if let Some(par) = link.parent() {
                std::fs::create_dir_all(par).map_err(|e| e.to_string())?;
            }
            let (l, t) = (link.to_string_lossy().to_string(), target.to_string_lossy().to_string());
            let o = run("cmd", &["/d", "/c", "chcp", "65001", ">nul", "&", "mklink", "/J", &l, &t], None, Duration::from_secs(30))?;
            if !o.ok() {
                return Err(format!("無法建立目錄連結 {rel}：{}", o.combined()));
            }
            linked.push(rel);
        }
    }
    // the project Skill tells Claude how the pipeline works; new projects may not have it committed
    let skill = wt.join(crate::claude::SKILL_REL);
    if !skill.exists() {
        crate::claude::install_skill(&wt, false)?;
        linked.push("（已安裝 pikara-video Skill）");
    }
    // ignored files the pipeline needs (fonts etc.): copy
    let mut copied = 0;
    if let Ok(o) = git(root, &["ls-files", "--others", "--ignored", "--exclude-standard", "--", "public/fonts"]) {
        for f in o.stdout.lines().filter(|l| !l.trim().is_empty()) {
            let (a, b) = (root.join(f), wt.join(f));
            if a.is_file() && !b.exists() {
                if let Some(par) = b.parent() {
                    let _ = std::fs::create_dir_all(par);
                }
                if std::fs::hard_link(&a, &b).or_else(|_| std::fs::copy(&a, &b).map(|_| ())).is_ok() {
                    copied += 1;
                }
            }
        }
    }
    Ok(format!(
        "工作樹 {}（分支 {branch}）；連結 {}；複製 {copied} 個被忽略的資源檔{}",
        clean_path(&wt),
        if linked.is_empty() { "無".into() } else { linked.join("、") },
        if dirty.is_empty() { String::new() } else { format!("。注意：專案有 {} 個未提交的修改，自動製作使用最後一次提交的版本", dirty.len()) }
    ))
}

/// Remove junctions first (so nothing is deleted through them), then the worktree, then (optionally) the branch.
pub fn remove_worktree(root: &Path, wid: &str, delete_branch: bool) -> Result<(), String> {
    let wt = worktree_dir(root, wid);
    for rel in LINKS {
        let l = wt.join(rel);
        if std::fs::symlink_metadata(&l).is_ok() {
            // RemoveDirectoryW on a junction removes the link itself, never the target's contents
            std::fs::remove_dir(&l).map_err(|e| format!("無法移除目錄連結 {}：{e}", clean_path(&l)))?;
        }
    }
    if wt.exists() {
        let _ = git(root, &["worktree", "remove", "--force", &wt.to_string_lossy()]);
    }
    if wt.exists() {
        std::fs::remove_dir_all(&wt).map_err(|e| format!("無法刪除 {}：{e}", clean_path(&wt)))?;
    }
    let _ = git(root, &["worktree", "prune"]);
    if delete_branch {
        let o = git(root, &["for-each-ref", "--format=%(refname:short)", "refs/heads/studio/auto/"])?;
        for b in o.stdout.lines().filter(|b| b.ends_with(&wid.trim_start_matches("auto-").to_string())) {
            let _ = git(root, &["branch", "-D", b]);
        }
    }
    Ok(())
}

/// Move the episode's finished files to the project root (never overwrite), commit the worktree, merge its branch.
fn deliver(root: &Path, wt: &Path, p: &Production) -> Result<(Vec<String>, bool, String), String> {
    let E = ep_upper(&p.episode);
    let re = Regex::new(&format!(r"^{E}(_.*)?\.(mp4|srt|png|md)$")).unwrap();
    let mut moved = vec![];
    let mut tracked_outputs = vec![];
    for e in std::fs::read_dir(wt).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !e.path().is_file() || !re.is_match(&name) || name.ends_with("_SOURCES.md") {
            continue;
        }
        let dst = root.join(&name);
        if dst.exists() {
            let same = std::fs::read(&dst).ok().zip(std::fs::read(e.path()).ok()).map(|(a, b)| a == b).unwrap_or(false);
            if !same {
                return Err(format!("專案資料夾已經有 {name}，內容不同，不會覆寫。請改名或移走後按「繼續」。"));
            }
            // delivered by an earlier (interrupted or conflicted) attempt: identical copy
            if !name.ends_with(".mp4") {
                // the merge brings tracked files; an identical untracked copy would block it
                let _ = std::fs::remove_file(&dst);
                tracked_outputs.push(name.clone());
            }
            moved.push(name);
            continue;
        }
        if name.ends_with(".mp4") {
            std::fs::rename(e.path(), &dst).or_else(|_| std::fs::copy(e.path(), &dst).map(|_| ())).map_err(|x| format!("移動 {name} 失敗：{x}"))?;
        } else {
            // text / image outputs are also committed with the branch; copy and let the merge bring them
            tracked_outputs.push(name.clone());
        }
        moved.push(name);
    }
    // QA reports
    let qa_dst = root.join("out/qa");
    let _ = std::fs::create_dir_all(&qa_dst);
    if let Ok(rd) = std::fs::read_dir(wt.join("out/qa")) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with(&E) {
                let _ = std::fs::copy(e.path(), qa_dst.join(e.file_name()));
            }
        }
    }
    checkpoint(wt, &format!("auto({E}): 交付 {}", p.config.topic.chars().take(40).collect::<String>()));
    let br = p.branch.clone().ok_or("沒有分支")?;
    let o = crate::util::run_env(
        "git",
        &["merge", "--no-ff", "--no-edit", "-m", &format!("Studio 自動製作 {E}：{}", p.config.topic.chars().take(60).collect::<String>()), &br],
        Some(root),
        &[("GIT_AUTHOR_NAME", "Pikara Studio (Auto)"), ("GIT_AUTHOR_EMAIL", "studio@pikara.local"), ("GIT_COMMITTER_NAME", "Pikara Studio"), ("GIT_COMMITTER_EMAIL", "studio@pikara.local")],
        Duration::from_secs(300),
    )?;
    let merged_ok = o.ok() || resolve_episode_conflicts(root, &p.episode).unwrap_or(false);
    if !merged_ok {
        let _ = git(root, &["merge", "--abort"]);
        // the main tree has no branch files: copy the non-mp4 outputs so the user still gets everything
        for n in &tracked_outputs {
            if !root.join(n).exists() {
                let _ = std::fs::copy(wt.join(n), root.join(n));
            }
        }
        return Ok((
            moved,
            false,
            format!(
                "成品已移到專案資料夾，但原始碼無法自動合併（專案在製作期間有其他修改）：{}\n分支 {br} 與工作樹保留；請在「提示詞」頁的工作樹清單檢視差異後手動合併，或解決衝突後按「繼續」。",
                first_line(&o.combined())
            ),
        ));
    }
    // list from the project root: a delivery that was interrupted and retried has already moved some files
    let mut all: Vec<String> = std::fs::read_dir(root)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| re.is_match(n)).collect())
        .unwrap_or_default();
    all.sort();
    Ok((all.clone(), true, format!("已合併 {br}，成品：{}", all.join("、"))))
}

/// Episode-aware conflict resolution for a merge in progress. Productions add a new key (`sequences.<ep>` in
/// narration.json, `<ep>` in timeline.generated.json, an entry in registry.ts); when the project gained another
/// episode meanwhile, git reports a textual conflict. Take the project's version and add this episode's entry.
/// Returns Ok(true) when every conflict was resolved and the merge commit was made.
fn resolve_episode_conflicts(root: &Path, ep: &str) -> Result<bool, String> {
    let o = git(root, &["diff", "--name-only", "--diff-filter=U"])?;
    let files: Vec<String> = o.stdout.lines().map(|l| l.trim().replace('\\', "/")).filter(|l| !l.is_empty()).collect();
    if files.is_empty() {
        return Ok(false);
    }
    let show = |stage: u8, f: &str| git(root, &["show", &format!(":{stage}:{f}")]).ok().filter(|o| o.ok()).map(|o| o.stdout);
    for f in &files {
        let resolved: String = match f.as_str() {
            "src/data/narration.json" | "src_cn/data/narration.json" | "src/data/timeline.generated.json" | "src_cn/data/timeline.generated.json" => {
                let (Some(ours), Some(theirs)) = (show(2, f), show(3, f)) else { return Ok(false) };
                let mut o: Value = serde_json::from_str(&ours).map_err(|e| e.to_string())?;
                let t: Value = serde_json::from_str(&theirs).map_err(|e| e.to_string())?;
                let base = show(1, f).and_then(|b| serde_json::from_str::<Value>(&b).ok());
                let (o_map, t_map, b_map) = if f.ends_with("narration.json") {
                    (o.get_mut("sequences"), t.get("sequences"), base.as_ref().and_then(|b| b.get("sequences")))
                } else {
                    (Some(&mut o), Some(&t), base.as_ref())
                };
                let (Some(o_map), Some(t_map)) = (o_map.and_then(|v| v.as_object_mut()), t_map.and_then(|v| v.as_object())) else { return Ok(false) };
                // only safe when the branch changed nothing but its own episode
                for (k, v) in t_map {
                    let base_v = b_map.and_then(|b| b.get(k));
                    if k != ep && base_v != Some(v) {
                        return Ok(false);
                    }
                }
                match t_map.get(ep) {
                    Some(v) => {
                        o_map.insert(ep.to_string(), v.clone());
                    }
                    None => return Ok(false),
                }
                crate::narration::serialize_like(&o, &ours)?
            }
            "src/episode/registry.ts" | "src_cn/episode/registry.ts" => {
                // imports + CUSTOM_ACTS entries are line additions on both sides: union merge keeps both
                let dir = std::env::temp_dir().join(format!("pikara-merge-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let mut paths = vec![];
                for (i, st) in [2u8, 1, 3].iter().enumerate() {
                    let pth = dir.join(format!("{i}.ts"));
                    std::fs::write(&pth, show(*st, f).unwrap_or_default()).map_err(|e| e.to_string())?;
                    paths.push(pth.to_string_lossy().to_string());
                }
                let r = git(root, &["merge-file", "-p", "--union", &paths[0], &paths[1], &paths[2]])?;
                let _ = std::fs::remove_dir_all(&dir);
                if r.stdout.is_empty() {
                    return Ok(false);
                }
                r.stdout
            }
            _ => return Ok(false),
        };
        std::fs::write(root.join(f), resolved).map_err(|e| e.to_string())?;
        git(root, &["add", "--", f])?;
    }
    let c = crate::util::run_env(
        "git",
        &["commit", "--no-edit", "-q"],
        Some(root),
        &[("GIT_AUTHOR_NAME", "Pikara Studio (Auto)"), ("GIT_AUTHOR_EMAIL", "studio@pikara.local"), ("GIT_COMMITTER_NAME", "Pikara Studio"), ("GIT_COMMITTER_EMAIL", "studio@pikara.local")],
        Duration::from_secs(120),
    )?;
    Ok(c.ok())
}

// ------------------------------------------------------------------ background thread

pub fn spawn(ap: Arc<Autopilot>) {
    std::thread::Builder::new()
        .name("studio-autopilot".into())
        .spawn(move || loop {
            ap.tick();
            std::thread::sleep(Duration::from_secs(2));
        })
        .expect("autopilot thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_and_billing_rules() {
        let mut c = AutoConfig { topic: "什麼是量化".into(), ..Default::default() };
        c.validate().unwrap();
        assert_eq!(c.billing, "subscription");
        assert_eq!(c.budget_usd, None, "subscription mode has no USD cap by default");
        let mut c2 = AutoConfig { topic: "x".into(), ..Default::default() };
        assert!(c2.validate().is_err());
        let mut api = AutoConfig { topic: "量化".into(), billing: "api".into(), ..Default::default() };
        assert!(api.validate().unwrap_err().contains("美元上限"));
        api.budget_usd = Some(3.0);
        api.validate().unwrap();
        let mut sub = AutoConfig { topic: "量化".into(), budget_usd: Some(5.0), ..Default::default() };
        sub.validate().unwrap();
        assert_eq!(sub.budget_usd, None);
    }

    #[test]
    fn limit_and_login_detection() {
        assert!(usage_limit("Claude AI usage limit reached|1763600000").unwrap().contains("額度"));
        assert!(usage_limit("You've hit your limit · resets 5pm (Asia/Taipei)").unwrap().contains("resets 5pm"));
        assert!(usage_limit("Invalid API key · Please run /login").unwrap().contains("登入"));
        assert!(usage_limit("步驟「渲染」失敗：區段 0–1799 失敗").is_none());
        assert!(is_transient("API Error: 529 {\"type\":\"overloaded_error\"}"));
    }

    #[test]
    fn pronunciation_and_qa_parsing() {
        let l = ["  ≡ ep04-s01-01 對上 20/20 字  CER 0.000", "  ≡ ep04-s01-02 對上 14/20 字  CER 0.300", "  ≡ ep04-s02-01 對上 19/20 字  CER 0.050"];
        let b = bad_pronunciations(l.iter().copied(), 0.15);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].0, "ep04-s01-02");
        assert_eq!(qa_problems(["x", "自動檢出需注意的問題：**2**（長時間…）"].iter().copied()), Some(2));
        assert_eq!(qa_problems(["自動檢出需注意的問題：**0**（…）"].iter().copied()), Some(0));
        assert_eq!(qa_problems(["nothing"].iter().copied()), None);
    }

    #[test]
    fn pronunciation_ignores_digits_and_homophones() {
        assert_eq!(cn_number(16), "十六");
        assert_eq!(cn_number(70), "七十");
        assert_eq!(cn_number(105), "一百零五");
        assert_eq!(cn_number(2026), "二千零二十六");
        assert_eq!(cn_number(7_000_000_000), "七十億");
        assert_eq!(cn_number(100_000), "十萬");
        assert_eq!(cn_number(10_005), "一萬零五");
        // real EP04 cases: Whisper wrote digits / homophones although the voice was right
        assert!(pron_error("用常見的十六位元格式存，每個參數大約占兩個位元組。", "用常見的16位元格式存每個參數大約佔兩個位元主") < MAX_PER);
        assert!(pron_error("一個七十億參數的模型，光是參數就要大約十四 G B。", "一個70億參數的模型光是參數這要大約14gb") < MAX_PER);
        assert_eq!(pron_error("對話越長，它占的空間就越大。", "對話越長他站的空間就越大"), 0.0);
        assert!(pron_error("改成四位元，參數占的空間大約只剩四分之一。", "改成四位原參數佔的空間大也只剩四分之一") < MAX_PER);
        // a real misreading is still caught
        assert!(pron_error("模型能不能整個放上工作桌", "模型能不能整個放上公主") > MAX_PER);
    }

    #[test]
    fn stage_plan_follows_config() {
        let mut p = Production { episode: "ep04".into(), worktree: Some("auto-ep04-abcd1234".into()), attempt: 1, ..Default::default() };
        p.config = AutoConfig { topic: "量化".into(), style: "generic".into(), bilibili: false, ..Default::default() };
        assert!(!stage_enabled("animate", &p.config) && !stage_enabled("bilibili", &p.config));
        p.stage = "final".into();
        let a = actions(&p);
        assert!(matches!(&a[0], Action::Job { kind: "typecheck", .. }), "typecheck before every render");
        match &a[1] {
            Action::Job { kind, params } => {
                assert_eq!(*kind, "final_tw");
                assert_eq!(params["workdir"], "auto-ep04-abcd1234");
                assert_eq!(params["episode"], "ep04");
                assert_eq!(params["fresh"], false);
            }
            _ => panic!(),
        }
        p.attempt = 2;
        match &actions(&p)[1] {
            Action::Job { params, .. } => assert_eq!(params["fresh"], true, "re-render after a fix"),
            _ => panic!(),
        }
        p.stage = "script".into();
        match &actions(&p)[0] {
            Action::Job { kind, params } => {
                assert_eq!(*kind, "claude_in");
                assert!(params["tools"].as_str().unwrap().contains("WebSearch"));
                assert_eq!(params["billing"], "subscription");
                assert!(params["prompt"].as_str().unwrap().contains("ep04"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn episode_allocation_never_reuses() {
        let d = std::env::temp_dir().join(format!("pss-auto-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("src/data")).unwrap();
        std::fs::write(d.join("src/data/narration.json"), r#"{"sequences":{"ep01":{"scenes":[]},"ep02":{"scenes":[]}}}"#).unwrap();
        std::fs::write(d.join("EP05_Final.mp4"), b"x").unwrap();
        let c = db::open_memory().unwrap();
        assert_eq!(allocate_episode(&c, &d).unwrap(), "ep06");
        let p = Production { id: "p1".into(), episode: "ep06".into(), status: "queued".into(), created_at: now_iso(), ..Default::default() };
        save(&c, &p).unwrap();
        assert_eq!(allocate_episode(&c, &d).unwrap(), "ep07");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn script_check_messages() {
        let d = std::env::temp_dir().join(format!("pss-auto-s-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("src/data")).unwrap();
        let line = |i: usize| json!({"id": format!("ep04-{i}"), "subtitle": "這是一句長度大約二十個字的測試旁白內容喔"});
        let doc = json!({"sequences": {"ep04": {"title": "量化", "scenes": [
            {"id": "s01", "title": "a", "lines": (0..10).map(line).collect::<Vec<_>>()},
            {"id": "s02", "title": "b", "lines": (10..20).map(line).collect::<Vec<_>>()}]}}});
        std::fs::write(d.join("src/data/narration.json"), serde_json::to_string_pretty(&doc).unwrap()).unwrap();
        // 20 lines × 20 chars = 400 chars ≈ 1.85 min
        assert!(check_script(&d, "ep04", 1.8).unwrap_err().contains("SOURCES"));
        std::fs::write(d.join("EP04_SOURCES.md"), "- https://a.example/1\n- https://b.example/2\n- https://c.example/3\n").unwrap();
        assert!(check_script(&d, "ep04", 1.8).unwrap().contains("劇本檢查通過"));
        assert!(check_script(&d, "ep04", 5.0).unwrap_err().contains("增加內容"));
        assert!(check_script(&d, "ep09", 1.8).unwrap_err().contains("沒有 sequences.ep09"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
