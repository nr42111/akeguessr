import { scoreForGuess } from "./scoring.js";

export const ROUND_COUNT = 5;

export function shuffle(items, rng = Math.random) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function pickRoundLocations(locations, count = ROUND_COUNT, rng = Math.random) {
  return shuffle(locations, rng).slice(0, Math.min(count, locations.length));
}

export function buildRoundPool(locations, seenIds, roundCount = ROUND_COUNT) {
  const seen = new Set(seenIds);
  let pool = locations.filter((location) => !seen.has(location.id));
  const required = Math.min(roundCount, locations.length);
  const reset = pool.length < required;
  if (reset) pool = locations.slice();
  return { pool, reset };
}

export function createGame(locations, { roundCount = ROUND_COUNT, rng = Math.random } = {}) {
  return {
    rounds: pickRoundLocations(locations, roundCount, rng),
    currentIndex: 0,
    results: [],
  };
}

export function getCurrentRound(game) {
  return game.rounds[game.currentIndex] ?? null;
}

export function evaluateGuess(location, selectedRegionId, selectedSubRegionId, guess, subRegion) {
  const correctSubRegion =
    location.regionId === selectedRegionId && location.subRegionId === selectedSubRegionId;

  if (!correctSubRegion) {
    return { correctSubRegion, distanceMeters: null, points: 0 };
  }

  const { distanceMeters, points } = scoreForGuess(
    location,
    guess,
    subRegion.metersPerPixel
  );
  return { correctSubRegion, distanceMeters, points };
}

export function recordResult(game, location, result, guess) {
  const entry = { location, ...result, guess };
  game.results.push(entry);
  return entry;
}

export function advanceGame(game) {
  if (game.results.length > game.currentIndex) {
    game.currentIndex += 1;
  }
  return game.currentIndex < game.rounds.length;
}

export function totalScore(game) {
  return game.results.reduce((sum, result) => sum + result.points, 0);
}
