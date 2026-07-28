use serde::{Deserialize, Serialize};

pub const EVENT_NOTIFICATION: &str = "web-bluetooth://characteristic-value-changed";
pub const EVENT_GATT_DISCONNECTED: &str = "web-bluetooth://gattserver-disconnected";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingRequest {
  pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResponse {
  pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDeviceOptions {
  #[serde(default)]
  pub accept_all_devices: bool,
  #[serde(default)]
  pub filters: Vec<DeviceFilter>,
  #[serde(default)]
  pub optional_services: Vec<String>,
  #[serde(default = "default_scan_timeout_ms")]
  pub scan_timeout_ms: u64,
}

fn default_scan_timeout_ms() -> u64 {
  10_000
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFilter {
  #[serde(default)]
  pub services: Vec<String>,
  pub name: Option<String>,
  pub name_prefix: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothDevice {
  pub id: String,
  pub name: Option<String>,
  #[serde(default)]
  pub uuids: Vec<String>,
  #[serde(default)]
  pub watching_advertisements: bool,
  pub connected: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GattServerInfo {
  pub device_id: String,
  pub connected: bool,
  #[serde(default)]
  pub services: Vec<BluetoothService>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothService {
  pub uuid: String,
  #[serde(default)]
  pub is_primary: bool,
  #[serde(default)]
  pub characteristics: Vec<BluetoothCharacteristic>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothCharacteristic {
  pub uuid: String,
  #[serde(default)]
  pub properties: CharacteristicProperties,
  #[serde(default)]
  pub descriptors: Vec<BluetoothDescriptor>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacteristicProperties {
  pub broadcast: bool,
  pub read: bool,
  pub write_without_response: bool,
  pub write: bool,
  pub notify: bool,
  pub indicate: bool,
  pub authenticated_signed_writes: bool,
  pub reliable_write: bool,
  pub writable_auxiliaries: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothDescriptor {
  pub uuid: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRequest {
  pub device_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRequest {
  pub device_id: String,
  pub service_uuid: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacteristicsRequest {
  pub device_id: String,
  pub service_uuid: String,
  pub characteristic_uuid: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DescriptorRequest {
  pub device_id: String,
  pub service_uuid: String,
  pub characteristic_uuid: String,
  pub descriptor_uuid: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadValueRequest {
  pub device_id: String,
  pub service_uuid: String,
  pub characteristic_uuid: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteValueRequest {
  pub device_id: String,
  pub service_uuid: String,
  pub characteristic_uuid: String,
  /// base64 encoded payload
  pub value: String,
  #[serde(default = "default_with_response")]
  pub with_response: bool,
}

fn default_with_response() -> bool {
  true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRequest {
  pub device_id: String,
  pub service_uuid: String,
  pub characteristic_uuid: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothValue {
  /// base64 encoded value
  pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEventPayload {
  pub device_id: String,
  pub service_uuid: String,
  pub characteristic_uuid: String,
  pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEventPayload {
  pub device_id: String,
}
