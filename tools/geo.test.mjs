import test from "node:test";
import assert from "node:assert/strict";

import { formatDistanceMeters, pixelDistanceMeters } from "../js/geo.js";
import { MAX_POINTS, pointsForDistanceMeters, scoreForGuess } from "../js/scoring.js";
import {
  ROUND_COUNT,
  advanceGame,
  createGame,
  evaluateGuess,
  getCurrentRound,
  recordResult,
  shuffle,
  totalScore,
} from "../js/game.js";

const METERS_PER_PIXEL = 0.1;
const ANSWER = { x: 100, y: 200 };
const SUB_REGION = {
  metersPerPixel: METERS_PER_PIXEL,
};

function seededRng(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

test("pixel distance converts using meters per pixel", () => {
  const distance = pixelDistanceMeters({ x: 0, y: 0 }, { x: 300, y: 400 }, METERS_PER_PIXEL);
  assert.ok(Math.abs(distance - 50) < 1e-9, `expected 50 m, got ${distance}`);
});

test("pixel distance is zero for identical points", () => {
  assert.equal(pixelDistanceMeters(ANSWER, ANSWER, METERS_PER_PIXEL), 0);
});

test("formatDistanceMeters displays metres", () => {
  assert.equal(formatDistanceMeters(0), "0 m");
  assert.equal(formatDistanceMeters(456), "456 m");
  assert.equal(formatDistanceMeters(1234), "1234 m");
  assert.equal(formatDistanceMeters(Number.NaN), "\u2014");
});

test("points are capped for guesses within two metres", () => {
  assert.equal(pointsForDistanceMeters(0), MAX_POINTS);
  assert.equal(pointsForDistanceMeters(2), MAX_POINTS);
  assert.ok(pointsForDistanceMeters(2.5) < MAX_POINTS);
});

test("a 60 metre miss scores 4000 points", () => {
  assert.equal(pointsForDistanceMeters(60), 4000);
});

test("an exact guess scores the maximum", () => {
  const result = scoreForGuess(ANSWER, ANSWER, METERS_PER_PIXEL);
  assert.equal(result.distanceMeters, 0);
  assert.equal(result.points, MAX_POINTS);
});

test("score falls as distance grows and never exceeds the maximum", () => {
  const near = scoreForGuess(ANSWER, { x: 110, y: 200 }, METERS_PER_PIXEL);
  const far = scoreForGuess(ANSWER, { x: 150, y: 200 }, METERS_PER_PIXEL);
  assert.ok(near.points > far.points);
  assert.ok(near.points <= MAX_POINTS);
  assert.ok(far.points >= 0);
});

test("evaluateGuess gives zero for the wrong sub-region", () => {
  const location = {
    x: ANSWER.x,
    y: ANSWER.y,
    regionId: "region-a",
    subRegionId: "sub-a",
  };

  const wrong = evaluateGuess(location, "region-a", "sub-b", ANSWER, SUB_REGION);
  assert.equal(wrong.correctSubRegion, false);
  assert.equal(wrong.points, 0);
  assert.equal(wrong.distanceMeters, null);

  const right = evaluateGuess(location, "region-a", "sub-a", ANSWER, SUB_REGION);
  assert.equal(right.correctSubRegion, true);
  assert.equal(right.points, MAX_POINTS);
});

test("shuffle is deterministic with a seeded rng and does not mutate input", () => {
  const input = [1, 2, 3, 4, 5];
  const first = shuffle(input, seededRng(7));
  const second = shuffle(input, seededRng(7));
  assert.deepEqual(first, second);
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
  assert.deepEqual([...first].sort((a, b) => a - b), input);
});

test("a game uses unique rounds and tracks results", () => {
  const locations = Array.from({ length: 9 }, (_, index) => ({
    id: `loc-${index}`,
    x: 100 + index,
    y: 200 + index,
    regionId: "region-a",
    subRegionId: "sub-a",
  }));

  const game = createGame(locations, { rng: seededRng(42) });
  assert.equal(game.rounds.length, ROUND_COUNT);
  assert.equal(new Set(game.rounds.map((location) => location.id)).size, ROUND_COUNT);
  assert.equal(getCurrentRound(game), game.rounds[0]);

  const location = getCurrentRound(game);
  const result = evaluateGuess(
    location,
    location.regionId,
    location.subRegionId,
    { x: location.x, y: location.y },
    SUB_REGION
  );
  recordResult(game, location, result, { x: location.x, y: location.y });

  assert.equal(game.results.length, 1);
  assert.equal(totalScore(game), MAX_POINTS);
  assert.equal(advanceGame(game), true);
  assert.equal(game.currentIndex, 1);
  assert.equal(getCurrentRound(game), game.rounds[1]);
});

test("advanceGame reports when the game is complete", () => {
  const game = createGame(
    [
      { id: "a", x: 1, y: 2, regionId: "r", subRegionId: "s" },
      { id: "b", x: 3, y: 4, regionId: "r", subRegionId: "s" },
    ],
    { roundCount: 2, rng: seededRng(1) }
  );
  assert.equal(game.rounds.length, 2);

  game.results.push({ points: 100 });
  assert.equal(advanceGame(game), true);
  game.results.push({ points: 200 });
  assert.equal(advanceGame(game), false);
  assert.equal(game.currentIndex, 2);
  assert.equal(totalScore(game), 300);
});
