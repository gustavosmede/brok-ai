import { buildPositions, positionMarketValueCents, roundPriceCents, type FillLike } from "./finance.ts";
import { fetchBinanceBars, toBinanceSpotSymbol, type BinanceInterval } from "./market-data.ts";

export type HistoricalPriceBar = {
  symbol: string;
  observedAt: string;
  priceCents: number;
  source?: string;
};

export type HistoricalCashEntry = {
  deltaCents: number;
  createdAt: string;
};

export type ReconstructedSnapshot = {
  createdAt: string;
  cashCents: number;
  equityCents: number;
  realizedPnlCents: number;
  unrealizedPnlCents: number;
  coveragePct: number;
};

function latestPriceAtOrBefore(bars: HistoricalPriceBar[], timestamp: number): number | null {
  let low = 0;
  let high = bars.length - 1;
  let match: number | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const observed = Date.parse(bars[middle].observedAt);
    if (observed <= timestamp) {
      match = bars[middle].priceCents;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match;
}

export function reconstructPortfolioSnapshots(input: {
  timestamps: string[];
  fills: FillLike[];
  cashEntries: HistoricalCashEntry[];
  bars: HistoricalPriceBar[];
}): ReconstructedSnapshot[] {
  const fills = [...input.fills].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const cashEntries = [...input.cashEntries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const barsBySymbol = new Map<string, HistoricalPriceBar[]>();
  for (const bar of [...input.bars].sort((a, b) => a.observedAt.localeCompare(b.observedAt))) {
    const current = barsBySymbol.get(bar.symbol) ?? [];
    current.push(bar);
    barsBySymbol.set(bar.symbol, current);
  }

  return [...new Set(input.timestamps)].sort().flatMap((createdAt) => {
    const timestamp = Date.parse(createdAt);
    if (!Number.isFinite(timestamp)) return [];
    const positions = buildPositions(fills.filter((fill) => Date.parse(fill.createdAt) <= timestamp));
    const cashCents = cashEntries
      .filter((entry) => Date.parse(entry.createdAt) <= timestamp)
      .reduce((sum, entry) => sum + entry.deltaCents, 0);
    let netMarketValueCents = 0;
    let unrealizedPnlCents = 0;
    let priced = 0;
    let required = 0;
    for (const position of positions.values()) {
      if (!position.quantityMicros) continue;
      required += 1;
      const price = latestPriceAtOrBefore(barsBySymbol.get(position.symbol) ?? [], timestamp);
      if (price === null) continue;
      priced += 1;
      const signedValue = positionMarketValueCents(position.quantityMicros, price);
      netMarketValueCents += signedValue;
      unrealizedPnlCents += signedValue - position.costBasisCents;
    }
    if (required > 0 && priced !== required) return [];
    const realizedPnlCents = [...positions.values()].reduce((sum, position) => sum + position.realizedPnlCents, 0);
    return [{
      createdAt,
      cashCents,
      equityCents: cashCents + netMarketValueCents,
      realizedPnlCents,
      unrealizedPnlCents,
      coveragePct: required ? priced / required * 100 : 100,
    }];
  });
}

type YahooInterval = "5m" | "30m" | "1h" | "1d";

function intervalForGap(gapMs: number): YahooInterval {
  if (gapMs <= 7 * 86_400_000) return "5m";
  if (gapMs <= 60 * 86_400_000) return "30m";
  if (gapMs <= 730 * 86_400_000) return "1h";
  return "1d";
}

function intervalMilliseconds(interval: YahooInterval): number {
  if (interval === "5m") return 5 * 60_000;
  if (interval === "30m") return 30 * 60_000;
  if (interval === "1h") return 60 * 60_000;
  return 24 * 60 * 60_000;
}

async function fetchYahooBars(symbol: string, start: number, end: number, interval: YahooInterval): Promise<HistoricalPriceBar[]> {
  const buffer = interval === "1d" ? 14 * 86_400_000 : 7 * 86_400_000;
  const period1 = Math.floor((start - buffer) / 1000);
  const period2 = Math.ceil(end / 1000) + 60;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=${interval}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Brok.ai/1.0 personal-research" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Yahoo respondeu ${response.status} para ${symbol}`);
  const payload = await response.json() as {
    chart?: { error?: { description?: string } | null; result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
  };
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error(payload.chart?.error?.description ?? `Sem histórico para ${symbol}`);
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  return (result.timestamp ?? []).flatMap((timestamp, index) => {
    const close = closes[index];
    return typeof close === "number" && Number.isFinite(close) && close > 0
      ? [{ symbol, observedAt: new Date(timestamp * 1000).toISOString(), priceCents: roundPriceCents(close * 100) }]
      : [];
  });
}

async function fetchMarketBars(symbol: string, start: number, end: number, interval: YahooInterval): Promise<HistoricalPriceBar[]> {
  if (toBinanceSpotSymbol(symbol)) {
    try {
      const bars = await fetchBinanceBars(symbol, interval as BinanceInterval, start, end);
      return bars.map((bar) => ({ symbol, ...bar, source: "BINANCE_BACKFILL" }));
    } catch {
      // Yahoo remains the automatic fallback for unsupported or unavailable Binance pairs.
    }
  }
  return (await fetchYahooBars(symbol, start, end, interval)).map((bar) => ({ ...bar, source: "YAHOO_BACKFILL" }));
}

async function batchRun(db: D1Database, statements: D1PreparedStatement[], size = 50): Promise<void> {
  for (let index = 0; index < statements.length; index += size) {
    await db.batch(statements.slice(index, index + size));
  }
}

export async function backfillMissingPortfolioHistory(db: D1Database): Promise<{ inserted: number; error?: string }> {
  const snapshotRows = await db.prepare("SELECT created_at FROM (SELECT created_at FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 600) ORDER BY created_at ASC")
    .all<{ created_at: string }>();
  const observed = snapshotRows.results ?? [];
  if (!observed.length) return { inserted: 0 };
  const now = Date.now();
  let gapStart = observed.at(-1)!.created_at;
  let gapEnd = new Date(now).toISOString();
  for (let index = 1; index < observed.length; index += 1) {
    const previous = Date.parse(observed[index - 1].created_at);
    const current = Date.parse(observed[index].created_at);
    if (current - previous > 15 * 60_000) {
      gapStart = observed[index - 1].created_at;
      gapEnd = observed[index].created_at;
      break;
    }
  }
  const start = Date.parse(gapStart);
  const end = Date.parse(gapEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 15 * 60_000) return { inserted: 0 };

  const attempt = await db.prepare("SELECT value FROM app_meta WHERE key = 'history_backfill_attempt'").first<{ value: string }>();
  if (attempt && now - Date.parse(attempt.value) < 60_000) return { inserted: 0 };
  await db.prepare("INSERT INTO app_meta (key, value) VALUES ('history_backfill_attempt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(new Date(now).toISOString()).run();

  const symbolRows = await db.prepare("SELECT DISTINCT symbol FROM fills WHERE created_at <= ?").bind(new Date(end).toISOString()).all<{ symbol: string }>();
  const symbols = (symbolRows.results ?? []).map((row) => row.symbol);
  if (!symbols.length) return { inserted: 0 };

  try {
    const interval = intervalForGap(end - start);
    const results = await Promise.all(symbols.map((symbol) => fetchMarketBars(symbol, start, end, interval)));
    const bars = results.flat();
    await batchRun(db, bars.map((bar) => db.prepare("INSERT OR IGNORE INTO price_bars (symbol, observed_at, price_cents, interval, source) VALUES (?, ?, ?, ?, ?)")
      .bind(bar.symbol, bar.observedAt, bar.priceCents, interval, bar.source ?? "YAHOO_BACKFILL")));

    const cadence = intervalMilliseconds(interval);
    let timestamps: string[] = [];
    for (let timestamp = start + cadence; timestamp <= end; timestamp += cadence) {
      timestamps.push(new Date(timestamp).toISOString());
    }
    const maximumPoints = 600;
    if (timestamps.length > maximumPoints) {
      const step = (timestamps.length - 1) / (maximumPoints - 1);
      timestamps = Array.from({ length: maximumPoints }, (_, index) => timestamps[Math.round(index * step)]);
    }
    if (!timestamps.length) return { inserted: 0 };

    const [fillRows, cashRows] = await Promise.all([
      db.prepare("SELECT symbol, side, quantity_micros, price_cents, fee_cents, created_at FROM fills WHERE created_at <= ? ORDER BY created_at ASC").bind(new Date(end).toISOString()).all<{ symbol: string; side: "BUY" | "SELL"; quantity_micros: number; price_cents: number; fee_cents: number; created_at: string }>(),
      db.prepare("SELECT delta_cents, created_at FROM cash_ledger WHERE created_at <= ? ORDER BY created_at ASC").bind(new Date(end).toISOString()).all<{ delta_cents: number; created_at: string }>(),
    ]);
    const reconstructed = reconstructPortfolioSnapshots({
      timestamps,
      fills: (fillRows.results ?? []).map((row) => ({ symbol: row.symbol, side: row.side, quantityMicros: row.quantity_micros, priceCents: row.price_cents, feeCents: row.fee_cents, createdAt: row.created_at })),
      cashEntries: (cashRows.results ?? []).map((row) => ({ deltaCents: row.delta_cents, createdAt: row.created_at })),
      bars,
    });
    const existingRows = await db.prepare("SELECT created_at FROM portfolio_snapshots WHERE created_at > ? AND created_at <= ?")
      .bind(gapStart, new Date(end).toISOString()).all<{ created_at: string }>();
    const existing = new Set((existingRows.results ?? []).map((row) => row.created_at));
    const snapshots = reconstructed.filter((snapshot) => !existing.has(snapshot.createdAt));
    const snapshotStatements: D1PreparedStatement[] = [];
    for (const snapshot of snapshots) {
      const snapshotId = `backfill-${Date.parse(snapshot.createdAt)}`;
      snapshotStatements.push(
        db.prepare("INSERT OR IGNORE INTO portfolio_snapshots (id, cash_cents, equity_cents, realized_pnl_cents, unrealized_pnl_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(snapshotId, snapshot.cashCents, snapshot.equityCents, snapshot.realizedPnlCents, snapshot.unrealizedPnlCents, snapshot.createdAt),
        db.prepare("INSERT OR IGNORE INTO snapshot_metadata (snapshot_id, source, coverage_pct, note) VALUES (?, 'MARKET_BACKFILL', ?, 'Reconstruído pela Binance com fallback Yahoo ao retornar após período offline')")
          .bind(snapshotId, snapshot.coveragePct),
      );
    }
    await batchRun(db, snapshotStatements);
    if (snapshots.length) {
      const completedAt = new Date().toISOString();
      await db.batch([
        db.prepare("INSERT INTO app_meta (key, value) VALUES ('history_backfill_success', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(completedAt),
        db.prepare("INSERT INTO audit_events (id, event_type, entity_type, entity_id, message, payload_json, created_at) VALUES (?, 'HISTORY_BACKFILLED', 'ACCOUNT', 'paper-usd', ?, ?, ?)")
          .bind(`audit-backfill-${crypto.randomUUID()}`, `${snapshots.length} pontos de patrimônio reconstruídos pela Binance/Yahoo`, JSON.stringify({ start: gapStart, end: gapEnd, interval, symbols }), completedAt),
      ]);
    }
    return { inserted: snapshots.length };
  } catch (error) {
    return { inserted: 0, error: error instanceof Error ? error.message : "Dados de mercado indisponíveis" };
  }
}
