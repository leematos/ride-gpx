// Polyfills `navigator.bluetooth` with the Web Bluetooth surface that
// trainer.mjs and heartrate.mjs already use (requestDevice/getDevices,
// device.gatt.connect()/getPrimaryService(), service.getCharacteristic(),
// characteristic.startNotifications()/writeValue()/'characteristicvaluechanged'),
// backed by tauri-plugin-web-bluetooth-api instead of a real browser. This
// lets both modules run completely unmodified inside the macOS Tauri app
// (see macos-app/), which has no Web Bluetooth implementation of its own.
//
// Loaded directly via a <script type="module"> tag in app.html, before
// app.js — like app.js itself, its top level is allowed to run install
// code immediately (nothing imports this module, so there is no feature
// import graph to keep side-effect-free). In a real browser
// `window.__TAURI_INTERNALS__` is absent and this module does nothing.
//
// Unlike tauri-plugin-blec (this project's first choice — see git history),
// tauri-plugin-web-bluetooth-api keeps one GATT connection per device (a
// `HashMap` keyed by device id), so the macOS build can hold a trainer and a
// heart-rate strap connected at once, exactly like the browser build.
// Device selection also happens entirely on the Rust side (a native picker
// window, or "first match" if none is configured — see
// macos-app/src-tauri/src/lib.rs), so requestDevice() here is a thin
// pass-through rather than a hand-rolled scan+picker UI.

import {
  connectGATT,
  disconnectGATT,
  getAdapterState,
  getAvailability,
  getDevices as pluginGetDevices,
  getPrimaryServices,
  onCharacteristicValueChanged,
  onGattServerDisconnected,
  readCharacteristicValue,
  requestDevice as pluginRequestDevice,
  startNotifications,
  stopNotifications,
  writeCharacteristicValue,
} from "../vendor/web-bluetooth-plugin/index.js";
import { base64ToBytes, bytesToBase64, normalizeUuid, toByteArray } from "./ble-uuid.mjs";

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

// How long the plugin's native device picker keeps scanning for candidates
// once opened. Desktop-shim-only timing (no browser or Python counterpart),
// so it stays a local constant rather than a tuning.yaml entry.
const SCAN_TIMEOUT_MS = 20000;

// deviceId -> FakeBluetoothDevice, so the two global plugin event listeners
// (registered once below) can route a notification/disconnect to the right
// fake device/characteristic instances.
const devicesById = new Map();
// `${deviceId}|${serviceUuid}|${characteristicUuid}` -> FakeBluetoothCharacteristic
const characteristicsByKey = new Map();

function characteristicKey(deviceId, serviceUuid, characteristicUuid) {
  return `${deviceId}|${serviceUuid}|${characteristicUuid}`;
}

class FakeBluetoothDevice extends EventTarget {
  constructor(address, name) {
    super();
    this.id = address;
    this.name = name;
    this._services = null;
    this._connected = false;
    devicesById.set(address, this);
    const device = this;
    this.gatt = {
      get connected() {
        return device._connected;
      },
      connect: () => connectFakeDevice(device),
      disconnect: () => disconnectFakeDevice(device),
      getPrimaryService: (serviceUuid) => getPrimaryService(device, serviceUuid),
    };
  }
}

class FakeBluetoothCharacteristic extends EventTarget {
  constructor(deviceId, serviceUuid, characteristicUuid) {
    super();
    this.uuid = characteristicUuid;
    this._deviceId = deviceId;
    this._serviceUuid = serviceUuid;
    this.value = null;
    characteristicsByKey.set(characteristicKey(deviceId, serviceUuid, characteristicUuid), this);
  }

  async startNotifications() {
    await startNotifications(this._deviceId, this._serviceUuid, this.uuid);
    return this;
  }

  async stopNotifications() {
    await stopNotifications(this._deviceId, this._serviceUuid, this.uuid);
    return this;
  }

  async readValue() {
    const { value } = await readCharacteristicValue(this._deviceId, this._serviceUuid, this.uuid);
    this.value = new DataView(base64ToBytes(value).buffer);
    return this.value;
  }

  async writeValue(bufferSource) {
    const base64 = bytesToBase64(toByteArray(bufferSource));
    await writeCharacteristicValue(this._deviceId, this._serviceUuid, this.uuid, base64, true);
  }

  async writeValueWithoutResponse(bufferSource) {
    const base64 = bytesToBase64(toByteArray(bufferSource));
    await writeCharacteristicValue(this._deviceId, this._serviceUuid, this.uuid, base64, false);
  }
}

