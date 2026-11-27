//! Production configuration, persisted production state and the stage table.

use super::*;

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
    // ---------------------------------------------------------- v0.2.1 content control (see content.rs)
    /// "auto" 全自主 | "guided" 指導 | "script" 自訂腳本
    pub mode: String,
    /// 影片內容與製作要求 (Markdown).
    pub brief: String,
    /// Custom chapters, in order (guided / script modes: one scene each).
    pub chapters: Vec<String>,
    pub must_include: String,
    pub must_avoid: String,
    pub opening: String,
    pub ending: String,
    pub voice_tone: String,
    pub animation_style: String,
    pub pacing: String,
    /// Script mode: the complete script (Markdown; `## ` headings = scenes). Filled from a `script` asset if empty.
    pub script_text: String,
    /// "zh-TW" | "zh-CN" | "both" | "en" (empty in productions made before v0.2.1 → derived from `bilibili`).
    pub language: String,
    /// Minimum number of source URLs in <EP>_SOURCES.md (None = 3, or 0 in script mode).
    pub min_sources: Option<u32>,
    /// Imported material (copied into the video's assets folder at start).
    pub assets: Vec<crate::assets::Asset>,
    /// Sandbox test: TEST number, delivered to sandbox/TESTnnn, never merged into the project.
    pub sandbox: bool,
    // ---------------------------------------------------------- v0.3.2 擬人化科普
    /// 敘事方式："auto"（預設：AI 依主題判斷哪些技術概念適合擬人化）| "personified"（一定使用擬人化角色）| "plain"（不使用）
    pub narrative: String,
    /// 使用者指定的角色（選填）。空白 = 由 AI 決定角色；有填時 AI 必須沿用這些角色的設定。
    pub characters: Vec<Character>,
}

/// 擬人化角色。外觀與性格寫進 narration.json 的 `sequences.<ep>.characters`，動畫與配音都依它保持一致。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Character {
    /// 角色名稱（例：CPU 大廚）
    pub name: String,
    /// 代表的技術概念（例：CPU）
    pub concept: String,
    /// 外觀（顏色、形狀、配件）
    pub look: String,
    /// 性格與說話方式
    pub personality: String,
    /// 參考人聲：tools/CosyVoice/reference 下的檔名（不含副檔名，空白 = 旁白人聲）
    pub voice: String,
    /// 音高（半音，-6～6；0 = 不變）
    pub pitch: f64,
}

