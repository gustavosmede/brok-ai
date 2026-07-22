import { ensureDatabase, getDatabase } from "../db";
import {
  buildPositions,
  cashPercentageFromText,
  dollarsToCents,
  dollarsToPriceCents,
  microsToShares,
  normalizeSymbol,
  parseDecimal,
  percentToBps,
  positionMarketValueCents,
  protectivePriceCents,
  resolveQuantityMicros,
  shouldFillOrder,
  simulatedFillPriceCents,
  type FillLike,
  type OrderIntent,
  type OrderType,
  type Quote,
  type Side,
} from "./finance";
import {
  COMPANY_SYMBOL_FALLBACKS,
  BinanceYahooMarketDataProvider,
  normalizeMarketSymbol,
  resolveYahooAsset,
  type AssetSuggestion,
  type MarketDataProvider,
  type SymbolResolution,
} from "./market-data";
import { getUsEquityMarketStatus } from "./market-calendar";
import { backfillMissingPortfolioHistory, reconstructRecentPortfolioPerformance } from "./portfolio-history";

type OrderRow = {
  id: string;
  symbol: string;
  side: Side;
  order_type: OrderType;
  role: "ENTRY" | "REDUCTION" | "STOP_LOSS" | "TAKE_PROFIT" | "CORPORATE_ACTION";
  status: "OPEN" | "FILLED" | "CANCELLED" | "REJECTED";
  quantity_micros: number;
  remaining_micros: number;
  trigger_price_cents: number | null;
  average_fill_price_cents: number | null;
  parent_order_id: string | null;
  oco_group_id: string | null;
  stop_loss_bps: number | null;
  take_profit_bps: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

type FillRow = {
  id: string;
  order_id: string;
  symbol: string;
  side: Side;
  quantity_micros: number;
  price_cents: number;
  fee_cents: number;
  created_at: string;
};

type QuoteRow = {
  symbol: string;
  price_cents: number;
  source: string;
  observed_at: string;
  asset_class: string;
  name: string | null;
  exchange: string | null;
};

export type OrderPreview = {
  draftId: string;
  expiresAt: string;
  symbol: string;
  action: OrderIntent["action"];
  side: Side;
  orderType: OrderType;
  sizingLabel: string;
  quantityMicros: number;
  referencePriceCents: number;
  triggerPriceCents: number | null;
  estimatedNotionalCents: number;
  stopLossPriceCents: number | null;
  takeProfitPriceCents: number | null;
  availableCashBeforeCents: number;
  availableCashAfterCents: number;
  quote: Quote;
  warnings: string[];
};

export type DashboardState = {
  market: ReturnType<typeof getUsEquityMarketStatus>;
  account: {
    cashCents: number;
    availableCashCents: number;
    equityCents: number;
    marketValueCents: number;
    realizedPnlCents: number;
    unrealizedPnlCents: number;
    exposurePct: number;
  };
  positions: Array<{
    symbol: string;
    direction: "LONG" | "SHORT";
    quantityMicros: number;
    averageCostCents: number;
    costBasisCents: number;
    lastPriceCents: number;
    marketValueCents: number;
    unrealizedPnlCents: number;
    realizedPnlCents: number;
    allocationPct: number;
    quoteSource: string;
    quoteObservedAt: string;
    assetClass: string;
    name: string;
    exchange: string;
  }>;
  openOrders: OrderRow[];
  recentOrders: OrderRow[];
  fills: FillRow[];
  snapshots: Array<{ id: string; equity_cents: number; cash_cents: number; created_at: string; source: string; coverage_pct: number }>;
  performanceSnapshots: Array<{ id: string; equity_cents: number; cash_cents: number; created_at: string; source: string; coverage_pct: number }>;
  audit: Array<{ id: string; event_type: string; message: string; created_at: string }>;
  corporateActions: Array<{ id: string; symbol: string; action_type: string; effective_date: string; value_text: string; status: string; created_at: string }>;
  lastQuoteAt: string | null;
};

const defaultProvider = new BinanceYahooMarketDataProvider();

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function cashBalance(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(delta_cents), 0) AS value FROM cash_ledger").first<{ value: number }>();
  return Number(row?.value ?? 0);
}

async function loadFills(db: D1Database): Promise<FillRow[]> {
  const result = await db.prepare("SELECT * FROM fills ORDER BY created_at ASC, id ASC").all<FillRow>();
  return result.results ?? [];
}

async function loadQuotes(db: D1Database): Promise<Map<string, Quote>> {
  const result = await db.prepare("SELECT * FROM quotes").all<QuoteRow>();
  return new Map((result.results ?? []).map((row) => [row.symbol, {
    symbol: row.symbol,
    priceCents: row.price_cents,
    source: row.source,
    observedAt: row.observed_at,
    assetClass: row.asset_class,
    name: row.name ?? row.symbol,
    exchange: row.exchange ?? "",
  }]));
}

async function currentQuote(db: D1Database, symbol: string): Promise<Quote | null> {
  const row = await db.prepare("SELECT * FROM quotes WHERE symbol = ?").bind(symbol).first<QuoteRow>();
  return row ? {
    symbol: row.symbol,
    priceCents: row.price_cents,
    source: row.source,
    observedAt: row.observed_at,
  } : null;
}

async function storeQuote(db: D1Database, quote: Quote): Promise<void> {
  await db.prepare("INSERT INTO quotes (symbol, price_cents, source, observed_at, asset_class, name, exchange) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET price_cents = excluded.price_cents, source = excluded.source, observed_at = excluded.observed_at, asset_class = excluded.asset_class, name = excluded.name, exchange = excluded.exchange")
    .bind(quote.symbol, quote.priceCents, quote.source, quote.observedAt, quote.assetClass ?? "OTHER", quote.name ?? quote.symbol, quote.exchange ?? "").run();
}

