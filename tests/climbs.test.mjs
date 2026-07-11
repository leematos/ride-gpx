import assert from "node:assert/strict";
import test from "node:test";
import { detectClimbs } from "../app/route/climbs.mjs";

// Every test passes the leaky-bucket parameters explicitly so this suite
// exercises the algorithm (bucket fill/drain, dip bridging, sanity filters),
// never the shipped tuning values — retuning climb detection must not break
// these tests.
const BUCKET = {
  fatigueThreshold: 300,
  maxFatigue: 900,
  restingGradientPercent: 0.5,
  recoveryMultiplier: 0.4,
  smoothingWindowSize: 1, // no pre-smoothing: tests control the geometry exactly
  minGainMeters: 20,
  minAverageGradePercent: 1.5,
};

// Build an enriched-route-shaped array from [distanceMeters, elevationMeters]
// pairs (detectClimbs only reads `distance` and `ele`).
function routeOf(points) {
  return points.map(([distance, ele]) => ({ distance, ele }));
}

// A straight segment climbing `gain` meters over `length` meters, sampled
// every `step` meters, starting at (startDistance, startEle).
function slope(points, { length, gain, step = 100 }) {
  const [startDistance, startEle] = points.length
    ? points[points.length - 1]
    : [0, 0];
  const count = Math.round(length / step);
  for (let i = 1; i <= count; i += 1) {
    points.push([startDistance + i * step, startEle + (gain * i) / count]);
  }
  return points;
}

test("a sustained climb is detected with its geometry", () => {
  // 4 km at 6% after a 1 km flat lead-in.
  const points = slope(slope([[0, 200]], { length: 1000, gain: 0 }), { length: 4000, gain: 240 });
  const climbs = detectClimbs(routeOf(points), BUCKET);

  assert.equal(climbs.length, 1);
  const [climb] = climbs;
  // The base is tagged retroactively at the last flat point before the grade.
  assert.equal(climb.startDistanceMeters, 1000);
  assert.equal(climb.endDistanceMeters, 5000);
  assert.ok(Math.abs(climb.gainMeters - 240) < 1);
  assert.ok(Math.abs(climb.averageGradePercent - 6) < 0.1);
});

test("a dead-flat route detects nothing", () => {
  const points = slope([[0, 100]], { length: 10_000, gain: 0 });
  assert.equal(detectClimbs(routeOf(points), BUCKET).length, 0);
});

test("a brief dip does not split one climb into two", () => {
  // 2 km at 6%, a 200 m -2% dip, then 2 km at 6% — one climb, not two.
  let points = slope([[0, 300]], { length: 2000, gain: 120 });
  points = slope(points, { length: 200, gain: -4 });
  points = slope(points, { length: 2000, gain: 120 });
  const climbs = detectClimbs(routeOf(points), BUCKET);

  assert.equal(climbs.length, 1);
  assert.equal(climbs[0].startDistanceMeters, 0);
  assert.equal(climbs[0].endDistanceMeters, 4200);
});

test("a long descent drains the bucket and closes the climb", () => {
  // 2 km at 6% up, 3 km at -5% down, then 2 km at 6% up again — two climbs.
  let points = slope([[0, 300]], { length: 2000, gain: 120 });
  points = slope(points, { length: 3000, gain: -150 });
  points = slope(points, { length: 2000, gain: 120 });
  const climbs = detectClimbs(routeOf(points), BUCKET);

  assert.equal(climbs.length, 2);
  assert.equal(climbs[0].endDistanceMeters, 2000);
  assert.equal(climbs[1].startDistanceMeters, 5000);
});

test("small total gain is rejected by the min-gain sanity check", () => {
  // Steep but tiny: 150 m at 8% is only 12 m of gain — under the 20 m floor.
  const points = slope([[0, 100]], { length: 150, gain: 12, step: 25 });
  assert.equal(detectClimbs(routeOf(points), BUCKET).length, 0);
  // The same profile passes once the explicit floor allows it.
  assert.equal(detectClimbs(routeOf(points), { ...BUCKET, minGainMeters: 10 }).length, 1);
});

