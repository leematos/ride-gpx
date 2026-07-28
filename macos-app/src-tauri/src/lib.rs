// Tauri app entry point: registers the tauri-plugin-web-bluetooth Bluetooth
// backend (see ../../app/trainer/tauri-ble-shim.mjs for the frontend side of
// the bridge) with its native device-picker dialog, and boots the webview
// that loads the GPX Rider app from app/.
use tauri_plugin_web_bluetooth::{init_with_selection_handler, NativeDialogSelectionHandler, SelectionHandler};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(init_with_selection_handler(SelectionHandler::new(
            NativeDialogSelectionHandler::new(),
        )))
        .run(tauri::generate_context!())
        .expect("error while running the GPX Rider Tauri application");
}
