import assert from "node:assert/strict";
import test from "node:test";
import { reconstructPortfolioSnapshots } from "../lib/portfolio-history.ts";

const initialCash = { deltaCents: 1_000_000, createdAt: "2026-07-19T09:00:00.000Z" };

test("reconstructs a long position with only prices known at that time", () => {
  const snapshots = reconstructPortfolioSnapshots({
    timestamps: ["2026-07-19T10:05:00.000Z", "2026-07-19T10:10:00.000Z"],
    cashEntries: [initialCash, { deltaCents: -10_000, createdAt: "2026-07-19T10:00:00.000Z" }],
    fills: [{ symbol: "AAPL", side: "BUY", quantityMicros: 1_000_000, priceCents: 10_000, feeCents: 0, createdAt: "2026-07-19T10:00:00.000Z" }],
    bars: [
      { symbol: "AAPL", observedAt: "2026-07-19T10:00:00.000Z", priceCents: 10_000 },
      { symbol: "AAPL", observedAt: "2026-07-19T10:10:00.000Z", priceCents: 12_000 },
    ],
  });
  assert.equal(snapshots[0].equityCents, 1_000_000);
  assert.equal(snapshots[1].equityCents, 1_002_000);
  assert.equal(snapshots[1].unrealizedPnlCents, 2_000);
});

test("reconstructs short P&L and skips a point without an earlier quote", () => {
  const short = reconstructPortfolioSnapshots({
    timestamps: ["2026-07-19T10:05:00.000Z"],
    cashEntries: [initialCash, { deltaCents: 10_000, createdAt: "2026-07-19T10:00:00.000Z" }],
    fills: [{ symbol: "CVX", side: "SELL", quantityMicros: 1_000_000, priceCents: 10_000, feeCents: 0, createdAt: "2026-07-19T10:00:00.000Z" }],
    bars: [{ symbol: "CVX", observedAt: "2026-07-19T10:05:00.000Z", priceCents: 9_000 }],
  });
  assert.equal(short[0].equityCents, 1_001_000);
  assert.equal(short[0].unrealizedPnlCents, 1_000);

  const missing = reconstructPortfolioSnapshots({
    timestamps: ["2026-07-19T10:05:00.000Z"],
    cashEntries: [initialCash, { deltaCents: -10_000, createdAt: "2026-07-19T10:00:00.000Z" }],
    fills: [{ symbol: "AAPL", side: "BUY", quantityMicros: 1_000_000, priceCents: 10_000, feeCents: 0, createdAt: "2026-07-19T10:00:00.000Z" }],
    bars: [{ symbol: "AAPL", observedAt: "2026-07-19T10:10:00.000Z", priceCents: 12_000 }],
  });
  assert.deepEqual(missing, []);
});
