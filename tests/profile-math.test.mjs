import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeProfile, configuredMllwOffset } from "../profile-math.mjs";

function profile(elevations, spacing = 5) {
  return elevations.map((elevationFt, i) => ({
    distanceFt: i * spacing,
    elevationFt,
    lat: 39 + i / 100,
    lng: -75 + i / 100
  }));
}

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

const pairedThresholds = () => ({
  navd88: { minor: 3.25, moderate: 4.25, major: 5.25 },
  mllw: { minor: 6, moderate: 7, major: 8 }
});

test("a narrow trough uses interpolated crossings rather than whole sample intervals", () => {
  const points = profile([4, 3, 4]);
  const original = structuredClone(points);
  const result = analyzeProfile(points, 3.25);
  assert.deepEqual(points, original);
  assert.equal(result.totalLengthFt, 10);
  assert.equal(result.coveredLengthFt, 10);
  assert.equal(result.unknownLengthFt, 0);
  assert.equal(result.exposedLengthFt, 2.5);
  assert.equal(result.longestExposedLengthFt, 2.5);
  assert.equal(result.exposedSegments.length, 1);
  const [start, middle, end] = result.exposedSegments[0];
  close(start.distanceFt, 3.75);
  close(start.lat, 39.0075);
  close(start.lng, -74.9925);
  assert.equal(start.elevationFt, 3.25);
  assert.deepEqual(middle, points[1]);
  close(end.distanceFt, 6.25);
  close(end.lat, 39.0125);
  close(end.lng, -74.9875);
  assert.equal(end.elevationFt, 3.25);
  close(end.distanceFt - start.distanceFt, result.exposedLengthFt);
});

test("null samples break coverage and cannot create a flooded bridge", () => {
  const result = analyzeProfile(profile([2, null, 2], 50), 3);
  assert.equal(result.totalLengthFt, 100);
  assert.equal(result.coveredLengthFt, 0);
  assert.equal(result.unknownLengthFt, 100);
  assert.equal(result.exposedLengthFt, 0);
  assert.equal(result.longestExposedLengthFt, 0);
  assert.deepEqual(result.exposedSegments, []);
  assert.equal(result.minElevationFt, 2);
});

test("all-below samples form one full-length exposed segment", () => {
  const points = profile([1, 2, 1], 50);
  const result = analyzeProfile(points, 3);
  assert.equal(result.exposedLengthFt, 100);
  assert.equal(result.longestExposedLengthFt, 100);
  assert.equal(result.unknownLengthFt, 0);
  assert.deepEqual(result.exposedSegments, [points]);
});

test("all-above samples are covered but unexposed", () => {
  const result = analyzeProfile(profile([4, 5, 4], 50), 3);
  assert.equal(result.coveredLengthFt, 100);
  assert.equal(result.exposedLengthFt, 0);
  assert.equal(result.longestExposedLengthFt, 0);
  assert.deepEqual(result.exposedSegments, []);
});

test("equality is exposed along a level interval, and an isolated touch has zero length", () => {
  const flat = analyzeProfile(profile([3, 3, 3]), 3);
  assert.equal(flat.exposedLengthFt, 10);
  assert.equal(flat.longestExposedLengthFt, 10);
  const touch = analyzeProfile(profile([4, 3, 4]), 3);
  assert.equal(touch.exposedLengthFt, 0);
  assert.deepEqual(touch.exposedSegments, []);
});

test("leading and trailing nodata remain in the total and unknown length", () => {
  const result = analyzeProfile(profile([null, 2, 2, null], 50), 3);
  assert.equal(result.totalLengthFt, 150);
  assert.equal(result.coveredLengthFt, 50);
  assert.equal(result.unknownLengthFt, 100);
  assert.equal(result.exposedLengthFt, 50);
  assert.equal(result.longestExposedLengthFt, 50);
  assert.deepEqual(result.exposedSegments[0].map(p => p.distanceFt), [50, 100]);
});

test("unknown terrain separates exposed runs and cannot extend the longest run", () => {
  const result = analyzeProfile(profile([2, 2, null, 2, 2, 2], 10), 3);
  assert.equal(result.totalLengthFt, 50);
  assert.equal(result.coveredLengthFt, 30);
  assert.equal(result.unknownLengthFt, 20);
  assert.equal(result.exposedLengthFt, 30);
  assert.equal(result.longestExposedLengthFt, 20);
  assert.equal(result.exposedSegments.length, 2);
});

