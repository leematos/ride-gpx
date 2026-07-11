// Physically-constrained camera transition arcs between two camera poses —
// the "missile POV" flight used for the overview ↔ chase handoffs.
//
// The camera eye and its look-at point each fly their own time-scaled cubic
// Hermite curve (executed as a cubic Bezier: control offsets = velocity·T/3),
// in a flat local east/north/up frame anchored at the start eye. Because the
// Hermite boundary conditions encode the true endpoint velocities, position
// AND velocity are continuous at both ends of the flight — the arc docks onto
// a moving chase camera (or leaves a spinning orbit) with no visible seam and
// no artificial alignment phase. The same math flies both directions; callers
// only swap the start and end states.
//
// Orientation is never interpolated as angles. Mid-flight the camera looks
// along its own flight tangent (a look-ahead point down the curve, so it
// never travels "crab-legged"); near both ends that look-ahead point blends —
// as a 3D point, not an angle — into the endpoint cameras' real look-at
// curve, whose Hermite boundary conditions make the docking view and its
// rate of rotation exact. Bank (roll) comes from the arc's own lateral
// acceleration, like a turning aircraft.
//
// Physical limits, scaled to the transition (a short hop is flown slower, so
// it may turn tighter — turn radius shrinks with v²):
//   • minimum turn radius: max(floor, fraction·D), enforced as a lateral-
//     acceleration cap of v_ref²/minRadius with v_ref = D/T — equivalent to
//     "radius ≥ minRadius at cruise speed, ∝ v² below it"
//   • maximum climb/dive angle of the flight tangent
//   • loop prevention: velocity control offsets may not exceed 0.5·D (a
//     candidate needing more is rejected, because clamping them would break
//     the exact-docking-velocity guarantee)
// The solver scans candidate durations from the configured minimum upward and
// returns the shortest duration whose curve satisfies every limit; if none
// does, it returns null and the caller falls back to the ordinary chase
// flight. Duration is a real geometric knob, not just playback speed: the
// control offsets scale with T, so a longer flight sweeps wider arcs.
//
// Pure math — no DOM, no app state. Configured by CAMERA_TRANSITION in
// core/tuning.mjs (tuning.yaml → camera_transition).

const EARTH_RADIUS_METERS = 6371000;
const METERS_PER_DEGREE = EARTH_RADIUS_METERS * Math.PI / 180;

// start: { eye, lookAt: {lat,lng,altitude}, velocity, lookAtVelocity: [east,
// north, up] m/s, rollDegrees, fovDegrees }. end: the same shape, or a
// function of the candidate duration in seconds (a moving chase target is
// intercepted where it will be, not where it was). Returns null when the
// inputs are degenerate or no candidate duration satisfies the physical
// limits — the caller falls back to its ordinary camera flight.
export function createCameraTransition({ start, end } = {}, config = {}) {
  const cfg = readConfig(config);
  const startState = normalizeState(start);
  if (!startState) return null;
  const endResolver = typeof end === "function" ? end : () => end;
  const frame = makeFrame(startState.eye);

  for (let T = cfg.minDuration; T <= cfg.maxDuration + 1e-9; T += cfg.stepSeconds) {
    const endState = normalizeState(endResolver(T));
    if (!endState) return null;
    const arc = buildArc(frame, startState, endState, T, cfg);
    if (arc) return arc;
  }
  return null;
}

