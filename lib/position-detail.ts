import { ensureDatabase, getDatabase } from "../db";
import { normalizeSymbol, positionMarketValueCents, type Side } from "./finance";
import { fetchMarketSeries, type Bar } from "./analytics";
import { getDashboardState } from "./trading-engine";
import { buildPositionPerformanceSeries, calculatePositionRisk, findOpenCycleStart, type PositionPerformancePoint } from "./position-detail-math";
import { tradingViewChartUrl } from "./external-links";

type DetailFillRow = {
  id: string;
  order_id: string;
  symbol: string;
  side: Side;
  quantity_micros: number;
  price_cents: number;
  fee_cents: number;
  created_at: string;
};

type DetailOrderRow = {
  id: string;
  symbol: string;
  side: Side;
  order_type: "MARKET" | "LIMIT" | "STOP";
  role: string;
  status: string;
  quantity_micros: number;
  remaining_micros: number;
  trigger_price_cents: number | null;
  average_fill_price_cents: number | null;
  oco_group_id: string | null;
  created_at: string;
  updated_at: string;
};

type DetailCorporateAction = {
  id: string;
  symbol: string;
  action_type: string;
  effective_date: string;
  value_text: string;
  status: string;
};

export type PositionDetail = {
  symbol: string;
  direction: "LONG" | "SHORT";
  name: string;
  assetClass: string;
  exchange: string;
  quote: { priceCents: number; source: string; observedAt: string; ageMinutes: number | null };
  position: {
    quantityMicros: number;
    averageCostCents: number;
    costBasisCents: number;
    marketValueCents: number;
    allocationPct: number;
  };
  pnl: {
    dayCents: number | null;
    dayPct: number | null;
    unrealizedCents: number;
    unrealizedPct: number;
    realizedHistoricalCents: number;
    totalCents: number;
    contributionPct: number;
    series: PositionPerformancePoint[];
  };
  risk: {
    stopPriceCents: number | null;
    targetPriceCents: number | null;
    stopDistancePct: number | null;
    targetDistancePct: number | null;
    capitalAtRiskCents: number | null;
    rewardRiskRatio: number | null;
    breakEvenCents: number;
    scenarios: Array<{ shockPct: number; pnlCents: number; resultingValueCents: number }>;
  };
  cycle: { openedAt: string | null; daysHeld: number | null };
  history: { bars: Bar[]; error: string | null };
  news: Array<{ id: string; title: string; publisher: string; url: string; publishedAt: string; relatedTickers: string[]; priority: boolean }>;
  newsError: string | null;
  tradingViewUrl: string;
  fills: DetailFillRow[];
  orders: DetailOrderRow[];
  corporateActions: DetailCorporateAction[];
};

function safeHttpUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function fetchYahooNews(symbol: string, name: string) {
  const query = symbol || name;
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=12&enableFuzzyQuery=false`;
  const response = await fetch(url, { headers: { "User-Agent": "Brok.ai/1.0 personal-research" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Yahoo News respondeu ${response.status}`);
  const payload = await response.json() as { news?: Array<{ uuid?: string; title?: string; publisher?: string; link?: string; providerPublishTime?: number; relatedTickers?: string[] }> };
  const priorityPublishers = ["reuters", "bloomberg", "associated press", "cnbc", "financial times", "wall street journal", "wsj", "barrons", "marketwatch", "coindesk"];
  return (payload.news ?? []).flatMap((item, index) => {
    const articleUrl = safeHttpUrl(item.link);
    if (!item.title || !articleUrl) return [];
    const publisher = item.publisher ?? "Yahoo Finance";
    return [{
      id: item.uuid ?? `${symbol}-${index}`,
      title: item.title,
      publisher,
      url: articleUrl,
      publishedAt: item.providerPublishTime ? new Date(item.providerPublishTime * 1000).toISOString() : "",
      relatedTickers: item.relatedTickers ?? [],
      priority: priorityPublishers.some((candidate) => publisher.toLowerCase().includes(candidate)),
    }];
  }).sort((a, b) => (Number(b.priority) * 3 + Number(b.relatedTickers.includes(symbol)) * 2) - (Number(a.priority) * 3 + Number(a.relatedTickers.includes(symbol)) * 2) || b.publishedAt.localeCompare(a.publishedAt)).slice(0, 6);
}

