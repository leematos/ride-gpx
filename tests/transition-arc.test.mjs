import test from "node:test";
import assert from "node:assert/strict";

import { createCameraTransition } from "../app/camera/transition-arc.mjs";
import { cameraEyePosition } from "../app/camera/camera.mjs";

// The two real camera poses this feature was specified against (gallery
// previewCamera exports of the Ještěd route): the riding chase camera and the
// whole-route overview camera.
const CHASE_CAMERA = {
  center: { lat: 50.68775, lng: 15.091503, altitude: 540 },
  heading: 68.63,
  range: 238.9,
  tilt: 73.85,
  roll: 0,
  fov: 35,
};
const OVERVIEW_CAMERA = {
  center: { lat: 50.705977, lng: 14.980256, altitude: 454.7 },
  heading: -71.56,
  range: 6599.1,
  tilt: 75.03,
  roll: 17.29,
  fov: 60,
};

// Rider moving at 30 km/h along the chase camera's heading, climbing gently.
const RIDER_SPEED_MPS = 30 / 3.6;
const RIDER_VELOCITY = [
  RIDER_SPEED_MPS * Math.sin(toRad(CHASE_CAMERA.heading)),
  RIDER_SPEED_MPS * Math.cos(toRad(CHASE_CAMERA.heading)),
  0.3,
];

const BASE = {
  min_duration_seconds: 2,
  max_duration_seconds: 10,
  solver_step_seconds: 0.5,
  min_turn_radius_floor_meters: 30,
  min_turn_radius_distance_fraction: 0.08,
  max_climb_angle_degrees: 75,
  velocity_clamp_distance_fraction: 0.5,
  lookat_blend_in_fraction: 0.25,
  lookat_blend_out_fraction: 0.35,
  max_bank_degrees: 25,
  sample_count: 240,
  min_distance_meters: 1,
};

function cameraState(camera, velocity = [0, 0, 0], lookAtVelocity = velocity) {
  return {
    eye: cameraEyePosition(camera),
    lookAt: { ...camera.center },
    velocity,
    lookAtVelocity,
    rollDegrees: camera.roll,
    fovDegrees: camera.fov,
  };
}

const OVERVIEW_STATE = () => cameraState(OVERVIEW_CAMERA);
const CHASE_STATE = () => cameraState(CHASE_CAMERA, RIDER_VELOCITY.slice(), RIDER_VELOCITY.slice());

test("returns null for degenerate transitions", () => {
  const parked = cameraState(CHASE_CAMERA);
  assert.equal(createCameraTransition({ start: parked, end: cameraState(CHASE_CAMERA) }, BASE), null);
  assert.equal(createCameraTransition({ start: { ...parked, eye: null }, end: OVERVIEW_STATE() }, BASE), null);
  assert.equal(createCameraTransition({ start: parked, end: { ...OVERVIEW_STATE(), eye: { lat: NaN, lng: 15 } } }, BASE), null);
});

test("flies the overview→chase handoff with finite poses and a solved duration", () => {
  const arc = createCameraTransition({ start: OVERVIEW_STATE(), end: CHASE_STATE() }, BASE);
  assert.ok(arc, "an arc is returned for the real fixture pair");
  assert.ok(arc.durationSeconds >= BASE.min_duration_seconds - 1e-9);
  assert.ok(arc.durationSeconds <= BASE.max_duration_seconds + 1e-9);
  assert.ok(arc.distanceMeters > 1000, "the fixture cameras are far apart");
  assert.ok(arc.minTurnRadiusMeters >= BASE.min_turn_radius_floor_meters);

  for (let i = 0; i <= 100; i++) {
    const pose = arc.poseAt((i / 100) * arc.durationSeconds);
    for (const key of ["lat", "lng", "altitude"]) {
      assert.ok(Number.isFinite(pose.eye[key]), `eye.${key} finite at ${i}%`);
      assert.ok(Number.isFinite(pose.lookAt[key]), `lookAt.${key} finite at ${i}%`);
    }
    assert.ok(Number.isFinite(pose.rollDegrees));
    assert.ok(Number.isFinite(pose.fovDegrees));
  }
  assert.equal(arc.poseAt(0).done, false);
  assert.equal(arc.poseAt(arc.durationSeconds).done, true);
});

