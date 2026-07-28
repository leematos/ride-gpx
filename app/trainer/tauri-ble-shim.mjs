// Polyfills `navigator.bluetooth` with the Web Bluetooth surface that
// trainer.mjs and heartrate.mjs already use (requestDevice/getDevices,
// device.gatt.connect()/getPrimaryService(), service.getCharacteristic(),
// characteristic.startNotifications()/writeValue()/'characteristicvaluechanged'),
// backed by tauri-plugin-blec instead of a real browser. This lets both
// modules run completely unmodified inside the macOS Tauri app (see
// macos-app/), which has no Web Bluetooth implementation of its own.
//
// Loaded directly via a <script type="module"> tag in app.html, before
// app.js — like app.js itself, its top level is allowed to run install
// code immediately (nothing imports this module, so there is no feature
// import graph to keep side-effect-free). In a real browser
// `window.__TAURI_INTERNALS__` is absent and this module does nothing.
//
// tauri-plugin-blec keeps a single active GATT connection for the whole
// app (its connect()/disconnect() are global, not per-device), unlike Web
// Bluetooth which lets a page hold independent connections to several
// devices at once. That means the macOS build can have a trainer OR a
// heart-rate strap connected, but not both simultaneously the way the
// browser build can — connecting the second one disconnects the first
// (surfaced the same way a real out-of-range disconnect would be, via
// 'gattserverdisconnected'). See macos-app/README.md.

import {
  checkPermissions,
  connect,
  disconnect,
  getAdapterState,
  listServices,
  read,
  send,
  startScan,
  stopScan,
  subscribe,
  unsubscribe,
} from "../vendor/plugin-blec/index.js";
import { deviceMatchesFilters, normalizeUuid, toByteArray } from "./ble-uuid.mjs";

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

// How long the interactive device picker scans before giving up if the
// user doesn't cancel or pick a device first. Desktop-shim-only timing
// (no browser or Python counterpart), so it stays a local constant rather
// than a tuning.yaml entry.
const PICKER_SCAN_TIMEOUT_MS = 20000;
// Short, non-interactive scan window used to look for a previously used
// device on boot (mirrors navigator.bluetooth.getDevices() in a browser).
const RECONNECT_SCAN_TIMEOUT_MS = 4000;

// registry.activeDevice tracks which FakeBluetoothDevice currently owns the
// plugin's single underlying GATT connection, so a second connect() knows to
// tear down the first one first.
const registry = { activeDevice: null };

class FakeBluetoothDevice extends EventTarget {
  constructor(address, name) {
    super();
    this.id = address;
    this.name = name;
    this._services = null;
    const device = this;
    this.gatt = {
      get connected() {
        return registry.activeDevice === device;
      },
      connect: () => connectFakeDevice(device),
      disconnect: () => disconnectFakeDevice(device),
      getPrimaryService: (serviceUuid) => getPrimaryService(device, serviceUuid),
    };
  }
}

class FakeBluetoothCharacteristic extends EventTarget {
  constructor(serviceUuid, characteristicUuid) {
    super();
    this.uuid = characteristicUuid;
    this._serviceUuid = serviceUuid;
    this.value = null;
  }

  async startNotifications() {
    await subscribe(this.uuid, this._serviceUuid, (data) => {
      this.value = new DataView(new Uint8Array(data).buffer);
      this.dispatchEvent(new Event("characteristicvaluechanged"));
    });
    return this;
  }

  async stopNotifications() {
    await unsubscribe(this.uuid, this._serviceUuid);
    return this;
  }

  async readValue() {
    const bytes = await read(this.uuid, this._serviceUuid);
    this.value = new DataView(new Uint8Array(bytes).buffer);
    return this.value;
  }

  async writeValue(bufferSource) {
    await send(this.uuid, toByteArray(bufferSource), "withResponse", this._serviceUuid);
  }

  async writeValueWithoutResponse(bufferSource) {
    await send(this.uuid, toByteArray(bufferSource), "withoutResponse", this._serviceUuid);
  }
}

function getPrimaryService(device, serviceUuid) {
  const wanted = normalizeUuid(serviceUuid);
  const match = (device._services || []).find((service) => service.uuid.toLowerCase() === wanted);
  if (!match) {
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
      return new FakeBluetoothCharacteristic(match.uuid, characteristic.uuid);
    },
  };
}

async function forceDisconnectActive() {
  const previous = registry.activeDevice;
  if (!previous) return;
  registry.activeDevice = null;
  try {
    await disconnect();
  } catch {
    // Already disconnected is fine — we're about to connect elsewhere anyway.
  }
  previous.dispatchEvent(new Event("gattserverdisconnected"));
}

async function connectFakeDevice(device) {
  if (registry.activeDevice && registry.activeDevice !== device) {
    await forceDisconnectActive();
  }

  const adapterState = await getAdapterState().catch(() => "Unknown");
  if (adapterState === "Off") {
    throw new Error("Turn on Bluetooth to connect.");
  }

  await connect(device.id, () => {
    if (registry.activeDevice === device) registry.activeDevice = null;
    device.dispatchEvent(new Event("gattserverdisconnected"));
  });

  const services = await listServices(device.id);
  if (typeof services === "string") throw new Error(services);
  device._services = services;
  registry.activeDevice = device;
  return device.gatt;
}

