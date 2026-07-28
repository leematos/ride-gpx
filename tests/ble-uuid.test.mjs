import assert from "node:assert/strict";
import test from "node:test";
import { base64ToBytes, bytesToBase64, normalizeUuid, toByteArray } from "../app/trainer/ble-uuid.mjs";

test("normalizeUuid expands a 16-bit Bluetooth SIG number to the full base UUID", () => {
  assert.equal(normalizeUuid(0x1826), "00001826-0000-1000-8000-00805f9b34fb");
  assert.equal(normalizeUuid(0x180d), "0000180d-0000-1000-8000-00805f9b34fb");
});

test("normalizeUuid expands 4- and 8-hex-digit short forms", () => {
  assert.equal(normalizeUuid("1826"), "00001826-0000-1000-8000-00805f9b34fb");
  assert.equal(normalizeUuid("2AD9"), "00002ad9-0000-1000-8000-00805f9b34fb");
  assert.equal(normalizeUuid("6e40fec1"), "6e40fec1-0000-1000-8000-00805f9b34fb");
});

test("normalizeUuid passes a full 128-bit UUID through, lower-cased", () => {
  assert.equal(
    normalizeUuid("6E40FEC1-B5A3-F393-E0A9-E50E24DCCA9E"),
    "6e40fec1-b5a3-f393-e0a9-e50e24dcca9e",
  );
});

test("toByteArray converts a Uint8Array to a plain number array", () => {
  assert.deepEqual(toByteArray(new Uint8Array([1, 2, 3])), [1, 2, 3]);
});

test("toByteArray converts a raw ArrayBuffer", () => {
  const buffer = new Uint8Array([9, 8, 7]).buffer;
  assert.deepEqual(toByteArray(buffer), [9, 8, 7]);
});

test("toByteArray respects a typed array's byteOffset/byteLength view into a shared buffer", () => {
  const buffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;
  const view = new Uint8Array(buffer, 1, 3);
  assert.deepEqual(toByteArray(view), [2, 3, 4]);
});

test("bytesToBase64 and base64ToBytes round-trip arbitrary byte values", () => {
  const bytes = new Uint8Array([0, 1, 2, 0x7f, 0x80, 0xff, 0x51, 0x40]);
  const encoded = bytesToBase64(bytes);
  assert.equal(typeof encoded, "string");
  assert.deepEqual(Array.from(base64ToBytes(encoded)), Array.from(bytes));
});

test("bytesToBase64 round-trips the empty array", () => {
  assert.deepEqual(Array.from(base64ToBytes(bytesToBase64([]))), []);
});
