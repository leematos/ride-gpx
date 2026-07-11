import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceDemoRide,
  createDemoRideModel,
  demoSpeedForPower,
  demoTargetPowerWatts,
  seedDemoHistory,
} from "../app/demo/demo.mjs";

// A pinned rider profile so the tests exercise the physics/HR model, never
// the shipped DEMO_RIDE tuning — retuning demo mode must not break this suite.
const TEST_RIDE = {
  riderWeightKg: 100,
  bikeWeightKg: 9,
  ftpWatts: 270,
  maxHeartRateBpm: 180,
  restingHeartRateBpm: 86,
  thresholdHeartRateBpm: 155,
  maxHistorySamples: 3600,
  flatPowerWatts: 205,
  climbWattsPerGradePercent: 13.5,
  descentWattsPerGradePercent: 24,
  minPowerWatts: 85,
  maxPowerWatts: 360,
  powerSmoothingTauSeconds: 7,
  rollingResistanceCoefficient: 0.005,
  dragAreaSquareMeters: 0.48,
  airDensityKgPerCubicMeter: 1.225,
  drivetrainEfficiency: 0.96,
  minSpeedKph: 5,
  maxSpeedKph: 72,
  speedSmoothingTauSeconds: 5,
  heartRateUpdateIntervalSeconds: 1,
  heartRateRiseTauSeconds: 30,
  heartRateFallDelaySeconds: 16,
  heartRateFallTauSeconds: 78,
  lowEffortReturnDelaySeconds: 120,
  heartRateNoiseBpm: 1,
};

test("demo target power rises on climbs and backs off on descents", () => {
  assert.ok(demoTargetPowerWatts(7, TEST_RIDE) > demoTargetPowerWatts(0, TEST_RIDE));
  assert.ok(demoTargetPowerWatts(-5, TEST_RIDE) < demoTargetPowerWatts(0, TEST_RIDE));
});

test("demo speed solve slows uphill and speeds downhill at the same power", () => {
  const flat = demoSpeedForPower(220, 0, TEST_RIDE);
  const climb = demoSpeedForPower(220, 8, TEST_RIDE);
  const descent = demoSpeedForPower(220, -5, TEST_RIDE);

  assert.ok(climb < flat, `${climb} kph should be slower than ${flat} kph`);
  assert.ok(descent > flat, `${descent} kph should be faster than ${flat} kph`);
});

test("demo heart rate settles near threshold HR at FTP power", () => {
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const config = { ...TEST_RIDE, flatPowerWatts: TEST_RIDE.ftpWatts };
    const model = createDemoRideModel(config);

    for (let i = 0; i < 240; i += 1) {
      advanceDemoRide(model, {
        elapsedSeconds: 1,
        gradePercent: 0,
        point: { lat: 50, lng: 14, ele: 300 },
        routeProgressMeters: i * 6,
        metersAdvanced: 6,
        caloriesFromPower: 0,
        config,
      });
    }

    assert.ok(Math.abs(model.heartRateBpm - TEST_RIDE.thresholdHeartRateBpm) <= 3);
  } finally {
    Math.random = originalRandom;
  }
});

test("demo heart rate publishes at most once a second", () => {
  const originalRandom = Math.random;
  let randomValue = 0.9;
  Math.random = () => randomValue;
  try {
    const model = createDemoRideModel(TEST_RIDE);
    advanceDemoRide(model, {
      elapsedSeconds: 1,
      gradePercent: 0,
      point: { lat: 50, lng: 14, ele: 300 },
      routeProgressMeters: 0,
      metersAdvanced: 0,
      caloriesFromPower: 0,
    });
    const first = model.heartRateBpm;
    randomValue = 0.1;
    advanceDemoRide(model, {
      elapsedSeconds: 0.25,
      gradePercent: 8,
      point: { lat: 50, lng: 14, ele: 301 },
      routeProgressMeters: 2,
      metersAdvanced: 2,
      caloriesFromPower: 0,
    });

    assert.equal(model.heartRateBpm, first);
  } finally {
    Math.random = originalRandom;
  }
});

test("demo history can be seeded up to the current route position", () => {
  const model = createDemoRideModel(TEST_RIDE);
  const route = [
    { lat: 50, lng: 14, ele: 300, distance: 0 },
    { lat: 50.005, lng: 14.005, ele: 330, distance: 500 },
    { lat: 50.01, lng: 14.01, ele: 310, distance: 1000 },
  ];

  seedDemoHistory(model, {
    route,
    progressMeters: 750,
    nowSeconds: 1000,
  });

  assert.ok(model.historySamples.length > 2);
  assert.ok(model.historySamples.at(-1).routeProgressMeters >= 749);
  assert.ok(model.elapsedSeconds > 0);
  assert.ok(model.caloriesKcal > 0);
  assert.ok(Number.isFinite(model.historySamples.at(-1).speedKph));
  assert.ok(Number.isFinite(model.historySamples.at(-1).powerWatts));
  assert.ok(Number.isFinite(model.historySamples.at(-1).heartRateBpm));
});
