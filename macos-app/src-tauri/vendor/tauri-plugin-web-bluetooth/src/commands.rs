use btleplug::api::CentralState;
use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::{Result, WebBluetoothExt};

#[command]
pub(crate) async fn get_availability<R: Runtime>(app: AppHandle<R>) -> Result<bool> {
    app.web_bluetooth().get_availability().await
}

#[command]
pub(crate) async fn get_adapter_state<R: Runtime>(app: AppHandle<R>) -> Result<CentralState> {
    app.web_bluetooth().get_adapter_state().await
}

#[command]
pub(crate) async fn get_devices<R: Runtime>(app: AppHandle<R>) -> Result<Vec<BluetoothDevice>> {
    app.web_bluetooth().get_devices().await
}

#[command]
pub(crate) async fn request_device<R: Runtime>(
    app: AppHandle<R>,
    options: RequestDeviceOptions,
) -> Result<BluetoothDevice> {
    app.web_bluetooth().request_device(options).await
}

#[command]
pub(crate) async fn connect_gatt<R: Runtime>(app: AppHandle<R>, request: DeviceRequest) -> Result<GattServerInfo> {
    app.web_bluetooth().connect_gatt(request).await
}

#[command]
pub(crate) async fn disconnect_gatt<R: Runtime>(app: AppHandle<R>, request: DeviceRequest) -> Result<()> {
    app.web_bluetooth().disconnect_gatt(request).await
}

#[command]
pub(crate) async fn forget_device<R: Runtime>(app: AppHandle<R>, request: DeviceRequest) -> Result<()> {
    app.web_bluetooth().forget_device(request).await
}

#[command]
pub(crate) async fn get_primary_services<R: Runtime>(
    app: AppHandle<R>,
    request: ServiceRequest,
) -> Result<Vec<BluetoothService>> {
    app.web_bluetooth().get_primary_services(request).await
}

#[command]
pub(crate) async fn get_characteristics<R: Runtime>(
    app: AppHandle<R>,
    request: CharacteristicsRequest,
) -> Result<Vec<BluetoothCharacteristic>> {
    app.web_bluetooth().get_characteristics(request).await
}

#[command]
pub(crate) async fn read_characteristic_value<R: Runtime>(
    app: AppHandle<R>,
    request: ReadValueRequest,
) -> Result<BluetoothValue> {
    app.web_bluetooth().read_characteristic_value(request).await
}

#[command]
pub(crate) async fn write_characteristic_value<R: Runtime>(
    app: AppHandle<R>,
    request: WriteValueRequest,
) -> Result<()> {
    app.web_bluetooth().write_characteristic_value(request).await
}

#[command]
pub(crate) async fn start_notifications<R: Runtime>(
    app: AppHandle<R>,
    request: NotificationRequest,
) -> Result<()> {
    app.web_bluetooth().start_notifications(request).await
}

#[command]
pub(crate) async fn stop_notifications<R: Runtime>(
    app: AppHandle<R>,
    request: NotificationRequest,
) -> Result<()> {
    app.web_bluetooth().stop_notifications(request).await
}

pub(crate) fn handlers<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool {
    tauri::generate_handler![
        get_availability,
        get_adapter_state,
        get_devices,
        request_device,
        connect_gatt,
        disconnect_gatt,
        forget_device,
        get_primary_services,
        get_characteristics,
        read_characteristic_value,
        write_characteristic_value,
        start_notifications,
        stop_notifications
    ]
}
