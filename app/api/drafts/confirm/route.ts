import { confirmDraft } from "../../../../lib/trading-engine";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { draftId?: string };
    if (!payload.draftId) return Response.json({ error: "draftId ausente" }, { status: 400 });
    return Response.json({ state: await confirmDraft(payload.draftId) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not confirm" }, { status: 409 });
  }
}

