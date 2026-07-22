import { getPositionDetail } from "../../../lib/position-detail";

export async function GET(request: Request) {
  try {
    const symbol = new URL(request.url).searchParams.get("symbol") ?? "";
    return Response.json({ detail: await getPositionDetail(symbol) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao carregar a posição";
    return Response.json({ error: message }, { status: message.includes("Não existe") ? 404 : 400 });
  }
}
