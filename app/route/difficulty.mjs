import {
  DIFFICULTY_THRESHOLDS_EQUIVALENT_KM,
  DISTANCE_CLASS_THRESHOLDS_KM,
  EQUIVALENT_KM_CLIMB_METERS,
  TERRAIN_CLASS_THRESHOLDS_M_PER_KM,
} from "../core/tuning.mjs";

// Highest-`min` threshold the value reaches or exceeds. Thresholds must be
// sorted ascending by `min`; the first entry's min is normally 0 so every
// non-negative value matches something.
function classify(value, thresholds) {
  let label = thresholds[0].label;
  for (const threshold of thresholds) {
    if (value >= threshold.min) label = threshold.label;
  }
  return label;
}

// Classifies a route from distance and total elevation gain alone — no
// power, speed, rider weight, weather, surface, or post-ride effort data.
// Returns null for a routeless/zero-distance state (nothing to classify).
// The threshold tables are explicit parameters (tests pass fixed tables so
// tuning changes can never break them); the tuning constants are only the
// scale the app ships with.
export function classifyRoute(distanceMeters, elevationGainMeters, {
  equivalentKmClimbMeters = EQUIVALENT_KM_CLIMB_METERS,
  distanceThresholdsKm = DISTANCE_CLASS_THRESHOLDS_KM,
  terrainThresholdsMPerKm = TERRAIN_CLASS_THRESHOLDS_M_PER_KM,
  difficultyThresholdsEquivalentKm = DIFFICULTY_THRESHOLDS_EQUIVALENT_KM,
} = {}) {
  const distanceKm = distanceMeters / 1000;
  if (!(distanceKm > 0)) return null;

  const elevationGainM = Math.max(0, elevationGainMeters);
  const elevationPerKm = elevationGainM / distanceKm;
  const equivalentKm = distanceKm + elevationGainM / equivalentKmClimbMeters;

  return {
    distanceKm,
    elevationGainM,
    elevationPerKm,
    equivalentKm,
    distanceClass: classify(distanceKm, distanceThresholdsKm),
    terrainClass: classify(elevationPerKm, terrainThresholdsMPerKm),
    difficulty: classify(equivalentKm, difficultyThresholdsEquivalentKm),
  };
}