async function reservedCashCents(db: D1Database, quotes: Map<string, Quote>): Promise<number> {
  const result = await db.prepare("SELECT * FROM orders WHERE status = 'OPEN' AND role = 'ENTRY'").all<OrderRow>();
  const entryReserve = (result.results ?? []).reduce((total, order) => {
    const reference = order.trigger_price_cents ?? quotes.get(order.symbol)?.priceCents ?? 0;
    const reserve = positionMarketValueCents(order.remaining_micros, reference);
    return total + Math.ceil(reserve * (order.order_type === "MARKET" ? 1.01 : 1));
  }, 0);
  const positions = buildPositions(fillsForDomain(await loadFills(db)));
  const shortCollateral = [...positions.values()].reduce((total, position) => {
    if (position.quantityMicros >= 0) return total;
    const reference = quotes.get(position.symbol)?.priceCents ?? position.averageCostCents;
    return total + positionMarketValueCents(Math.abs(position.quantityMicros), reference);
  }, 0);
  return entryReserve + shortCollateral;
}

function fillsForDomain(rows: FillRow[]): FillLike[] {
  return rows.map((row) => ({
    side: row.side,
    symbol: row.symbol,
    quantityMicros: row.quantity_micros,
    priceCents: row.price_cents,
    feeCents: row.fee_cents,
    createdAt: row.created_at,
  }));
}

async function getOrFetchQuote(
  db: D1Database,
  symbol: string,
  provider: MarketDataProvider = defaultProvider,
): Promise<Quote> {
  const cached = await currentQuote(db, symbol);
  const freshEnough = cached && Date.now() - Date.parse(cached.observedAt) < 2 * 60_000;
  if (freshEnough) return cached;
  try {
    const quote = await provider.getQuote(symbol);
    await storeQuote(db, quote);
    return quote;
  } catch (error) {
    if (cached) return cached;
    throw new Error(`Could not fetch quote for ${symbol}. Use a manual quote and try again.`, { cause: error });
  }
}

function normalizeIntent(input: OrderIntent): OrderIntent {
  const action = input.action === "REDUCE" || input.action === "CLOSE"
    ? input.action
    : input.action === "SHORT" ? "SHORT" : input.action === "SELL" ? "SELL" : "BUY";
  const sizingType = action === "CLOSE" ? "POSITION_PCT" : input.sizingType;
  return {
    ...input,
    action,
    symbol: normalizeMarketSymbol(input.symbol),
    sizingType,
    sizingValue: action === "CLOSE" ? "100" : String(parseDecimal(input.sizingValue)),
    orderType: input.orderType ?? "MARKET",
  };
}

function sideForIntent(intent: OrderIntent, positionQuantityMicros: number): Side {
  if (intent.action === "BUY") return "BUY";
  if (intent.action === "SHORT") return "SELL";
  if ((intent.action === "REDUCE" || intent.action === "CLOSE") && positionQuantityMicros < 0) return "BUY";
  return "SELL";
}

function validateIntent(intent: OrderIntent): void {
  if (!intent.symbol) throw new Error("Enter a valid ticker");
  if (!/^[A-Z0-9.^=\-]{1,24}$/.test(intent.symbol)) throw new Error("Invalid ticker");
  if (!['MARKET', 'LIMIT', 'STOP'].includes(intent.orderType)) throw new Error("Invalid order type");
  if (intent.orderType !== "MARKET" && dollarsToPriceCents(intent.triggerPrice ?? 0) <= 0) {
    throw new Error("Limit and stop orders require a trigger price");
  }
  if (intent.action !== "CLOSE" && parseDecimal(intent.sizingValue) <= 0) throw new Error("Order size must be positive");
}

async function buildPreviewData(db: D1Database, input: OrderIntent): Promise<Omit<OrderPreview, "draftId" | "expiresAt">> {
  const intent = normalizeIntent(input);
  validateIntent(intent);
  const quote = await getOrFetchQuote(db, intent.symbol);
  const fills = await loadFills(db);
  const positions = buildPositions(fillsForDomain(fills));
  const position = positions.get(intent.symbol);
  const positionQuantity = position?.quantityMicros ?? 0;
  const side = sideForIntent(intent, positionQuantity);
  const quotes = await loadQuotes(db);
  const cash = await cashBalance(db);
  const reserved = await reservedCashCents(db, quotes);
  const availableCash = Math.max(0, cash - reserved);
  const triggerPriceCents = intent.orderType === "MARKET" ? null : dollarsToPriceCents(intent.triggerPrice ?? 0);
  const referencePriceCents = triggerPriceCents ?? quote.priceCents;
  const quantityMicros = resolveQuantityMicros({
    intent,
    referencePriceCents,
    availableCashCents: availableCash,
    positionQuantityMicros: positionQuantity,
  });
  if (quantityMicros <= 0) throw new Error("The resultou em quantidade zero");

  const estimatedNotionalCents = positionMarketValueCents(quantityMicros, referencePriceCents);
  if (intent.action === "SHORT" && positionQuantity > 0) throw new Error("Close or reduce the long position before opening a short in this asset");
  if (intent.action === "BUY" && positionQuantity < 0) throw new Error("Use reduce or close to cover the short position before buying");
  if (intent.action === "SELL" && positionQuantity <= 0) throw new Error("There is no long position to sell. To open short exposure, request a short.");
  if ((intent.action === "REDUCE" || intent.action === "CLOSE") && positionQuantity === 0) throw new Error("There is no open position in this asset");
  if ((intent.action === "SELL" || intent.action === "REDUCE" || intent.action === "CLOSE") && quantityMicros > Math.abs(positionQuantity)) throw new Error("The reduction exceeds the available position");
  if ((intent.action === "BUY" || intent.action === "SHORT") && estimatedNotionalCents > availableCash) throw new Error("Insufficient available cash for this order");

  const stopLossBps = percentToBps(intent.stopLossPct);
  const takeProfitBps = percentToBps(intent.takeProfitPct);
  const warnings: string[] = [];
  if (intent.orderType !== "MARKET") {
    if (side === "BUY" && intent.orderType === "LIMIT" && triggerPriceCents! >= quote.priceCents) {
      warnings.push("This buy limit is above the quote and may execute immediately.");
    }
    if (side === "BUY" && intent.orderType === "STOP" && triggerPriceCents! <= quote.priceCents) {
      warnings.push("This buy stop is below the quote and may execute immediately.");
    }
  }
  if (Date.now() - Date.parse(quote.observedAt) > 5 * 60_000) warnings.push("The quote used is stale.");
  const opensPosition = intent.action === "BUY" || intent.action === "SHORT";
  if (!opensPosition && (stopLossBps > 0 || takeProfitBps > 0)) warnings.push("Protections are only attached when opening a position.");
  if (intent.action === "SHORT" && intent.symbol.startsWith("^")) warnings.push("Synthetic short exposure to the index for simulation; the index is not directly tradable.");
  const direction = intent.action === "SHORT" ? "SHORT" : "LONG";

  return {
    symbol: intent.symbol,
    action: intent.action,
    side,
    orderType: intent.orderType,
    sizingLabel: `${intent.sizingType} · ${intent.sizingValue}`,
    quantityMicros,
    referencePriceCents,
    triggerPriceCents,
    estimatedNotionalCents,
    stopLossPriceCents: opensPosition && stopLossBps > 0 ? protectivePriceCents(referencePriceCents, stopLossBps, "STOP_LOSS", direction) : null,
    takeProfitPriceCents: opensPosition && takeProfitBps > 0 ? protectivePriceCents(referencePriceCents, takeProfitBps, "TAKE_PROFIT", direction) : null,
    availableCashBeforeCents: availableCash,
    availableCashAfterCents: opensPosition
      ? availableCash - estimatedNotionalCents
      : side === "SELL" ? availableCash + estimatedNotionalCents : availableCash,
    quote,
    warnings,
  };
}

