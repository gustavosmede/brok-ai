import { createDraft } from "../../../lib/trading-engine";
import type { OrderIntent } from "../../../lib/finance";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { intent?: OrderIntent; source?: string; originalText?: string };
    if (!payload.intent) return Response.json({ error: "Missing intent" }, { status: 400 });
    const preview = await createDraft(payload.intent, payload.source ?? "MANUAL", payload.originalText);
    return Response.json({ preview }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not create preview" }, { status: 400 });
  }
}

