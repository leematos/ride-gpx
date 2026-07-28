#[cfg(not(desktop))]
use std::marker::PhantomData;
use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
pub use desktop::{
  DeviceSelectionContext,
  DeviceSelectionHandler,
  NativeDialogSelectionHandler,
  SelectionHandler,
};

#[cfg(desktop)]
use desktop::WebBluetooth;
#[cfg(mobile)]
use mobile::WebBluetooth;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the web-bluetooth APIs.
pub trait WebBluetoothExt<R: Runtime> {
  fn web_bluetooth(&self) -> &WebBluetooth<R>;
}

impl<R: Runtime, T: Manager<R>> crate::WebBluetoothExt<R> for T {
  fn web_bluetooth(&self) -> &WebBluetooth<R> {
    self.state::<WebBluetooth<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  init_with_config(InitConfig::<R>::default())
}

/// Initializes the plugin with a custom device selection handler on desktop targets.
#[cfg(desktop)]
pub fn init_with_selection_handler<R: Runtime>(selection_handler: SelectionHandler<R>) -> TauriPlugin<R> {
  init_with_config(InitConfig { selection_handler })
}

fn init_with_config<R: Runtime>(config: InitConfig<R>) -> TauriPlugin<R> {
  let builder = Builder::new("web-bluetooth").invoke_handler(commands::handlers());
  #[cfg(desktop)]
  let builder = desktop::register_selection_scheme_protocol(builder);
  builder
    .setup(move |app, api| {
      #[cfg(mobile)]
      let web_bluetooth = mobile::init(app, api)?;
      #[cfg(desktop)]
      let web_bluetooth = desktop::init(app, api, config.selection_handler.clone())?;
      app.manage(web_bluetooth);
      Ok(())
    })
    .build()
}

#[cfg(desktop)]
struct InitConfig<R: Runtime> {
  selection_handler: SelectionHandler<R>,
}

#[cfg(desktop)]
impl<R: Runtime> Default for InitConfig<R> {
  fn default() -> Self {
    Self {
      selection_handler: SelectionHandler::default(),
    }
  }
}

#[cfg(not(desktop))]
struct InitConfig<R: Runtime>(PhantomData<R>);

#[cfg(not(desktop))]
impl<R: Runtime> Default for InitConfig<R> {
  fn default() -> Self {
    Self(PhantomData)
  }
}
