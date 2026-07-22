import type { DashboardState } from "./trading-engine";
import { fetchBinanceBars, toBinanceSpotSymbol } from "./market-data.ts";
import { roundPriceCents } from "./finance.ts";

export type AnalyticsAlert = { severity: "HIGH" | "MEDIUM" | "INFO"; title: string; detail: string };

export type PositionAnalytics = {
  symbol: string;
  dayPnlCents: number | null;
  dayReturnPct: number | null;
  totalReturnPct: number;
  contributionPct: number;
  stopPriceCents: number | null;
  targetPriceCents: number | null;
  stopDistancePct: number | null;
  targetDistancePct: number | null;
  capitalAtRiskCents: number | null;
  daysHeld: number;
  quoteAgeMinutes: number | null;
};

export type PortfolioAnalytics = {
  generatedAt: string;
  benchmark: string;
  performance: {
    returnTodayPct: number | null;
    returnWeekPct: number | null;
    returnMonthPct: number | null;
    returnSinceStartPct: number;
    benchmarkSinceStartPct: number | null;
    excessReturnPct: number | null;
    maxDrawdownPct: number;
    currentDrawdownPct: number;
    series: Array<{ date: string; portfolioPct: number; benchmarkPct: number | null }>;
  };
  risk: {
    lossAtStopsCents: number;
    unprotectedValueCents: number;
    protectedPositions: number;
    unprotectedPositions: number;
    largestPositionPct: number;
    topFiveConcentrationPct: number;
    annualizedVolatilityPct: number | null;
    betaVsSpy: number | null;
    highCorrelationPairs: Array<{ left: string; right: string; correlation: number }>;
    scenarios: Array<{ shockPct: number; estimatedPnlCents: number; estimatedEquityCents: number }>;
  };
  execution: {
    fillRatePct: number | null;
    filledOrders: number;
    cancelledOrders: number;
    rejectedOrders: number;
    openOrders: number;
    turnoverPct: number;
    feesCents: number;
    averageSlippageBps: number | null;
    averageFillLatencySeconds: number | null;
  };
  positions: PositionAnalytics[];
  alerts: AnalyticsAlert[];
  health: {
    yahoo: "OK" | "DEGRADED";
    quoteAgeMinutes: number | null;
    staleQuotes: number;
    historyPoints: number;
    note: string;
  };
};

export type Bar = { date: string; closeCents: number };
export type MarketSeries = { symbol: string; previousCloseCents: number | null; bars: Bar[] };

const seriesCache = new Map<string, { expiresAt: number; value: MarketSeries }>();

function safeReturn(current: number, base: number): number {
  return base > 0 ? (current / base - 1) * 100 : 0;
}

export function calculateDrawdowns(values: number[]): { maxDrawdownPct: number; currentDrawdownPct: number } {
  if (!values.length) return { maxDrawdownPct: 0, currentDrawdownPct: 0 };
  let peak = values[0];
  let maxDrawdownPct = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    const drawdown = peak > 0 ? (value / peak - 1) * 100 : 0;
    maxDrawdownPct = Math.min(maxDrawdownPct, drawdown);
  }
  const finalPeak = Math.max(...values);
  return {
    maxDrawdownPct,
    currentDrawdownPct: finalPeak > 0 ? (values.at(-1)! / finalPeak - 1) * 100 : 0,
  };
}

export function correlation(left: number[], right: number[]): number | null {
  const length = Math.min(left.length, right.length);
  if (length < 10) return null;
  const a = left.slice(-length);
  const b = right.slice(-length);
  const meanA = a.reduce((sum, value) => sum + value, 0) / length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < length; index += 1) {
    const deltaA = a[index] - meanA;
    const deltaB = b[index] - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA * deltaA;
    varianceB += deltaB * deltaB;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator > 0 ? covariance / denominator : null;
}

export function selectBenchmarkStartBar(bars: Bar[], startDate: string): Bar | undefined {
  return bars.find((bar) => bar.date >= startDate)
    ?? bars.filter((bar) => bar.date <= startDate).at(-1)
    ?? bars[0];
}

function dailyReturns(series: MarketSeries): Map<string, number> {
  const result = new Map<string, number>();
  for (let index = 1; index < series.bars.length; index += 1) {
    const previous = series.bars[index - 1].closeCents;
    const current = series.bars[index].closeCents;
    if (previous > 0) result.set(series.bars[index].date, current / previous - 1);
  }
  return result;
}

