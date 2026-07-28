use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::{models::*, Error, Result};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_web_bluetooth);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> Result<WebBluetooth<R>> {
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("", "ExamplePlugin")?;
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_web_bluetooth)?;
  Ok(WebBluetooth(handle))
}

/// Access to the web-bluetooth APIs.
pub struct WebBluetooth<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> WebBluetooth<R> {
  pub async fn get_availability(&self) -> Result<bool> {
    Err(Error::UnsupportedPlatform)
  }

  pub async fn get_devices(&self) -> Result<Vec<BluetoothDevice>> {
    Err(Error::UnsupportedPlatform)
  }

  pub async fn request_device(&self, _options: RequestDeviceOptions) -> Result<BluetoothDevice> {
    Err(Error::UnsupportedPlatform)
  }

  pub async fn connect_gatt(&self, _request: DeviceRequest) -> Result<GattServerInfo> {
    Err(Error::UnsupportedPlatform)
  }

  pub async fn disconnect_gatt(&self, _request: DeviceRequest) -> Result<()> {
    Err(Error::UnsupportedPlatform)
  }

  pub async fn forget_device(&self, _request: DeviceRequest) -> Result<()> {
    Err(Error::UnsupportedPlatform)
  }

  pub async fn get_primary_services(&self, _request: ServiceRequest) -> Result<Vec<BluetoothService>> {
    Err(Error::UnsupportedPlatform)
  }

  pub async fn get_characteristics(&self, _request: CharacteristicsRequest) -> Result<Vec<BluetoothCharacteristic>> {
    Err(Error::UnsupportedPlatform)
  }

  pub async fn read_characteristic_value(&self, _request: ReadValueRequest) -> Result<BluetoothValue> {
    Err(Error::UnsupportedPlatform)
  }

  pub async fn write_characteristic_value(&self, _request: WriteValueRequest) -> Result<()> {
    Err(Error::UnsupportedPlatform)
  }

  pub async fn start_notifications(&self, _request: NotificationRequest) -> Result<()> {
    Err(Error::UnsupportedPlatform)
  }

  pub async fn stop_notifications(&self, _request: NotificationRequest) -> Result<()> {
    Err(Error::UnsupportedPlatform)
  }
}
