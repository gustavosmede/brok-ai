import { env } from "cloudflare:workers";
import { ingestFinancialJuiceMessage } from "../../../../lib/market-intelligence";

function apiKey(): string {
  const value = (env as unknown as Record<string, unknown>).FINANCIALJUICE_API_KEY;
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  const expected = apiKey();
  const authorization = request.headers.get("authorization") ?? "";
  if (!expected || authorization !== `Bearer ${expected}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const payload = await request.json() as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return Response.json({ error: "Invalid payload" }, { status: 400 });
    await ingestFinancialJuiceMessage(payload as Record<string, unknown>);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed to persist event" }, { status: 500 });
  }
}
