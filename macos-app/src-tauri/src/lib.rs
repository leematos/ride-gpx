// Tauri app entry point: registers the tauri-plugin-web-bluetooth Bluetooth
// backend (see ../../app/trainer/tauri-ble-shim.mjs for the frontend side of
// the bridge) with its native device-picker dialog, builds a native macOS
// menu bar with a Reload + Toggle Developer Tools item (the app has no
// window chrome of its own to put these in), and boots the webview that
// loads the GPX Rider app from app/.
use tauri::{
    menu::{Menu, MenuItemBuilder, SubmenuBuilder},
    Manager, Runtime,
};
use tauri_plugin_web_bluetooth::{init_with_selection_handler, NativeDialogSelectionHandler, SelectionHandler};

fn build_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = SubmenuBuilder::new(app, "GPX Rider")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // No devtools without this feature in a release build — see Cargo.toml.
    let reload_item = MenuItemBuilder::with_id("reload", "Reload").accelerator("CmdOrCtrl+R").build(app)?;
    let devtools_item = MenuItemBuilder::with_id("toggle-devtools", "Toggle Developer Tools")
        .accelerator("CmdOrCtrl+Alt+I")
        .build(app)?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&reload_item)
        .separator()
        .item(&devtools_item)
        .separator()
        .fullscreen()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window").minimize().close_window().build()?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(init_with_selection_handler(SelectionHandler::new(
            NativeDialogSelectionHandler::new(),
        )))
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            if event.id() == "reload" {
                let _ = window.eval("window.location.reload()");
            } else if event.id() == "toggle-devtools" {
                // Always available: the "devtools" feature on the `tauri`
                // dependency in Cargo.toml (not a feature of this crate)
                // keeps open_devtools()/close_devtools() enabled in release
                // builds too, not just debug ones.
                if window.is_devtools_open() {
                    window.close_devtools();
                } else {
                    window.open_devtools();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the GPX Rider Tauri application");
}
