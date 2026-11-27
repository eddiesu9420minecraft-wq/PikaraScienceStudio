// Frontend fingerprint: SHA-256 over every file of ../src (the directory Tauri embeds as `frontendDist`), so a built
// exe can prove which UI it contains (`--cli build-info`, `app_info.frontendSha256`). scripts/check-ui.mjs computes
// the same hash from the source tree and fails a release whose exe embeds anything else.
// Rule (must match check-ui.mjs): files sorted by '/'-separated relative path; for each: path, NUL, content with
// CRLF normalised to LF, NUL.
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, base, out);
        } else {
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            out.push((rel, p));
        }
    }
}

fn main() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src");
    println!("cargo:rerun-if-changed={}", src.display());
    let mut files = vec![];
    walk(&src, &src, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut h = Sha256::new();
    for (rel, p) in &files {
        let bytes = std::fs::read(p).unwrap_or_default();
        let mut norm = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
                i += 1;
                continue;
            }
            norm.push(bytes[i]);
            i += 1;
        }
        h.update(rel.as_bytes());
        h.update([0u8]);
        h.update(&norm);
        h.update([0u8]);
        println!("cargo:rerun-if-changed={}", p.display());
    }
    let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    println!("cargo:rustc-env=PIKARA_FRONTEND_SHA256={hex}");
    println!("cargo:rustc-env=PIKARA_FRONTEND_FILES={}", files.len());
    // Git commit the exe was built from (CI sets GITHUB_SHA; local builds ask git). "-dirty" when the tree had
    // uncommitted changes, "unknown" outside a checkout.
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..");
    let git = |args: &[&str]| {
        std::process::Command::new("git").args(args).current_dir(&repo).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let commit = std::env::var("GITHUB_SHA").ok().filter(|s| !s.is_empty()).or_else(|| git(&["rev-parse", "HEAD"])).unwrap_or_else(|| "unknown".into());
    let dirty = std::env::var("GITHUB_SHA").is_err() && git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty());
    println!("cargo:rustc-env=PIKARA_GIT_COMMIT={}{}", commit, if dirty { "-dirty" } else { "" });
    // HEAD only names the branch; the reflog changes on every commit, checkout and reset
    for f in ["HEAD", "logs/HEAD"] {
        if let Some(p) = git(&["rev-parse", "--git-path", f]) {
            println!("cargo:rerun-if-changed={}", repo.join(p).display());
        }
    }
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    tauri_build::build()
}
