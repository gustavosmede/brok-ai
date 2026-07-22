export const QUANTITY_SCALE = 1_000_000;

export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "STOP";
export type SizingType =
  | "SHARES"
  | "NOTIONAL"
  | "CASH_PCT"
  | "POSITION_PCT";

export type OrderIntent = {
  action: "BUY" | "SHORT" | "SELL" | "REDUCE" | "CLOSE";
  symbol: string;
  sizingType: SizingType;
  sizingValue: string;
  orderType: OrderType;
  triggerPrice?: string | null;
  stopLossPct?: string | null;
  takeProfitPct?: string | null;
  note?: string | null;
};

export type Quote = {
  symbol: string;
  priceCents: number;
  observedAt: string;
  source: string;
  assetClass?: string;
  name?: string;
  exchange?: string;
};

export type FillLike = {
  side: Side;
  symbol: string;
  quantityMicros: number;
  priceCents: number;
  feeCents: number;
  createdAt: string;
};

export type Position = {
  symbol: string;
  quantityMicros: number;
  averageCostCents: number;
  costBasisCents: number;
  realizedPnlCents: number;
};

export function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9.^=\-]/g, "");
}

export function parseDecimal(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const compact = String(value)
    .trim()
    .replace(/\s/g, "")
    .replace(/^(?:US\$|USD|\$)/i, "")
    .replace(/(?:%|USD)$/i, "");
  let normalized = compact;
  if (compact.includes(".") && compact.includes(",")) {
    normalized = compact.lastIndexOf(",") > compact.lastIndexOf(".")
      ? compact.replaceAll(".", "").replace(",", ".")
      : compact.replaceAll(",", "");
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(compact)) {
    normalized = compact.replaceAll(".", "");
  } else if (/^\d{1,3}(?:,\d{3})+$/.test(compact)) {
    normalized = compact.replaceAll(",", "");
  } else {
    normalized = compact.replace(",", ".");
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

export function dollarsToCents(value: string | number): number {
  return Math.round(parseDecimal(value) * 100);
}

export function roundPriceCents(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

export function dollarsToPriceCents(value: string | number): number {
  return roundPriceCents(parseDecimal(value) * 100);
}

export function sharesToMicros(value: string | number): number {
  return Math.round(parseDecimal(value) * QUANTITY_SCALE);
}

export function microsToShares(value: number): number {
  return value / QUANTITY_SCALE;
}

export function percentToBps(value: string | number | null | undefined): number {
  return Math.round(parseDecimal(value) * 100);
}

export function cashPercentageFromText(value: string): number | null {
  const match = value.toLocaleLowerCase("pt-BR").match(/([\d.,]+)\s*%\s*(?:do|de)?\s*caixa\b/);
  if (!match) return null;
  const percentage = parseDecimal(match[1]);
  return percentage > 0 ? percentage : null;
}

export function positionMarketValueCents(
  quantityMicros: number,
  priceCents: number,
): number {
  return Math.round((quantityMicros * priceCents) / QUANTITY_SCALE);
}

export function resolveQuantityMicros(args: {
  intent: OrderIntent;
  referencePriceCents: number;
  availableCashCents: number;
  positionQuantityMicros: number;
}): number {
  const { intent, referencePriceCents, availableCashCents, positionQuantityMicros } = args;
  const value = parseDecimal(intent.sizingValue);

  if (referencePriceCents <= 0) return 0;
  if (intent.action === "CLOSE") return Math.abs(positionQuantityMicros);

  switch (intent.sizingType) {
    case "SHARES":
      return Math.max(0, sharesToMicros(value));
    case "NOTIONAL":
      return Math.max(
        0,
        Math.floor((dollarsToCents(value) * QUANTITY_SCALE) / referencePriceCents),
      );
    case "CASH_PCT": {
      const notionalCents = Math.floor(availableCashCents * (value / 100));
      return Math.max(
        0,
        Math.floor((notionalCents * QUANTITY_SCALE) / referencePriceCents),
      );
    }
    case "POSITION_PCT":
      return Math.max(0, Math.floor(Math.abs(positionQuantityMicros) * (value / 100)));
  }
}

export function shouldFillOrder(args: {
  side: Side;
  orderType: OrderType;
  quotePriceCents: number;
  triggerPriceCents: number | null;
}): boolean {
  const { side, orderType, quotePriceCents, triggerPriceCents } = args;
  if (orderType === "MARKET") return true;
  if (!triggerPriceCents || triggerPriceCents <= 0) return false;
  if (orderType === "LIMIT") {
    return side === "BUY"
      ? quotePriceCents <= triggerPriceCents
      : quotePriceCents >= triggerPriceCents;
  }
  return side === "BUY"
    ? quotePriceCents >= triggerPriceCents
    : quotePriceCents <= triggerPriceCents;
}

export function simulatedFillPriceCents(args: {
  side: Side;
  orderType: OrderType;
  quotePriceCents: number;
  triggerPriceCents: number | null;
  slippageBps?: number;
}): number {
  const {
    side,
    orderType,
    quotePriceCents,
    triggerPriceCents,
    slippageBps = 5,
  } = args;
  const slip = side === "BUY" ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;

  if (orderType === "LIMIT" && triggerPriceCents) {
    const favorable = side === "BUY"
      ? Math.min(quotePriceCents, triggerPriceCents)
      : Math.max(quotePriceCents, triggerPriceCents);
    return Math.max(0.00000001, roundPriceCents(favorable));
  }

  return Math.max(0.00000001, roundPriceCents(quotePriceCents * slip));
}

export function buildPositions(fills: FillLike[]): Map<string, Position> {
  const positions = new Map<string, Position>();
  const ordered = [...fills].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const fill of ordered) {
    const current = positions.get(fill.symbol) ?? {
      symbol: fill.symbol,
      quantityMicros: 0,
      averageCostCents: 0,
      costBasisCents: 0,
      realizedPnlCents: 0,
    };

    let remainingMicros = fill.quantityMicros;
    if (fill.side === "BUY" && current.quantityMicros < 0) {
      const coveredMicros = Math.min(remainingMicros, Math.abs(current.quantityMicros));
      const fee = Math.round(fill.feeCents * coveredMicros / Math.max(1, fill.quantityMicros));
      current.realizedPnlCents += positionMarketValueCents(coveredMicros, current.averageCostCents - fill.priceCents) - fee;
      current.quantityMicros += coveredMicros;
      current.costBasisCents += positionMarketValueCents(coveredMicros, current.averageCostCents);
      remainingMicros -= coveredMicros;
    } else if (fill.side === "SELL" && current.quantityMicros > 0) {
      const soldMicros = Math.min(remainingMicros, current.quantityMicros);
      const fee = Math.round(fill.feeCents * soldMicros / Math.max(1, fill.quantityMicros));
      current.realizedPnlCents += positionMarketValueCents(soldMicros, fill.priceCents - current.averageCostCents) - fee;
      current.quantityMicros -= soldMicros;
      current.costBasisCents -= positionMarketValueCents(soldMicros, current.averageCostCents);
      remainingMicros -= soldMicros;
    }

    if (current.quantityMicros === 0) current.costBasisCents = 0;
    if (remainingMicros > 0 && fill.side === "BUY") {
      const fee = Math.round(fill.feeCents * remainingMicros / Math.max(1, fill.quantityMicros));
      current.quantityMicros += remainingMicros;
      current.costBasisCents += positionMarketValueCents(remainingMicros, fill.priceCents) + fee;
    } else if (remainingMicros > 0) {
      const fee = Math.round(fill.feeCents * remainingMicros / Math.max(1, fill.quantityMicros));
      current.quantityMicros -= remainingMicros;
      current.costBasisCents -= positionMarketValueCents(remainingMicros, fill.priceCents) - fee;
    }
    current.averageCostCents = current.quantityMicros === 0
      ? 0
      : Math.abs(roundPriceCents((current.costBasisCents * QUANTITY_SCALE) / current.quantityMicros));
    positions.set(fill.symbol, current);
  }

  return positions;
}

export function protectivePriceCents(
  fillPriceCents: number,
  percentBps: number,
  kind: "STOP_LOSS" | "TAKE_PROFIT",
  direction: "LONG" | "SHORT" = "LONG",
): number {
  const move = percentBps / 10_000;
  const factor = direction === "LONG"
    ? kind === "STOP_LOSS" ? 1 - move : 1 + move
    : kind === "STOP_LOSS" ? 1 + move : 1 - move;
  return Math.max(0.00000001, roundPriceCents(fillPriceCents * factor));
}