function buildArc(frame, start, end, T, cfg) {
  const p0 = frame.toLocal(start.eye);
  const p3 = frame.toLocal(end.eye);
  const distance = distanceBetween(p0, p3);
  if (distance < cfg.minDistance) return null;

  // Loop-prevention guardrail: control offsets past half the straight-line
  // distance can fold the curve back over itself. Clamping them would silently
  // break the exact endpoint velocities (the whole point of the Hermite fit),
  // so an offending candidate is rejected instead — a shorter duration shrinks
  // the offsets, and if even the shortest clamps, the caller's fallback flight
  // handles it.
  const offsetLimit = cfg.clampFraction * distance;
  const eyeOffset0 = scaleVector(start.velocity, T / 3);
  const eyeOffset1 = scaleVector(end.velocity, T / 3);
  if (vectorLength(eyeOffset0) > offsetLimit + 1e-9) return null;
  if (vectorLength(eyeOffset1) > offsetLimit + 1e-9) return null;
  const eyeCurve = bezierFromHermite(p0, eyeOffset0, p3, eyeOffset1);

  const minTurnRadius = Math.max(cfg.radiusFloor, cfg.radiusFraction * distance);
  const referenceSpeed = distance / T;
  const maxLateralAccel = referenceSpeed * referenceSpeed / minTurnRadius;
  if (!satisfiesPhysics(eyeCurve, T, referenceSpeed, maxLateralAccel, cfg)) return null;

  // The docking look targets, extrapolated at their own dock velocities
  // (the rider's look-at keeps moving while the camera flies in). These are
  // deliberately *local first-order anchors*, not a global look-at curve
  // between them: a curve racing from one look target to the other would
  // pass fast and close to the eye and whip the blended view direction —
  // whereas each anchor only ever moves at its dock rate, and only matters
  // inside its own blend window. Linear extrapolation is exactly what makes
  // the docking look-at position AND velocity exact at t=0 and t=T.
  const l0 = frame.toLocal(start.lookAt);
  const l3 = frame.toLocal(end.lookAt);
  const startAnchorAt = (u) => addVectors(l0, scaleVector(start.lookAtVelocity, u * T));
  const endAnchorAt = (u) => addVectors(l3, scaleVector(end.lookAtVelocity, (u - 1) * T));

  // Eye and look-at in local meters at normalized time u — the single source
  // both poseAt (geo) and velocityAt (numeric derivative) sample.
  function localPoseAt(u) {
    const eye = bezierPoint(eyeCurve, u);
    const startAnchor = startAnchorAt(u);
    const endAnchor = endAnchorAt(u);
    const startDistance = Math.max(1e-6, distanceBetween(startAnchor, eye));
    const endDistance = Math.max(1e-6, distanceBetween(endAnchor, eye));
    // The view distance carries from the departure camera's to the arrival
    // camera's viewing scale across the flight; direction is handled below.
    const viewDistance = startDistance + (endDistance - startDistance) * smoothstep(u);

    const derivative = bezierDerivative(eyeCurve, u);
    const speed = vectorLength(derivative);
    // A (near-)static endpoint has no tangent to look along; the nearer
    // anchor's direction fully owns the view there anyway.
    let direction;
    if (speed < 1e-6 * Math.max(distance, 1)) {
      const anchor = u < 0.5 ? startAnchor : endAnchor;
      direction = scaleVector(subtractVectors(anchor, eye), 1 / (u < 0.5 ? startDistance : endDistance));
    } else {
      // Missile POV with docking blends: mid-flight the view is the flight
      // tangent; inside each blend window the tangent is rotated toward that
      // dock's real look direction by (their angle)·weight around their
      // common normal — a constant-rate sweep of the view *direction* (never
      // separate heading/tilt channels), so a large reorientation spreads
      // evenly across the window instead of bunching. The weights reach 1
      // with zero slope at their endpoint, so the docking view and its rate
      // of rotation are exact.
      direction = scaleVector(derivative, 1 / speed);
      const inWeight = 1 - smoothstep(Math.min(u / cfg.blendIn, 1));
      if (inWeight > 0) {
        direction = rotateToward(direction, scaleVector(subtractVectors(startAnchor, eye), 1 / startDistance), inWeight);
      }
      const outWeight = 1 - smoothstep(Math.min((1 - u) / cfg.blendOut, 1));
      if (outWeight > 0) {
        direction = rotateToward(direction, scaleVector(subtractVectors(endAnchor, eye), 1 / endDistance), outWeight);
      }
    }
    return { eye, look: eye.map((value, i) => value + direction[i] * viewDistance) };
  }

  function poseAt(tSeconds) {
    const u = clamp((Number(tSeconds) || 0) / T, 0, 1);
    const { eye, look } = localPoseAt(u);
    const weight = edgeWeight(u, cfg);
    const targetRoll = start.roll + (end.roll - start.roll) * smoothstep(u);
    const bank = bankAt(eyeCurve, u, T, maxLateralAccel, cfg.maxBank);
    return {
      eye: frame.toGeo(eye),
      lookAt: frame.toGeo(look),
      rollDegrees: bank * (1 - weight) + targetRoll * weight,
      fovDegrees: start.fov + (end.fov - start.fov) * smoothstep(u),
      done: (Number(tSeconds) || 0) >= T - 1e-9,
    };
  }

  // Velocities of the blended pose in [east, north, up] m/s. The eye's is
  // analytic; the look-at's is differentiated numerically (second-order, with
  // one-sided stencils at the endpoints) because the direction blend makes
  // its closed form gratuitously messy.
  function velocityAt(tSeconds) {
    const u = clamp((Number(tSeconds) || 0) / T, 0, 1);
    const h = 1 / 20000;
    const side = u <= h ? 1 : u >= 1 - h ? -1 : 0;
    let lookVelocity;
    if (side === 0) {
      const before = localPoseAt(u - h).look;
      const after = localPoseAt(u + h).look;
      lookVelocity = after.map((value, i) => (value - before[i]) / (2 * h * T));
    } else {
      const f0 = localPoseAt(u).look;
      const f1 = localPoseAt(u + side * h).look;
      const f2 = localPoseAt(u + side * 2 * h).look;
      lookVelocity = f0.map((value, i) => (-3 * value + 4 * f1[i] - f2[i]) / (2 * side * h * T));
    }
    return {
      eye: scaleVector(bezierDerivative(eyeCurve, u), 1 / T),
      lookAt: lookVelocity,
    };
  }

  return {
    durationSeconds: T,
    distanceMeters: distance,
    minTurnRadiusMeters: minTurnRadius,
    poseAt,
    velocityAt,
  };
}

