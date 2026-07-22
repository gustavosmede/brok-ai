import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function readLocalEnv() {
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/).flatMap((line) => {
    const clean = line.trim().replace(/^export\s+/, "");
    if (!clean || clean.startsWith("#") || !clean.includes("=")) return [];
    const separator = clean.indexOf("=");
    return [[clean.slice(0, separator).trim(), clean.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2")]];
  }));
}

const localEnv = readLocalEnv();
const apiKey = (process.env.FINANCIALJUICE_API_KEY || localEnv.FINANCIALJUICE_API_KEY || "").trim();
const ingestUrl = process.env.BROKAI_INGEST_URL || "http://127.0.0.1:3000/api/intelligence/ingest";
const terminalCloseCodes = new Set([4001, 4003, 4030]);
let socket;
let attempts = 0;
let stopped = false;

if (!apiKey || apiKey === "fj_replace_me") {
  console.log("[FinancialJuice] Chave ausente; Yahoo permanece como fallback.");
  process.exit(0);
}

async function deliver(message) {
  try {
    const response = await fetch(ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.error(`[FinancialJuice] ingest respondeu ${response.status}`);
  } catch (error) {
    console.error(`[FinancialJuice] ingest indisponível: ${error instanceof Error ? error.message : error}`);
  }
}

function retry() {
  if (stopped) return;
  attempts += 1;
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6)) + Math.round(Math.random() * 750);
  console.log(`[FinancialJuice] reconectando em ${(delay / 1000).toFixed(1)}s`);
  setTimeout(connect, delay).unref();
}

function connect() {
  if (stopped) return;
  const url = `wss://stream.financialjuice.com/v1/stream?apikey=${encodeURIComponent(apiKey)}&takeover=true`;
  socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    attempts = 0;
    console.log("[FinancialJuice] stream conectado (plano gratuito: atraso de 10 min). ");
    void deliver({ type: "connection", event: "opened", data: { delaySeconds: 600 } });
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.type === "hello") console.log(`[FinancialJuice] canais: ${JSON.stringify(message.channels ?? message.data?.channels ?? [])}; delay: ${message.delay_seconds ?? message.data?.delay_seconds ?? "?"}s`);
      if (message.type === "calendar") console.log(`[FinancialJuice] calendário ${message.event}: ${Array.isArray(message.data) ? message.data.length : 1} evento(s)`);
      void deliver(message);
    }
    catch { console.error("[FinancialJuice] mensagem JSON inválida ignorada"); }
  });
  socket.addEventListener("error", () => console.error("[FinancialJuice] erro no WebSocket"));
  socket.addEventListener("close", (event) => {
    void deliver({ type: "connection", event: "closed", data: { code: event.code, reason: event.reason } });
    if (terminalCloseCodes.has(event.code)) {
      console.error(`[FinancialJuice] conexão encerrada sem retry (${event.code}): ${event.reason || "verifique a chave"}`);
      return;
    }
    retry();
  });
}

function shutdown() {
  stopped = true;
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) socket.close(1000, "Brok.ai encerrado");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
connect();