pub const NARRATIVES: [&str; 3] = ["auto", "personified", "plain"];

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
            mode: "auto".into(),
            brief: String::new(),
            chapters: vec![],
            must_include: String::new(),
            must_avoid: String::new(),
            opening: String::new(),
            ending: String::new(),
            voice_tone: String::new(),
            animation_style: String::new(),
            pacing: String::new(),
            script_text: String::new(),
            language: "zh-TW".into(),
            min_sources: None,
            assets: vec![],
            sandbox: false,
            narrative: "auto".into(),
            characters: vec![],
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
        for s in [&mut self.tone, &mut self.audience, &mut self.notes, &mut self.must_include, &mut self.must_avoid, &mut self.opening, &mut self.ending, &mut self.voice_tone, &mut self.animation_style, &mut self.pacing] {
            *s = s.trim().chars().take(4000).collect();
        }
        if self.mode.is_empty() {
            self.mode = "auto".into();
        }
        if !crate::content::MODES.contains(&self.mode.as_str()) {
            return Err(format!("mode 必須是 auto、guided 或 script：{}", self.mode));
        }
        if self.language.is_empty() {
            self.language = if self.bilibili { "both".into() } else { "zh-TW".into() };
        }
        if !crate::content::LANGS.contains(&self.language.as_str()) {
            return Err(format!("language 必須是 zh-TW、zh-CN、both 或 en：{}", self.language));
        }
        // platform switches follow the language (no zh-TW render for a Simplified-only video, etc.)
        match self.language.as_str() {
            "en" => {
                self.youtube = false;
                self.bilibili = false;
            }
            "zh-TW" => self.bilibili = false,
            "zh-CN" => {
                self.youtube = false;
                self.bilibili = true;
            }
            "both" => self.bilibili = true,
            _ => self.bilibili = false,
        }
        if self.brief.chars().count() > 20000 {
            return Err("「影片內容與製作要求」最多 20000 字".into());
        }
        if self.script_text.chars().count() > 60000 {
            return Err("自訂腳本最多 60000 字".into());
        }
        self.chapters = self.chapters.iter().map(|c| c.trim().chars().take(60).collect::<String>()).filter(|c| !c.is_empty()).take(20).collect();
        if let Some(n) = self.min_sources {
            self.min_sources = Some(n.min(20));
        }
        if self.narrative.is_empty() {
            self.narrative = "auto".into();
        }
        if !NARRATIVES.contains(&self.narrative.as_str()) {
            return Err(format!("narrative 必須是 auto、personified 或 plain：{}", self.narrative));
        }
        let clip = |s: &str, n: usize| s.trim().chars().take(n).collect::<String>();
        self.characters = self
            .characters
            .iter()
            .map(|c| Character {
                name: clip(&c.name, 20),
                concept: clip(&c.concept, 40),
                look: clip(&c.look, 300),
                personality: clip(&c.personality, 300),
                voice: clip(&c.voice, 40),
                pitch: if c.pitch.is_finite() { c.pitch.clamp(-6.0, 6.0) } else { 0.0 },
            })
            .filter(|c| !c.name.is_empty() || !c.concept.is_empty())
            .take(6)
            .collect();
        for c in &self.characters {
            if !c.voice.is_empty() && !c.voice.chars().all(|ch| ch.is_ascii_alphanumeric() || "-_".contains(ch)) {
                return Err(format!("角色「{}」的參考人聲名稱只能使用英數字、- 與 _：{}", c.name, c.voice));
            }
        }
        if self.narrative == "plain" {
            self.characters.clear();
        }
        Ok(())
    }

    /// 這部影片會不會使用擬人化角色：plain 不會；personified 一定會；auto 由 AI 判斷（指定了角色時視為會）。
    pub fn narrative_mode(&self) -> &str {
        match self.narrative.as_str() {
            "plain" => "plain",
            "personified" => "personified",
            _ if !self.characters.is_empty() => "personified",
            _ => "auto",
        }
    }

    /// Script mode needs the script (pasted, or a `script` asset — checked again after import).
    pub fn require_script(&self) -> Result<(), String> {
        if self.mode == "script" && self.script_text.trim().chars().count() < 10 {
            return Err("自訂腳本模式需要完整腳本：貼上腳本，或匯入一個「自訂腳本」素材（TXT／Markdown）".into());
        }
        Ok(())
    }

    pub fn min_sources(&self) -> u32 {
        self.min_sources.unwrap_or(if self.mode == "script" { 0 } else { 3 })
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

pub(crate) const ACTIVE: [&str; 5] = ["queued", "running", "paused", "paused_limit", "waiting_agent"];

// ------------------------------------------------------------------ stages

pub const STAGES: [(&str, &str); 12] = [
    ("prepare", "準備（分配集數、建立隔離工作樹）"),
    ("script", "資料研究與劇本"),
    ("animate", "動畫程式（Claude 撰寫）"),
    ("voice", "配音與發音檢查"),
    ("timeline", "時間軸與字幕"),
    ("visual", "畫面檢查（關鍵幀＋AI 審查）"),
    ("final", "正式版渲染＋QA"),
    ("youtube", "YouTube 1.5× 版"),
    ("bilibili", "Bilibili 簡中版"),
    ("thumbnail", "封面"),
    ("publish", "上架資訊"),
    ("deliver", "交付（合併、移出成品）"),
];

pub(crate) fn stage_enabled(id: &str, c: &AutoConfig) -> bool {
    match id {
        "animate" => c.style == "ai",
        "visual" => c.visual_review,
        // YouTube 1.5× is a zh-TW variant; "Bilibili" as a separate stage only converts a zh-TW master ("both").
        // zh-CN only renders the Simplified video in the "final" stage — no Traditional render at all.
        "youtube" => c.youtube && content::wants_tw(c),
        "bilibili" => content::lang(c) == "both",
        "thumbnail" => c.thumbnail,
        "publish" => c.publish_info,
        _ => true,
    }
}

/// Stage label for this production's language.
pub fn stage_label_for(id: &str, c: &AutoConfig) -> String {
    match (id, content::lang(c)) {
        ("final", "zh-CN") => "簡中正式版渲染＋QA（Bilibili，直接使用簡中腳本）".into(),
        ("final", "en") => "英文正式版渲染＋QA".into(),
        ("bilibili", _) => "Bilibili 簡中版（由繁中稿轉換）".into(),
        _ => stage_label(id).to_string(),
    }
}

pub(crate) fn stage_label(id: &str) -> &'static str {
    STAGES.iter().find(|s| s.0 == id).map(|s| s.1).unwrap_or("?")
}
