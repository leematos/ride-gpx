import assert from "node:assert/strict";
import test from "node:test";
import { deviceMatchesFilters, normalizeUuid, toByteArray } from "../app/trainer/ble-uuid.mjs";

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

test("deviceMatchesFilters accepts everything when there are no filters", () => {
  assert.equal(deviceMatchesFilters({ name: "Anything", services: [] }, []), true);
  assert.equal(deviceMatchesFilters({ name: "Anything", services: [] }, undefined), true);
});

test("deviceMatchesFilters matches by advertised service UUID", () => {
  const device = { name: "KICKR CORE", services: ["00001826-0000-1000-8000-00805f9b34fb"] };
  assert.equal(deviceMatchesFilters(device, [{ services: [0x1826] }]), true);
  assert.equal(deviceMatchesFilters(device, [{ services: [0x180d] }]), false);
});

test("deviceMatchesFilters matches by name prefix and exact name", () => {
  const device = { name: "Tacx Flow", services: [] };
  assert.equal(deviceMatchesFilters(device, [{ namePrefix: "Tacx" }]), true);
  assert.equal(deviceMatchesFilters(device, [{ namePrefix: "KICKR" }]), false);
  assert.equal(deviceMatchesFilters(device, [{ name: "Tacx Flow" }]), true);
  assert.equal(deviceMatchesFilters({ name: "Other", services: [] }, [{ name: "Tacx Flow" }]), false);
});

test("deviceMatchesFilters matches if any filter in the list matches", () => {
  const device = { name: "Tacx Flow", services: [] };
  const filters = [{ services: [0x1826] }, { namePrefix: "Tacx" }];
  assert.equal(deviceMatchesFilters(device, filters), true);
});

test("deviceMatchesFilters copes with a device that has no name or services", () => {
  assert.equal(deviceMatchesFilters({}, [{ namePrefix: "KICKR" }]), false);
  assert.equal(deviceMatchesFilters({}, [{ services: [0x1826] }]), false);
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
