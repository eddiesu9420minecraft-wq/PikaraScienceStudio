// Git commit this binary was built from (CI sets GITHUB_SHA; local builds ask git). Same rule as the GUI's build.rs.
use std::path::Path;

fn main() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let git = |args: &[&str]| {
        std::process::Command::new("git").args(args).current_dir(&repo).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let commit = std::env::var("GITHUB_SHA").ok().filter(|s| !s.is_empty()).or_else(|| git(&["rev-parse", "HEAD"])).unwrap_or_else(|| "unknown".into());
    let dirty = std::env::var("GITHUB_SHA").is_err() && git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty());
    println!("cargo:rustc-env=PIKARA_GIT_COMMIT={}{}", commit, if dirty { "-dirty" } else { "" });
    for f in ["HEAD", "logs/HEAD"] {
        if let Some(p) = git(&["rev-parse", "--git-path", f]) {
            println!("cargo:rerun-if-changed={}", repo.join(p).display());
        }
    }
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
}