export async function createDraft(input: OrderIntent, source = "MANUAL", originalText?: string): Promise<OrderPreview> {
  const db = getDatabase();
  await ensureDatabase(db);
  const intent = normalizeIntent(input);
  const previewData = await buildPreviewData(db, intent);
  const draftId = id("draft");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const preview: OrderPreview = { draftId, expiresAt, ...previewData };
  await db.batch([
    db.prepare("INSERT INTO command_drafts (id, source, original_text, intent_json, preview_json, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)")
      .bind(draftId, source, originalText ?? null, JSON.stringify(intent), JSON.stringify(preview), expiresAt, createdAt),
    db.prepare("INSERT INTO audit_events (id, event_type, entity_type, entity_id, message, payload_json, created_at) VALUES (?, 'DRAFT_CREATED', 'DRAFT', ?, ?, ?, ?)")
      .bind(id("audit"), draftId, `Preview criado para ${preview.side} ${preview.symbol}`, JSON.stringify({ intent, preview }), createdAt),
  ]);
  return preview;
}

export async function confirmDraft(draftId: string): Promise<DashboardState> {
  const db = getDatabase();
  await ensureDatabase(db);
  const row = await db.prepare("SELECT * FROM command_drafts WHERE id = ?").bind(draftId).first<{
    id: string; intent_json: string; preview_json: string; status: string; expires_at: string;
  }>();
  if (!row) throw new Error("Preview not found");
  if (row.status !== "PENDING") throw new Error("This preview has already been used");
  if (Date.parse(row.expires_at) < Date.now()) {
    await db.prepare("UPDATE command_drafts SET status = 'EXPIRED' WHERE id = ?").bind(draftId).run();
    throw new Error("The preview expired. Generate a new one before confirming.");
  }
  const intent = normalizeIntent(JSON.parse(row.intent_json) as OrderIntent);
  const freshPreview = await buildPreviewData(db, intent);
  const originalPreview = JSON.parse(row.preview_json) as OrderPreview;
  const drift = Math.abs(freshPreview.referencePriceCents - originalPreview.referencePriceCents) / Math.max(1, originalPreview.referencePriceCents);
  if (intent.orderType === "MARKET" && drift > 0.01) throw new Error("The quote moved more than 1%. Generate a new preview.");

  const side = freshPreview.side;
  const orderId = id("ord");
  const timestamp = nowIso();
  const role = intent.action === "BUY" || intent.action === "SHORT" ? "ENTRY" : "REDUCTION";
  await db.batch([
    db.prepare("INSERT INTO orders (id, symbol, side, order_type, role, status, quantity_micros, remaining_micros, trigger_price_cents, average_fill_price_cents, parent_order_id, oco_group_id, stop_loss_bps, take_profit_bps, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)")
      .bind(orderId, intent.symbol, side, intent.orderType, role, freshPreview.quantityMicros, freshPreview.quantityMicros, freshPreview.triggerPriceCents, percentToBps(intent.stopLossPct) || null, percentToBps(intent.takeProfitPct) || null, intent.note ?? null, timestamp, timestamp),
    db.prepare("UPDATE command_drafts SET status = 'CONFIRMED' WHERE id = ?").bind(draftId),
    db.prepare("INSERT INTO audit_events (id, event_type, entity_type, entity_id, message, payload_json, created_at) VALUES (?, 'ORDER_CONFIRMED', 'ORDER', ?, ?, ?, ?)")
      .bind(id("audit"), orderId, `${side} ${intent.symbol} confirmed after preview`, JSON.stringify(freshPreview), timestamp),
  ]);
  await processOpenOrders([intent.symbol]);
  return getDashboardState();
}

