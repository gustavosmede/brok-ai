import { getDashboardState } from "../../../lib/trading-engine";

export async function GET() {
  try {
    return Response.json({ state: await getDashboardState() });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Falha ao carregar a carteira" }, { status: 500 });
  }
}

