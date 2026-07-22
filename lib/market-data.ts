import { normalizeSymbol, roundPriceCents, type Quote } from "./finance.ts";

export type MarketDataProvider = {
  id: string;
  getQuote(symbol: string): Promise<Quote>;
};

export type BinanceInterval = "5m" | "30m" | "1h" | "1d";
export type BinancePriceBar = { observedAt: string; priceCents: number };
export type BinancePair = { binanceSymbol: string; portfolioSymbol: string; baseAsset: string };

const BINANCE_MARKET_DATA_URL = "https://data-api.binance.vision";

export function parseBinancePairInput(rawSymbol: string): BinancePair | null {
  const symbol = normalizeSymbol(rawSymbol).replaceAll("/", "").replaceAll(" ", "");
  const match = symbol.match(/^([A-Z0-9]{2,15})-?USDT$/) ?? symbol.match(/^([A-Z0-9]{2,15})-USD$/);
  if (!match || match[1] === "USDT") return null;
  return { binanceSymbol: `${match[1]}USDT`, portfolioSymbol: `${match[1]}-USD`, baseAsset: match[1] };
}

export function toBinanceSpotSymbol(rawSymbol: string): string | null {
  return parseBinancePairInput(rawSymbol)?.binanceSymbol ?? null;
}

export function normalizeMarketSymbol(rawSymbol: string): string {
  return parseBinancePairInput(rawSymbol)?.portfolioSymbol ?? normalizeSymbol(rawSymbol);
}

export function normalizeBinanceKlines(payload: unknown): BinancePriceBar[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const timestamp = Number(row[0]);
    const close = Number(row[4]);
    return Number.isFinite(timestamp) && Number.isFinite(close) && close > 0
      ? [{ observedAt: new Date(timestamp).toISOString(), priceCents: roundPriceCents(close * 100) }]
      : [];
  });
}

export async function fetchBinanceBars(
  rawSymbol: string,
  interval: BinanceInterval,
  start: number,
  end: number,
): Promise<BinancePriceBar[]> {
  const symbol = toBinanceSpotSymbol(rawSymbol);
  if (!symbol) throw new Error(`Sem par spot Binance para ${rawSymbol}`);
  const bars: BinancePriceBar[] = [];
  let cursor = Math.max(0, start);
  for (let page = 0; page < 25 && cursor <= end; page += 1) {
    const params = new URLSearchParams({ symbol, interval, startTime: String(cursor), endTime: String(end), limit: "1000" });
    const response = await fetch(`${BINANCE_MARKET_DATA_URL}/api/v3/klines?${params}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Binance respondeu ${response.status} para ${symbol}`);
    const pageBars = normalizeBinanceKlines(await response.json());
    if (!pageBars.length) break;
    bars.push(...pageBars);
    const next = Date.parse(pageBars.at(-1)!.observedAt) + 1;
    if (next <= cursor || pageBars.length < 1000) break;
    cursor = next;
  }
  if (!bars.length) throw new Error(`Histórico Binance indisponível para ${symbol}`);
  return bars;
}

export type SymbolResolution = {
  query: string;
  symbol: string;
  name: string;
  exchange: string;
  assetClass: YahooAssetClass;
  source: "BINANCE_SPOT" | "YAHOO_SEARCH" | "LOCAL_FALLBACK";
};

export type YahooAssetClass = "EQUITY" | "ETF" | "MUTUALFUND" | "INDEX" | "CRYPTOCURRENCY" | "FUTURE" | "CURRENCY" | "OPTION" | "MONEYMARKET" | "ECNQUOTE" | "OTHER";

export type AssetSuggestion = SymbolResolution & { reason: string };

export type AssetResolutionResult = {
  resolution: SymbolResolution | null;
  suggestions: AssetSuggestion[];
  needsSelection: boolean;
};

export type YahooSearchQuote = {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchange?: string;
  exchDisp?: string;
  quoteType?: string;
  typeDisp?: string;
  score?: number;
};

export const COMPANY_SYMBOL_FALLBACKS: Record<string, string> = {
  apple: "AAPL",
  netflix: "NFLX",
  paypal: "PYPL",
  microsoft: "MSFT",
  amazon: "AMZN",
  nvidia: "NVDA",
  meta: "META",
  facebook: "META",
  google: "GOOGL",
  alphabet: "GOOGL",
  tesla: "TSLA",
  chevron: "CVX",
  bitcoin: "BTC-USD",
  btc: "BTC-USD",
  ethereum: "ETH-USD",
  ether: "ETH-USD",
  spx: "^GSPC",
  "s&p 500": "^GSPC",
  "s&p500": "^GSPC",
  "sp 500": "^GSPC",
  nasdaq: "^IXIC",
  "dow jones": "^DJI",
  vix: "^VIX",
};

