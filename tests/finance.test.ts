import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPositions,
  dollarsToPriceCents,
  positionMarketValueCents,
  protectivePriceCents,
  parseDecimal,
  cashPercentageFromText,
  resolveQuantityMicros,
  shouldFillOrder,
  simulatedFillPriceCents,
  normalizeSymbol,
} from "../lib/finance.ts";
import { COMPANY_SYMBOL_FALLBACKS, selectYahooAssetMatch } from "../lib/market-data.ts";

test("resolves notional and percentage sizing without floating portfolio state", () => {
  assert.equal(
    resolveQuantityMicros({
      intent: {
        action: "BUY",
        symbol: "NFLX",
        sizingType: "NOTIONAL",
        sizingValue: "1000",
        orderType: "MARKET",
      },
      referencePriceCents: 50_000,
      availableCashCents: 10_000_00,
      positionQuantityMicros: 0,
    }),
    2_000_000,
  );
  assert.equal(
    resolveQuantityMicros({
      intent: {
        action: "REDUCE",
        symbol: "PYPL",
        sizingType: "POSITION_PCT",
        sizingValue: "50",
        orderType: "MARKET",
      },
      referencePriceCents: 7_000,
      availableCashCents: 0,
      positionQuantityMicros: 12_000_000,
    }),
    6_000_000,
  );
});

test("preserva precisão subcentavo para criptoativos como PEPE", () => {
  const priceCents = dollarsToPriceCents("0.00000284");
  const quantityMicros = resolveQuantityMicros({
    intent: { action: "BUY", symbol: "PEPE-USD", sizingType: "NOTIONAL", sizingValue: "100", orderType: "MARKET" },
    referencePriceCents: priceCents,
    availableCashCents: 10_000,
    positionQuantityMicros: 0,
  });
  assert.equal(priceCents, 0.000284);
  assert.ok(quantityMicros > 35_000_000 * 1_000_000);
  assert.equal(positionMarketValueCents(quantityMicros, priceCents), 10_000);
  assert.ok(simulatedFillPriceCents({ side: "BUY", orderType: "MARKET", quotePriceCents: priceCents, triggerPriceCents: null }) < 0.001);
  assert.ok(protectivePriceCents(priceCents, 500, "STOP_LOSS") > 0);
});

test("extracts an explicit percentage of available cash from natural language", () => {
  assert.equal(cashPercentageFromText("compre 10% do caixa disponivel em petroleo"), 10);
  assert.equal(cashPercentageFromText("invista 2,5% de caixa em Apple"), 2.5);
  assert.equal(cashPercentageFromText("compre US$ 100 de Apple"), null);
});

test("parses Brazilian and US formatted monetary values", () => {
  assert.equal(parseDecimal("1.000"), 1000);
  assert.equal(parseDecimal("1.000,50"), 1000.5);
  assert.equal(parseDecimal("1,000.50"), 1000.5);
  assert.equal(parseDecimal("190.50"), 190.5);
  assert.equal(parseDecimal("10%"), 10);
  assert.equal(parseDecimal("US$ 1.000,50"), 1000.5);
});

test("applies correct limit and stop trigger semantics", () => {
  assert.equal(shouldFillOrder({ side: "BUY", orderType: "LIMIT", quotePriceCents: 9_900, triggerPriceCents: 10_000 }), true);
  assert.equal(shouldFillOrder({ side: "BUY", orderType: "STOP", quotePriceCents: 9_900, triggerPriceCents: 10_000 }), false);
  assert.equal(shouldFillOrder({ side: "SELL", orderType: "STOP", quotePriceCents: 9_900, triggerPriceCents: 10_000 }), true);
  assert.equal(simulatedFillPriceCents({ side: "BUY", orderType: "LIMIT", quotePriceCents: 9_800, triggerPriceCents: 10_000 }), 9_800);
});

