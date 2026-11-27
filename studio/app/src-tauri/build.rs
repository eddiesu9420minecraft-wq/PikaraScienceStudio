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
    tauri_build::build()
}
