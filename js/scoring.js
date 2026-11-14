import { pixelDistanceMeters } from "./geo.js";

export const MAX_POINTS = 5000;
export const GRACE_METERS = 2;
const POINTS_AT_60_METERS = 4000;
const DECAY_PER_METER =
  Math.log(MAX_POINTS / POINTS_AT_60_METERS) / (60 - GRACE_METERS);

export function pointsForDistanceMeters(distanceMeters) {
  const adjusted = Math.max(0, distanceMeters - GRACE_METERS);
  const raw = MAX_POINTS * Math.exp(-DECAY_PER_METER * adjusted);
  return Math.min(MAX_POINTS, Math.max(0, Math.round(raw)));
}

export function scoreForGuess(answer, guess, metersPerPixel) {
  const distanceMeters = pixelDistanceMeters(answer, guess, metersPerPixel);
  return { distanceMeters, points: pointsForDistanceMeters(distanceMeters) };
}