async function createProtectionOrders(db: D1Database, entry: OrderRow, fillPriceCents: number): Promise<void> {
  const stopBps = entry.stop_loss_bps ?? 0;
  const takeBps = entry.take_profit_bps ?? 0;
  if (stopBps <= 0 && takeBps <= 0) return;
  const timestamp = nowIso();
  const ocoGroup = id("oco");
  const statements: D1PreparedStatement[] = [];
  const direction = entry.side === "BUY" ? "LONG" : "SHORT";
  const protectiveSide: Side = entry.side === "BUY" ? "SELL" : "BUY";
  if (stopBps > 0) {
    statements.push(db.prepare("INSERT INTO orders (id, symbol, side, order_type, role, status, quantity_micros, remaining_micros, trigger_price_cents, average_fill_price_cents, parent_order_id, oco_group_id, stop_loss_bps, take_profit_bps, note, created_at, updated_at) VALUES (?, ?, ?, 'STOP', 'STOP_LOSS', 'OPEN', ?, ?, ?, NULL, ?, ?, NULL, NULL, 'Automatic protection', ?, ?)")
      .bind(id("ord"), entry.symbol, protectiveSide, entry.quantity_micros, entry.quantity_micros, protectivePriceCents(fillPriceCents, stopBps, "STOP_LOSS", direction), entry.id, ocoGroup, timestamp, timestamp));
  }
  if (takeBps > 0) {
    statements.push(db.prepare("INSERT INTO orders (id, symbol, side, order_type, role, status, quantity_micros, remaining_micros, trigger_price_cents, average_fill_price_cents, parent_order_id, oco_group_id, stop_loss_bps, take_profit_bps, note, created_at, updated_at) VALUES (?, ?, ?, 'LIMIT', 'TAKE_PROFIT', 'OPEN', ?, ?, ?, NULL, ?, ?, NULL, NULL, 'Automatic protection', ?, ?)")
      .bind(id("ord"), entry.symbol, protectiveSide, entry.quantity_micros, entry.quantity_micros, protectivePriceCents(fillPriceCents, takeBps, "TAKE_PROFIT", direction), entry.id, ocoGroup, timestamp, timestamp));
  }
  if (statements.length) await db.batch(statements);
}

async function reconcileProtection(db: D1Database, symbol: string): Promise<void> {
  const fills = await loadFills(db);
  const position = buildPositions(fillsForDomain(fills)).get(symbol);
  let remaining = Math.abs(position?.quantityMicros ?? 0);
  const result = await db.prepare("SELECT * FROM orders WHERE symbol = ? AND status = 'OPEN' AND role IN ('STOP_LOSS', 'TAKE_PROFIT') ORDER BY created_at ASC").bind(symbol).all<OrderRow>();
  const groups = new Map<string, OrderRow[]>();
  for (const order of result.results ?? []) {
    const key = order.oco_group_id ?? order.id;
    groups.set(key, [...(groups.get(key) ?? []), order]);
  }
  for (const orders of groups.values()) {
    const groupSize = Math.max(...orders.map((order) => order.remaining_micros));
    const allowed = Math.max(0, Math.min(groupSize, remaining));
    remaining -= allowed;
    for (const order of orders) {
      if (allowed === 0) {
        await db.prepare("UPDATE orders SET status = 'CANCELLED', remaining_micros = 0, updated_at = ? WHERE id = ?").bind(nowIso(), order.id).run();
      } else if (order.remaining_micros !== allowed) {
        await db.prepare("UPDATE orders SET quantity_micros = ?, remaining_micros = ?, updated_at = ? WHERE id = ?").bind(allowed, allowed, nowIso(), order.id).run();
      }
    }
  }
}

export async function processOpenOrders(symbols?: string[]): Promise<number> {
  const db = getDatabase();
  await ensureDatabase(db);
  const params = (symbols ?? []).map(normalizeSymbol).filter(Boolean);
  const result = params.length
    ? await db.prepare(`SELECT * FROM orders WHERE status = 'OPEN' AND symbol IN (${params.map(() => "?").join(",")}) ORDER BY created_at ASC`).bind(...params).all<OrderRow>()
    : await db.prepare("SELECT * FROM orders WHERE status = 'OPEN' ORDER BY created_at ASC").all<OrderRow>();
  let filled = 0;
  for (const order of result.results ?? []) {
    const latest = await db.prepare("SELECT status FROM orders WHERE id = ?").bind(order.id).first<{ status: string }>();
    if (latest?.status !== "OPEN") continue;
    const quote = await currentQuote(db, order.symbol);
    if (!quote) continue;
    if (!shouldFillOrder({ side: order.side, orderType: order.order_type, quotePriceCents: quote.priceCents, triggerPriceCents: order.trigger_price_cents })) continue;

    const domainPositions = buildPositions(fillsForDomain(await loadFills(db)));
    const currentPosition = domainPositions.get(order.symbol)?.quantityMicros ?? 0;
    let quantity = 0;
    if (order.role === "ENTRY") {
      const canOpen = order.side === "BUY" ? currentPosition >= 0 : currentPosition <= 0;
      quantity = canOpen ? order.remaining_micros : 0;
    } else if (order.side === "SELL" && currentPosition > 0) {
      quantity = Math.min(order.remaining_micros, currentPosition);
    } else if (order.side === "BUY" && currentPosition < 0) {
      quantity = Math.min(order.remaining_micros, Math.abs(currentPosition));
    }
    if (quantity <= 0) {
      await db.prepare("UPDATE orders SET status = 'CANCELLED', remaining_micros = 0, updated_at = ? WHERE id = ?").bind(nowIso(), order.id).run();
      continue;
    }
    const fillPrice = simulatedFillPriceCents({ side: order.side, orderType: order.order_type, quotePriceCents: quote.priceCents, triggerPriceCents: order.trigger_price_cents });
    const notional = positionMarketValueCents(quantity, fillPrice);
    const cash = await cashBalance(db);
    const quoteMap = await loadQuotes(db);
    const reserved = await reservedCashCents(db, quoteMap);
    const ownReference = order.trigger_price_cents ?? quote.priceCents;
    const ownReserve = order.role === "ENTRY" ? positionMarketValueCents(order.remaining_micros, ownReference) : 0;
    const entryCapacity = Math.max(0, cash - reserved + ownReserve);
    if (order.role === "ENTRY" && notional > entryCapacity) {
      await db.batch([
        db.prepare("UPDATE orders SET status = 'REJECTED', updated_at = ? WHERE id = ?").bind(nowIso(), order.id),
        db.prepare("INSERT INTO audit_events (id, event_type, entity_type, entity_id, message, payload_json, created_at) VALUES (?, 'ORDER_REJECTED', 'ORDER', ?, 'Order rejected due to insufficient cash', NULL, ?)").bind(id("audit"), order.id, nowIso()),
      ]);
      continue;
    }
    const timestamp = nowIso();
    const fillId = id("fill");
    const cashDelta = order.side === "BUY" ? -notional : notional;
    const statements = [
      db.prepare("INSERT INTO fills (id, order_id, symbol, side, quantity_micros, price_cents, fee_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)").bind(fillId, order.id, order.symbol, order.side, quantity, fillPrice, timestamp),
      db.prepare("INSERT INTO cash_ledger (id, delta_cents, entry_type, reference_id, description, created_at) VALUES (?, ?, 'TRADE', ?, ?, ?)").bind(id("cash"), cashDelta, fillId, `${order.side} ${microsToShares(quantity).toFixed(4)} ${order.symbol}`, timestamp),
      db.prepare("UPDATE orders SET status = 'FILLED', remaining_micros = 0, average_fill_price_cents = ?, updated_at = ? WHERE id = ?").bind(fillPrice, timestamp, order.id),
      db.prepare("INSERT INTO audit_events (id, event_type, entity_type, entity_id, message, payload_json, created_at) VALUES (?, 'ORDER_FILLED', 'ORDER', ?, ?, ?, ?)").bind(id("audit"), order.id, `${order.side} ${order.symbol} executada a ${(fillPrice / 100).toFixed(2)}`, JSON.stringify({ quantityMicros: quantity, quote }), timestamp),
    ];
    if (order.oco_group_id) {
      statements.push(db.prepare("UPDATE orders SET status = 'CANCELLED', remaining_micros = 0, updated_at = ? WHERE oco_group_id = ? AND id <> ? AND status = 'OPEN'").bind(timestamp, order.oco_group_id, order.id));
    }
    await db.batch(statements);
    if (order.role === "ENTRY") await createProtectionOrders(db, order, fillPrice);
    else await reconcileProtection(db, order.symbol);
    filled += 1;
  }
  await saveSnapshot(db);
  return filled;
}

