const MAX_AUDIO_BYTES = 3 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const incoming = await request.formData();
    const audio = incoming.get("file");
    if (!(audio instanceof File)) return Response.json({ error: "Envie uma gravação de áudio" }, { status: 400 });
    if (audio.size === 0) return Response.json({ error: "A gravação está vazia" }, { status: 400 });
    if (audio.size > MAX_AUDIO_BYTES) return Response.json({ error: "A gravação excede o limite de 30 segundos" }, { status: 413 });
    if (audio.type && audio.type !== "audio/wav" && audio.type !== "audio/x-wav") {
      return Response.json({ error: "Formato de áudio inválido" }, { status: 415 });
    }

    const payload = new FormData();
    payload.append("file", audio, "brokai-voice.wav");
    payload.append("response_format", "json");
    payload.append("language", "pt");
    payload.append("temperature", "0.0");
    payload.append("no_speech_thold", "0.6");
    payload.append("prompt", "Ordem de paper trading em português. Apple, Chevron, Netflix, PayPal, Bitcoin, Ethereum, petróleo, urânio, caixa disponível, posição long, posição short, stop-loss, take profit, ordem a mercado e ordem limitada.");

    let response: Response;
    try {
      response = await fetch("http://127.0.0.1:8080/inference", {
        method: "POST",
        body: payload,
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      throw new Error("O Whisper local não está disponível. Execute npm run voice:install e tente novamente.", { cause: error });
    }
    const raw = await response.text();
    if (!response.ok) throw new Error(`Whisper local respondeu ${response.status}: ${raw.slice(0, 160)}`);
    let text = raw;
    try {
      const parsed = JSON.parse(raw) as { text?: string };
      text = parsed.text ?? "";
    } catch {
      // Some whisper.cpp versions return plain text even when JSON is requested.
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) throw new Error("Não identifiquei fala na gravação. Tente novamente mais perto do microfone.");
    return Response.json({ text, engine: "WHISPER_LOCAL" });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Falha ao transcrever a gravação" }, { status: 503 });
  }
}
