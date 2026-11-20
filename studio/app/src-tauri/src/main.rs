// Release builds use the GUI subsystem (no console window).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--selftest" || a == "--cli") {
        #[cfg(windows)]
        unsafe {
            // GUI-subsystem exe: attach to the parent console so `--selftest` prints there.
            windows_sys::Win32::System::Console::AttachConsole(windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS);
        }
        if args.iter().any(|a| a == "--cli") {
            std::process::exit(studio_lib::cli::run(&args));
        }
        std::process::exit(studio_lib::selftest::run(&args));
    }
    studio_lib::run();
}