// Registered once: the plugin broadcasts every connected device's events
// through the same two global Tauri events, tagged with deviceId (and
// serviceUuid/characteristicUuid for notifications).
let globalListenersReady = null;
function ensureGlobalListeners() {
  if (!globalListenersReady) {
    globalListenersReady = Promise.all([
      onCharacteristicValueChanged(({ deviceId, serviceUuid, characteristicUuid, value }) => {
        const characteristic = characteristicsByKey.get(characteristicKey(deviceId, serviceUuid, characteristicUuid));
        if (!characteristic) return;
        characteristic.value = new DataView(base64ToBytes(value).buffer);
        characteristic.dispatchEvent(new Event("characteristicvaluechanged"));
      }),
      onGattServerDisconnected(({ deviceId }) => {
        const device = devicesById.get(deviceId);
        if (!device) return;
        console.debug(`[tauri-ble] disconnected: ${device.name || deviceId}`);
        device._connected = false;
        device.dispatchEvent(new Event("gattserverdisconnected"));
      }),
    ]);
  }
  return globalListenersReady;
}

function getPrimaryService(device, serviceUuid) {
  const wanted = normalizeUuid(serviceUuid);
  const match = (device._services || []).find((service) => service.uuid.toLowerCase() === wanted);
  if (!match) {
    console.warn(
      `[tauri-ble] service ${wanted} not found on ${device.name || device.id}; discovered services:`,
      (device._services || []).map((service) => service.uuid),
    );
    throw new DOMException(`No Services matching UUID ${wanted} found in Device.`, "NotFoundError");
  }
  return {
    uuid: match.uuid,
    getCharacteristic: (characteristicUuid) => {
      const wantedChar = normalizeUuid(characteristicUuid);
      const characteristic = match.characteristics.find((c) => c.uuid.toLowerCase() === wantedChar);
      if (!characteristic) {
        throw new DOMException(`No Characteristic matching UUID ${wantedChar} found in Service.`, "NotFoundError");
      }
      return new FakeBluetoothCharacteristic(device.id, match.uuid, characteristic.uuid);
    },
  };
}

// getAvailability() only reports whether adapter *hardware* exists, not
// whether its radio is switched on — a Mac with Bluetooth toggled off still
// "has" an adapter, so requestDevice()/connect would otherwise scan for the
// full timeout and fail with an unhelpful "no devices found" instead of the
// real, immediately-known reason. getAdapterState() is a GPX Rider addition
// to the vendored plugin (see its NOTICE.md) exposing btleplug's actual
// CentralState.
async function ensureBluetoothReady() {
  const adapterAvailable = await getAvailability().catch(() => false);
  if (!adapterAvailable) {
    throw new Error("No Bluetooth adapter found on this Mac.");
  }
  const adapterState = await getAdapterState().catch(() => "Unknown");
  if (adapterState !== "PoweredOn") {
    console.warn(`[tauri-ble] adapter not powered on (state: ${adapterState})`);
    throw new Error("Bluetooth is turned off. Turn it on in Control Center or System Settings, then try again.");
  }
}

async function connectFakeDevice(device) {
  await ensureGlobalListeners();
  await ensureBluetoothReady();

  console.debug(`[tauri-ble] connecting GATT: ${device.name || device.id}`);
  const info = await connectGATT(device.id);
  device._services = info.services;
  device._connected = info.connected;
  console.debug(
    `[tauri-ble] connected: ${device.name || device.id}; services:`,
    info.services.map((service) => service.uuid),
  );
  return device.gatt;
}

async function disconnectFakeDevice(device) {
  if (!device._connected) return;
  await disconnectGATT(device.id);
  device._connected = false;
  device.dispatchEvent(new Event("gattserverdisconnected"));
}

function toPluginFilters(filters) {
  return (filters || []).map((filter) => ({
    ...filter,
    services: filter.services?.map(normalizeUuid),
  }));
}

async function requestDevice(options = {}) {
  await ensureBluetoothReady();

  console.debug("[tauri-ble] requesting device", options.filters);
  const picked = await pluginRequestDevice({
    filters: toPluginFilters(options.filters),
    optionalServices: options.optionalServices?.map(normalizeUuid),
    scanTimeoutMs: SCAN_TIMEOUT_MS,
  });
  console.debug(`[tauri-ble] device picked: ${picked.name || picked.id}`);
  return devicesById.get(picked.id) || new FakeBluetoothDevice(picked.id, picked.name || picked.id);
}

async function getDevices() {
  const known = await pluginGetDevices().catch(() => []);
  return known.map((device) => devicesById.get(device.id) || new FakeBluetoothDevice(device.id, device.name || device.id));
}

if (isTauri && !navigator.bluetooth) {
  navigator.bluetooth = { requestDevice, getDevices };
}