export async function fetchYahooSeries(symbol: string, range: "1y" | "5y" = "1y"): Promise<MarketSeries> {
  const cacheKey = `${symbol}:${range}`;
  const cached = seriesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Brok.ai/1.0 personal-research" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Yahoo respondeu ${response.status} para ${symbol}`);
  const payload = await response.json() as {
    chart?: { result?: Array<{ meta?: { previousClose?: number }; timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
  };
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const bars = timestamps.flatMap((timestamp, index) => {
    const close = closes[index];
    return typeof close === "number" && Number.isFinite(close)
      ? [{ date: new Date(timestamp * 1000).toISOString().slice(0, 10), closeCents: roundPriceCents(close * 100) }]
      : [];
  });
  if (!bars.length) throw new Error(`Histórico indisponível para ${symbol}`);
  const value = {
    symbol,
    previousCloseCents: result?.meta?.previousClose ? Math.round(result.meta.previousClose * 100) : bars.at(-2)?.closeCents ?? null,
    bars,
  };
  seriesCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value });
  return value;
}

export async function fetchMarketSeries(symbol: string, range: "1y" | "5y" = "1y"): Promise<MarketSeries> {
  if (!toBinanceSpotSymbol(symbol)) return fetchYahooSeries(symbol, range);
  const cacheKey = `binance:${symbol}:${range}`;
  const cached = seriesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const days = range === "5y" ? 5 * 366 : 366;
    const end = Date.now();
    const binanceBars = await fetchBinanceBars(symbol, "1d", end - days * 86_400_000, end);
    const bars = binanceBars.map((bar) => ({ date: bar.observedAt.slice(0, 10), closeCents: bar.priceCents }));
    const value = { symbol, previousCloseCents: bars.at(-2)?.closeCents ?? null, bars };
    seriesCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value });
    return value;
  } catch {
    return fetchYahooSeries(symbol, range);
  }
}

function periodReturn(snapshots: DashboardState["snapshots"], days: number): number | null {
  if (snapshots.length < 2) return null;
  const latest = snapshots.at(-1)!;
  const cutoff = Date.parse(latest.created_at) - days * 86_400_000;
  const baseline = [...snapshots].reverse().find((snapshot) => Date.parse(snapshot.created_at) <= cutoff);
  return baseline ? safeReturn(latest.equity_cents, baseline.equity_cents) : null;
}

function returnToday(snapshots: DashboardState["snapshots"]): number | null {
  if (snapshots.length < 2) return null;
  const latest = snapshots.at(-1)!;
  const day = latest.created_at.slice(0, 10);
  const firstToday = snapshots.find((snapshot) => snapshot.created_at.slice(0, 10) === day);
  return firstToday && firstToday.id !== latest.id ? safeReturn(latest.equity_cents, firstToday.equity_cents) : null;
}

function alignedReturns(series: MarketSeries[]): Map<string, Map<string, number>> {
  return new Map(series.map((item) => [item.symbol, dailyReturns(item)]));
}

