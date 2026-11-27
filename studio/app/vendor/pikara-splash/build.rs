const COMMANDS: &[&str] = &["status", "shown", "reveal_main", "close", "main_ready", "wait_ready", "action"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
