// Prevents an extra console window from appearing on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Defaults to "info" (covers the Bluetooth plugin's own log::info!/
    // log::warn! scan diagnostics) unless RUST_LOG overrides it. Only
    // visible when launched from a terminal, not when double-clicked from
    // Finder — see "Debugging" in ../README.md.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    gpx_rider_lib::run();
}