test("a near-flat false drag is rejected by the min-average-grade check", () => {
  // 30 m of gain over 6 km is only 0.5% average — well under the 1.5% floor
  // (kept above restingGradientPercent so the bucket still fills).
  const points = slope([[0, 100]], { length: 6000, gain: 60 });
  const filtered = detectClimbs(routeOf(points), { ...BUCKET, minAverageGradePercent: 1.5 });
  assert.equal(filtered.length, 0);
  const kept = detectClimbs(routeOf(points), { ...BUCKET, minAverageGradePercent: 0.8 });
  assert.equal(kept.length, 1);
});

test("the fatigue threshold decides how much sustained grade counts as a climb", () => {
  // 500 m at 4%: fills (4 − 0.5) × 500 = 1750 fatigue — a climb at threshold
  // 300, ignored entirely when the threshold is out of reach.
  const points = slope([[0, 100]], { length: 500, gain: 20 });
  assert.equal(detectClimbs(routeOf(points), BUCKET).length, 1);
  assert.equal(detectClimbs(routeOf(points), { ...BUCKET, fatigueThreshold: 2000 }).length, 0);
});

test("maxFatigue caps the bucket so a huge climb still closes on descent", () => {
  // A 10 km alpine climb followed by a descent just long enough to drain a
  // capped bucket: with the cap the climb closes and a later riser is a new
  // climb; with an uncapped (huge) bucket the fatigue never drains in time.
  let points = slope([[0, 500]], { length: 10_000, gain: 800 });
  points = slope(points, { length: 2600, gain: -130 });
  points = slope(points, { length: 1000, gain: 60 });
  const capped = detectClimbs(routeOf(points), BUCKET);
  assert.equal(capped.length, 2, "capped bucket closes after the descent");
  const uncapped = detectClimbs(routeOf(points), { ...BUCKET, maxFatigue: 1e9 });
  assert.equal(uncapped.length, 1, "uncapped bucket rides through the descent");
});

test("elevation smoothing flattens micro-jitter before detection", () => {
  // ±3 m sawtooth on a flat road: raw geometry has grade spikes; a 5-point
  // moving average flattens them below the resting gradient.
  const points = [];
  for (let i = 0; i <= 100; i += 1) points.push([i * 50, 100 + (i % 2 ? 3 : 0)]);
  const smoothed = detectClimbs(routeOf(points), { ...BUCKET, smoothingWindowSize: 5 });
  assert.equal(smoothed.length, 0);
});

test("gainMeters is accumulated gain, so rolling climbs keep their upward work", () => {
  // Three 30 m steps with 10 m drops between them: net 70 m from base to
  // peak, but 90 m of accumulated climbing.
  let points = slope([[0, 100]], { length: 1000, gain: 30 });
  points = slope(points, { length: 200, gain: -10 });
  points = slope(points, { length: 1000, gain: 30 });
  points = slope(points, { length: 200, gain: -10 });
  points = slope(points, { length: 1000, gain: 30 });
  const climbs = detectClimbs(routeOf(points), BUCKET);

  assert.equal(climbs.length, 1);
  assert.ok(Math.abs(climbs[0].gainMeters - 90) < 1, `accumulated gain ${climbs[0].gainMeters}`);
  assert.ok(Math.abs(climbs[0].netGainMeters - 70) < 1, `net gain ${climbs[0].netGainMeters}`);
});

test("a climb running through the finish line is flushed", () => {
  const points = slope([[0, 100]], { length: 3000, gain: 180 });
  const climbs = detectClimbs(routeOf(points), BUCKET);
  assert.equal(climbs.length, 1);
  assert.equal(climbs[0].endDistanceMeters, 3000);
});