export async function getPositionDetail(rawSymbol: string): Promise<PositionDetail> {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol || !/^[A-Z0-9.^=\-]{1,24}$/.test(symbol)) throw new Error("Ticker inválido");
  const db = getDatabase();
  await ensureDatabase(db);
  const state = await getDashboardState();
  const position = state.positions.find((item) => item.symbol === symbol);
  if (!position) throw new Error(`Não existe posição aberta em ${symbol}`);
  const [fillResult, orderResult, actionResult, historyResult, newsResult] = await Promise.all([
    db.prepare("SELECT * FROM fills WHERE symbol = ? ORDER BY created_at ASC, id ASC").bind(symbol).all<DetailFillRow>(),
    db.prepare("SELECT * FROM orders WHERE symbol = ? ORDER BY created_at DESC, id DESC").bind(symbol).all<DetailOrderRow>(),
    db.prepare("SELECT id, symbol, action_type, effective_date, value_text, status FROM corporate_actions WHERE symbol = ? ORDER BY effective_date DESC").bind(symbol).all<DetailCorporateAction>(),
    fetchMarketSeries(symbol, "1y").then((series) => ({ series, error: null as string | null })).catch((error) => ({ series: null, error: error instanceof Error ? error.message : "Histórico indisponível" })),
    fetchYahooNews(symbol, position.name).then((news) => ({ news, error: null as string | null })).catch((error) => ({ news: [], error: error instanceof Error ? error.message : "Notícias indisponíveis" })),
  ]);
  const fills = fillResult.results ?? [];
  const orders = orderResult.results ?? [];
  const openStop = orders.find((order) => order.status === "OPEN" && order.role === "STOP_LOSS");
  const openTarget = orders.find((order) => order.status === "OPEN" && order.role === "TAKE_PROFIT");
  const stopPriceCents = openStop?.trigger_price_cents ?? null;
  const targetPriceCents = openTarget?.trigger_price_cents ?? null;
  const risk = calculatePositionRisk({ quantityMicros: position.quantityMicros, direction: position.direction, lastPriceCents: position.lastPriceCents, stopPriceCents, targetPriceCents });
  const costBasisCents = positionMarketValueCents(Math.abs(position.quantityMicros), position.averageCostCents);
  const previousCloseCents = historyResult.series?.previousCloseCents ?? null;
  const dayCents = previousCloseCents === null ? null : positionMarketValueCents(position.quantityMicros, position.lastPriceCents - previousCloseCents);
  const openedAt = findOpenCycleStart(fills);
  const performanceSeries = buildPositionPerformanceSeries({
    symbol,
    fills,
    bars: historyResult.series?.bars ?? [],
    quote: { priceCents: position.lastPriceCents, observedAt: position.quoteObservedAt || new Date().toISOString() },
  });
  const grossAbsolutePnl = state.positions.reduce((total, item) => total + Math.abs(item.unrealizedPnlCents), 0);
  return {
    symbol,
    direction: position.direction,
    name: position.name,
    assetClass: position.assetClass,
    exchange: position.exchange,
    quote: {
      priceCents: position.lastPriceCents,
      source: position.quoteSource,
      observedAt: position.quoteObservedAt,
      ageMinutes: position.quoteObservedAt ? Math.max(0, (Date.now() - Date.parse(position.quoteObservedAt)) / 60_000) : null,
    },
    position: {
      quantityMicros: position.quantityMicros,
      averageCostCents: position.averageCostCents,
      costBasisCents,
      marketValueCents: position.marketValueCents,
      allocationPct: position.allocationPct,
    },
    pnl: {
      dayCents,
      dayPct: previousCloseCents && previousCloseCents > 0 ? (position.lastPriceCents / previousCloseCents - 1) * 100 * (position.direction === "SHORT" ? -1 : 1) : null,
      unrealizedCents: position.unrealizedPnlCents,
      unrealizedPct: costBasisCents > 0 ? position.unrealizedPnlCents / costBasisCents * 100 : 0,
      realizedHistoricalCents: position.realizedPnlCents,
      totalCents: position.realizedPnlCents + position.unrealizedPnlCents,
      contributionPct: grossAbsolutePnl > 0 ? position.unrealizedPnlCents / grossAbsolutePnl * 100 : 0,
      series: performanceSeries,
    },
    risk: {
      stopPriceCents,
      targetPriceCents,
      ...risk,
      breakEvenCents: position.averageCostCents,
      scenarios: [-10, -5, 5, 10].map((shockPct) => ({
        shockPct,
        pnlCents: Math.round(position.marketValueCents * shockPct / 100 * (position.direction === "SHORT" ? -1 : 1)),
        resultingValueCents: Math.round(position.marketValueCents * (1 + shockPct / 100)),
      })),
    },
    cycle: { openedAt, daysHeld: openedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(openedAt)) / 86_400_000)) : null },
    history: { bars: historyResult.series?.bars ?? [], error: historyResult.error },
    news: newsResult.news,
    newsError: newsResult.error,
    tradingViewUrl: tradingViewChartUrl(symbol, position.assetClass, position.exchange),
    fills: [...fills].reverse(),
    orders,
    corporateActions: actionResult.results ?? [],
  };
}