const THEME_SEARCHES: Record<string, string> = {
  uranio: "uranium ETF",
  uranium: "uranium ETF",
  ouro: "gold ETF",
  gold: "gold ETF",
  petroleo: "oil ETF",
  oil: "oil ETF",
  prata: "silver ETF",
  silver: "silver ETF",
  cobre: "copper ETF",
  copper: "copper ETF",
  cannabis: "cannabis ETF",
  hidrogenio: "hydrogen ETF",
};

function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function assetClassOf(quote: YahooSearchQuote): YahooAssetClass {
  const value = (quote.quoteType ?? quote.typeDisp ?? "OTHER").replaceAll(" ", "").toUpperCase();
  const supported: YahooAssetClass[] = ["EQUITY", "ETF", "MUTUALFUND", "INDEX", "CRYPTOCURRENCY", "FUTURE", "CURRENCY", "OPTION", "MONEYMARKET", "ECNQUOTE"];
  return supported.includes(value as YahooAssetClass) ? value as YahooAssetClass : "OTHER";
}

export function selectYahooAssetMatch(query: string, quotes: YahooSearchQuote[]): YahooSearchQuote | null {
  const normalizedQuery = normalizeSearchText(query);
  const tickerQuery = normalizeSymbol(query);
  const assets = quotes.filter((quote) => Boolean(quote.symbol));
  return assets.find((quote) => normalizeSymbol(quote.symbol ?? "") === tickerQuery)
    ?? assets.find((quote) => normalizeSearchText(quote.shortname ?? "") === normalizedQuery || normalizeSearchText(quote.longname ?? "") === normalizedQuery)
    ?? assets.find((quote) => {
      const name = normalizeSearchText(`${quote.shortname ?? ""} ${quote.longname ?? ""}`);
      return normalizedQuery.length >= 4 && (name.startsWith(normalizedQuery) || name.includes(` ${normalizedQuery} `));
    })
    ?? null;
}

async function yahooSearch(query: string, count = 12): Promise<YahooSearchQuote[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=${count}&newsCount=0`;
  const response = await fetch(url, { headers: { "User-Agent": "Brok.ai/1.0 personal-research" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Yahoo Search respondeu ${response.status}`);
  const payload = await response.json() as { quotes?: YahooSearchQuote[] };
  return payload.quotes ?? [];
}

function toResolution(query: string, quote: YahooSearchQuote): SymbolResolution {
  return {
    query,
    symbol: normalizeSymbol(quote.symbol ?? ""),
    name: quote.longname ?? quote.shortname ?? quote.symbol ?? query,
    exchange: quote.exchDisp ?? quote.exchange ?? "Yahoo Finance",
    assetClass: assetClassOf(quote),
    source: "YAHOO_SEARCH",
  };
}

