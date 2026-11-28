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
    /// Environment variables removed from the child (subscription mode strips API keys from `claude`).
    pub env_remove: Vec<String>,
    /// Kill the step if it prints nothing (stdout or stderr) for this long. The TTS script prints a heartbeat every
    /// 30 s even during model load / long lines, so silence here means the whole process is frozen, not slow.
    pub stall_secs: Option<u64>,
    /// With `stall_secs`: a file changing under this folder also counts as activity (an AI agent running a long,
    /// quiet command that still writes files is working, not stalled).
    pub activity_dir: Option<std::path::PathBuf>,
}

/// No-output limit for a step kind; `PIKARA_STALL_<KIND>_SECS` overrides (0 disables).
pub fn stall_limit(kind: &str, default: u64) -> Option<u64> {
    let v = std::env::var(format!("PIKARA_STALL_{}_SECS", kind.to_ascii_uppercase())).ok().and_then(|s| s.parse::<u64>().ok()).unwrap_or(default);
    (v > 0).then_some(v)
}

mod kinds;
mod progress;
mod steps;
pub use kinds::*;
pub use progress::*;
pub use steps::*;

#[cfg(test)]
mod tests;