async function disconnectFakeDevice(device) {
  if (registry.activeDevice !== device) return;
  registry.activeDevice = null;
  try {
    await disconnect();
  } catch {
    // Already disconnected.
  }
  device.dispatchEvent(new Event("gattserverdisconnected"));
}

let pickerStylesInjected = false;
function injectPickerStyles() {
  if (pickerStylesInjected) return;
  pickerStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    dialog.tauri-ble-picker {
      width: min(420px, 90vw);
      border: none;
      border-radius: 12px;
      padding: 20px;
      background: #1a1d24;
      color: #eef0f4;
      font-family: "Space Grotesk", system-ui, sans-serif;
    }
    dialog.tauri-ble-picker::backdrop { background: rgba(0, 0, 0, 0.5); }
    .tauri-ble-picker-form h2 { margin: 0 0 8px; font-size: 17px; }
    .tauri-ble-picker-hint { margin: 0 0 12px; color: #9aa3b2; font-size: 13px; }
    .tauri-ble-picker-list { list-style: none; margin: 0 0 12px; padding: 0; max-height: 260px; overflow-y: auto; }
    .tauri-ble-picker-device {
      display: block; width: 100%; text-align: left; padding: 10px 12px; margin-bottom: 6px;
      background: #262a33; color: inherit; border: 1px solid #383e4a; border-radius: 8px; cursor: pointer;
    }
    .tauri-ble-picker-device:hover { background: #313744; }
    .tauri-ble-picker-toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #c3c9d4; margin-bottom: 16px; }
    .tauri-ble-picker-actions { display: flex; justify-content: flex-end; }
    .tauri-ble-picker-cancel {
      padding: 8px 16px; border-radius: 8px; border: 1px solid #383e4a; background: transparent; color: inherit; cursor: pointer;
    }
  `;
  document.head.appendChild(style);
}

function pickDevice(filters) {
  injectPickerStyles();
  return new Promise((resolve, reject) => {
    const dialog = document.createElement("dialog");
    dialog.className = "tauri-ble-picker";
    dialog.innerHTML = `
      <form method="dialog" class="tauri-ble-picker-form">
        <h2>Select a Bluetooth device</h2>
        <p class="tauri-ble-picker-hint">Scanning for nearby devices…</p>
        <ul class="tauri-ble-picker-list" role="listbox"></ul>
        <label class="tauri-ble-picker-toggle">
          <input type="checkbox" class="tauri-ble-picker-show-all">
          Show all nearby devices
        </label>
        <div class="tauri-ble-picker-actions">
          <button type="button" class="tauri-ble-picker-cancel">Cancel</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);

    const list = dialog.querySelector(".tauri-ble-picker-list");
    const hint = dialog.querySelector(".tauri-ble-picker-hint");
    const showAllToggle = dialog.querySelector(".tauri-ble-picker-show-all");
    const cancelBtn = dialog.querySelector(".tauri-ble-picker-cancel");

    let settled = false;
    let latestDevices = [];

    function finish(result, error) {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      void stopScan().catch(() => {});
      if (error) reject(error);
      else resolve(result);
    }

    function renderList() {
      const visible = latestDevices.filter((d) => showAllToggle.checked || deviceMatchesFilters(d, filters));
      list.innerHTML = "";
      hint.textContent = visible.length ? "Select a device to connect:" : "Scanning for nearby devices…";
      for (const device of visible) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tauri-ble-picker-device";
        button.textContent = device.name?.trim() ? `${device.name} (${device.address})` : device.address;
        button.addEventListener("click", () => finish(device));
        item.appendChild(button);
        list.appendChild(item);
      }
    }

    showAllToggle.addEventListener("change", renderList);
    cancelBtn.addEventListener("click", () => {
      finish(null, new DOMException("User cancelled the requestDevice() chooser.", "NotFoundError"));
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null, new DOMException("User cancelled the requestDevice() chooser.", "NotFoundError"));
    });

    startScan((devices) => {
      latestDevices = devices;
      renderList();
    }, PICKER_SCAN_TIMEOUT_MS).catch((error) => {
      finish(null, error instanceof Error ? error : new Error(String(error)));
    });

    dialog.showModal();
  });
}

async function requestDevice(options = {}) {
  const permitted = await checkPermissions(true).catch(() => false);
  if (!permitted) {
    throw new Error("Bluetooth permission was not granted. Enable it in System Settings → Privacy & Security → Bluetooth.");
  }
  const adapterState = await getAdapterState().catch(() => "Unknown");
  if (adapterState === "Off") {
    throw new Error("Turn on Bluetooth to pair a device.");
  }

  const picked = await pickDevice(options.filters || []);
  return new FakeBluetoothDevice(picked.address, picked.name || picked.address);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getDevices() {
  const permitted = await checkPermissions(false).catch(() => false);
  if (!permitted) return [];

  const found = new Map();
  const scanning = startScan((devices) => {
    for (const device of devices) found.set(device.address, device);
  }, RECONNECT_SCAN_TIMEOUT_MS).catch(() => {});
  await delay(RECONNECT_SCAN_TIMEOUT_MS);
  await stopScan().catch(() => {});
  await scanning;

  return Array.from(found.values(), (device) => new FakeBluetoothDevice(device.address, device.name || device.address));
}

if (isTauri && !navigator.bluetooth) {
  navigator.bluetooth = { requestDevice, getDevices };
}
