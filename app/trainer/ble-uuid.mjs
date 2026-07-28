// Pure BLE helpers shared by tauri-ble-shim.mjs: normalizing a 16-bit
// Bluetooth SIG UUID (a bare number, e.g. FTMS's 0x1826, or the 4/8-hex-digit
// short forms) to its full 128-bit form so it can be compared against the
// UUID strings tauri-plugin-web-bluetooth-api returns, plus the
// bytes/base64 conversions its characteristic read/write/notify commands
// use on the wire instead of Web Bluetooth's raw byte arrays.

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

export function toByteArray(bufferSource) {
  if (ArrayBuffer.isView(bufferSource)) {
    return Array.from(new Uint8Array(bufferSource.buffer, bufferSource.byteOffset, bufferSource.byteLength));
  }
  if (bufferSource instanceof ArrayBuffer) return Array.from(new Uint8Array(bufferSource));
  return Array.from(bufferSource);
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
