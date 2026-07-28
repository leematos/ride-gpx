// Tauri app entry point: registers the tauri-plugin-blec Bluetooth backend
// (see ../../app/trainer/tauri-ble-shim.mjs for the frontend side of the
// bridge) and boots the webview that loads the GPX Rider app from app/.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_blec::init())
        .run(tauri::generate_context!())
        .expect("error while running the GPX Rider Tauri application");
}