test("docks position, roll and fov exactly at both endpoints (both directions)", () => {
  for (const [start, end] of [[OVERVIEW_STATE(), CHASE_STATE()], [CHASE_STATE(), OVERVIEW_STATE()]]) {
    const arc = createCameraTransition({ start, end }, BASE);
    assert.ok(arc);

    for (const [pose, expected] of [[arc.poseAt(0), start], [arc.poseAt(arc.durationSeconds), end]]) {
      assert.ok(haversineMeters(pose.eye, expected.eye) < 0.5, "eye ground position docks");
      assert.ok(Math.abs(pose.eye.altitude - expected.eye.altitude) < 0.5, "eye altitude docks");
      assert.ok(haversineMeters(pose.lookAt, expected.lookAt) < 0.5, "look-at ground position docks");
      assert.ok(Math.abs(pose.lookAt.altitude - expected.lookAt.altitude) < 0.5, "look-at altitude docks");
      assert.ok(Math.abs(pose.rollDegrees - expected.rollDegrees) < 0.05, "roll docks");
      assert.ok(Math.abs(pose.fovDegrees - expected.fovDegrees) < 0.05, "fov docks");
    }
  }
});

test("docks velocity exactly at both endpoints — the seamless-handoff guarantee", () => {
  const start = OVERVIEW_STATE();
  const end = CHASE_STATE();
  const arc = createCameraTransition({ start, end }, BASE);
  assert.ok(arc);
  const frame = localFrame(start.eye);

  for (const [t, expected, sign] of [
    [0, start, 1],
    [arc.durationSeconds, end, -1],
  ]) {
    for (const [pick, label] of [[(p) => p.eye, "eye"], [(p) => p.lookAt, "lookAt"]]) {
      const measured = oneSidedVelocity((tt) => frame.toLocal(pick(arc.poseAt(tt))), t, sign, arc.durationSeconds);
      const spec = label === "eye" ? expected.velocity : expected.lookAtVelocity;
      const diff = Math.hypot(...measured.map((v, i) => v - spec[i]));
      const tolerance = Math.max(0.15, 0.05 * Math.hypot(...spec));
      assert.ok(diff < tolerance, `${label} velocity docks at t=${t} (off by ${diff.toFixed(3)} m/s)`);
    }
  }
});

test("the flight obeys the physical limits along the entire arc (both directions)", () => {
  for (const [start, end] of [[OVERVIEW_STATE(), CHASE_STATE()], [CHASE_STATE(), OVERVIEW_STATE()]]) {
    const arc = createCameraTransition({ start, end }, BASE);
    assert.ok(arc);
    assertArcPhysics(arc, start, BASE);
  }
});

test("mid-flight the camera looks along its own flight path (missile POV)", () => {
  const arc = createCameraTransition({ start: OVERVIEW_STATE(), end: CHASE_STATE() }, BASE);
  assert.ok(arc);
  const frame = localFrame(OVERVIEW_STATE().eye);
  const T = arc.durationSeconds;
  const h = T / 4000;

  for (const u of [0.42, 0.5, 0.58]) {
    const t = u * T;
    const ahead = frame.toLocal(arc.poseAt(t + h).eye);
    const behind = frame.toLocal(arc.poseAt(t - h).eye);
    const velocity = ahead.map((v, i) => (v - behind[i]) / (2 * h));
    const pose = arc.poseAt(t);
    const eye = frame.toLocal(pose.eye);
    const view = frame.toLocal(pose.lookAt).map((v, i) => v - eye[i]);
    const angle = angleBetweenDegrees(velocity, view);
    assert.ok(angle < 3, `view aligned with travel at u=${u} (off by ${angle.toFixed(2)}°)`);
  }
});

test("orientation evolves smoothly — no snap anywhere, including the docking frames", () => {
  // The view direction may legitimately sweep a large arc (including through
  // near-nadir, where the heading *coordinate* alone is degenerate), so
  // smoothness is bounded on the view vector's angular step per sample — the
  // camera's actual rotation rate — plus roll and fov steps.
  for (const [start, end] of [[OVERVIEW_STATE(), CHASE_STATE()], [CHASE_STATE(), OVERVIEW_STATE()]]) {
    const arc = createCameraTransition({ start, end }, BASE);
    assert.ok(arc);
    const frame = localFrame(start.eye);
    const steps = 600;
    let previous = null;
    for (let i = 0; i <= steps; i++) {
      const pose = arc.poseAt((i / steps) * arc.durationSeconds);
      const eye = frame.toLocal(pose.eye);
      const look = frame.toLocal(pose.lookAt);
      const view = look.map((v, j) => v - eye[j]);
      if (previous) {
        const step = angleBetweenDegrees(view, previous.view);
        assert.ok(step < 2.5, `view rotation step ${step.toFixed(2)}° at sample ${i}`);
        assert.ok(Math.abs(pose.rollDegrees - previous.roll) < 1.5, `roll step at sample ${i}`);
        assert.ok(Math.abs(pose.fovDegrees - previous.fov) < 0.5, `fov step at sample ${i}`);
      }
      previous = { view, roll: pose.rollDegrees, fov: pose.fovDegrees };
    }
  }
});

