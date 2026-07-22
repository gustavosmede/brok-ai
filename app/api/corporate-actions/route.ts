import { applyCorporateAction } from "../../../lib/trading-engine";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { symbol?: string; actionType?: "DIVIDEND" | "SPLIT"; value?: string; effectiveDate?: string };
    if (!payload.symbol || !payload.actionType || !payload.value || !payload.effectiveDate) {
      return Response.json({ error: "Preencha todos os campos do evento corporativo" }, { status: 400 });
    }
    const state = await applyCorporateAction({ symbol: payload.symbol, actionType: payload.actionType, value: payload.value, effectiveDate: payload.effectiveDate });
    return Response.json({ state });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Não foi possível aplicar o evento" }, { status: 400 });
  }
}