// Sample the eye curve and verify the physical limits everywhere the flight
// is actually moving. Below a small fraction of cruise speed the pose barely
// changes on screen and the parametric curvature formula degenerates (a
// zero-velocity endpoint has |B'| → 0), so those samples are skipped — which
// is also physically right: turn radius shrinks with v².
function satisfiesPhysics(curve, T, referenceSpeed, maxLateralAccel, cfg) {
  const speedFloor = Math.max(0.5, 0.02 * referenceSpeed);
  const maxClimbSin = Math.sin(cfg.maxClimb * Math.PI / 180);
  for (let i = 0; i <= cfg.sampleCount; i++) {
    const u = i / cfg.sampleCount;
    const d1 = bezierDerivative(curve, u);
    const parametricSpeed = vectorLength(d1);
    const speed = parametricSpeed / T;
    if (speed < speedFloor) continue;

    const d2 = bezierSecond(curve, u);
    // Lateral (turn) acceleration: |v × a| / |v|, with v = B'/T, a = B''/T².
    const lateral = vectorLength(crossProduct(d1, d2)) / (parametricSpeed * T * T * T);
    if (lateral > maxLateralAccel * (1 + 1e-9)) return false;

    if (Math.abs(d1[2]) / parametricSpeed > maxClimbSin) return false;
  }
  return true;
}

// Bank like an aircraft: roll in proportion to the lateral acceleration of
// the horizontal turn, reaching the full configured bank exactly at the
// physical limit. Positive roll banks into a right turn, matching the
// fly-by/fly-over convention.
function bankAt(curve, u, T, maxLateralAccel, maxBank) {
  if (!(maxBank > 0) || !(maxLateralAccel > 0)) return 0;
  const d1 = bezierDerivative(curve, u);
  const d2 = bezierSecond(curve, u);
  const eastSpeed = d1[0] / T;
  const northSpeed = d1[1] / T;
  const horizontalSpeed = Math.hypot(eastSpeed, northSpeed);
  if (horizontalSpeed < 1e-6) return 0;
  // CCW-positive signed lateral acceleration; a right turn is clockwise.
  const lateral = (eastSpeed * (d2[1] / (T * T)) - northSpeed * (d2[0] / (T * T))) / horizontalSpeed;
  return -clamp(lateral / maxLateralAccel, -1, 1) * maxBank;
}

// 1 at both endpoints (the endpoint cameras' real look-at, roll and view
// win there — with zero slope, so their velocities dock exactly), easing to
// 0 across the blend windows so the middle of the flight is pure tangent
// look-ahead.
function edgeWeight(u, cfg) {
  return 1 - smoothstep(Math.min(u / cfg.blendIn, (1 - u) / cfg.blendOut, 1));
}

// Rotate unit vector `from` toward unit vector `to` by `fraction` of the
// angle between them (Rodrigues' rotation around their common normal). At
// fraction 1 the result is exactly `to`. Exactly opposed inputs have no
// defined shortest sweep; `to` is the stable choice for that degenerate
// instant (the surrounding blend weights make it seamless in practice).
function rotateToward(from, to, fraction) {
  const cross = crossProduct(from, to);
  const sinAngle = vectorLength(cross);
  const cosAngle = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (sinAngle < 1e-9) return to;
  const axis = scaleVector(cross, 1 / sinAngle);
  const angle = Math.atan2(sinAngle, cosAngle) * clamp(fraction, 0, 1);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const axisDot = axis[0] * from[0] + axis[1] * from[1] + axis[2] * from[2];
  const axisCross = crossProduct(axis, from);
  return from.map((value, i) => value * cos + axisCross[i] * sin + axis[i] * axisDot * (1 - cos));
}

