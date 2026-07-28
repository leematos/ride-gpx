# Tauri Plugin web-bluetooth

Native Web Bluetooth adapter for Tauri 2 apps powered by [`btleplug`](https://github.com/deviceplug/btleplug). The plugin mirrors the browser Web Bluetooth API surface (device discovery, GATT connect, service/characteristic access, notifications, and availability checks) so you can reuse existing Web Bluetooth code paths inside a desktop Tauri application.

> ⚠️ The current implementation targets desktop platforms (Windows, macOS, Linux). All commands except `ping` return `UnsupportedPlatform` on mobile builds.

## Installation

### 1. Add the Rust crate

In `src-tauri/Cargo.toml` add the dependency (or use `cargo add tauri-plugin-web-bluetooth`):

```toml
[dependencies]
tauri-plugin-web-bluetooth = { path = "../tauri-plugin-web-bluetooth" }
```

Initialize the plugin inside `src-tauri/src/main.rs`:

```rust
fn main() {
	tauri::Builder::default()
		.plugin(tauri_plugin_web_bluetooth::init())
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
```

#### Customizing the device picker (desktop)

By default `request_device` mirrors Chromium's "first matching device" behavior. On desktop targets you can install a custom picker by passing a [`SelectionHandler`](src/desktop.rs) when initializing the plugin. The crate ships with `NativeDialogSelectionHandler`, which renders a lightweight Tauri window styled after the Chromium chooser:

```rust
use tauri_plugin_web_bluetooth::{
	init_with_selection_handler,
	desktop::{NativeDialogSelectionHandler, SelectionHandler},
};

fn main() {
	tauli::Builder::default()
		.plugin(init_with_selection_handler(SelectionHandler::new(
			NativeDialogSelectionHandler::new(),
		)))
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
```

To ensure the native chooser can call into the Tauri bridge and receive streaming scan updates you must:

1. Set `withGlobalTauri` to `true` in `tauri.conf.json` so the dialog can access `window.__TAURI__`:

	 ```jsonc
	 {
		 "app": {
			 "withGlobalTauri": true
		 }
	 }
	 ```

2. Allow the plugin to spawn `web-bluetooth-selector-*` windows (and grant event permissions) inside your capability definition, e.g. `src-tauri/capabilities/default.json`:

	 ```jsonc
	 {
		 "windows": [
			 "main",
			 "web-bluetooth-selector-*"
		 ],
		 "permissions": [
			 "core:default",
			 "core:event:default",
			 "web-bluetooth:default"
		 ]
	 }
	 ```

The plugin registers the `web-bluetooth-selector://` protocol and manages the dialog HTML internally, so no extra asset wiring is required.

You can also plug in any async selection strategy by wrapping a closure:

```rust
use tauri_plugin_web_bluetooth::desktop::{DeviceSelectionContext, SelectionHandler};

let custom_handler = SelectionHandler::new(|ctx: DeviceSelectionContext<_>| {
	Box::pin(async move {
		let preferred = ctx
			.devices
			.iter()
			.find(|device| device.name.as_deref() == Some("Heart Rate"))
			.map(|device| device.id.clone());
		Ok(preferred)
	})
});
```

Return `Ok(None)` (or let the helper dialog time out) to signal a user cancellation, which surfaces as `Error::SelectionCancelled` on the frontend.

### 2. Use the guest bindings

Bundle the TypeScript helper by linking the `guest-js` folder or copying it into your frontend project. Then import the functions you need:

```ts
import {
	requestDevice,
	connectGATT,
	getPrimaryServices,
	getCharacteristics,
	startNotifications,
	onCharacteristicValueChanged,
} from '@/plugins/web-bluetooth'

const device = await requestDevice({ acceptAllDevices: true })
const gatt = await connectGATT(device.id)
const [service] = await getPrimaryServices(device.id)
const [characteristic] = await getCharacteristics(device.id, service.uuid)

await startNotifications(device.id, service.uuid, characteristic.uuid)
await onCharacteristicValueChanged(({ value }) => {
	const data = Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
	console.log('notification payload', data)
})
```

All payloads that carry raw bytes (reads, writes, notifications) are base64-encoded strings to stay compatible with Tauri IPC. Use `atob`/`btoa`, `Buffer.from`, or any Base64 utility to convert to/from `Uint8Array`.

## Available commands

| Command | Description |
| --- | --- |
| `get_availability` | Returns whether a Bluetooth adapter was detected on the host.
| `get_devices` | Lists cached devices matched via `request_device`.
| `request_device` | Scans for peripherals according to Web Bluetooth filters and yields the device selected by the active `SelectionHandler` (first match by default).
| `connect_gatt` / `disconnect_gatt` | Connects or disconnects the device's primary GATT server.
| `forget_device` | Removes a cached device identifier.
| `get_primary_services` | Lists primary services (optionally filter by UUID).
| `get_characteristics` | Lists characteristics for a given service.
| `read_characteristic_value` | Reads a characteristic value (base64 result).
| `write_characteristic_value` | Writes a characteristic (base64 payload, toggle `withResponse`).
| `start_notifications` / `stop_notifications` | Subscribes or unsubscribes from characteristic notifications.

Every command is gated by a dedicated permission (see `permissions/autogenerated/commands`). The default profile enables the entire surface; edit `permissions/default.toml` to tighten access before distributing your plugin.

## Events

Events are broadcast to every window through the Tauri event system. Use the helpers in `guest-js` or listen manually via `@tauri-apps/api/event`.

| Event | Payload |
| --- | --- |
| `web-bluetooth://characteristic-value-changed` | `{ deviceId, serviceUuid, characteristicUuid, value }`
| `web-bluetooth://gattserver-disconnected` | `{ deviceId }`

## Limitations & roadmap

- Desktop only (btleplug mobile back-ends are still experimental).
- `request_device` still relies on the host application's selection handler for advanced UX. Use the built-in native dialog or provide your own handler if you need multi-select or persistent device lists.
- Descriptor APIs and advertisement watching are not implemented yet.

Contributions are welcome! Please open an issue if you find gaps with the Web Bluetooth spec or run into adapter-specific quirks.
