import assert from "node:assert/strict";
import test from "node:test";
import { buildPositionPerformanceSeries, calculatePositionRisk, findOpenCycleStart } from "../lib/position-detail-math.ts";
import { toTradingViewSymbol, tradingViewChartUrl } from "../lib/external-links.ts";

test("finds the start of the current open position cycle", () => {
  const fills = [
    { side: "BUY" as const, quantity_micros: 2_000_000, created_at: "2026-01-01T10:00:00Z" },
    { side: "SELL" as const, quantity_micros: 2_000_000, created_at: "2026-01-02T10:00:00Z" },
    { side: "BUY" as const, quantity_micros: 1_000_000, created_at: "2026-02-01T10:00:00Z" },
    { side: "BUY" as const, quantity_micros: 500_000, created_at: "2026-02-03T10:00:00Z" },
  ];
  assert.equal(findOpenCycleStart(fills), "2026-02-01T10:00:00Z");
});

test("calculates capital at risk and reward-risk from stop and target", () => {
  const risk = calculatePositionRisk({ quantityMicros: 2_000_000, lastPriceCents: 10_000, stopPriceCents: 9_000, targetPriceCents: 12_000 });
  assert.equal(risk.stopDistancePct, 10);
  assert.equal(risk.targetDistancePct, 20);
  assert.equal(risk.capitalAtRiskCents, 2_000);
  assert.equal(risk.rewardRiskRatio, 2);
});

test("marks risk as unlimited when no stop exists", () => {
  const risk = calculatePositionRisk({ quantityMicros: 1_000_000, lastPriceCents: 10_000, stopPriceCents: null, targetPriceCents: 11_000 });
  assert.equal(risk.capitalAtRiskCents, null);
  assert.equal(risk.rewardRiskRatio, null);
});

test("tracks a short cycle and calculates inverse stop and target distances", () => {
  const fills = [
    { side: "SELL" as const, quantity_micros: 2_000_000, created_at: "2026-03-01T10:00:00Z" },
    { side: "BUY" as const, quantity_micros: 500_000, created_at: "2026-03-02T10:00:00Z" },
  ];
  assert.equal(findOpenCycleStart(fills), "2026-03-01T10:00:00Z");
  const risk = calculatePositionRisk({ quantityMicros: -1_500_000, direction: "SHORT", lastPriceCents: 10_000, stopPriceCents: 11_000, targetPriceCents: 8_000 });
  assert.equal(risk.stopDistancePct, 10);
  assert.equal(risk.targetDistancePct, 20);
  assert.equal(risk.capitalAtRiskCents, 1_500);
  assert.equal(risk.rewardRiskRatio, 2);
});

test("builds position pnl over time from the actual open cycle", () => {
  const longSeries = buildPositionPerformanceSeries({
    symbol: "AAPL",
    fills: [{ side: "BUY", symbol: "AAPL", quantity_micros: 2_000_000, price_cents: 10_000, fee_cents: 0, created_at: "2026-01-01T15:00:00Z" }],
    bars: [{ date: "2026-01-02", closeCents: 11_000 }],
    quote: { priceCents: 9_000, observedAt: "2026-01-03T15:00:00Z" },
  });
  assert.deepEqual(longSeries.map((point) => point.pnlCents), [0, 2_000, -2_000]);
  assert.equal(longSeries.at(-1)?.returnPct, -10);

  const shortSeries = buildPositionPerformanceSeries({
    symbol: "^GSPC",
    fills: [{ side: "SELL", symbol: "^GSPC", quantity_micros: 2_000_000, price_cents: 10_000, fee_cents: 0, created_at: "2026-01-01T15:00:00Z" }],
    bars: [],
    quote: { priceCents: 9_000, observedAt: "2026-01-02T15:00:00Z" },
  });
  assert.equal(shortSeries.at(-1)?.pnlCents, 2_000);
  assert.equal(shortSeries.at(-1)?.returnPct, 10);
});

test("maps Yahoo asset symbols to TradingView chart symbols", () => {
  assert.equal(toTradingViewSymbol("BTC-USD", "CRYPTOCURRENCY", "CCC"), "COINBASE:BTCUSD");
  assert.equal(toTradingViewSymbol("AAPL", "EQUITY", "NasdaqGS"), "NASDAQ:AAPL");
  assert.equal(toTradingViewSymbol("GC=F", "FUTURE", "COMEX"), "COMEX:GC1!");
  assert.equal(toTradingViewSymbol("^GSPC", "INDEX", "SNP"), "SP:SPX");
  assert.equal(tradingViewChartUrl("AAPL", "EQUITY", "NasdaqGS"), "https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL");
});