// --- Hermite/Bezier primitives (3D points as [east, north, up] arrays) --------

function bezierFromHermite(p0, offset0, p3, offset1) {
  return [p0, addVectors(p0, offset0), subtractVectors(p3, offset1), p3];
}

function bezierPoint([a, b, c, d], u) {
  const s = 1 - u;
  return a.map((_, i) => s * s * s * a[i] + 3 * s * s * u * b[i] + 3 * s * u * u * c[i] + u * u * u * d[i]);
}

function bezierDerivative([a, b, c, d], u) {
  const s = 1 - u;
  return a.map((_, i) => 3 * (s * s * (b[i] - a[i]) + 2 * s * u * (c[i] - b[i]) + u * u * (d[i] - c[i])));
}

function bezierSecond([a, b, c, d], u) {
  const s = 1 - u;
  return a.map((_, i) => 6 * (s * (c[i] - 2 * b[i] + a[i]) + u * (d[i] - 2 * c[i] + b[i])));
}

// --- Geo ↔ local frame ---------------------------------------------------------

// Equirectangular frame anchored at the start eye — the transitions this
// flies span at most a few tens of kilometers, where the flat-earth error is
// millimeters. Altitudes pass through absolute.
function makeFrame(anchor) {
  const cosLat = Math.cos(anchor.lat * Math.PI / 180) || 1e-6;
  return {
    toLocal: (point) => [
      (point.lng - anchor.lng) * METERS_PER_DEGREE * cosLat,
      (point.lat - anchor.lat) * METERS_PER_DEGREE,
      Number(point.altitude) || 0,
    ],
    toGeo: ([east, north, up]) => ({
      lat: anchor.lat + north / METERS_PER_DEGREE,
      lng: anchor.lng + east / (METERS_PER_DEGREE * cosLat),
      altitude: up,
    }),
  };
}

// --- Input & config normalization ----------------------------------------------

function normalizeState(state) {
  if (!isFinitePoint(state?.eye) || !isFinitePoint(state?.lookAt)) return null;
  const velocity = normalizeVector(state.velocity);
  return {
    eye: geoPoint(state.eye),
    lookAt: geoPoint(state.lookAt),
    velocity,
    // A camera translating rigidly moves its look-at with its eye.
    lookAtVelocity: state.lookAtVelocity === undefined ? velocity : normalizeVector(state.lookAtVelocity),
    roll: Number(state.rollDegrees) || 0,
    fov: Number(state.fovDegrees) || 35,
  };
}

function readConfig(config) {
  const minDuration = Math.max(0.5, numberOr(config.min_duration_seconds, 3.5));
  return {
    minDuration,
    maxDuration: Math.max(minDuration, numberOr(config.max_duration_seconds, 12)),
    stepSeconds: Math.max(0.1, numberOr(config.solver_step_seconds, 0.5)),
    radiusFloor: Math.max(1, numberOr(config.min_turn_radius_floor_meters, 30)),
    radiusFraction: Math.max(0, numberOr(config.min_turn_radius_distance_fraction, 0.08)),
    maxClimb: clamp(numberOr(config.max_climb_angle_degrees, 75), 5, 89),
    clampFraction: Math.max(0.05, numberOr(config.velocity_clamp_distance_fraction, 0.5)),
    blendIn: clamp(numberOr(config.lookat_blend_in_fraction, 0.25), 0.01, 0.49),
    blendOut: clamp(numberOr(config.lookat_blend_out_fraction, 0.35), 0.01, 0.49),
    maxBank: Math.max(0, numberOr(config.max_bank_degrees, 25)),
    sampleCount: Math.max(32, Math.round(numberOr(config.sample_count, 240))),
    minDistance: Math.max(0.1, numberOr(config.min_distance_meters, 1)),
  };
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isFinitePoint(point) {
  return Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng));
}

function geoPoint(point) {
  return { lat: Number(point.lat), lng: Number(point.lng), altitude: Number(point.altitude) || 0 };
}

function normalizeVector(vector) {
  if (!Array.isArray(vector) || vector.length !== 3) return [0, 0, 0];
  return vector.map((value) => (Number.isFinite(Number(value)) ? Number(value) : 0));
}

// --- Small vector helpers -------------------------------------------------------

function addVectors(a, b) {
  return a.map((value, i) => value + b[i]);
}

function subtractVectors(a, b) {
  return a.map((value, i) => value - b[i]);
}

function scaleVector(vector, factor) {
  return vector.map((value) => value * factor);
}

function vectorLength(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function distanceBetween(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function crossProduct(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function smoothstep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
