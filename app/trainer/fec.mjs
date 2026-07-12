// Pure Tacx FE-C (ANT+ FitnessEquipment Control) codec for the FE-C over BLE
// trainer backend. No DOM, no BLE, no app state — byte-in / byte-out so it is
// unit-tested exactly like fit.mjs. The wheel-on Tacx trainers (Flow, Vortex,
// Bushido, Genius) don't speak FTMS; they tunnel standard ANT+ FE-C messages
// over the vendor service 6e40fec1, and this module owns that wire format.
//
// Two layers are kept deliberately separate so the BLE module can compose them
// and adapt to how a given device frames its data:
//   1. ANT serial framing — [0xA4 sync][len][msgId][channel][…8 data bytes]
//      [XOR checksum]. buildAntFrame / parseAntFrame handle that envelope.
//   2. FE-C data pages — the 8-byte ANT+ FE-C payloads. decodeFecPage reads
//      the trainer's telemetry (page 16 General FE Data, page 25 Specific
//      Trainer Data); encodeTrackResistancePage writes the grade command
//      (page 51 Track Resistance).

export const ANT_SYNC = 0xa4;
export const ANT_BROADCAST_DATA = 0x4e; // trainer -> app (telemetry)
export const ANT_ACKNOWLEDGED_DATA = 0x4f; // app -> trainer (control)

export const FEC_PAGE_GENERAL = 0x10; // 16 — General FE Data (speed, HR)
export const FEC_PAGE_TRAINER = 0x19; // 25 — Specific Trainer Data (power, cadence)
export const FEC_PAGE_TRACK_RESISTANCE = 0x33; // 51 — Track Resistance (grade)

// Page 51 grade field: uint16, 0.01% resolution, encoded with a -200% offset.
const GRADE_MIN_PERCENT = -200;
const GRADE_MAX_PERCENT = 200;
const GRADE_OFFSET_PERCENT = 200;
const GRADE_UNITS_PER_PERCENT = 100;
const GRADE_INVALID = 0xffff;

// Page 16 speed field: uint16 in units of 0.001 m/s.
const SPEED_UNITS_MPS = 0.001;
const MPS_TO_KPH = 3.6;
const SPEED_INVALID = 0xffff;

// Page 25 instantaneous power: 12-bit value in watts. 0x0FFF marks invalid.
const POWER_INVALID = 0x0fff;
const CADENCE_INVALID = 0xff;
const HEART_RATE_INVALID = 0xff;

// Page 51 rolling-resistance coefficient: uint8 in units of 5x10^-5.
const CRR_UNITS = 5e-5;
const CRR_INVALID = 0xff;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toBytes(value) {
  return value instanceof Uint8Array ? value : Uint8Array.from(value);
}

export function xorChecksum(bytes) {
  let checksum = 0;
  for (const byte of bytes) checksum ^= byte;
  return checksum & 0xff;
}

// Wrap an 8-byte FE-C data page in an ANT serial frame. The length byte counts
// the channel byte plus the data bytes (9 for FE-C).
export function buildAntFrame(msgId, channel, data) {
  const head = [ANT_SYNC, 1 + data.length, msgId, channel, ...data];
  return Uint8Array.from([...head, xorChecksum(head)]);
}

// Parse an ANT serial frame, returning { msgId, channel, data } or null when
// the bytes are not a valid, checksum-correct frame — so the caller can fall
// back to treating the notification as a bare page.
export function parseAntFrame(bytes) {
  const arr = toBytes(bytes);
  if (arr.length < 5 || arr[0] !== ANT_SYNC) return null;
  const totalLength = arr[1] + 4; // sync + len + msgId + payload + checksum
  if (arr.length < totalLength) return null;
  const frame = arr.subarray(0, totalLength);
  if (frame[totalLength - 1] !== xorChecksum(frame.subarray(0, totalLength - 1))) return null;
  return {
    msgId: frame[2],
    channel: frame[3],
    data: Uint8Array.from(frame.subarray(4, totalLength - 1)),
  };
}

// Encode FE-C page 51 (Track Resistance): the terrain grade the trainer should
// simulate, plus a rolling-resistance coefficient. Grade is clamped to the
// FE-C range so one bad elevation point can't send an out-of-range command.
export function encodeTrackResistancePage(gradePercent, { crr = 0.004 } = {}) {
  const grade = clamp(gradePercent, GRADE_MIN_PERCENT, GRADE_MAX_PERCENT);
  const raw = clamp(
    Math.round((grade + GRADE_OFFSET_PERCENT) * GRADE_UNITS_PER_PERCENT),
    0,
    GRADE_INVALID - 1,
  );
  const crrRaw = crr == null ? CRR_INVALID : clamp(Math.round(crr / CRR_UNITS), 0, CRR_INVALID - 1);
  return Uint8Array.from([
    FEC_PAGE_TRACK_RESISTANCE,
    0xff, 0xff, 0xff, 0xff, // reserved
    raw & 0xff, (raw >> 8) & 0xff,
    crrRaw,
  ]);
}

// Decode a trainer telemetry page into partial telemetry. Returns null for
// pages this app doesn't read, so the caller merges only real updates. Fields
// that the trainer flags invalid come back as null (distinct from a real 0).
export function decodeFecPage(page) {
  const arr = toBytes(page);
  if (arr.length < 8) return null;
  const pageNumber = arr[0];

  if (pageNumber === FEC_PAGE_GENERAL) {
    const speedRaw = arr[4] | (arr[5] << 8);
    const heartRate = arr[6];
    return {
      page: pageNumber,
      speedKph: speedRaw === SPEED_INVALID ? null : speedRaw * SPEED_UNITS_MPS * MPS_TO_KPH,
      heartRateBpm: heartRate === HEART_RATE_INVALID || heartRate === 0 ? null : heartRate,
    };
  }

  if (pageNumber === FEC_PAGE_TRAINER) {
    const cadence = arr[2];
    const powerRaw = arr[5] | ((arr[6] & 0x0f) << 8);
    return {
      page: pageNumber,
      cadenceRpm: cadence === CADENCE_INVALID ? null : cadence,
      powerWatts: powerRaw === POWER_INVALID ? null : powerRaw,
    };
  }

  return null;
}
