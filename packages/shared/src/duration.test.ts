import assert from "node:assert/strict";
import test from "node:test";

import { effectiveHours, formatDuration, hoursToDays, parseDurationHours } from "./duration.js";

test("a bare number means hours, not days", () => {
  // The whole point of the change: "6" must be six hours. Reading it as six
  // days would hand out a window eight times too long.
  assert.equal(parseDurationHours("6"), 6);
  assert.equal(parseDurationHours(" 36 "), 36);
});

test("day, week and hour suffixes", () => {
  assert.equal(parseDurationHours("3d"), 72);
  assert.equal(parseDurationHours("1w"), 168);
  assert.equal(parseDurationHours("12h"), 12);
  assert.equal(parseDurationHours("2d 6h"), 54);
  assert.equal(parseDurationHours("2D6H"), 54);
  assert.equal(parseDurationHours("1w 2d"), 216);
});

test("minutes round up, so a window is never shorter than asked", () => {
  assert.equal(parseDurationHours("90m"), 2);
  assert.equal(parseDurationHours("30m"), 1);
  assert.equal(parseDurationHours("1h 30m"), 2);
});

test("the ways an admin says 'no limit'", () => {
  for (const input of ["", " ", "-", "0", "none", "unlimited", "0d"]) {
    assert.equal(parseDurationHours(input), null, `expected null for ${JSON.stringify(input)}`);
  }
});

test("nonsense is rejected rather than half-parsed", () => {
  // "3 dayz" must not quietly become 3 hours.
  for (const input of ["3 dayz", "abc", "3x", "-5", "1e5"]) {
    assert.equal(parseDurationHours(input), undefined, `expected undefined for ${JSON.stringify(input)}`);
  }
});

test("absurd windows are refused", () => {
  assert.equal(parseDurationHours("4000d"), undefined);
  assert.equal(parseDurationHours("3650d"), 87_600);
});

test("formatting reads back the way it was typed", () => {
  assert.equal(formatDuration(72), "3d");
  assert.equal(formatDuration(54), "2d 6h");
  assert.equal(formatDuration(6), "6h");
  assert.equal(formatDuration(null), "unlimited");
  assert.equal(formatDuration(0), "unlimited");
});

test("parse and format round-trip", () => {
  for (const hours of [1, 6, 23, 24, 25, 54, 72, 168, 8760]) {
    assert.equal(parseDurationHours(formatDuration(hours)), hours, `round-trip failed for ${hours}h`);
  }
});

test("hours win over the legacy day column, and null means no limit", () => {
  assert.equal(effectiveHours(6, 30), 6);
  assert.equal(effectiveHours(null, 3), 72);
  assert.equal(effectiveHours(undefined, 3), 72);
  assert.equal(effectiveHours(null, null), null);
  assert.equal(effectiveHours(0, 3), 72, "a zero hour column must not read as 'no limit' and hide the days");
});

test("days published to the API round up, so a 6h window is never reported as 0", () => {
  assert.equal(hoursToDays(6), 1);
  assert.equal(hoursToDays(24), 1);
  assert.equal(hoursToDays(25), 2);
  assert.equal(hoursToDays(null), null);
});
