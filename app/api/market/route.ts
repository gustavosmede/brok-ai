import { syncMarket } from "../../../lib/trading-engine";

export async function POST(request: Request) {
  try {
    const payload = await request.json().catch(() => ({})) as { symbols?: string[]; manualQuotes?: Record<string, number> };
    return Response.json(await syncMarket(payload));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed to update quotes" }, { status: 502 });
  }
}

