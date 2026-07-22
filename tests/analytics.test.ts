import assert from "node:assert/strict";
import test from "node:test";
import { calculateDrawdowns, correlation, selectBenchmarkStartBar } from "../lib/analytics.ts";

test("calculates maximum and current drawdown from observed equity", () => {
  const result = calculateDrawdowns([100, 120, 90, 110]);
  assert.equal(result.maxDrawdownPct, -25);
  assert.ok(Math.abs(result.currentDrawdownPct - (-8.333333333333337)) < 1e-9);
});

test("requires enough observations and identifies correlated returns", () => {
  assert.equal(correlation([1, 2], [1, 2]), null);
  const left = Array.from({ length: 12 }, (_, index) => index / 100);
  const right = left.map((value) => value * 2);
  assert.ok((correlation(left, right) ?? 0) > .999);
});

test("uses the latest benchmark close before a weekend account start", () => {
  const bars = [
    { date: "2026-07-16", closeCents: 100 },
    { date: "2026-07-17", closeCents: 101 },
  ];
  assert.equal(selectBenchmarkStartBar(bars, "2026-07-18")?.closeCents, 101);
});
