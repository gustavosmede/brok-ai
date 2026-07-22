const MAX_AUDIO_BYTES = 3 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const incoming = await request.formDate();
    const audio = incoming.get("file");
    if (!(audio instanceof File)) return Response.json({ error: "Send an audio recording" }, { status: 400 });
    if (audio.size === 0) return Response.json({ error: "The recording is empty" }, { status: 400 });
    if (audio.size > MAX_AUDIO_BYTES) return Response.json({ error: "The recording exceeds the 30-second limit" }, { status: 413 });
    if (audio.type && audio.type !== "audio/wav" && audio.type !== "audio/x-wav") {
      return Response.json({ error: "Invalid audio format" }, { status: 415 });
    }

    const payload = new FormData();
    payload.append("file", audio, "brokai-voice.wav");
    payload.append("response_format", "json");
    payload.append("language", "pt");
    payload.append("temperature", "0.0");
    payload.append("no_speech_thold", "0.6");
    payload.append("prompt", "Paper trading order in English. Apple, Chevron, Netflix, PayPal, Bitcoin, Ethereum, oil, uranium, available cash, long position, short position, stop-loss, take profit, market order, and limit order.");

    let response: Response;
    try {
      response = await fetch("http://127.0.0.1:8080/inference", {
        method: "POST",
        body: payload,
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      throw new Error("Local Whisper is not available. Run npm run voice:install and try again.", { cause: error });
    }
    const raw = await response.text();
    if (!response.ok) throw new Error(`Local Whisper returned ${response.status}: ${raw.slice(0, 160)}`);
    let text = raw;
    try {
      const parsed = JSON.parse(raw) as { text?: string };
      text = parsed.text ?? "";
    } catch {
      // Some whisper.cpp versions return plain text even when JSON is requested.
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) throw new Error("No speech was detected in the recording. Try again closer to the microphone.");
    return Response.json({ text, engine: "WHISPER_LOCAL" });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed to transcribe the recording" }, { status: 503 });
  }
}