test("banks into a hard turn, never beyond the configured maximum", () => {
  // Start velocity perpendicular to the line toward the target forces a real
  // turn, so the physical bank must engage somewhere mid-flight.
  const start = OVERVIEW_STATE();
  const end = CHASE_STATE();
  const frame = localFrame(start.eye);
  const toEnd = frame.toLocal(end.eye);
  const heading = Math.atan2(toEnd[0], toEnd[1]);
  const speed = 250;
  start.velocity = [speed * Math.sin(heading + Math.PI / 2), speed * Math.cos(heading + Math.PI / 2), 0];
  start.lookAtVelocity = start.velocity.slice();

  const arc = createCameraTransition({ start, end }, BASE);
  assert.ok(arc, "a perpendicular entry is still flyable");
  let maxBank = 0;
  for (let i = 0; i <= 400; i++) {
    const roll = arc.poseAt((i / 400) * arc.durationSeconds).rollDegrees;
    assert.ok(Math.abs(roll) <= Math.max(BASE.max_bank_degrees, Math.abs(OVERVIEW_CAMERA.roll)) + 0.1);
    if (i > 100 && i < 300) maxBank = Math.max(maxBank, Math.abs(roll));
  }
  assert.ok(maxBank > 0.5, `banks into the turn mid-flight (max ${maxBank.toFixed(2)}°)`);
});

test("an entry pointing away from the target stays bounded — no orbital looping", () => {
  // 400 m/s pointing 160° away from a target ~2 km away (the lateral
  // component is what lets a cubic carve a real turn — an exactly anti-
  // parallel entry can only reverse through a vertical dive, which the climb
  // limit rejects). The control-point guardrail (velocity offsets capped at
  // 0.5·D) plus the duration solver must still produce a bounded turn-back,
  // never a loop that overshoots wildly.
  const start = OVERVIEW_STATE();
  const end = CHASE_STATE();
  const frame = localFrame(start.eye);
  const toEnd = frame.toLocal(end.eye);
  const away = Math.atan2(-toEnd[0], -toEnd[1]) + toRad(20);
  start.velocity = [400 * Math.sin(away), 400 * Math.cos(away), 0];
  start.lookAtVelocity = start.velocity.slice();

  const arc = createCameraTransition({ start, end }, BASE);
  assert.ok(arc, "a turn-back entry is still flyable");
  assertArcPhysics(arc, start, BASE);

  let pathLength = 0;
  let previous = frame.toLocal(arc.poseAt(0).eye);
  for (let i = 1; i <= 800; i++) {
    const point = frame.toLocal(arc.poseAt((i / 800) * arc.durationSeconds).eye);
    pathLength += Math.hypot(...point.map((v, j) => v - previous[j]));
    previous = point;
  }
  assert.ok(pathLength < 3 * arc.distanceMeters, `path length ${pathLength.toFixed(0)} m stays bounded`);
  assert.ok(haversineMeters(arc.poseAt(arc.durationSeconds).eye, end.eye) < 0.5, "still docks");
});

test("rejects a physically impossible intercept instead of flying an unphysical arc", () => {
  // A ~4 km near-vertical drop with almost no horizontal offset: every
  // candidate duration violates the max climb/dive angle, so the solver must
  // signal fallback (the caller then uses the ordinary chase flight).
  const start = {
    eye: { lat: 50.7, lng: 15.0, altitude: 5000 },
    lookAt: { lat: 50.71, lng: 15.0, altitude: 4900 },
    velocity: [60, 0, 0],
    lookAtVelocity: [60, 0, 0],
    rollDegrees: 0,
    fovDegrees: 35,
  };
  const end = {
    eye: { lat: 50.7, lng: 15.0, altitude: 800 },
    lookAt: { lat: 50.71, lng: 15.0, altitude: 700 },
    velocity: [8, 0, 0],
    lookAtVelocity: [8, 0, 0],
    rollDegrees: 0,
    fovDegrees: 35,
  };
  assert.equal(createCameraTransition({ start, end }, BASE), null);
});

test("a moving target is intercepted at its duration-predicted position", () => {
  const start = OVERVIEW_STATE();
  const endAt = (durationSeconds) => {
    const advanced = movePoint(CHASE_CAMERA.center, RIDER_VELOCITY, durationSeconds);
    const camera = { ...CHASE_CAMERA, center: advanced };
    return cameraState(camera, RIDER_VELOCITY.slice(), RIDER_VELOCITY.slice());
  };
  const arc = createCameraTransition({ start, end: endAt }, BASE);
  assert.ok(arc);

  const predicted = endAt(arc.durationSeconds);
  const finalPose = arc.poseAt(arc.durationSeconds);
  assert.ok(haversineMeters(finalPose.eye, predicted.eye) < 0.5, "docks on the predicted eye");
  assert.ok(haversineMeters(finalPose.lookAt, predicted.lookAt) < 0.5, "docks on the predicted look-at");
});