test("computes weighted cost and realized pnl from immutable fills", () => {
  const positions = buildPositions([
    { side: "BUY", symbol: "AAPL", quantityMicros: 10_000_000, priceCents: 10_000, feeCents: 0, createdAt: "2026-01-01" },
    { side: "BUY", symbol: "AAPL", quantityMicros: 10_000_000, priceCents: 12_000, feeCents: 0, createdAt: "2026-01-02" },
    { side: "SELL", symbol: "AAPL", quantityMicros: 5_000_000, priceCents: 13_000, feeCents: 0, createdAt: "2026-01-03" },
  ]).get("AAPL");

  assert.ok(positions);
  assert.equal(positions.quantityMicros, 15_000_000);
  assert.equal(positions.averageCostCents, 11_000);
  assert.equal(positions.realizedPnlCents, 10_000);
});

test("derives protective prices from the actual fill", () => {
  assert.equal(protectivePriceCents(20_000, 500, "STOP_LOSS"), 19_000);
  assert.equal(protectivePriceCents(20_000, 1_000, "TAKE_PROFIT"), 22_000);
  assert.equal(protectivePriceCents(20_000, 500, "STOP_LOSS", "SHORT"), 21_000);
  assert.equal(protectivePriceCents(20_000, 1_000, "TAKE_PROFIT", "SHORT"), 18_000);
});

test("opens, partially covers, and closes a short with inverse pnl", () => {
  const partial = buildPositions([
    { side: "SELL", symbol: "^GSPC", quantityMicros: 10_000_000, priceCents: 10_000, feeCents: 0, createdAt: "2026-01-01" },
    { side: "BUY", symbol: "^GSPC", quantityMicros: 4_000_000, priceCents: 9_000, feeCents: 0, createdAt: "2026-01-02" },
  ]).get("^GSPC");
  assert.ok(partial);
  assert.equal(partial.quantityMicros, -6_000_000);
  assert.equal(partial.averageCostCents, 10_000);
  assert.equal(partial.costBasisCents, -60_000);
  assert.equal(partial.realizedPnlCents, 4_000);

  const closed = buildPositions([
    { side: "SELL", symbol: "^GSPC", quantityMicros: 10_000_000, priceCents: 10_000, feeCents: 0, createdAt: "2026-01-01" },
    { side: "BUY", symbol: "^GSPC", quantityMicros: 4_000_000, priceCents: 9_000, feeCents: 0, createdAt: "2026-01-02" },
    { side: "BUY", symbol: "^GSPC", quantityMicros: 6_000_000, priceCents: 11_000, feeCents: 0, createdAt: "2026-01-03" },
  ]).get("^GSPC");
  assert.ok(closed);
  assert.equal(closed.quantityMicros, 0);
  assert.equal(closed.realizedPnlCents, -2_000);
});

test("selects any Yahoo asset type that matches a name or ticker", () => {
  const quotes = [
    { symbol: "APLE", shortname: "Apple Hospitality REIT", quoteType: "EQUITY" },
    { symbol: "AAPL", longname: "Apple Inc.", quoteType: "EQUITY" },
    { symbol: "AAPL240", shortname: "Apple option", quoteType: "OPTION" },
  ];
  assert.equal(selectYahooAssetMatch("AAPL", quotes)?.symbol, "AAPL");
  assert.equal(selectYahooAssetMatch("Apple Inc.", quotes)?.symbol, "AAPL");
  assert.equal(selectYahooAssetMatch("AAPL240", quotes)?.quoteType, "OPTION");
});

test("preserves Yahoo symbols for crypto, futures, currencies, and indices", () => {
  assert.equal(normalizeSymbol("btc-usd"), "BTC-USD");
  assert.equal(normalizeSymbol("gc=f"), "GC=F");
  assert.equal(normalizeSymbol("eurusd=x"), "EURUSD=X");
  assert.equal(normalizeSymbol("^gspc"), "^GSPC");
  assert.equal(COMPANY_SYMBOL_FALLBACKS.spx, "^GSPC");
  assert.equal(COMPANY_SYMBOL_FALLBACKS.chevron, "CVX");
});
