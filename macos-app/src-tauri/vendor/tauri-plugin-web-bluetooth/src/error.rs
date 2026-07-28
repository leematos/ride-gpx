use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
  #[error(transparent)]
  Io(#[from] std::io::Error),
  #[error(transparent)]
  Btleplug(#[from] btleplug::Error),
  #[error(transparent)]
  UuidParse(#[from] uuid::Error),
  #[error(transparent)]
  Base64Decode(#[from] base64::DecodeError),
  #[error("Bluetooth adapter is not available on this system")]
  NoAdapter,
  #[error("Device {0} not found")]
  DeviceNotFound(String),
  #[error("Device selection was cancelled by the user")]
  SelectionCancelled,
  #[error("Service {service_uuid} not found for device {device_id}")]
  ServiceNotFound {
    device_id: String,
    service_uuid: String,
  },
  #[error("Characteristic {characteristic_uuid} not found for device {device_id}")]
  CharacteristicNotFound {
    device_id: String,
    characteristic_uuid: String,
  },
  #[error("Descriptor {descriptor_uuid} not found for device {device_id}")]
  DescriptorNotFound {
    device_id: String,
    descriptor_uuid: String,
  },
  #[error("{0}")]
  InvalidRequest(String),
  #[error(transparent)]
  Json(#[from] serde_json::Error),
  #[error("Notifications already active for {characteristic_uuid} on device {device_id}")]
  NotificationsAlreadyActive {
    device_id: String,
    characteristic_uuid: String,
  },
  #[error("Notifications not active for {characteristic_uuid} on device {device_id}")]
  NotificationsNotActive {
    device_id: String,
    characteristic_uuid: String,
  },
  #[error("Web Bluetooth is not implemented for this platform yet")]
  UnsupportedPlatform,
  #[error(transparent)]
  Tauri(#[from] tauri::Error),
  #[cfg(mobile)]
  #[error(transparent)]
  PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl Serialize for Error {
  fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
  where
    S: Serializer,
  {
    serializer.serialize_str(self.to_string().as_ref())
  }
}
