import { parseIntentWithOllama } from "../../../lib/trading-engine";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { message?: string; model?: string };
    const message = payload.message?.trim();
    if (!message) return Response.json({ error: "Escreva uma ordem" }, { status: 400 });
    const parsed = await parseIntentWithOllama(message, payload.model?.trim() || undefined);
    return Response.json(parsed);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Falha ao interpretar a ordem" }, { status: 400 });
  }
}