test("velocityAt matches the actual motion of the arc", () => {
  const start = OVERVIEW_STATE();
  const arc = createCameraTransition({ start, end: CHASE_STATE() }, BASE);
  assert.ok(arc);
  const frame = localFrame(start.eye);
  const T = arc.durationSeconds;
  const h = T / 4000;

  for (const u of [0.1, 0.5, 0.9, 1]) {
    const t = u * T;
    const reported = arc.velocityAt(t);
    for (const [pick, key] of [[(p) => p.eye, "eye"], [(p) => p.lookAt, "lookAt"]]) {
      const sign = t + h > T ? -1 : 1;
      const measured = oneSidedVelocity((tt) => frame.toLocal(pick(arc.poseAt(tt))), t, sign, T);
      const diff = Math.hypot(...measured.map((v, i) => v - reported[key][i]));
      assert.ok(diff < Math.max(0.2, 0.03 * Math.hypot(...reported[key])), `${key} velocityAt(${u}·T) (off by ${diff.toFixed(3)})`);
    }
  }
});

// --- helpers -------------------------------------------------------------------

function assertArcPhysics(arc, start, config) {
  const frame = localFrame(start.eye);
  const T = arc.durationSeconds;
  const D = arc.distanceMeters;
  const vRef = D / T;
  const minRadius = Math.max(
    config.min_turn_radius_floor_meters,
    config.min_turn_radius_distance_fraction * D,
  );
  assert.ok(Math.abs(arc.minTurnRadiusMeters - minRadius) < 1e-6, "reported turn-radius limit matches the scale-aware rule");
  const maxLateral = vRef * vRef / minRadius;

  const steps = 1500;
  const h = T / steps;
  const points = [];
  for (let i = 0; i <= steps; i++) points.push(frame.toLocal(arc.poseAt(i * h).eye));

  for (let i = 1; i < steps; i++) {
    const velocity = points[i + 1].map((v, j) => (v - points[i - 1][j]) / (2 * h));
    const accel = points[i + 1].map((v, j) => (v - 2 * points[i][j] + points[i - 1][j]) / (h * h));
    const speed = Math.hypot(...velocity);
    if (speed < Math.max(0.5, 0.02 * vRef)) continue;

    const cross = crossProduct(velocity, accel);
    const lateral = Math.hypot(...cross) / speed;
    assert.ok(
      lateral <= maxLateral * 1.15 + 0.5,
      `lateral acceleration ${lateral.toFixed(1)} ≤ ${maxLateral.toFixed(1)} m/s² at sample ${i}`,
    );

    const climb = Math.abs(Math.asin(velocity[2] / speed)) * 180 / Math.PI;
    assert.ok(
      climb <= config.max_climb_angle_degrees + 2,
      `climb/dive angle ${climb.toFixed(1)}° within ±${config.max_climb_angle_degrees}° at sample ${i}`,
    );
  }
}

// Second-order one-sided finite difference, so endpoint velocities can be
// measured without sampling outside [0, T].
function oneSidedVelocity(sample, t, sign, T) {
  const h = sign * (T / 8000);
  const p0 = sample(t);
  const p1 = sample(t + h);
  const p2 = sample(t + 2 * h);
  return p0.map((v, i) => (-3 * v + 4 * p1[i] - p2[i]) / (2 * h));
}

function localFrame(anchor) {
  const mPerDeg = 6371000 * Math.PI / 180;
  const cosLat = Math.cos(toRad(anchor.lat));
  return {
    toLocal: (point) => [
      (point.lng - anchor.lng) * mPerDeg * cosLat,
      (point.lat - anchor.lat) * mPerDeg,
      Number(point.altitude) || 0,
    ],
  };
}

function movePoint(point, velocityEnu, seconds) {
  const mPerDeg = 6371000 * Math.PI / 180;
  const cosLat = Math.cos(toRad(point.lat));
  return {
    lat: point.lat + (velocityEnu[1] * seconds) / mPerDeg,
    lng: point.lng + (velocityEnu[0] * seconds) / (mPerDeg * cosLat),
    altitude: (Number(point.altitude) || 0) + velocityEnu[2] * seconds,
  };
}

function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function crossProduct(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function angleBetweenDegrees(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cos = dot / ((Math.hypot(...a) * Math.hypot(...b)) || 1e-12);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
}

function toRad(value) {
  return value * Math.PI / 180;
}
