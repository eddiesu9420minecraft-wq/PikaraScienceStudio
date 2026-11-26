//! Stage → actions plan (queued jobs, AI runs, inline checks) and Claude job parameters.

use super::*;

#[derive(Debug, Clone)]
pub(crate) enum Action {
    Job { kind: &'static str, params: Value },
    Inline(&'static str),
    /// AI work for an external agent (agent = "external"): Studio waits in `waiting_agent` until `agent_done`.
    Agent { title: String, prompt: String },
}

/// The AI step of a stage, for the configured provider. Claude Code and the 豆包 CLI run as queue jobs inside the
/// worktree; an external agent gets the same instructions as a task file and reports back through the CLI.
pub(crate) fn ai(p: &Production, title: &str, prompt: &str, tools: &str) -> Action {
    match p.config.agent.as_str() {
        "external" => Action::Agent { title: format!("{} {}", ep_upper(&p.episode), title), prompt: prompt.to_string() },
        "doubao" => Action::Job {
            kind: "agent_cli",
            params: json!({"provider": "doubao", "title": format!("{} {}", ep_upper(&p.episode), title), "prompt": prompt, "model": p.config.agent_model}),
        },
        _ => Action::Job { kind: "claude_in", params: claude_params(p, title, prompt, tools) },
    }
}

pub(crate) fn with_base(a: Action, p: &Production) -> Action {
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
pub(crate) enum Fixer {
    None,
    Script,
    Code,
    Pronunciation,
    Qa,
}

/// Soft stages continue with a warning when attempts run out; hard stages stop the production.
pub(crate) fn stage_meta(id: &str) -> (Fixer, bool) {
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

pub(crate) fn ep_upper(ep: &str) -> String {
    ep.to_ascii_uppercase()
}

pub(crate) fn actions(p: &Production) -> Vec<Action> {
    let ep = p.episode.clone();
    let wid = p.worktree.clone().unwrap_or_default();
    let c = &p.config;
    let cn = content::cn_only(c);
    let en = content::is_en(c);
    let lang_v = if en { "en" } else { "" };
    let base = |mut v: Value| {
        v["workdir"] = json!(wid);
        v["episode"] = json!(ep);
        if !lang_v.is_empty() {
            v["lang"] = json!(lang_v);
        }
        v
    };
    // scene-level incremental rendering (render.mjs fingerprints) replaces the old "fresh" full re-render
    let refresh = false;
    let bgm = crate::assets::music(&c.assets).map(|a| format!("public/user/{ep}/{}", a.name));
    let with_bgm = |mut v: Value| {
        if let Some(b) = &bgm {
            v["bgm"] = json!(b);
        }
        v
    };
    let make_cn = || Action::Job { kind: "make_cn", params: base(json!({"reconvert": true})) };
    let E = ep_upper(&p.episode);
    match p.stage.as_str() {
        "prepare" => vec![Action::Inline("prepare")],
        "script" if content::mode(c) == "script" => vec![
            Action::Inline("import_script"),
            with_base(ai(p, "劇本整理（自訂腳本）", &prompt_script(p), TOOLS_RESEARCH), p),
            Action::Inline("check_script"),
        ],
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
            if let (Some(cps), false) = (c.tw_cps, cn || en) {
                v["targetCps"] = json!(cps);
            }
            if cn {
                // the Simplified master is mirrored into src_cn (identity conversion + Mainland terms), then voiced
                vec![make_cn(), Action::Job { kind: "voiceover_cn", params: base(v) }, Action::Inline("check_voice")]
            } else {
                vec![Action::Job { kind: "voiceover_tw", params: base(v) }, Action::Inline("check_voice")]
            }
        }
        "timeline" => vec![Action::Job { kind: "timeline", params: base(if cn { json!({"src": "src_cn"}) } else { json!({}) }) }],
        "visual" => {
            let mut v = vec![];
            if cn {
                v.push(make_cn());
            }
            v.push(Action::Inline("plan_stills"));
            let mut st = json!({"comp": format!("{E}-30fps"), "frames": p.data["stillFrames"].as_str().unwrap_or("0")});
            if cn {
                st["src"] = json!("src_cn");
            }
            v.push(Action::Job { kind: "stills", params: base(st) });
            v.push(with_base(ai(p, "畫面審查", &prompt_visual(p), TOOLS_CODE), p));
            v.push(Action::Job { kind: "typecheck", params: base(json!({})) });
            v.push(Action::Inline("check_visual"));
            v
        }
        "final" if cn => vec![
            Action::Job { kind: "typecheck", params: base(json!({})) },
            Action::Job { kind: "bilibili", params: base(with_bgm(json!({"fresh": refresh, "skipVoice": true, "reconvert": true}))) },
            Action::Inline("check_qa"),
        ],
        "final" => vec![
            Action::Job { kind: "typecheck", params: base(json!({})) },
            Action::Job { kind: "final_tw", params: base(with_bgm(if en { json!({"fresh": refresh, "out": format!("{E}_Final_en.mp4")}) } else { json!({"fresh": refresh}) })) },
            Action::Inline("check_qa"),
        ],
        "youtube" => vec![
            Action::Job { kind: "typecheck", params: base(json!({})) },
            Action::Job { kind: "youtube_15x", params: base(json!({"fresh": refresh})) },
            Action::Job { kind: "qa", params: base(json!({"video": format!("{E}_YouTube_zh-TW.mp4"), "speed": 1.5})) },
            Action::Inline("check_qa"),
        ],
        "bilibili" => vec![Action::Job { kind: "typecheck", params: base(json!({})) }, Action::Job { kind: "bilibili", params: base(with_bgm(json!({"fresh": refresh}))) }, Action::Inline("check_qa")],
        "thumbnail" => {
            let mut v = vec![];
            if !cn {
                v.push(Action::Job { kind: "stills", params: base(json!({"comp": format!("{E}-Thumbnail"), "frames": "0"})) });
                v.push(Action::Inline("copy_thumb_tw"));
            }
            if content::wants_cn(c) {
                if cn {
                    v.push(make_cn());
                }
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

pub(crate) const TOOLS_RESEARCH: &str = "Read,Glob,Grep,Edit,Write,WebSearch,WebFetch";
pub(crate) const TOOLS_CODE: &str = "Read,Glob,Grep,Edit,Write,Bash(node node_modules/typescript/bin/tsc *)";

pub(crate) fn claude_params(p: &Production, title: &str, prompt: &str, tools: &str) -> Value {
    json!({
        "title": format!("{} {}", ep_upper(&p.episode), title),
        "prompt": prompt,
        "tools": tools,
        "maxTurns": p.config.max_turns,
        "billing": p.config.billing,
        "budgetUsd": p.config.budget_usd,
    })
}
