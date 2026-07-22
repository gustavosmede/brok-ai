import { buildPortfolioAnalytics } from "../../../lib/analytics";
import { getDashboardState } from "../../../lib/trading-engine";

export async function GET() {
  try {
    const state = await getDashboardState();
    return Response.json({ analytics: await buildPortfolioAnalytics(state) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed to calculate analytics" }, { status: 500 });
  }
}