async function saveSnapshot(db: D1Database): Promise<void> {
  const state = await computeState(db, false);
  const last = await db.prepare("SELECT created_at FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1").first<{ created_at: string }>();
  if (last && Date.now() - Date.parse(last.created_at) < 30_000) return;
  await db.prepare("INSERT INTO portfolio_snapshots (id, cash_cents, equity_cents, realized_pnl_cents, unrealized_pnl_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id("snap"), state.account.cashCents, state.account.equityCents, state.account.realizedPnlCents, state.account.unrealizedPnlCents, nowIso()).run();
}

async function computeState(db: D1Database, includeLists = true): Promise<DashboardState> {
  const [cash, fillRows, quotes, openOrderResult, recentOrderResult, snapshotResult, auditResult, actionResult] = await Promise.all([
    cashBalance(db),
    loadFills(db),
    loadQuotes(db),
    db.prepare("SELECT * FROM orders WHERE status = 'OPEN' ORDER BY created_at DESC").all<OrderRow>(),
    db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 60").all<OrderRow>(),
    db.prepare("SELECT * FROM (SELECT s.id, s.equity_cents, s.cash_cents, s.created_at, COALESCE(m.source, 'LIVE') AS source, COALESCE(m.coverage_pct, 100) AS coverage_pct FROM portfolio_snapshots s LEFT JOIN snapshot_metadata m ON m.snapshot_id = s.id ORDER BY s.created_at DESC LIMIT 600) ORDER BY created_at ASC").all<{ id: string; equity_cents: number; cash_cents: number; created_at: string; source: string; coverage_pct: number }>(),
    db.prepare("SELECT id, event_type, message, created_at FROM audit_events ORDER BY created_at DESC LIMIT 80").all<{ id: string; event_type: string; message: string; created_at: string }>(),
    db.prepare("SELECT * FROM corporate_actions ORDER BY effective_date DESC, created_at DESC LIMIT 50").all<{ id: string; symbol: string; action_type: string; effective_date: string; value_text: string; status: string; created_at: string }>(),
  ]);
  const positionsMap = buildPositions(fillsForDomain(fillRows));
  const realized = [...positionsMap.values()].reduce((sum, position) => sum + position.realizedPnlCents, 0);
  let marketValue = 0;
  let netMarketValue = 0;
  let unrealized = 0;
  const rawPositions = [...positionsMap.values()].filter((position) => position.quantityMicros !== 0).map((position) => {
    const quote = quotes.get(position.symbol);
    const lastPrice = quote?.priceCents ?? position.averageCostCents;
    const signedValue = positionMarketValueCents(position.quantityMicros, lastPrice);
    const value = Math.abs(signedValue);
    const pnl = signedValue - position.costBasisCents;
    marketValue += value;
    netMarketValue += signedValue;
    unrealized += pnl;
    return { position, quote, lastPrice, value, pnl };
  });
  const equity = cash + netMarketValue;
  const reserved = await reservedCashCents(db, quotes);
  const positions = rawPositions.map(({ position, quote, lastPrice, value, pnl }) => ({
    symbol: position.symbol,
    direction: position.quantityMicros < 0 ? "SHORT" as const : "LONG" as const,
    quantityMicros: position.quantityMicros,
    averageCostCents: position.averageCostCents,
    costBasisCents: Math.abs(position.costBasisCents),
    lastPriceCents: lastPrice,
    marketValueCents: value,
    unrealizedPnlCents: pnl,
    realizedPnlCents: position.realizedPnlCents,
    allocationPct: equity > 0 ? (value / equity) * 100 : 0,
    quoteSource: quote?.source ?? "COST",
    quoteObservedAt: quote?.observedAt ?? "",
    assetClass: quote?.assetClass ?? "OTHER",
    name: quote?.name ?? position.symbol,
    exchange: quote?.exchange ?? "",
  })).sort((a, b) => b.marketValueCents - a.marketValueCents);
  const lastQuoteAt = [...quotes.values()].map((quote) => quote.observedAt).sort().at(-1) ?? null;
  let performanceSnapshots = snapshotResult.results ?? [];
  if (includeLists) {
    try {
      performanceSnapshots = await reconstructRecentPortfolioPerformance(db);
    } catch {
      performanceSnapshots = snapshotResult.results ?? [];
    }
  }
  const currentSnapshot = {
    id: "live-now",
    equity_cents: equity,
    cash_cents: cash,
    created_at: nowIso(),
    source: "LIVE_NOW",
    coverage_pct: rawPositions.length && rawPositions.some(({ quote }) => !quote) ? 0 : 100,
  };
  if (includeLists) {
    performanceSnapshots = [...performanceSnapshots.filter((snapshot) => snapshot.id !== "live-now"), currentSnapshot]
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }
  return {
    market: getUsEquityMarketStatus(),
    account: {
      cashCents: cash,
      availableCashCents: Math.max(0, cash - reserved),
      equityCents: equity,
      marketValueCents: marketValue,
      realizedPnlCents: realized,
      unrealizedPnlCents: unrealized,
      exposurePct: equity > 0 ? (marketValue / equity) * 100 : 0,
    },
    positions,
    openOrders: includeLists ? openOrderResult.results ?? [] : [],
    recentOrders: includeLists ? recentOrderResult.results ?? [] : [],
    fills: includeLists ? fillRows.slice(-80).reverse() : [],
    snapshots: snapshotResult.results ?? [],
    performanceSnapshots,
    audit: includeLists ? auditResult.results ?? [] : [],
    corporateActions: includeLists ? actionResult.results ?? [] : [],
    lastQuoteAt,
  };
}

export async function getDashboardState(): Promise<DashboardState> {
  const db = getDatabase();
  await ensureDatabase(db);
  const snapshotCount = await db.prepare("SELECT COUNT(*) AS count FROM portfolio_snapshots").first<{ count: number }>();
  if (!snapshotCount?.count) await saveSnapshot(db);
  else await backfillMissingPortfolioHistory(db);
  return computeState(db);
}

export async function syncMarket(args: { symbols?: string[]; manualQuotes?: Record<string, number> }): Promise<{ updated: Quote[]; filled: number; errors: string[]; state: DashboardState }> {
  const db = getDatabase();
  await ensureDatabase(db);
  const positions = buildPositions(fillsForDomain(await loadFills(db)));
  const openOrders = await db.prepare("SELECT DISTINCT symbol FROM orders WHERE status = 'OPEN'").all<{ symbol: string }>();
  const symbols = [...new Set([
    ...positions.keys(),
    ...(openOrders.results ?? []).map((row) => row.symbol),
    ...(args.symbols ?? []).map(normalizeSymbol),
    ...Object.keys(args.manualQuotes ?? {}).map(normalizeSymbol),
  ].filter(Boolean))];
  const updated: Quote[] = [];
  const errors: string[] = [];
  for (const symbol of symbols) {
    const manual = args.manualQuotes?.[symbol];
    if (manual && manual > 0) {
      const quote = { symbol: normalizeMarketSymbol(symbol), priceCents: dollarsToPriceCents(manual), source: "MANUAL", observedAt: nowIso() };
      await storeQuote(db, quote);
      updated.push(quote);
      continue;
    }
    try {
      const quote = await defaultProvider.getQuote(symbol);
      await storeQuote(db, quote);
      updated.push(quote);
    } catch (error) {
      errors.push(`${symbol}: ${error instanceof Error ? error.message : "quote failure"}`);
    }
  }
  const filled = await processOpenOrders(symbols);
  return { updated, filled, errors, state: await getDashboardState() };
}

export async function cancelOrder(orderId: string): Promise<DashboardState> {
  const db = getDatabase();
  await ensureDatabase(db);
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<OrderRow>();
  if (!order) throw new Error("Order not found");
  if (order.status !== "OPEN") throw new Error("Somente ordens open podem ser canceladas");
  const timestamp = nowIso();
  const statements = [
    db.prepare("UPDATE orders SET status = 'CANCELLED', remaining_micros = 0, updated_at = ? WHERE id = ?").bind(timestamp, orderId),
    db.prepare("INSERT INTO audit_events (id, event_type, entity_type, entity_id, message, payload_json, created_at) VALUES (?, 'ORDER_CANCELLED', 'ORDER', ?, ?, NULL, ?)").bind(id("audit"), orderId, `Order ${order.symbol} cancelled by the user`, timestamp),
  ];
  if (order.oco_group_id) statements.push(db.prepare("UPDATE orders SET status = 'CANCELLED', remaining_micros = 0, updated_at = ? WHERE oco_group_id = ? AND status = 'OPEN'").bind(timestamp, order.oco_group_id));
  await db.batch(statements);
  return getDashboardState();
}

export async function applyCorporateAction(input: { symbol: string; actionType: "DIVIDEND" | "SPLIT"; value: string; effectiveDate: string }): Promise<DashboardState> {
  const db = getDatabase();
  await ensureDatabase(db);
  const symbol = normalizeSymbol(input.symbol);
  const positions = buildPositions(fillsForDomain(await loadFills(db)));
  const position = positions.get(symbol);
  if (!position || position.quantityMicros <= 0) throw new Error(`No open position in ${symbol}`);
  const actionId = id("corp");
  const timestamp = nowIso();
  const statements: D1PreparedStatement[] = [
    db.prepare("INSERT INTO corporate_actions (id, symbol, action_type, effective_date, value_text, status, created_at) VALUES (?, ?, ?, ?, ?, 'APPLIED', ?)").bind(actionId, symbol, input.actionType, input.effectiveDate, input.value, timestamp),
  ];
  if (input.actionType === "DIVIDEND") {
    const perShareCents = dollarsToCents(input.value);
    const credit = positionMarketValueCents(position.quantityMicros, perShareCents);
    statements.push(db.prepare("INSERT INTO cash_ledger (id, delta_cents, entry_type, reference_id, description, created_at) VALUES (?, ?, 'DIVIDEND', ?, ?, ?)").bind(id("cash"), credit, actionId, `Dividendo ${symbol}`, timestamp));
  } else {
    const ratio = parseDecimal(input.value);
    if (ratio <= 0) throw new Error("The split ratio must be positive");
    const deltaMicros = Math.round(position.quantityMicros * (ratio - 1));
    if (deltaMicros !== 0) {
      const orderId = id("ord");
      const side: Side = deltaMicros > 0 ? "BUY" : "SELL";
      const quantity = Math.abs(deltaMicros);
      statements.push(
        db.prepare("INSERT INTO orders (id, symbol, side, order_type, role, status, quantity_micros, remaining_micros, trigger_price_cents, average_fill_price_cents, parent_order_id, oco_group_id, stop_loss_bps, take_profit_bps, note, created_at, updated_at) VALUES (?, ?, ?, 'MARKET', 'CORPORATE_ACTION', 'FILLED', ?, 0, NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?)").bind(orderId, symbol, side, quantity, side === "BUY" ? 0 : position.averageCostCents, `Split ${ratio}:1`, timestamp, timestamp),
        db.prepare("INSERT INTO fills (id, order_id, symbol, side, quantity_micros, price_cents, fee_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)").bind(id("fill"), orderId, symbol, side, quantity, side === "BUY" ? 0 : position.averageCostCents, timestamp),
      );
    }
  }
  statements.push(db.prepare("INSERT INTO audit_events (id, event_type, entity_type, entity_id, message, payload_json, created_at) VALUES (?, 'CORPORATE_ACTION_APPLIED', 'CORPORATE_ACTION', ?, ?, ?, ?)").bind(id("audit"), actionId, `${input.actionType} aplicado em ${symbol}`, JSON.stringify(input), timestamp));
  await db.batch(statements);
  await reconcileProtection(db, symbol);
  await saveSnapshot(db);
  return getDashboardState();
}

export function parseIntentWithRules(message: string): OrderIntent {
  const text = message.trim();
  const lower = text.toLocaleLowerCase("en-US");
  const tickerMatch = [...text.matchAll(/(?:\^[A-Z0-9.]{1,20}|\b[A-Z0-9.]{1,20}(?:[-=][A-Z0-9.]{1,10})?\b)/g)]
    .map((match) => match[0])
    .find((candidate) => /[A-Z^]/.test(candidate) && !["US", "USD"].includes(candidate));
  const alias = Object.entries(COMPANY_SYMBOL_FALLBACKS).find(([name]) => lower.includes(name));
  const companyMatch = text.match(/(?:shares?\s+(?:of|in)|(?:of|in)\s+)([\p{L}\d.& -]+?)(?=\s+(?:at\s+market|market|when|with\s+(?:stop|[\d.,]+\s*%)|using|stop|target|take[ -]?profit|for\s+us\$)|[,.;]|$)/iu);
  const symbol = alias?.[1] ?? tickerMatch ?? companyMatch?.[1]?.trim() ?? "";
  const isReduce = /reduce|trim|decrease|take profit on/.test(lower);
  const isClose = /close|flatten|exit|sell all|cover all/.test(lower);
  const isShort = /\bshort\b|short sell|open a short/.test(lower);
  const isSell = /sell|reduce|trim|decrease|close|flatten|exit/.test(lower);
  const action: OrderIntent["action"] = isClose ? "CLOSE" : isReduce ? "REDUCE" : isShort ? "SHORT" : isSell ? "SELL" : "BUY";
  const usdMatch = lower.match(/(?:us\$|usd|\$)\s*([\d.,]+)/)
    ?? lower.match(/([\d.,]+)\s*(?:dollars?|usd)\b/);
  const percentMatch = lower.match(/([\d.,]+)\s*%/);
  const sharesMatch = lower.match(/(?:buy|sell|reduce|short)\s+(\d+(?:[.,]\d+)?)\s+(?:shares?|units?)/);
  let sizingType: OrderIntent["sizingType"] = "SHARES";
  let sizingValue = sharesMatch?.[1] ?? "1";
  if (isClose) {
    sizingType = "POSITION_PCT";
    sizingValue = "100";
  } else if (percentMatch && /cash/.test(lower)) {
    sizingType = "CASH_PCT";
    sizingValue = percentMatch[1];
  } else if (percentMatch && (isSell || /posi/.test(lower))) {
    sizingType = "POSITION_PCT";
    sizingValue = percentMatch[1];
  } else if (usdMatch) {
    sizingType = "NOTIONAL";
    sizingValue = usdMatch[1];
  } else if (!sharesMatch) {
    const firstNumber = lower.match(/\b(\d+(?:[.,]\d+)?)\b/);
    sizingValue = firstNumber?.[1] ?? "1";
  }
  const explicitlyMarket = /\bat\s+market\b|\bmarket\b/.test(lower);
  const triggerMatch = explicitlyMarket
    ? null
    : lower.match(/\b(?:at|to|reach|when|price(?:\s+of)?)\s+(?:us\$|usd|\$)?\s*([\d.,]+)/);
  const orderType: OrderIntent["orderType"] = explicitlyMarket
    ? "MARKET"
    : /\b(?:breakout|above|buy stop)/.test(lower) ? "STOP" : triggerMatch ? "LIMIT" : "MARKET";
  const stopLoss = lower.match(/stop(?:-loss)?(?:\s+de|\s+em|\s+)?\s*([\d.,]+)\s*%/);
  const takeProfit = lower.match(/(?:take profit|take-profit|target)(?:\s+of|\s+at|\s+)?\s*([\d.,]+)\s*%/);
  return {
    action,
    symbol,
    sizingType,
    sizingValue,
    orderType,
    triggerPrice: triggerMatch?.[1] ?? null,
    stopLossPct: stopLoss?.[1] ?? null,
    takeProfitPct: takeProfit?.[1] ?? null,
    note: `Interpreted from: ${message}`,
  };
}

export async function parseIntentWithOllama(message: string, model = "qwen3.5:9b"): Promise<{ intent: OrderIntent; parser: "OLLAMA" | "RULES"; resolution: SymbolResolution | null; suggestions: AssetSuggestion[]; needsSelection: boolean; processing: { model: string; durationMs: number; ollamaAttempts: number; repairedFields: string[] }; warning?: string }> {
  const startedAt = Date.now();
  let ollamaAttempts = 0;
  let repairedFields: string[] = [];
  const rulesForRepair = parseIntentWithRules(message);
  const schema = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["BUY", "SHORT", "SELL", "REDUCE", "CLOSE"] },
      symbol: { type: "string" },
      sizingType: { type: "string", enum: ["SHARES", "NOTIONAL", "CASH_PCT", "POSITION_PCT"] },
      sizingValue: { type: "string" },
      orderType: { type: "string", enum: ["MARKET", "LIMIT", "STOP"] },
      triggerPrice: { type: ["string", "null"] },
      stopLossPct: { type: ["string", "null"] },
      takeProfitPct: { type: ["string", "null"] },
      note: { type: ["string", "null"] },
    },
    required: ["action", "symbol", "sizingType", "sizingValue", "orderType", "triggerPrice", "stopLossPct", "takeProfitPct", "note"],
  };
  try {
    const systemPrompt = `You convert informal English trading requests into one structured paper-trading order. Do not provide recommendations or explanations.
- Understand typos, repeated words, and conversational phrasing.
- LONG, buy, go long, and open a long position mean BUY.
- SHORT, short sell, and open a short position mean SHORT. SELL only sells an existing long position.
- REDUCE reduces the existing position and CLOSE closes 100%, whether long or short.
- CASH_PCT is a percentage of available cash; POSITION_PCT is a percentage of the existing position; NOTIONAL is USD value; SHARES is unit quantity.
- Extract the company, asset, or theme name into symbol. If you know the Yahoo ticker confidently, you may use it; otherwise keep the cited name so the server can search Yahoo Finance. Never invent tickers.
- Nunca interprete US ou USD como ticker.
- Without an explicit price, use MARKET. A buy below price is LIMIT; a breakout above price is STOP.
- Stop-loss and take-profit percentages are separate from order size.
Example: "open a long position in Chevron with 1% of available cash" => action BUY, symbol Chevron, sizingType CASH_PCT, sizingValue 1, orderType MARKET.
Retorne somente o objeto que respeita o schema.`;
    let previousContent = "";
    let rawIntent: OrderIntent | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      ollamaAttempts = attempt;
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
        ...(attempt === 2 ? [
          { role: "assistant", content: previousContent },
          { role: "user", content: "The previous response was empty or invalid. Fix the fields and return only schema JSON." },
        ] : []),
      ];
      const response = await fetch("http://127.0.0.1:11434/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: "10m",
          format: schema,
          options: { temperature: 0, num_predict: 256 },
          messages,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const payload = await response.json() as { message?: { content?: string } };
      previousContent = payload.message?.content?.trim() ?? "";
      if (!previousContent) {
        if (attempt === 1) continue;
        throw new Error("Resposta vazia do Ollama");
      }
      try {
        const candidate = JSON.parse(previousContent) as OrderIntent;
        const repaired: OrderIntent = { ...candidate };
        repairedFields = [];
        if (!candidate.symbol?.trim() && rulesForRepair.symbol) { repaired.symbol = rulesForRepair.symbol; repairedFields.push("symbol"); }
        if (!candidate.action) { repaired.action = rulesForRepair.action; repairedFields.push("action"); }
        if (!candidate.sizingType) { repaired.sizingType = rulesForRepair.sizingType; repairedFields.push("sizingType"); }
        if (!candidate.orderType) { repaired.orderType = rulesForRepair.orderType; repairedFields.push("orderType"); }
        if (!String(candidate.sizingValue ?? "").trim()) { repaired.sizingValue = rulesForRepair.sizingValue; repairedFields.push("sizingValue"); }
        const explicitCashPercent = cashPercentageFromText(message);
        if (explicitCashPercent !== null && (repaired.sizingType !== "CASH_PCT" || parseDecimal(repaired.sizingValue) !== explicitCashPercent)) {
          repaired.sizingType = "CASH_PCT";
          repaired.sizingValue = String(explicitCashPercent);
          if (!repairedFields.includes("sizingType")) repairedFields.push("sizingType");
          if (!repairedFields.includes("sizingValue")) repairedFields.push("sizingValue");
        }
        const missingFields = [
          !repaired.symbol?.trim() ? "symbol" : "",
          !repaired.action ? "action" : "",
          !repaired.sizingType ? "sizingType" : "",
          !repaired.orderType ? "orderType" : "",
          !String(repaired.sizingValue ?? "").trim() ? "sizingValue" : "",
        ].filter(Boolean);
        if (missingFields.length) {
          if (attempt === 1) continue;
          throw new Error(`Ollama returned empty required fields: ${missingFields.join(", ")}`);
        }
        rawIntent = repaired;
        break;
      } catch (error) {
        if (attempt === 1) continue;
        throw error;
      }
    }
    if (!rawIntent) throw new Error("Ollama did not return a valid order");
    const result = await resolveYahooAsset(rawIntent.symbol);
    const intent = normalizeIntent({ ...rawIntent, symbol: result.resolution?.symbol ?? rawIntent.symbol });
    if (!result.needsSelection) validateIntent(intent);
    return { intent, parser: "OLLAMA", ...result, processing: { model, durationMs: Date.now() - startedAt, ollamaAttempts, repairedFields } };
  } catch (error) {
    const rawIntent = parseIntentWithRules(message);
    const result = await resolveYahooAsset(rawIntent.symbol);
    const intent = normalizeIntent({ ...rawIntent, symbol: result.resolution?.symbol ?? rawIntent.symbol });
    if (!result.needsSelection) validateIntent(intent);
    return { intent, parser: "RULES", ...result, processing: { model, durationMs: Date.now() - startedAt, ollamaAttempts, repairedFields: [] }, warning: `Ollama unavailable; used the local rules parser and checked Binance/Yahoo. ${error instanceof Error ? error.message : ""}`.trim() };
  }
}
