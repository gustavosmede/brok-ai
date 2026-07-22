import { getPositionDetail } from "../../../lib/position-detail";

export async function GET(request: Request) {
  try {
    const symbol = new URL(request.url).searchParams.get("symbol") ?? "";
    return Response.json({ detail: await getPositionDetail(symbol) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load the position";
    return Response.json({ error: message }, { status: message.includes("No open position exists") ? 404 : 400 });
  }
}