export async function buildPortfolioAnalytics(state: DashboardState): Promise<PortfolioAnalytics> {
  const generatedAt = new Date().toISOString();
  const symbols = state.positions.slice(0, 12).map((position) => position.symbol);
  const benchmark = state.positions.length > 0 && state.positions.every((position) => position.assetClass === "CRYPTOCURRENCY") ? "BTC-USD" : "SPY";
  const start = state.snapshots[0]?.created_at ?? generatedAt;
  const range = Date.now() - Date.parse(start) > 365 * 86_400_000 ? "5y" : "1y";
  const requested = [...new Set([benchmark, ...symbols])];
  const results = await Promise.allSettled(requested.map((symbol) => fetchMarketSeries(symbol, range)));
  const marketSeries = new Map<string, MarketSeries>();
  results.forEach((result, index) => { if (result.status === "fulfilled") marketSeries.set(requested[index], result.value); });
  const spy = marketSeries.get(benchmark);

  const snapshots = state.snapshots;
  const firstEquity = snapshots[0]?.equity_cents ?? state.account.equityCents;
  const portfolioSeries = snapshots.map((snapshot) => ({
    date: snapshot.created_at.slice(0, 10),
    portfolioPct: safeReturn(snapshot.equity_cents, firstEquity),
    benchmarkPct: null as number | null,
  }));
  const startDate = start.slice(0, 10);
  const spyStart = spy ? selectBenchmarkStartBar(spy.bars, startDate) : undefined;
  for (const point of portfolioSeries) {
    const spyPoint = spy?.bars.filter((bar) => bar.date <= point.date).at(-1);
    point.benchmarkPct = spyStart && spyPoint ? safeReturn(spyPoint.closeCents, spyStart.closeCents) : null;
  }
  const returnSinceStartPct = safeReturn(state.account.equityCents, firstEquity);
  const benchmarkSinceStartPct = spyStart && spy?.bars.at(-1) ? safeReturn(spy.bars.at(-1)!.closeCents, spyStart.closeCents) : null;
  const drawdowns = calculateDrawdowns(snapshots.map((snapshot) => snapshot.equity_cents));

  const grossAbsolutePnl = state.positions.reduce((sum, position) => sum + Math.abs(position.unrealizedPnlCents), 0);
  const stopBySymbol = new Map<string, DashboardState["openOrders"]>();
  const targetBySymbol = new Map<string, DashboardState["openOrders"]>();
  for (const order of state.openOrders) {
    const destination = order.role === "STOP_LOSS" ? stopBySymbol : order.role === "TAKE_PROFIT" ? targetBySymbol : null;
    if (destination) destination.set(order.symbol, [...(destination.get(order.symbol) ?? []), order]);
  }
  let lossAtStopsCents = 0;
  let unprotectedValueCents = 0;
  let staleQuotes = 0;
  const positionAnalytics = state.positions.map((position) => {
    const series = marketSeries.get(position.symbol);
    const previousClose = series?.previousCloseCents ?? null;
    const stopOrders = stopBySymbol.get(position.symbol) ?? [];
    const targetOrders = targetBySymbol.get(position.symbol) ?? [];
    const weightedTrigger = (orders: DashboardState["openOrders"]): number | null => {
      const quantity = orders.reduce((sum, order) => sum + order.remaining_micros, 0);
      return quantity > 0 ? roundPriceCents(orders.reduce((sum, order) => sum + (order.trigger_price_cents ?? 0) * order.remaining_micros, 0) / quantity) : null;
    };
    const stopPrice = weightedTrigger(stopOrders);
    const targetPrice = weightedTrigger(targetOrders);
    const directionSign = position.direction === "SHORT" ? -1 : 1;
    const capitalAtRisk = stopPrice
      ? stopOrders.reduce((sum, order) => sum + Math.max(0, Math.round(order.remaining_micros * (position.direction === "SHORT"
        ? (order.trigger_price_cents ?? position.lastPriceCents) - position.lastPriceCents
        : position.lastPriceCents - (order.trigger_price_cents ?? position.lastPriceCents)) / 1_000_000)), 0)
      : null;
    if (capitalAtRisk !== null) lossAtStopsCents += capitalAtRisk;
    else unprotectedValueCents += position.marketValueCents;
    const quoteAgeMinutes = position.quoteObservedAt ? Math.max(0, (Date.now() - Date.parse(position.quoteObservedAt)) / 60_000) : null;
    if (quoteAgeMinutes === null || quoteAgeMinutes > 15) staleQuotes += 1;
    const openingSide = position.direction === "SHORT" ? "SELL" : "BUY";
    const firstEntry = [...state.fills].reverse().find((fill) => fill.symbol === position.symbol && fill.side === openingSide);
    const costBasis = Math.round(Math.abs(position.quantityMicros) * position.averageCostCents / 1_000_000);
    return {
      symbol: position.symbol,
      dayPnlCents: previousClose ? Math.round(position.quantityMicros * (position.lastPriceCents - previousClose) / 1_000_000) : null,
      dayReturnPct: previousClose ? safeReturn(position.lastPriceCents, previousClose) * directionSign : null,
      totalReturnPct: costBasis > 0 ? position.unrealizedPnlCents / costBasis * 100 : 0,
      contributionPct: grossAbsolutePnl > 0 ? position.unrealizedPnlCents / grossAbsolutePnl * 100 : 0,
      stopPriceCents: stopPrice,
      targetPriceCents: targetPrice,
      stopDistancePct: stopPrice ? Math.max(0, (position.direction === "SHORT" ? stopPrice / position.lastPriceCents - 1 : 1 - stopPrice / position.lastPriceCents) * 100) : null,
      targetDistancePct: targetPrice ? Math.max(0, (position.direction === "SHORT" ? 1 - targetPrice / position.lastPriceCents : targetPrice / position.lastPriceCents - 1) * 100) : null,
      capitalAtRiskCents: capitalAtRisk,
      daysHeld: firstEntry ? Math.max(0, Math.floor((Date.now() - Date.parse(firstEntry.created_at)) / 86_400_000)) : 0,
      quoteAgeMinutes,
    } satisfies PositionAnalytics;
  });

  const availableSeries = symbols.flatMap((symbol) => marketSeries.get(symbol) ? [marketSeries.get(symbol)!] : []);
  const returnsBySymbol = alignedReturns([...(spy ? [spy] : []), ...availableSeries]);
  const commonDates = spy ? [...(returnsBySymbol.get("SPY")?.keys() ?? [])].filter((date) => availableSeries.every((series) => returnsBySymbol.get(series.symbol)?.has(date))).slice(-60) : [];
  const portfolioReturns = commonDates.map((date) => state.positions.slice(0, 12).reduce((sum, position) => {
    const value = returnsBySymbol.get(position.symbol)?.get(date) ?? 0;
    return sum + value * (position.direction === "SHORT" ? -1 : 1) * (position.allocationPct / Math.max(1, state.account.exposurePct));
  }, 0));
  const spyReturns = commonDates.map((date) => returnsBySymbol.get("SPY")?.get(date) ?? 0);
  const meanPortfolio = portfolioReturns.length ? portfolioReturns.reduce((sum, value) => sum + value, 0) / portfolioReturns.length : 0;
  const variancePortfolio = portfolioReturns.length > 1 ? portfolioReturns.reduce((sum, value) => sum + (value - meanPortfolio) ** 2, 0) / (portfolioReturns.length - 1) : 0;
  const meanSpy = spyReturns.length ? spyReturns.reduce((sum, value) => sum + value, 0) / spyReturns.length : 0;
  const varianceSpy = spyReturns.length > 1 ? spyReturns.reduce((sum, value) => sum + (value - meanSpy) ** 2, 0) / (spyReturns.length - 1) : 0;
  const covariance = portfolioReturns.length > 1 ? portfolioReturns.reduce((sum, value, index) => sum + (value - meanPortfolio) * (spyReturns[index] - meanSpy), 0) / (portfolioReturns.length - 1) : 0;
  const highCorrelationPairs: Array<{ left: string; right: string; correlation: number }> = [];
  for (let left = 0; left < availableSeries.length; left += 1) {
    for (let right = left + 1; right < availableSeries.length; right += 1) {
      const leftReturns = returnsBySymbol.get(availableSeries[left].symbol)!;
      const rightReturns = returnsBySymbol.get(availableSeries[right].symbol)!;
      const dates = [...leftReturns.keys()].filter((date) => rightReturns.has(date)).slice(-60);
      const value = correlation(dates.map((date) => leftReturns.get(date)!), dates.map((date) => rightReturns.get(date)!));
      if (value !== null && Math.abs(value) >= .75) highCorrelationPairs.push({ left: availableSeries[left].symbol, right: availableSeries[right].symbol, correlation: value });
    }
  }

  const orders = state.recentOrders.filter((order) => order.role !== "CORPORATE_ACTION");
  const filledOrders = orders.filter((order) => order.status === "FILLED");
  const cancelledOrders = orders.filter((order) => order.status === "CANCELLED").length;
  const rejectedOrders = orders.filter((order) => order.status === "REJECTED").length;
  const terminalOrders = filledOrders.length + cancelledOrders + rejectedOrders;
  const slippages = filledOrders.flatMap((order) => order.trigger_price_cents && order.average_fill_price_cents
    ? [((order.side === "BUY" ? order.average_fill_price_cents - order.trigger_price_cents : order.trigger_price_cents - order.average_fill_price_cents) / order.trigger_price_cents) * 10_000]
    : []);
  const latencies = filledOrders.map((order) => Math.max(0, (Date.parse(order.updated_at) - Date.parse(order.created_at)) / 1000));
  const tradedNotional = state.fills.reduce((sum, fill) => sum + Math.round(fill.quantity_micros * fill.price_cents / 1_000_000), 0);

  const alerts: AnalyticsAlert[] = [];
  for (const position of state.positions) {
    const analytics = positionAnalytics.find((item) => item.symbol === position.symbol)!;
    if (!analytics.stopPriceCents) alerts.push({ severity: "HIGH", title: `${position.symbol} sem stop`, detail: `${(position.allocationPct).toFixed(1)}% do patrimônio está sem proteção automática.` });
    if (position.allocationPct >= 25) alerts.push({ severity: "MEDIUM", title: `Concentração em ${position.symbol}`, detail: `A posição representa ${position.allocationPct.toFixed(1)}% do patrimônio.` });
    if (analytics.quoteAgeMinutes === null || analytics.quoteAgeMinutes > 15) alerts.push({ severity: "MEDIUM", title: `Cotação desatualizada: ${position.symbol}`, detail: analytics.quoteAgeMinutes === null ? "Sem horário de cotação disponível." : `Última atualização há ${analytics.quoteAgeMinutes.toFixed(0)} minutos.` });
  }
  for (const order of state.openOrders) {
    const ageHours = (Date.now() - Date.parse(order.created_at)) / 3_600_000;
    if (ageHours > 24) alerts.push({ severity: "INFO", title: `Ordem antiga: ${order.symbol}`, detail: `A ordem ${order.order_type} está aberta há ${ageHours.toFixed(0)} horas.` });
  }
  if (drawdowns.currentDrawdownPct <= -10) alerts.push({ severity: "HIGH", title: "Drawdown elevado", detail: `A carteira está ${Math.abs(drawdowns.currentDrawdownPct).toFixed(1)}% abaixo do pico.` });

  const quoteAges = state.positions.flatMap((position) => position.quoteObservedAt ? [(Date.now() - Date.parse(position.quoteObservedAt)) / 60_000] : []);
  const distinctHistoryDays = new Set(snapshots.map((snapshot) => snapshot.created_at.slice(0, 10))).size;
  return {
    generatedAt,
    benchmark,
    performance: {
      returnTodayPct: returnToday(snapshots),
      returnWeekPct: periodReturn(snapshots, 7),
      returnMonthPct: periodReturn(snapshots, 30),
      returnSinceStartPct,
      benchmarkSinceStartPct,
      excessReturnPct: benchmarkSinceStartPct === null ? null : returnSinceStartPct - benchmarkSinceStartPct,
      maxDrawdownPct: drawdowns.maxDrawdownPct,
      currentDrawdownPct: drawdowns.currentDrawdownPct,
      series: portfolioSeries,
    },
    risk: {
      lossAtStopsCents,
      unprotectedValueCents,
      protectedPositions: positionAnalytics.filter((position) => position.stopPriceCents !== null).length,
      unprotectedPositions: positionAnalytics.filter((position) => position.stopPriceCents === null).length,
      largestPositionPct: Math.max(0, ...state.positions.map((position) => position.allocationPct)),
      topFiveConcentrationPct: state.positions.slice(0, 5).reduce((sum, position) => sum + position.allocationPct, 0),
      annualizedVolatilityPct: portfolioReturns.length >= 20 ? Math.sqrt(variancePortfolio * 252) * 100 : null,
      betaVsSpy: portfolioReturns.length >= 20 && varianceSpy > 0 ? covariance / varianceSpy : null,
      highCorrelationPairs: highCorrelationPairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation)).slice(0, 8),
      scenarios: [-5, -10, -20].map((shockPct) => {
        const directionalExposure = state.positions.reduce((sum, position) => sum + position.marketValueCents * (position.direction === "SHORT" ? -1 : 1), 0);
        const estimatedPnlCents = Math.round(directionalExposure * shockPct / 100);
        return { shockPct, estimatedPnlCents, estimatedEquityCents: state.account.equityCents + estimatedPnlCents };
      }),
    },
    execution: {
      fillRatePct: terminalOrders ? filledOrders.length / terminalOrders * 100 : null,
      filledOrders: filledOrders.length,
      cancelledOrders,
      rejectedOrders,
      openOrders: state.openOrders.length,
      turnoverPct: state.account.equityCents > 0 ? tradedNotional / state.account.equityCents * 100 : 0,
      feesCents: state.fills.reduce((sum, fill) => sum + fill.fee_cents, 0),
      averageSlippageBps: slippages.length ? slippages.reduce((sum, value) => sum + value, 0) / slippages.length : null,
      averageFillLatencySeconds: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
    },
    positions: positionAnalytics,
    alerts,
    health: {
      yahoo: results.some((result) => result.status === "rejected") ? "DEGRADED" : "OK",
      quoteAgeMinutes: quoteAges.length ? Math.max(...quoteAges) : null,
      staleQuotes,
      historyPoints: distinctHistoryDays,
      note: distinctHistoryDays < 20 ? `Há ${distinctHistoryDays} ${distinctHistoryDays === 1 ? "sessão registrada" : "sessões registradas"}; métricas de performance ganham confiabilidade após 20 pregões.` : "Histórico diário suficiente para métricas de performance observadas.",
    },
  };
}
