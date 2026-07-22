import { env } from "cloudflare:workers";
import { getMarketIntelligence } from "../../../lib/market-intelligence";
import { getDashboardState } from "../../../lib/trading-engine";

function configured(): boolean {
  const value = (env as unknown as Record<string, unknown>).FINANCIALJUICE_API_KEY;
  return typeof value === "string" && value.trim().length > 8 && value !== "fj_replace_me";
}

export async function GET() {
  try {
    const state = await getDashboardState();
    const holdings = state.positions.map(({ symbol, name }) => ({ symbol, name }));
    return Response.json({ intelligence: await getMarketIntelligence(holdings, configured()) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Falha ao carregar notícias" }, { status: 500 });
  }
}
