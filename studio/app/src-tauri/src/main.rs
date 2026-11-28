// Release builds use the GUI subsystem (no console window).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // `PikaraScienceStudio <command>` / `nogui` / `--cli …` / `--selftest`: command line, no window
    // (crates/studio-cli — the same code as the Linux CLI-only build)
    let selftest = args.iter().any(|a| a == "--selftest");
    if selftest || studio_cli::wants_cli(&args) {
        #[cfg(windows)]
        unsafe {
            // GUI-subsystem exe: attach to the parent console so output appears there.
            windows_sys::Win32::System::Console::AttachConsole(windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS);
        }
        if selftest {
            std::process::exit(studio_lib::selftest::run(&args));
        }
        std::process::exit(studio_cli::run(&args, studio_lib::build_info()));
    }
    studio_lib::run();
}
