import { normalizeSymbol } from "./finance.ts";

const INDEX_SYMBOLS: Record<string, string> = {
  "^GSPC": "SP:SPX",
  "^DJI": "DJ:DJI",
  "^IXIC": "NASDAQ:IXIC",
  "^RUT": "RUSSELL:RUT",
  "^VIX": "CBOE:VIX",
};

const FUTURE_EXCHANGES: Record<string, string> = {
  GC: "COMEX", SI: "COMEX", HG: "COMEX",
  CL: "NYMEX", NG: "NYMEX",
  ES: "CME_MINI", NQ: "CME_MINI", RTY: "CME_MINI", YM: "CBOT_MINI",
  ZB: "CBOT", ZN: "CBOT", ZC: "CBOT", ZW: "CBOT", ZS: "CBOT",
};

export function toTradingViewSymbol(rawSymbol: string, assetClass: string, exchange: string): string {
  const symbol = normalizeSymbol(rawSymbol);
  if (INDEX_SYMBOLS[symbol]) return INDEX_SYMBOLS[symbol];
  if (assetClass === "CRYPTOCURRENCY" && symbol.endsWith("-USD")) return `COINBASE:${symbol.replace("-", "")}`;
  if (assetClass === "CURRENCY" && symbol.endsWith("=X")) return `FX_IDC:${symbol.replace("=X", "")}`;
  if (assetClass === "FUTURE" && symbol.endsWith("=F")) {
    const root = symbol.replace("=F", "");
    return `${FUTURE_EXCHANGES[root] ?? "CME"}:${root}1!`;
  }
  const normalizedExchange = exchange.toUpperCase();
  const prefix = normalizedExchange.includes("NASDAQ") ? "NASDAQ"
    : normalizedExchange.includes("NYSEARCA") || normalizedExchange.includes("NYSE ARCA") ? "AMEX"
      : normalizedExchange.includes("NYSE") ? "NYSE"
        : normalizedExchange.includes("CBOE") || normalizedExchange.includes("BATS") ? "CBOE"
          : "";
  return prefix ? `${prefix}:${symbol}` : symbol;
}

export function tradingViewChartUrl(symbol: string, assetClass: string, exchange: string): string {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(toTradingViewSymbol(symbol, assetClass, exchange))}`;
}
