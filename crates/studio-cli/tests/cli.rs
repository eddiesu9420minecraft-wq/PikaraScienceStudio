//! Runs the real `pikara-studio` binary against a throwaway data folder (never the user's Studio database).

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_pikara-studio")
}

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Tmp {
        let d = std::env::temp_dir().join(format!("pikara-cli-test-{tag}-{}-{}", std::process::id(), uuid_like()));
        std::fs::create_dir_all(&d).unwrap();
        Tmp(d)
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn uuid_like() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

/// Run with an isolated data dir; returns (exit code, stdout, stderr).
fn run(data: &Path, args: &[&str]) -> (i32, String, String) {
    let o = Command::new(bin())
        .args(["--data", data.to_str().unwrap()])
        .args(args)
        .env("PIKARA_STUDIO_DATA", data) // belt and braces
        .output()
        .expect("run pikara-studio");
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into(), String::from_utf8_lossy(&o.stderr).into())
}

fn json_line(s: &str) -> Value {
    serde_json::from_str(s.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("null")).unwrap_or(Value::Null)
}

#[test]
fn version_help_and_usage_errors() {
    let t = Tmp::new("ver");
    let (c, out, _) = run(&t.0, &["--version"]);
    assert_eq!(c, 0);
    assert!(out.contains(env!("CARGO_PKG_VERSION")), "{out}");
    let (c, out, _) = run(&t.0, &["--json", "version"]);
    assert_eq!(c, 0);
    let v = json_line(&out);
    assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(v["gui"], false);
    assert!(["windows", "macos", "linux"].contains(&v["os"].as_str().unwrap()));
    let (c, out, _) = run(&t.0, &["--help"]);
    assert_eq!(c, 0);
    for verb in ["create", "status", "pause", "resume", "cancel", "retry", "logs", "render", "revoice", "config", "doctor"] {
        assert!(out.contains(verb), "help lists {verb}");
    }
    let (c, _, err) = run(&t.0, &["no-such-command"]);
    assert_eq!(c, 2, "unknown command is a usage error: {err}");
    let (c, out, _) = run(&t.0, &["--json", "create", "--project", t.0.to_str().unwrap()]);
    assert_eq!(c, 2, "create without --topic");
    assert_eq!(json_line(&out)["ok"], false);
}

#[test]
fn empty_data_dir_list_status_config() {
    let t = Tmp::new("empty");
    let (c, out, err) = run(&t.0, &["--json", "list"]);
    assert_eq!(c, 0, "{err}");
    assert_eq!(json_line(&out)["productions"].as_array().map(|a| a.len()), Some(0));
    // the database was created in the isolated folder, nowhere else
    assert!(t.0.join("studio.db").is_file());
    let (c, _, _) = run(&t.0, &["status", "deadbeef"]);
    assert_eq!(c, 3, "unknown production id → not found");
    let (c, out, _) = run(&t.0, &["--json", "config", "get", "perfMode"]);
    assert_eq!(c, 0, "{out}");
    let (c, _, _) = run(&t.0, &["config", "get", "no.such.key"]);
    assert_eq!(c, 3);
    let (c, out, _) = run(&t.0, &["--json", "config", "path"]);
    assert_eq!(c, 0);
    assert!(json_line(&out)["dataDir"].as_str().unwrap().contains("pikara-cli-test-empty"));
}

#[test]
fn hardware_report_is_read_only() {
    let t = Tmp::new("hw");
    let (c, out, err) = run(&t.0, &["hardware"]);
    assert_eq!(c, 0, "{err}");
    let v: Value = serde_json::from_str(&out).expect("hardware prints JSON");
    assert_eq!(v["ok"], true);
    assert!(v["platform"]["os"].is_string());
    assert!(!t.0.join("studio.db").exists(), "hardware must not create a database");
}

/// Full control flow without GPU or AI: new project from the pipeline template → draft production →
/// list / status / pause refused / cancel → logs. Needs git (the project is a git repository).
#[test]
fn production_lifecycle_without_gpu() {
    if Command::new("git").arg("--version").output().is_err() {
        eprintln!("git not installed: skipped");
        return;
    }
    let t = Tmp::new("life");
    let data = t.0.join("data");
    let proj = t.0.join("專案 測試");
    let template = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../pipeline");
    let (c, out, err) = run(&data, &["--json", "project", "new", "--dest", proj.to_str().unwrap(), "--title", "CLI 測試", "--template", template.to_str().unwrap(), "--no-link-tools"]);
    assert_eq!(c, 0, "project new: {out} {err}");
    let (c, out, err) = run(&data, &["--json", "create", "--project", proj.to_str().unwrap(), "--topic", "為什麼天空是藍色的", "--minutes", "1", "--style", "generic", "--agent", "external", "--draft"]);
    assert_eq!(c, 0, "create: {out} {err}");
    let v = json_line(&out);
    let id = v["id"].as_str().unwrap().to_string();
    assert_eq!(v["status"], "draft");
    let short = &id[..8];
    let (c, out, _) = run(&data, &["--json", "status", short]);
    assert_eq!(c, 0);
    let st = json_line(&out);
    assert_eq!(st["production"]["status"], "draft");
    assert_eq!(st["production"]["steps"].as_array().map(|a| a.len()), Some(11), "the 11 steps of the 製作狀態 page");
    let (c, _, _) = run(&data, &["pause", short]);
    assert_eq!(c, 1, "a draft cannot be paused");
    let (c, out, _) = run(&data, &["--json", "cancel", short]);
    assert_eq!(c, 0, "{out}");
    assert_eq!(json_line(&out)["status"], "canceled");
    let (c, out, _) = run(&data, &["--json", "list"]);
    assert_eq!(c, 0);
    assert_eq!(json_line(&out)["productions"][0]["status"], "canceled");
    let (c, out, _) = run(&data, &["--json", "logs", short]);
    assert_eq!(c, 0, "{out}");
    // worker with nothing to do ends at once
    let (c, out, err) = run(&data, &["--json", "run", "--timeout", "60"]);
    assert_eq!(c, 0, "run: {out} {err}");
}
