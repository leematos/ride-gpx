// Pure BLE UUID helpers shared by tauri-ble-shim.mjs: normalizing a 16-bit
// Bluetooth SIG UUID (a bare number, e.g. FTMS's 0x1826, or the 4/8-hex-digit
// short forms) to its full 128-bit form so it can be compared against the
// UUID strings tauri-plugin-blec returns, and matching a scanned device
// against Web Bluetooth `requestDevice()`-style filters.

const BASE_UUID_SUFFIX = "-0000-1000-8000-00805f9b34fb";

export function normalizeUuid(uuid) {
  if (typeof uuid === "number") {
    return `0000${uuid.toString(16).padStart(4, "0")}${BASE_UUID_SUFFIX}`;
  }
  const value = String(uuid).toLowerCase();
  if (/^[0-9a-f]{4}$/.test(value)) return `0000${value}${BASE_UUID_SUFFIX}`;
  if (/^[0-9a-f]{8}$/.test(value)) return `${value}${BASE_UUID_SUFFIX}`;
  return value;
}

export function deviceMatchesFilters(bleDevice, filters) {
  if (!filters || filters.length === 0) return true;
  const advertised = (bleDevice.services || []).map((uuid) => uuid.toLowerCase());
  return filters.some((filter) => {
    if (filter.services?.some((uuid) => advertised.includes(normalizeUuid(uuid)))) return true;
    if (filter.namePrefix && bleDevice.name?.startsWith(filter.namePrefix)) return true;
    if (filter.name && bleDevice.name === filter.name) return true;
    return false;
  });
}

export function toByteArray(bufferSource) {
  if (ArrayBuffer.isView(bufferSource)) {
    return Array.from(new Uint8Array(bufferSource.buffer, bufferSource.byteOffset, bufferSource.byteLength));
  }
  if (bufferSource instanceof ArrayBuffer) return Array.from(new Uint8Array(bufferSource));
  return Array.from(bufferSource);
}
