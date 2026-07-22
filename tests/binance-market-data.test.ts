import test from "node:test";
import assert from "node:assert/strict";
import { BinanceMarketDataProvider, normalizeBinanceKlines, normalizeMarketSymbol, parseBinancePairInput, resolveYahooAsset, toBinanceSpotSymbol } from "../lib/market-data.ts";

test("converte símbolos Yahoo de cripto para pares spot USDT da Binance", () => {
  assert.equal(toBinanceSpotSymbol("BTC-USD"), "BTCUSDT");
  assert.equal(toBinanceSpotSymbol("eth-usdt"), "ETHUSDT");
  assert.equal(toBinanceSpotSymbol("PEPEUSDT"), "PEPEUSDT");
  assert.deepEqual(parseBinancePairInput("PEPE/USDT"), { binanceSymbol: "PEPEUSDT", portfolioSymbol: "PEPE-USD", baseAsset: "PEPE" });
  assert.equal(normalizeMarketSymbol("PEPEUSDT"), "PEPE-USD");
  assert.equal(toBinanceSpotSymbol("AAPL"), null);
  assert.equal(toBinanceSpotSymbol("EURUSD=X"), null);
  assert.equal(toBinanceSpotSymbol("USDT-USD"), null);
});

test("normaliza candles válidos da Binance e ignora linhas inválidas", () => {
  const bars = normalizeBinanceKlines([
    [1_700_000_000_000, "1", "2", "0.5", "123.456"],
    ["inválido", "1", "2", "0.5", "99"],
    [1_700_000_100_000, "1", "2", "0.5", "0"],
  ]);
  assert.deepEqual(bars, [{ observedAt: new Date(1_700_000_000_000).toISOString(), priceCents: 12_345.6 }]);
});

test("resolve PEPEUSDT pela Binance e preserva preço subcentavo", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ symbol: "PEPEUSDT", price: "0.00000284" });
  try {
    const quote = await new BinanceMarketDataProvider().getQuote("PEPEUSDT");
    assert.equal(quote.symbol, "PEPE-USD");
    assert.equal(quote.priceCents, 0.000284);
    const result = await resolveYahooAsset("PEPEUSDT");
    assert.equal(result.resolution?.symbol, "PEPE-USD");
    assert.equal(result.resolution?.source, "BINANCE_SPOT");
    assert.equal(result.resolution?.assetClass, "CRYPTOCURRENCY");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
