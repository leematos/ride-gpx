import assert from "node:assert/strict";
import test from "node:test";
import {
  createRideEstimator,
  estimateRemainingSeconds,
  flatEquivalentMeters,
  recordEstimatorTick,
} from "../app/ride/eta.mjs";

// Tests pass explicit model parameters so they exercise the algorithm, never
// the shipped tuning values — retuning the config must not break this suite.
const MODEL = { climbEquivalentFactor: 25, descentCreditFactor: 5 };
const HISTORY = { minHistorySeconds: 45, minHistoryMeters: 150 };

test("flatEquivalentMeters charges climbs and credits descents", () => {
  assert.equal(flatEquivalentMeters({ distanceMeters: 1000, ...MODEL }), 1000);
  assert.equal(
    flatEquivalentMeters({ distanceMeters: 1000, ascentMeters: 80, ...MODEL }),
    1000 + 80 * 25,
  );
  assert.equal(
    flatEquivalentMeters({ distanceMeters: 1000, descentMeters: 80, ...MODEL }),
    1000 - 80 * 5,
  );
  // Never negative, whatever the descent credit adds up to.
  assert.equal(flatEquivalentMeters({ distanceMeters: 10, descentMeters: 1000, ...MODEL }), 0);
});

test("estimator falls back to the given speed until history accrues", () => {
  const estimator = createRideEstimator();

  // 36 km/h = 10 m/s → 1000 m remaining = 100 s.
  const eta = estimateRemainingSeconds(estimator, { remainingMeters: 1000, fallbackSpeedKph: 36, ...HISTORY });
  assert.equal(eta, 100);

  assert.equal(estimateRemainingSeconds(estimator, { remainingMeters: 1000, ...HISTORY }), null);
  assert.equal(estimateRemainingSeconds(estimator, { remainingMeters: 0, fallbackSpeedKph: 36, ...HISTORY }), 0);
});

test("estimator projects the measured flat-equivalent pace onto the remaining route", () => {
  const estimator = createRideEstimator();

  // Ride 10 minutes on the flat at 6 m/s (fed in one-second ticks).
  for (let i = 0; i < 600; i += 1) {
    recordEstimatorTick(estimator, { elapsedSeconds: 1, distanceMeters: 6, ...MODEL });
  }
  assert.ok(estimator.movingSeconds >= HISTORY.minHistorySeconds);

  // Flat finish: plain distance/speed.
  assert.equal(Math.round(estimateRemainingSeconds(estimator, { remainingMeters: 3600, ...MODEL, ...HISTORY })), 600);

  // The same distance with 100 m of climbing left takes longer; with 100 m
  // of descending left it takes less.
  const climbing = estimateRemainingSeconds(estimator, { remainingMeters: 3600, remainingAscentMeters: 100, ...MODEL, ...HISTORY });
  const descending = estimateRemainingSeconds(estimator, { remainingMeters: 3600, remainingDescentMeters: 100, ...MODEL, ...HISTORY });
  assert.ok(climbing > 600, `climbing ETA ${climbing} should exceed flat 600`);
  assert.ok(descending < 600, `descending ETA ${descending} should beat flat 600`);
});

test("a slow climb does not project a slow descent", () => {
  const estimator = createRideEstimator();

  // Climb for 10 minutes: 2.5 m/s ground speed on an 8% grade. In
  // flat-equivalent terms this is a normal recreational pace.
  for (let i = 0; i < 600; i += 1) {
    recordEstimatorTick(estimator, { elapsedSeconds: 1, distanceMeters: 2.5, ascentMeters: 0.2, ...MODEL });
  }

  // Naive distance/speed for the remaining flat 3 km would say 1200 s; the
  // flat-equivalent model knows the crawl was the climb's fault.
  const eta = estimateRemainingSeconds(estimator, { remainingMeters: 3000, ...MODEL, ...HISTORY });
  assert.ok(eta < 600, `flat finish after a climb should be fast, got ${eta}`);

  // Standing still contributes nothing (guards against divide-by-zero).
  recordEstimatorTick(estimator, { elapsedSeconds: 1, distanceMeters: 0, ...MODEL });
  assert.ok(Number.isFinite(estimateRemainingSeconds(estimator, { remainingMeters: 100, ...MODEL, ...HISTORY })));
});
