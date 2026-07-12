import assert from "node:assert/strict";
import test from "node:test";
import {
  ANT_ACKNOWLEDGED_DATA,
  ANT_BROADCAST_DATA,
  ANT_SYNC,
  buildAntFrame,
  decodeFecPage,
  encodeTrackResistancePage,
  parseAntFrame,
  xorChecksum,
} from "../app/trainer/fec.mjs";

test("xorChecksum XORs every byte", () => {
  assert.equal(xorChecksum([0xa4, 0x09, 0x4e]), 0xa4 ^ 0x09 ^ 0x4e);
  assert.equal(xorChecksum([]), 0);
});

test("buildAntFrame produces sync, length, checksum-terminated ANT frame", () => {
  const page = new Uint8Array([0x10, 1, 2, 3, 4, 5, 6, 7]);
  const frame = buildAntFrame(ANT_BROADCAST_DATA, 0x05, page);
  // sync + len + msgId + channel + 8 data + checksum
  assert.equal(frame.length, 13);
  assert.equal(frame[0], ANT_SYNC);
  assert.equal(frame[1], 0x09); // channel + 8 data bytes
  assert.equal(frame[2], ANT_BROADCAST_DATA);
  assert.equal(frame[3], 0x05);
  assert.equal(frame[12], xorChecksum(frame.subarray(0, 12)));
});

test("parseAntFrame round-trips buildAntFrame and recovers the page", () => {
  const page = new Uint8Array([0x19, 9, 90, 0, 0, 0xfa, 0x00, 0x00]);
  const frame = buildAntFrame(ANT_ACKNOWLEDGED_DATA, 0x03, page);
  const parsed = parseAntFrame(frame);
  assert.equal(parsed.msgId, ANT_ACKNOWLEDGED_DATA);
  assert.equal(parsed.channel, 0x03);
  assert.deepEqual([...parsed.data], [...page]);
});

test("parseAntFrame rejects bad sync, bad checksum, and truncated frames", () => {
  const page = new Uint8Array([0x10, 0, 0, 0, 0, 0, 0, 0]);
  const frame = buildAntFrame(ANT_BROADCAST_DATA, 0x05, page);

  const wrongSync = Uint8Array.from(frame);
  wrongSync[0] = 0x00;
  assert.equal(parseAntFrame(wrongSync), null);

  const badChecksum = Uint8Array.from(frame);
  badChecksum[badChecksum.length - 1] ^= 0xff;
  assert.equal(parseAntFrame(badChecksum), null);

  assert.equal(parseAntFrame(frame.subarray(0, 6)), null);
});

test("encodeTrackResistancePage encodes grade with the -200% offset at 0.01%", () => {
  // 0% grade -> (0 + 200) * 100 = 20000 = 0x4E20 (little-endian 0x20, 0x4E).
  const flat = encodeTrackResistancePage(0, { crr: 0.004 });
  assert.deepEqual([...flat], [0x33, 0xff, 0xff, 0xff, 0xff, 0x20, 0x4e, 0x50]);

  // 5% grade -> (205) * 100 = 20500 = 0x5014.
  const climb = encodeTrackResistancePage(5, { crr: 0.004 });
  assert.deepEqual([climb[5], climb[6]], [0x14, 0x50]);

  // -5% grade -> (195) * 100 = 19500 = 0x4C2C.
  const descent = encodeTrackResistancePage(-5, { crr: 0.004 });
  assert.deepEqual([descent[5], descent[6]], [0x2c, 0x4c]);
});

test("encodeTrackResistancePage clamps grade to the FE-C range", () => {
  // +300% clamps to +200% -> (400) * 100 = 40000 = 0x9C40.
  const tooSteep = encodeTrackResistancePage(300);
  assert.deepEqual([tooSteep[5], tooSteep[6]], [0x40, 0x9c]);
  // -300% clamps to -200% -> 0.
  const tooDeep = encodeTrackResistancePage(-300);
  assert.deepEqual([tooDeep[5], tooDeep[6]], [0x00, 0x00]);
});

test("decodeFecPage reads speed and heart rate from page 16", () => {
  // 10000 * 0.001 m/s = 10 m/s = 36 km/h; HR 150.
  const page = new Uint8Array([0x10, 0x19, 0, 0, 0x10, 0x27, 150, 0]);
  const decoded = decodeFecPage(page);
  assert.equal(decoded.page, 0x10);
  assert.ok(Math.abs(decoded.speedKph - 36) < 1e-9);
  assert.equal(decoded.heartRateBpm, 150);
});

test("decodeFecPage reads power and cadence from page 25", () => {
  // cadence 90, instantaneous power 250 (0x0FA) split across bytes 5 and 6.
  const page = new Uint8Array([0x19, 12, 90, 0, 0, 0xfa, 0x00, 0x00]);
  const decoded = decodeFecPage(page);
  assert.equal(decoded.page, 0x19);
  assert.equal(decoded.cadenceRpm, 90);
  assert.equal(decoded.powerWatts, 250);
});

test("decodeFecPage decodes the top of the 12-bit power range", () => {
  // power 2500 = 0x9C4 -> byte5 = 0xC4, byte6 low nibble = 0x09.
  const page = new Uint8Array([0x19, 12, 80, 0, 0, 0xc4, 0x09, 0x00]);
  assert.equal(decodeFecPage(page).powerWatts, 2500);
});

test("decodeFecPage returns null telemetry fields when the trainer flags invalid", () => {
  const noSpeed = new Uint8Array([0x10, 0x19, 0, 0, 0xff, 0xff, 0xff, 0]);
  const speedDecoded = decodeFecPage(noSpeed);
  assert.equal(speedDecoded.speedKph, null);
  assert.equal(speedDecoded.heartRateBpm, null);

  const noPower = new Uint8Array([0x19, 12, 0xff, 0, 0, 0xff, 0x0f, 0]);
  const powerDecoded = decodeFecPage(noPower);
  assert.equal(powerDecoded.powerWatts, null);
  assert.equal(powerDecoded.cadenceRpm, null);
});

test("decodeFecPage ignores pages this app doesn't read", () => {
  assert.equal(decodeFecPage(new Uint8Array([0x50, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(decodeFecPage(new Uint8Array([0x10, 0, 0])), null); // too short
});