export async function resolveYahooAsset(rawQuery: string): Promise<AssetResolutionResult> {
  const query = rawQuery.trim();
  if (!query) throw new Error("Não identifiquei o ativo, tema ou ticker");
  if (["US", "USD"].includes(normalizeSymbol(query))) throw new Error(`${query} é uma moeda de referência, não um ticker`);
  const normalizedQuery = normalizeSearchText(query);
  const localSymbol = COMPANY_SYMBOL_FALLBACKS[normalizedQuery];
  const binancePair = parseBinancePairInput(query);
  const explicitBinancePair = binancePair && normalizeSymbol(query).replaceAll("/", "").endsWith("USDT") ? binancePair : null;
  try {
    if (explicitBinancePair) {
      const quote = await new BinanceMarketDataProvider().getQuote(query);
      return {
        resolution: {
          query,
          symbol: explicitBinancePair.portfolioSymbol,
          name: `${explicitBinancePair.baseAsset} / US Dollar`,
          exchange: quote.exchange ?? "Binance Spot",
          assetClass: "CRYPTOCURRENCY",
          source: "BINANCE_SPOT",
        },
        suggestions: [],
        needsSelection: false,
      };
    }
    const directQuery = localSymbol ?? binancePair?.portfolioSymbol ?? query;
    const directQuotes = await yahooSearch(directQuery);
    const match = THEME_SEARCHES[normalizedQuery] ? null : selectYahooAssetMatch(directQuery, directQuotes);
    if (match?.symbol) return { resolution: toResolution(query, match), suggestions: [], needsSelection: false };

    const suggestionQuery = THEME_SEARCHES[normalizedQuery] ?? `${query} ETF`;
    const suggestionQuotes = suggestionQuery === directQuery ? directQuotes : await yahooSearch(suggestionQuery, 20);
    const preferred = suggestionQuotes
      .filter((quote) => quote.symbol)
      .sort((a, b) => Number(assetClassOf(b) === "ETF") - Number(assetClassOf(a) === "ETF") || (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 5)
      .map((quote) => ({ ...toResolution(query, quote), reason: assetClassOf(quote) === "ETF" ? `ETF relacionado a ${query}` : `Ativo relacionado a ${query}` }));
    if (!preferred.length) throw new Error(`Nenhum ativo ou alternativa encontrado para ${query}`);
    return { resolution: null, suggestions: preferred, needsSelection: true };
  } catch (error) {
    const symbol = localSymbol ?? binancePair?.portfolioSymbol ?? (/^[A-Z0-9.^=\-]{1,24}$/.test(query) && !["US", "USD"].includes(query) ? query : "");
    if (!symbol) throw error;
    return { resolution: { query, symbol: normalizeSymbol(symbol), name: query, exchange: "Fallback local", assetClass: "OTHER", source: "LOCAL_FALLBACK" }, suggestions: [], needsSelection: false };
  }
}

export class YahooMarketDataProvider implements MarketDataProvider {
  id = "YAHOO";

  async getQuote(rawSymbol: string): Promise<Quote> {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) throw new Error("Símbolo inválido");
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Brok.ai/1.0 personal-research" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Yahoo respondeu ${response.status}`);
    const payload = await response.json() as {
      chart?: {
        error?: { description?: string } | null;
        result?: Array<{
          meta?: { regularMarketPrice?: number; previousClose?: number; instrumentType?: string; longName?: string; shortName?: string; exchangeName?: string; fullExchangeName?: string };
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = payload.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const lastClose = [...closes].reverse().find((value) => typeof value === "number");
    const price = result?.meta?.regularMarketPrice ?? lastClose ?? result?.meta?.previousClose;
    if (!price || !Number.isFinite(price)) {
      throw new Error(payload.chart?.error?.description ?? `Sem cotação para ${symbol}`);
    }
    return {
      symbol,
      priceCents: roundPriceCents(price * 100),
      observedAt: new Date().toISOString(),
      source: this.id,
      assetClass: result?.meta?.instrumentType ?? "OTHER",
      name: result?.meta?.longName ?? result?.meta?.shortName ?? symbol,
      exchange: result?.meta?.fullExchangeName ?? result?.meta?.exchangeName ?? "Yahoo Finance",
    };
  }
}

export class BinanceMarketDataProvider implements MarketDataProvider {
  id = "BINANCE_SPOT";

  async getQuote(rawSymbol: string): Promise<Quote> {
    const pair = parseBinancePairInput(rawSymbol);
    const yahooSymbol = pair?.portfolioSymbol ?? normalizeSymbol(rawSymbol);
    const symbol = pair?.binanceSymbol ?? null;
    if (!symbol) throw new Error(`Sem par spot Binance para ${yahooSymbol}`);
    const response = await fetch(`${BINANCE_MARKET_DATA_URL}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Binance respondeu ${response.status} para ${symbol}`);
    const payload = await response.json() as { price?: string };
    const price = Number(payload.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Sem cotação Binance para ${symbol}`);
    return {
      symbol: yahooSymbol,
      priceCents: roundPriceCents(price * 100),
      observedAt: new Date().toISOString(),
      source: this.id,
      assetClass: "CRYPTOCURRENCY",
      name: yahooSymbol.replace(/-(USD|USDT)$/, ""),
      exchange: "Binance Spot",
    };
  }
}

export class BinanceYahooMarketDataProvider implements MarketDataProvider {
  id = "BINANCE_YAHOO";
  private readonly binance = new BinanceMarketDataProvider();
  private readonly yahoo = new YahooMarketDataProvider();

  async getQuote(symbol: string): Promise<Quote> {
    if (toBinanceSpotSymbol(symbol)) {
      try {
        return await this.binance.getQuote(symbol);
      } catch {
        // Yahoo preserves availability when a pair is absent, rate-limited or regionally unavailable.
      }
    }
    return this.yahoo.getQuote(symbol);
  }
}

export class AlpacaMarketDataProvider implements MarketDataProvider {
  id = "ALPACA_IEX";
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  async getQuote(rawSymbol: string): Promise<Quote> {
    const symbol = normalizeSymbol(rawSymbol);
    const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=iex`;
    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": this.apiKey,
        "APCA-API-SECRET-KEY": this.apiSecret,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Alpaca respondeu ${response.status}`);
    const payload = await response.json() as { quote?: { ap?: number; bp?: number; t?: string } };
    const ask = payload.quote?.ap;
    const bid = payload.quote?.bp;
    const price = ask && bid ? (ask + bid) / 2 : ask ?? bid;
    if (!price) throw new Error(`Sem cotação Alpaca para ${symbol}`);
    return {
      symbol,
      priceCents: roundPriceCents(price * 100),
      observedAt: payload.quote?.t ?? new Date().toISOString(),
      source: this.id,
    };
  }
}
