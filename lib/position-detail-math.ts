import { buildPositions, positionMarketValueCents, type FillLike, type Side } from "./finance.ts";

export type CycleFill = { side: Side; quantity_micros: number; created_at: string };
export type PerformanceFill = CycleFill & { symbol: string; price_cents: number; fee_cents: number };
export type PositionPerformancePoint = { createdAt: string; pnlCents: number; returnPct: number; marketValueCents: number };

export function findOpenCycleStart(fills: CycleFill[]): string | null {
  let quantity = 0;
  let openedAt: string | null = null;
  for (const fill of [...fills].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const before = quantity;
    quantity = fill.side === "BUY" ? quantity + fill.quantity_micros : quantity - fill.quantity_micros;
    if (before === 0 && quantity !== 0) openedAt = fill.created_at;
    if (before !== 0 && Math.sign(before) !== Math.sign(quantity) && quantity !== 0) openedAt = fill.created_at;
    if (quantity === 0) openedAt = null;
  }
  return openedAt;
}

export function calculatePositionRisk(input: { quantityMicros: number; direction?: "LONG" | "SHORT"; lastPriceCents: number; stopPriceCents: number | null; targetPriceCents: number | null }) {
  const { quantityMicros, lastPriceCents, stopPriceCents, targetPriceCents } = input;
  const direction = input.direction ?? (quantityMicros < 0 ? "SHORT" : "LONG");
  const stopDistance = stopPriceCents === null ? null : Math.max(0, direction === "LONG" ? lastPriceCents - stopPriceCents : stopPriceCents - lastPriceCents);
  const targetDistance = targetPriceCents === null ? null : Math.max(0, direction === "LONG" ? targetPriceCents - lastPriceCents : lastPriceCents - targetPriceCents);
  const capitalAtRiskCents = stopDistance === null ? null : positionMarketValueCents(Math.abs(quantityMicros), stopDistance);
  return {
    stopDistancePct: stopDistance === null || lastPriceCents <= 0 ? null : stopDistance / lastPriceCents * 100,
    targetDistancePct: targetDistance === null || lastPriceCents <= 0 ? null : targetDistance / lastPriceCents * 100,
    capitalAtRiskCents,
    rewardRiskRatio: stopDistance && targetDistance !== null ? targetDistance / stopDistance : null,
  };
}

export function buildPositionPerformanceSeries(input: {
  symbol: string;
  fills: PerformanceFill[];
  bars: Array<{ date: string; closeCents: number }>;
  quote: { priceCents: number; observedAt: string };
}): PositionPerformancePoint[] {
  const orderedFills = [...input.fills].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const openedAt = findOpenCycleStart(orderedFills);
  if (!openedAt) return [];
  const quoteTime = Date.parse(input.quote.observedAt);
  const domainFills: FillLike[] = orderedFills.map((fill) => ({
    side: fill.side,
    symbol: fill.symbol,
    quantityMicros: fill.quantity_micros,
    priceCents: fill.price_cents,
    feeCents: fill.fee_cents,
    createdAt: fill.created_at,
  }));
  const baselineRealized = buildPositions(domainFills.filter((fill) => fill.createdAt < openedAt)).get(input.symbol)?.realizedPnlCents ?? 0;
  const openDate = openedAt.slice(0, 10);
  const events = [
    ...input.bars.flatMap((bar) => {
      const createdAt = `${bar.date}T23:59:59.999Z`;
      return bar.date >= openDate && Date.parse(createdAt) <= quoteTime ? [{ createdAt, priceCents: bar.closeCents }] : [];
    }),
    ...orderedFills.filter((fill) => fill.created_at >= openedAt).map((fill) => ({ createdAt: fill.created_at, priceCents: fill.price_cents })),
    { createdAt: input.quote.observedAt, priceCents: input.quote.priceCents },
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const uniqueEvents = [...new Map(events.map((event) => [event.createdAt, event])).values()];
  return uniqueEvents.flatMap((event) => {
    const position = buildPositions(domainFills.filter((fill) => fill.createdAt <= event.createdAt)).get(input.symbol);
    if (!position || position.quantityMicros === 0) return [];
    const signedMarketValue = positionMarketValueCents(position.quantityMicros, event.priceCents);
    const unrealizedPnl = signedMarketValue - position.costBasisCents;
    const pnlCents = unrealizedPnl + position.realizedPnlCents - baselineRealized;
    const grossCost = Math.max(1, Math.abs(position.costBasisCents));
    return [{
      createdAt: event.createdAt,
      pnlCents,
      returnPct: pnlCents / grossCost * 100,
      marketValueCents: Math.abs(signedMarketValue),
    }];
  });
}
