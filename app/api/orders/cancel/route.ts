import { cancelOrder } from "../../../../lib/trading-engine";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { orderId?: string };
    if (!payload.orderId) return Response.json({ error: "orderId ausente" }, { status: 400 });
    return Response.json({ state: await cancelOrder(payload.orderId) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not cancel" }, { status: 409 });
  }
}

