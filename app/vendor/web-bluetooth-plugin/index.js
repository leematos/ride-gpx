// Hand-ported to plain JS from tauri-plugin-web-bluetooth-api's guest-js/
// (index.ts + types.ts) at commit 742b6b6210ee1e979f3fc133e7bbdf9a626da31f
// of https://github.com/ParticleG/tauri-plugin-web-bluetooth-api — the
// project has no published npm package or prebuilt JS bundle to vendor
// verbatim (unlike Leaflet or @tauri-apps/api), so this is a manual,
// behavior-preserving transliteration of that ~200-line IPC wrapper: same
// command names, same request/response shapes, same event names, types
// dropped. Re-sync by diffing guest-js/index.ts at a newer commit against
// this file.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const NAMESPACE = "plugin:web-bluetooth";

export const EVENTS = {
  characteristicValueChanged: "web-bluetooth://characteristic-value-changed",
  gattServerDisconnected: "web-bluetooth://gattserver-disconnected",
};

function call(command, payload) {
  return invoke(`${NAMESPACE}|${command}`, payload ?? {});
}

export function getAvailability() {
  return call("get_availability");
}

export function getDevices() {
  return call("get_devices");
}

export function requestDevice(options) {
  return call("request_device", { options });
}

export function connectGATT(deviceId) {
  return call("connect_gatt", { request: { deviceId } });
}

export function disconnectGATT(deviceId) {
  return call("disconnect_gatt", { request: { deviceId } });
}

export function forgetDevice(deviceId) {
  return call("forget_device", { request: { deviceId } });
}

export function getPrimaryServices(deviceId, serviceUuid) {
  return call("get_primary_services", { request: { deviceId, serviceUuid } });
}

export function getCharacteristics(deviceId, serviceUuid, characteristicUuid) {
  return call("get_characteristics", { request: { deviceId, serviceUuid, characteristicUuid } });
}

export function readCharacteristicValue(deviceId, serviceUuid, characteristicUuid) {
  return call("read_characteristic_value", { request: { deviceId, serviceUuid, characteristicUuid } });
}

export function writeCharacteristicValue(deviceId, serviceUuid, characteristicUuid, value, withResponse = true) {
  return call("write_characteristic_value", {
    request: { deviceId, serviceUuid, characteristicUuid, value, withResponse },
  });
}

export function startNotifications(deviceId, serviceUuid, characteristicUuid) {
  return call("start_notifications", { request: { deviceId, serviceUuid, characteristicUuid } });
}

export function stopNotifications(deviceId, serviceUuid, characteristicUuid) {
  return call("stop_notifications", { request: { deviceId, serviceUuid, characteristicUuid } });
}

export function onCharacteristicValueChanged(handler) {
  return listen(EVENTS.characteristicValueChanged, (event) => handler(event.payload));
}

export function onGattServerDisconnected(handler) {
  return listen(EVENTS.gattServerDisconnected, (event) => handler(event.payload));
}
