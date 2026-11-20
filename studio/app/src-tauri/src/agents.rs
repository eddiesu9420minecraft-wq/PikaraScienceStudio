//! AI agent providers for Autonomous Production Mode, and their connection / capability test.
//!
//! - `claude`: the signed-in official Claude Code CLI (default; subscription mode strips API-key variables).
//! - `doubao`: the official 豆包 CLI from 豆包工作 (`npm install -g @bytedance/doubao-cli`, `doubao login` by QR code with
//!   the user's Doubao account — no API key). Documented flags used: `-C <dir>`, `-p "<prompt>"`,
//!   `--permission-mode always_allow`, `--model`, `doubao auth status --verify`, `--version`.
//! - `external`: an outside agent (e.g. the 豆包工作 desktop client with the Pikara Studio Skill) drives Studio through
//!   `--cli agent-task` / `agent-done`; nothing to test here except that the CLI works.
//!
//! Studio never stores or forwards credentials of any provider; each CLI keeps its own login.

use crate::util::{clean_path, run_env_rm, which};
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

pub fn doubao_path() -> Option<String> {
    if let Some(p) = which("doubao") {
        return Some(p);
    }
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    for c in [format!(r"{appdata}\npm\doubao.cmd"), format!(r"{appdata}\npm\doubao")] {
        if Path::new(&c).exists() {
            return Some(c);
        }
    }
    None
}

fn run_clean(exe: &str, args: &[&str], cwd: Option<&Path>, secs: u64) -> (bool, String, f64) {
    let t = Instant::now();
    // provider isolation: the child never sees Anthropic API variables (Claude subscription stays the default auth,
    // and the 豆包 CLI has nothing to do with them). Only the child's environment is changed.
    let r = run_env_rm(exe, args, cwd, &[], &crate::jobs::API_KEY_VARS, Duration::from_secs(secs));
    let secs = t.elapsed().as_secs_f64();
    match r {
        Ok(o) => (o.ok(), o.combined(), secs),
        Err(e) => (false, e, secs),
    }
}

/// `deep = false`: installed + version + login. `deep = true`: also a real agent run in a temporary folder that must
/// write a file and run a command — proves file editing and tool use, not just text generation.
pub fn check(provider: &str, deep: bool) -> Value {
    let (exe, version_args): (Option<String>, Vec<&str>) = match provider {
        "claude" => (crate::claude::claude_path(), vec!["--version"]),
        "doubao" => (doubao_path(), vec!["--version"]),
        "external" => {
            return json!({"provider": provider, "ok": true, "note": "外部 Agent 透過 Studio CLI（--cli agent-task / agent-done）操作，不需要連線測試。"});
        }
        p => return json!({"provider": p, "ok": false, "error": "未知的提供者"}),
    };
    let Some(exe) = exe else {
        let how = if provider == "doubao" {
            "安裝豆包 CLI：npm install -g @bytedance/doubao-cli（豆包工作官方文件），再執行 doubao login 掃碼登入。"
        } else {
            "安裝 Claude Code，並在終端機執行 claude 登入。"
        };
        return json!({"provider": provider, "ok": false, "found": false, "error": format!("找不到 {provider} CLI。{how}")});
    };
    let (vok, vout, _) = run_clean(&exe, &version_args, None, 30);
    let mut out = json!({"provider": provider, "found": true, "path": exe, "version": vout.trim().lines().last().unwrap_or("").to_string(), "versionOk": vok});
    // login
    if provider == "doubao" {
        let (lok, lout, _) = run_clean(&exe, &["auth", "status", "--verify"], None, 60);
        let logged = lok && !regex::Regex::new(r"未登录|未登入|not logged|expired|失效").unwrap().is_match(&lout);
        out["login"] = json!({"ok": logged, "output": lout.trim().chars().take(800).collect::<String>()});
        if !logged {
            out["ok"] = json!(false);
            out["error"] = json!("豆包 CLI 尚未登入：請在終端機執行 doubao login，用豆包或飛書手機版掃碼。");
            return out;
        }
    }
    if !deep {
        out["ok"] = json!(vok);
        return out;
    }
    // capability: really edit a file and run a tool in a scratch folder
    let dir = std::env::temp_dir().join(format!("pikara-agent-check-{}", uuid::Uuid::new_v4()));
    let _ = std::fs::create_dir_all(&dir);
    let token = format!("PIKARA_OK_{}", &uuid::Uuid::new_v4().to_string()[..8]);
    let prompt = format!("請在目前目錄建立檔案 agent_check.txt，第一行寫入 {token}；然後執行命令 node --version，把輸出的版本號寫在第二行。只做這件事，完成後回覆 DONE。");
    let dir_s = dir.to_string_lossy().to_string();
    let (rok, rout, secs) = match provider {
        "doubao" => run_clean(&exe, &["-C", &dir_s, "--permission-mode", "always_allow", "-p", &prompt], None, 300),
        _ => run_clean(&exe, &["-p", &prompt, "--permission-mode", "dontAsk", "--allowedTools", "Write,Edit,Read,Bash(node --version)", "--max-turns", "8"], Some(&dir), 300),
    };
    let file = std::fs::read_to_string(dir.join("agent_check.txt")).unwrap_or_default();
    let wrote = file.contains(&token);
    let ran_tool = regex::Regex::new(r"v\d+\.\d+\.\d+").unwrap().is_match(&file);
    out["capability"] = json!({
        "ok": wrote && ran_tool, "fileWritten": wrote, "toolRan": ran_tool, "exitOk": rok, "seconds": (secs * 10.0).round() / 10.0,
        "file": file.chars().take(200).collect::<String>(), "output": rout.trim().chars().rev().take(600).collect::<String>().chars().rev().collect::<String>(),
        "folder": clean_path(&dir),
    });
    out["ok"] = json!(vok && wrote && ran_tool);
    let _ = std::fs::remove_dir_all(&dir);
    out
}
