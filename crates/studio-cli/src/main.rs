//! `pikara-studio` / Linux `PikaraScienceStudio`: the command line only (no window, no WebView).

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let info = studio_cli::BuildInfo {
        version: env!("CARGO_PKG_VERSION"),
        git_commit: env!("PIKARA_GIT_COMMIT"),
        frontend_sha256: None,
        frontend_files: 0,
        gui: false,
    };
    if args.iter().any(|a| a == "--selftest") {
        std::process::exit(studio_core::selftest::run(&args));
    }
    std::process::exit(studio_cli::run(&args, info));
}