test("separate wet troughs retain individual interpolated lengths", () => {
  const result = analyzeProfile(profile([2, 4, 2], 10), 3);
  assert.equal(result.exposedLengthFt, 10);
  assert.equal(result.longestExposedLengthFt, 5);
  assert.deepEqual(result.exposedSegments.map(s => s.map(p => p.distanceFt)), [[0, 5], [15, 20]]);
});

test("coverage provides a valid denominator, with no percentage implied for unknown-only terrain", () => {
  const mixed = analyzeProfile(profile([2, 4, null, 4, 2], 10), 3);
  assert.equal(mixed.totalLengthFt, mixed.coveredLengthFt + mixed.unknownLengthFt);
  assert.equal(mixed.coveredLengthFt, 20);
  assert.equal(mixed.exposedLengthFt / mixed.coveredLengthFt, 0.5);
  const unknown = analyzeProfile(profile([null, null]), 3);
  assert.equal(unknown.minElevationFt, null);
  assert.equal(unknown.coveredLengthFt, 0);
  assert.equal(unknown.exposedLengthFt, 0);
  assert.equal(unknown.unknownLengthFt, 5);
});

test("empty and one-point profiles have zero length and do not invent elevations", () => {
  const empty = analyzeProfile([], 3);
  assert.equal(empty.minElevationFt, null);
  assert.equal(empty.totalLengthFt, 0);
  assert.equal(empty.coveredLengthFt, 0);
  assert.deepEqual(empty.exposedSegments, []);
  const one = analyzeProfile(profile([2]), 3);
  assert.equal(one.minElevationFt, 2);
  assert.equal(one.totalLengthFt, 0);
  assert.equal(one.exposedLengthFt, 0);
});

test("nonfinite elevations are unknown rather than zero", () => {
  const result = analyzeProfile(profile([2, NaN, Infinity, undefined, 2]), 3);
  assert.equal(result.totalLengthFt, 20);
  assert.equal(result.coveredLengthFt, 0);
  assert.equal(result.unknownLengthFt, 20);
  assert.deepEqual(result.exposedSegments, []);
});

test("invalid thresholds and backwards or nonnumeric distances fail explicitly", () => {
  for (const threshold of [NaN, Infinity, null, "3"]) {
    assert.throws(() => analyzeProfile(profile([2, 2]), threshold), /threshold/);
  }
  assert.throws(() => analyzeProfile([{ distanceFt: 10 }, { distanceFt: 0 }], 3), /distances/);
  assert.throws(() => analyzeProfile([{ distanceFt: "0" }], 3), /distances/);
  assert.throws(() => analyzeProfile(null, 3), /array/);
});

test("consistent paired town stages yield 2.75 feet without a default offset", async () => {
  assert.equal(configuredMllwOffset({ datum: "NAVD88", thresholds: pairedThresholds() }), 2.75);
  const townStats = JSON.parse(await readFile(new URL("../flood_stats.json", import.meta.url)));
  const offset = configuredMllwOffset(townStats);
  assert.equal(offset, 2.75);
  for (const name of ["minor", "moderate", "major"]) {
    assert.equal(townStats.thresholds.navd88[name] + offset, townStats.thresholds.mllw[name]);
  }
});

test("an explicit finite offset works alone or with matching stage pairs", () => {
  assert.equal(configuredMllwOffset({ datum: { mllwOffsetFromNavd88Ft: 0 } }), 0);
  assert.equal(configuredMllwOffset({ datum: { mllwOffsetFromNavd88Ft: 2.75 }, thresholds: pairedThresholds() }), 2.75);
});

test("metadata and paired stages cannot silently disagree", () => {
  assert.throws(() => configuredMllwOffset({ datum: { mllwOffsetFromNavd88Ft: 0.45 }, thresholds: pairedThresholds() }), /disagrees/);
  const thresholds = pairedThresholds();
  thresholds.mllw.major = 8.1;
  assert.throws(() => configuredMllwOffset({ thresholds }), /inconsistent/);
});

test("missing or nonnumeric datum information fails instead of falling back", () => {
  for (const datum of [{ mllwOffsetFromNavd88Ft: null }, { mllwOffsetFromNavd88Ft: "2.75" }, { mllwOffsetFromNavd88Ft: Infinity }]) {
    assert.throws(() => configuredMllwOffset({ datum, thresholds: pairedThresholds() }), /finite number/);
  }
  for (const stats of [null, {}, { datum: "NAVD88" }, { thresholds: { navd88: { minor: 3.25 }, mllw: { minor: 6 } } }]) {
    assert.throws(() => configuredMllwOffset(stats));
  }
});
