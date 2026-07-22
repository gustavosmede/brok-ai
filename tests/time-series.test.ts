import assert from "node:assert/strict";
import test from "node:test";
import { splitTimeSeriesAtGaps, timeSeriesGapThreshold } from "../lib/time-series.ts";

test("splits a chart instead of drawing through a missing period", () => {
  const points = [
    { created_at: "2026-07-19T10:00:00.000Z" },
    { created_at: "2026-07-19T10:05:00.000Z" },
    { created_at: "2026-07-19T10:10:00.000Z" },
    { created_at: "2026-07-19T14:00:00.000Z" },
  ];
  assert.equal(timeSeriesGapThreshold(points), 20 * 60_000);
  assert.deepEqual(splitTimeSeriesAtGaps(points).map((segment) => segment.length), [3, 1]);
});
