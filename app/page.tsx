"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PortfolioAnalytics } from "../lib/analytics";
import type { OrderIntent } from "../lib/finance";
import type { AssetSuggestion, SymbolResolution } from "../lib/market-data";
import type { MarketIntelligence } from "../lib/market-intelligence";
import type { PositionDetail } from "../lib/position-detail";
import type { DashboardState, OrderPreview } from "../lib/trading-engine";
import { recordedAudioToWav } from "../lib/audio";
import { splitTimeSeriesAtGaps } from "../lib/time-series";
import { PositionDetailDrawer } from "./components/position-detail-drawer";

type Tab = "overview" | "performance" | "risk" | "orders" | "activity" | "news" | "settings";
type Notice = { kind: "success" | "error" | "info"; text: string } | null;
type ChatStage = "OLLAMA" | "PREVIEW" | null;
type VoiceStage = "RECORDING" | "TRANSCRIBING" | null;
type TerminalTarget = "overview" | "portfolio" | "orders" | "news";
type InterpreterResult = { parser: "OLLAMA" | "RULES"; model: string; durationMs: number; attempts: number; repairedFields: string[] };

const defaultIntent: OrderIntent = {
  action: "BUY",
  symbol: "AAPL",
  sizingType: "NOTIONAL",
  sizingValue: "1000",
  orderType: "MARKET",
  triggerPrice: "",
  stopLossPct: "5",
  takeProfitPct: "10",
  note: "",
};

const colors = ["#ff9f1c", "#168bff", "#35d46f", "#b56cff", "#ff4b5c", "#22c7d6"];

function money(cents: number, digits = 2): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
}

function priceMoney(cents: number): string {
  const dollars = cents / 100;
  const digits = dollars !== 0 && Math.abs(dollars) < 0.01 ? 8 : 2;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(dollars);
}

function shares(micros: number): string {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 6 }).format(micros / 1_000_000);
}

function compactDate(value?: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function percent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "Dados insuficientes";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "A operação falhou");
  return body;
}

function EquityChart({ points }: { points: DashboardState["snapshots"] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const width = rect.width;
      const height = rect.height;
      ctx.clearRect(0, 0, width, height);

      const source = points.length ? points : [{ id: "empty", equity_cents: 10_000_000, cash_cents: 10_000_000, created_at: new Date().toISOString() }];
      const values = source.map((point) => point.equity_cents);
      const times = source.map((point) => Date.parse(point.created_at));
      const firstTime = Math.min(...times);
      const lastTime = Math.max(...times);
      const timeRange = Math.max(1, lastTime - firstTime);
      const rawMin = Math.min(...values);
      const rawMax = Math.max(...values);
      const observedRange = rawMax - rawMin;
      const minimumRange = Math.max(1_000, Math.round(Math.abs(values[0]) * .0002));
      const paddedRange = Math.max(minimumRange, observedRange * 1.24);
      const center = (rawMin + rawMax) / 2;
      const min = center - paddedRange / 2;
      const max = center + paddedRange / 2;
      const range = max - min;
      const left = width < 520 ? 58 : 76;
      const right = 14;
      const top = 19;
      const bottom = 30;
      const plotWidth = Math.max(1, width - left - right);
      const plotHeight = Math.max(1, height - top - bottom);
      const x = (time: number, index: number) => source.length === 1 ? left + plotWidth / 2 : left + ((timeRange === 1 ? index / (source.length - 1) : (time - firstTime) / timeRange) * plotWidth);
      const y = (value: number) => top + (max - value) / range * plotHeight;
      const yDigits = range < 10_000 ? 2 : 0;
      const yFormat = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: yDigits, maximumFractionDigits: yDigits });
      const spanHours = timeRange / 3_600_000;
      const timeFormat = new Intl.DateTimeFormat("pt-BR", spanHours <= 24
        ? { hour: "2-digit", minute: "2-digit" }
        : spanHours <= 24 * 14 ? { day: "2-digit", month: "short", hour: "2-digit" }
          : { day: "2-digit", month: "short" });

      ctx.font = "9px Menlo, monospace";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 1;
      for (let index = 0; index <= 4; index += 1) {
        const value = max - range * index / 4;
        const guideY = top + plotHeight * index / 4;
        ctx.strokeStyle = index === 4 ? "rgba(180,180,180,.22)" : "rgba(180,180,180,.12)";
        ctx.beginPath(); ctx.moveTo(left, guideY); ctx.lineTo(width - right, guideY); ctx.stroke();
        ctx.fillStyle = "#8f8f8f";
        ctx.textAlign = "right";
        ctx.fillText(yFormat.format(value / 100), left - 8, guideY);
      }

      const tickCount = width < 520 ? 3 : 5;
      ctx.textBaseline = "top";
      for (let index = 0; index < tickCount; index += 1) {
        const ratioAlong = index / Math.max(1, tickCount - 1);
        const tickX = left + ratioAlong * plotWidth;
        const tickTime = firstTime + ratioAlong * timeRange;
        ctx.strokeStyle = "rgba(180,180,180,.10)";
        ctx.beginPath(); ctx.moveTo(tickX, top); ctx.lineTo(tickX, top + plotHeight); ctx.stroke();
        ctx.fillStyle = "#8f8f8f";
        ctx.textAlign = index === 0 ? "left" : index === tickCount - 1 ? "right" : "center";
        ctx.fillText(timeFormat.format(new Date(tickTime)).replace(".", ""), tickX, height - bottom + 9);
      }

      const baselineY = y(values[0]);
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = "rgba(255,159,28,.32)";
      ctx.beginPath(); ctx.moveTo(left, baselineY); ctx.lineTo(width - right, baselineY); ctx.stroke();
      ctx.setLineDash([]);

      const sourceSegments = splitTimeSeriesAtGaps(source);
      const coordsFor = (segment: typeof source) => segment.map((point) => {
        const index = source.indexOf(point);
        return { x: x(times[index], index), y: y(point.equity_cents) };
      });
      const gradient = ctx.createLinearGradient(0, top, 0, top + plotHeight);
      gradient.addColorStop(0, "rgba(22,139,255,.28)");
      gradient.addColorStop(1, "rgba(22,139,255,.015)");
      for (const segment of sourceSegments) {
        const coords = coordsFor(segment);
        ctx.beginPath();
        ctx.moveTo(coords[0].x, top + plotHeight);
        coords.forEach((point) => ctx.lineTo(point.x, point.y));
        ctx.lineTo(coords.at(-1)!.x, top + plotHeight);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
        ctx.beginPath();
        coords.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
        ctx.strokeStyle = "#f2f2f2";
        ctx.lineWidth = 1.7;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
      }
      for (let index = 1; index < sourceSegments.length; index += 1) {
        const previous = sourceSegments[index - 1].at(-1)!;
        const next = sourceSegments[index][0];
        const previousIndex = source.indexOf(previous);
        const nextIndex = source.indexOf(next);
        const gapStart = x(times[previousIndex], previousIndex);
        const gapEnd = x(times[nextIndex], nextIndex);
        ctx.fillStyle = "rgba(255,75,92,.05)";
        ctx.fillRect(gapStart, top, Math.max(1, gapEnd - gapStart), plotHeight);
        if (gapEnd - gapStart > 70) {
          ctx.fillStyle = "#8f8f8f";
          ctx.font = "8px Menlo, monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText("SEM DADOS", (gapStart + gapEnd) / 2, top + 8);
        }
      }
      const lastSegment = sourceSegments.at(-1)!;
      const last = coordsFor(lastSegment).at(-1)!;
      ctx.beginPath(); ctx.arc(last.x, last.y, 5, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,159,28,.24)"; ctx.fill();
      ctx.beginPath(); ctx.arc(last.x, last.y, 2.5, 0, Math.PI * 2); ctx.fillStyle = "#ff9f1c"; ctx.fill();
      ctx.fillStyle = "#8f8f8f";
      ctx.font = "8px Menlo, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("PATRIMÔNIO · USD", left, 3);
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [points]);
  const first = points[0];
  const last = points.at(-1);
  return <canvas ref={ref} className="equity-canvas" aria-label={`Curva histórica do patrimônio${first && last ? ` de ${compactDate(first.created_at)} até ${compactDate(last.created_at)}` : ""}`} />;
}

function MetricCard({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "positive" | "negative" | "neutral" }) {
  return <article className="metric-card"><div className="metric-label">{label}</div><div className={`metric-value ${tone}`}>{value}</div><div className="metric-detail">{detail}</div></article>;
}

export default function Home() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [analytics, setAnalytics] = useState<PortfolioAnalytics | null>(null);
  const [intelligence, setIntelligence] = useState<MarketIntelligence | null>(null);
  const [intelligenceLoading, setIntelligenceLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [terminalTarget, setTerminalTarget] = useState<TerminalTarget>("overview");
  const [intent, setIntent] = useState<OrderIntent>(defaultIntent);
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [chat, setChat] = useState("");
  const [ollamaModel, setOllamaModel] = useState("qwen3.5:9b");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [chatStage, setChatStage] = useState<ChatStage>(null);
  const [voiceStage, setVoiceStage] = useState<VoiceStage>(null);
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  const [interpreterResult, setInterpreterResult] = useState<InterpreterResult | null>(null);
  const [ticketMode, setTicketMode] = useState<"chat" | "manual">("chat");
  const [symbolResolution, setSymbolResolution] = useState<SymbolResolution | null>(null);
  const [assetSuggestions, setAssetSuggestions] = useState<AssetSuggestion[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [positionDetail, setPositionDetail] = useState<PositionDetail | null>(null);
  const [positionDetailLoading, setPositionDetailLoading] = useState(false);
  const [positionDetailError, setPositionDetailError] = useState<string | null>(null);
  const [manualSymbol, setManualSymbol] = useState("AAPL");
  const [manualPrice, setManualPrice] = useState("");
  const [corp, setCorp] = useState({ symbol: "AAPL", actionType: "DIVIDEND" as "DIVIDEND" | "SPLIT", value: "0.25", effectiveDate: new Date().toISOString().slice(0, 10) });
  const autoSymbols = useRef<string[]>([]);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const voiceChunks = useRef<Blob[]>([]);
  const voiceCancelled = useRef(false);
  const voiceTimer = useRef<number | null>(null);
  const voiceLimit = useRef<number | null>(null);

  const loadAnalytics = useCallback(async () => {
    try {
      const body = await api<{ analytics: PortfolioAnalytics }>("/api/analytics");
      setAnalytics(body.analytics);
    } catch {
      setAnalytics(null);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const body = await api<{ state: DashboardState }>("/api/state");
      setState(body.state);
      void loadAnalytics();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Falha ao carregar" });
    }
  }, [loadAnalytics]);

  const loadIntelligence = useCallback(async () => {
    setIntelligenceLoading(true);
    try {
      const body = await api<{ intelligence: MarketIntelligence }>("/api/intelligence");
      setIntelligence(body.intelligence);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Falha ao carregar notícias" });
    } finally {
      setIntelligenceLoading(false);
    }
  }, []);

  const navigateTerminal = useCallback((target: TerminalTarget) => {
    setTerminalTarget(target);
    if (target === "portfolio") {
      setTab("overview");
      window.setTimeout(() => document.getElementById("portfolio-monitor")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
      return;
    }
    setTab(target);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  const dashboardReady = state !== null;

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const command = document.getElementById("chat-command") as HTMLTextAreaElement | null;
    if (command) command.placeholder = "Compre US$ 1.000 de Netflix a mercado, stop de 5% e alvo de 12%.";
  }, [ticketMode, dashboardReady]);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const functionKey = /^F[1-4]$/.test(event.key);
      const optionNumber = event.altKey && /^Digit[1-4]$/.test(event.code);
      if (!functionKey && !optionNumber) return;
      const element = event.target as HTMLElement | null;
      const editable = element?.matches("input, textarea, select, [contenteditable='true']");
      if (editable && !functionKey) return;
      const number = functionKey ? Number(event.key.slice(1)) : Number(event.code.slice(-1));
      const targets: TerminalTarget[] = ["overview", "portfolio", "orders", "news"];
      const target = targets[number - 1];
      if (!target) return;
      event.preventDefault();
      navigateTerminal(target);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [navigateTerminal]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (tab !== "news" && tab !== "overview") return;
    const initial = window.setTimeout(() => { void loadIntelligence(); }, 0);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void loadIntelligence(); }, 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [tab, loadIntelligence]);
  useEffect(() => {
    autoSymbols.current = [...new Set([
      ...state?.positions.map((position) => position.symbol) ?? [],
      ...state?.openOrders.map((order) => order.symbol) ?? [],
    ])];
  }, [state]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || autoSymbols.current.length === 0) return;
      void api<{ state: DashboardState }>("/api/market", {
        method: "POST",
        body: JSON.stringify({ symbols: autoSymbols.current }),
      }).then((body) => { setState(body.state); void loadAnalytics(); }).catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadAnalytics]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => () => {
    voiceCancelled.current = true;
    if (mediaRecorder.current?.state !== "inactive") mediaRecorder.current?.stop();
    mediaStream.current?.getTracks().forEach((track) => track.stop());
    if (voiceTimer.current !== null) window.clearInterval(voiceTimer.current);
    if (voiceLimit.current !== null) window.clearTimeout(voiceLimit.current);
  }, []);

  const pnlTotal = (state?.account.realizedPnlCents ?? 0) + (state?.account.unrealizedPnlCents ?? 0);
  const allocationBackground = useMemo(() => {
    if (!state?.positions.length) return "conic-gradient(#343434 0 100%)";
    let start = 0;
    const segments = state.positions.map((position, index) => {
      const end = Math.min(100, start + position.allocationPct);
      const segment = `${colors[index % colors.length]} ${start}% ${end}%`;
      start = end;
      return segment;
    });
    if (start < 100) segments.push(`#343434 ${start}% 100%`);
    return `conic-gradient(${segments.join(",")})`;
  }, [state]);

  function releaseVoiceCapture() {
    mediaStream.current?.getTracks().forEach((track) => track.stop());
    mediaStream.current = null;
    mediaRecorder.current = null;
    if (voiceTimer.current !== null) window.clearInterval(voiceTimer.current);
    if (voiceLimit.current !== null) window.clearTimeout(voiceLimit.current);
    voiceTimer.current = null;
    voiceLimit.current = null;
  }

  async function transcribeVoice(recording: Blob) {
    setVoiceStage("TRANSCRIBING");
    try {
      const wav = await recordedAudioToWav(recording);
      const form = new FormData();
      form.append("file", wav, "brokai-voice.wav");
      const response = await fetch("/api/transcribe", { method: "POST", body: form });
      const body = await response.json() as { text?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Não foi possível transcrever o áudio");
      const text = body.text?.trim();
      if (!text) throw new Error("Não identifiquei fala na gravação. Tente novamente mais perto do microfone.");
      setChat(text);
      setSymbolResolution(null);
      setAssetSuggestions([]);
      setInterpreterResult(null);
      setPreview(null);
      setNotice({ kind: "success", text: "Transcrição pronta. Revise o pedido e gere o preview." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Falha na transcrição local" });
    } finally {
      setVoiceStage(null);
      setVoiceSeconds(0);
    }
  }

  function stopVoiceCapture(cancel = false) {
    voiceCancelled.current = cancel;
    const recorder = mediaRecorder.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else {
      releaseVoiceCapture();
      setVoiceStage(null);
      setVoiceSeconds(0);
    }
  }

  async function startVoiceCapture() {
    if (busy || chatStage || voiceStage) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setNotice({ kind: "error", text: "Este navegador não oferece gravação de áudio. Use uma versão atual do Chrome, Safari ou Edge." });
      return;
    }
    try {
      setNotice(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const supportedType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, supportedType ? { mimeType: supportedType } : undefined);
      mediaStream.current = stream;
      mediaRecorder.current = recorder;
      voiceChunks.current = [];
      voiceCancelled.current = false;
      recorder.ondataavailable = (event) => { if (event.data.size) voiceChunks.current.push(event.data); };
      recorder.onerror = () => {
        voiceCancelled.current = true;
        setNotice({ kind: "error", text: "A gravação foi interrompida pelo navegador." });
      };
      recorder.onstop = () => {
        const chunks = [...voiceChunks.current];
        const cancelled = voiceCancelled.current;
        const mimeType = recorder.mimeType || supportedType || "audio/webm";
        releaseVoiceCapture();
        if (cancelled) {
          setVoiceStage(null);
          setVoiceSeconds(0);
          return;
        }
        if (!chunks.length) {
          setVoiceStage(null);
          setNotice({ kind: "error", text: "Nenhum áudio foi capturado. Verifique a permissão do microfone." });
          return;
        }
        void transcribeVoice(new Blob(chunks, { type: mimeType }));
      };
      recorder.start(250);
      setVoiceSeconds(0);
      setVoiceStage("RECORDING");
      voiceTimer.current = window.setInterval(() => setVoiceSeconds((seconds) => seconds + 1), 1000);
      voiceLimit.current = window.setTimeout(() => stopVoiceCapture(false), 30_000);
    } catch (error) {
      releaseVoiceCapture();
      const denied = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
      setNotice({ kind: "error", text: denied ? "Permita o acesso ao microfone nas configurações do navegador e tente novamente." : "Não foi possível acessar o microfone do Mac." });
    }
  }

  async function draftOrder(orderIntent: OrderIntent, source = "MANUAL", originalText?: string) {
    setBusy(true);
    try {
      const body = await api<{ preview: OrderPreview }>("/api/drafts", { method: "POST", body: JSON.stringify({ intent: orderIntent, source, originalText }) });
      setPreview(body.preview);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Falha ao preparar a ordem" });
    } finally { setBusy(false); }
  }

  async function submitManual(event: FormEvent) {
    event.preventDefault();
    await draftOrder(intent);
  }

  async function submitChat(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setChatStage("OLLAMA");
    setInterpreterResult(null);
    setNotice(null);
    try {
      const parsed = await api<{ intent: OrderIntent; parser: "OLLAMA" | "RULES"; resolution: SymbolResolution | null; suggestions: AssetSuggestion[]; needsSelection: boolean; processing: { model: string; durationMs: number; ollamaAttempts: number; repairedFields: string[] }; warning?: string }>("/api/chat", { method: "POST", body: JSON.stringify({ message: chat, model: ollamaModel }) });
      setIntent(parsed.intent);
      setSymbolResolution(parsed.resolution);
      setAssetSuggestions(parsed.suggestions);
      setInterpreterResult({ parser: parsed.parser, model: parsed.processing.model, durationMs: parsed.processing.durationMs, attempts: parsed.processing.ollamaAttempts, repairedFields: parsed.processing.repairedFields });
      if (parsed.warning) setNotice({ kind: "info", text: parsed.warning });
      if (parsed.needsSelection) {
        setNotice({ kind: "info", text: "Não encontrei um instrumento direto. Escolha uma alternativa do Yahoo antes de gerar o preview — isto não é recomendação." });
        return;
      }
      setChatStage("PREVIEW");
      const body = await api<{ preview: OrderPreview }>("/api/drafts", { method: "POST", body: JSON.stringify({ intent: parsed.intent, source: parsed.parser, originalText: chat }) });
      setPreview(body.preview);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Não consegui interpretar" });
    } finally { setChatStage(null); setBusy(false); }
  }

  async function chooseAsset(suggestion: AssetSuggestion) {
    const selectedIntent = { ...intent, symbol: suggestion.symbol };
    setIntent(selectedIntent);
    setSymbolResolution(suggestion);
    setAssetSuggestions([]);
    await draftOrder(selectedIntent, "YAHOO_SUGGESTION", chat);
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    try {
      const body = await api<{ state: DashboardState }>("/api/drafts/confirm", { method: "POST", body: JSON.stringify({ draftId: preview.draftId }) });
      setState(body.state); void loadAnalytics(); setPreview(null); setNotice({ kind: "success", text: "Ordem confirmada e registrada no paper broker." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Falha ao confirmar" });
    } finally { setBusy(false); }
  }

  async function syncMarket(manual?: Record<string, number>) {
    setBusy(true);
    try {
      const symbols = [...new Set([...(state?.positions.map((p) => p.symbol) ?? []), ...(state?.openOrders.map((o) => o.symbol) ?? []), intent.symbol].filter(Boolean))];
      const body = await api<{ state: DashboardState; filled: number; errors: string[] }>("/api/market", { method: "POST", body: JSON.stringify({ symbols, manualQuotes: manual }) });
      setState(body.state);
      void loadAnalytics();
      const message = body.filled ? `${body.filled} ordem(ns) executada(s).` : "Cotações atualizadas; nenhuma ordem atingiu o gatilho.";
      setNotice({ kind: body.errors.length ? "info" : "success", text: body.errors.length ? `${message} ${body.errors.join(" · ")}` : message });
    } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : "Falha na atualização" }); }
    finally { setBusy(false); }
  }

  async function cancel(orderId: string) {
    setBusy(true);
    try {
      const body = await api<{ state: DashboardState }>("/api/orders/cancel", { method: "POST", body: JSON.stringify({ orderId }) });
      setState(body.state); void loadAnalytics(); setNotice({ kind: "success", text: "Ordem cancelada." });
    } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : "Falha ao cancelar" }); }
    finally { setBusy(false); }
  }

  async function applyCorp(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const body = await api<{ state: DashboardState }>("/api/corporate-actions", { method: "POST", body: JSON.stringify(corp) });
      setState(body.state); void loadAnalytics(); setNotice({ kind: "success", text: "Evento corporativo aplicado e auditado." });
    } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : "Falha no evento" }); }
    finally { setBusy(false); }
  }

  function reducePosition(symbol: string, pct: number) {
    void draftOrder({ action: "REDUCE", symbol, sizingType: "POSITION_PCT", sizingValue: String(pct), orderType: "MARKET", triggerPrice: null, stopLossPct: null, takeProfitPct: null, note: `Redução rápida de ${pct}%` }, "QUICK_ACTION");
  }

  const closePositionDetail = useCallback(() => {
    setSelectedSymbol(null);
    setPositionDetail(null);
    setPositionDetailError(null);
  }, []);

  async function openPositionDetail(symbol: string) {
    setSelectedSymbol(symbol);
    setPositionDetail(null);
    setPositionDetailError(null);
    setPositionDetailLoading(true);
    try {
      const body = await api<{ detail: PositionDetail }>(`/api/position-detail?symbol=${encodeURIComponent(symbol)}`);
      setPositionDetail(body.detail);
    } catch (error) {
      setPositionDetailError(error instanceof Error ? error.message : "Falha ao carregar a posição");
    } finally {
      setPositionDetailLoading(false);
    }
  }

  function reduceFromDetail(symbol: string, pct: number) {
    closePositionDetail();
    reducePosition(symbol, pct);
  }

  function closeFromDetail(symbol: string) {
    closePositionDetail();
    void draftOrder({ action: "CLOSE", symbol, sizingType: "POSITION_PCT", sizingValue: "100", orderType: "MARKET", triggerPrice: null, stopLossPct: null, takeProfitPct: null, note: "Fechamento solicitado no detalhe da posição" }, "POSITION_DETAIL");
  }

  if (!state) return <main className="boot-screen"><div className="boot-mark">B</div><p>Preparando sua conta paper…</p></main>;
  const hasCrypto = state.positions.some((position) => position.assetClass === "CRYPTOCURRENCY");
  const onlyCrypto = state.positions.length > 0 && state.positions.every((position) => position.assetClass === "CRYPTOCURRENCY");
  const marketLabel = onlyCrypto ? "Mercado 24/7" : hasCrypto ? "Sessões mistas" : state.market.label;
  const marketTitle = onlyCrypto ? "Criptoativos negociam continuamente" : hasCrypto ? "A carteira contém ativos com calendários diferentes" : `${state.market.reason} · ${state.market.newYorkTime}`;
  const marketOpen = onlyCrypto || hasCrypto || state.market.isOpen;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand" aria-label="Brok.ai"><div className="brand-mark" aria-hidden="true">B</div><div className="brand-wordmark"><strong>Brok<span>.ai</span></strong><small>Broker // Intelligence</small></div></div>
      <nav aria-label="Navegação principal">
        {([['overview', 'Visão geral', '⌁'], ['performance', 'Performance', '⌁'], ['risk', 'Risco', '◇'], ['orders', 'Ordens', '⇄'], ['activity', 'Execução', '◴'], ['news', 'Notícias', '▤'], ['settings', 'Configurações', '⚙']] as const).map(([key, label, icon]) => <button key={key} className={tab === key ? "nav-item active" : "nav-item"} onClick={() => { if (key === "overview") setTerminalTarget("overview"); setTab(key); }}><span>{icon}</span>{label}{key === 'orders' && state.openOrders.length > 0 ? <em>{state.openOrders.length}</em> : key === 'risk' && analytics?.alerts.length ? <em>{analytics.alerts.length}</em> : null}</button>)}
      </nav>
      <div className="mode-card"><div className="mode-row"><span className="status-dot" />Paper mode</div><p>Nenhuma ordem real pode sair daqui. Gatilhos são atualizados enquanto o painel está aberto.</p></div>
      <div className="sidebar-footer"><span>Conta</span><strong>Paper USD</strong><small>Dados locais · SQLite</small></div>
    </aside>

    <main className="workspace">
      <nav className="terminal-strip" aria-label="Atalhos do terminal"><button type="button" className="terminal-strip-brand" onClick={() => navigateTerminal("overview")} aria-label="Voltar à visão geral">BROK.AI</button>{([['overview', 'F1', 'VISÃO GERAL', '⌥1'], ['portfolio', 'F2', 'PORTFÓLIO', '⌥2'], ['orders', 'F3', 'ORDENS', '⌥3'], ['news', 'F4', 'NOTÍCIAS', '⌥4']] as const).map(([target, key, label, macKey]) => { const active = target === "portfolio" ? tab === "overview" && terminalTarget === "portfolio" : target === "overview" ? tab === "overview" && terminalTarget !== "portfolio" : tab === target; return <button type="button" key={target} className={`terminal-shortcut ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} title={`${label} — ${key} ou ${macKey}`} onClick={() => navigateTerminal(target)}><b>{key}</b> {label}<kbd>{macKey}</kbd></button>; })}<em>LOCAL // USD</em></nav>
      <header className="topbar"><div><p className="eyebrow">CARTEIRA SIMULADA</p><h1>{tab === 'overview' ? 'Visão geral' : tab === 'performance' ? 'Performance e benchmark' : tab === 'risk' ? 'Risco e alertas' : tab === 'orders' ? 'Ordens e posições' : tab === 'activity' ? 'Execução e auditoria' : tab === 'news' ? 'Notícias e calendário' : 'Configurações locais'}</h1></div><div className="top-actions"><div className={`market-clock ${marketOpen ? 'open' : ''}`} title={marketTitle}><span className="status-dot" />{marketLabel}</div><div className="quote-status"><span>Última cotação</span><strong>{compactDate(state.lastQuoteAt)}</strong></div><button className="ghost-button" disabled={busy} onClick={() => void syncMarket()}><span className={busy ? "spin" : ""}>↻</span> Atualizar</button><button className="primary-button" onClick={() => { setTab('overview'); document.getElementById('order-ticket')?.scrollIntoView({ behavior: 'smooth' }); }}>+ Nova ordem</button></div></header>

      <div className="content-layout">
        <section className="content-main">
          {tab === "overview" && <>
            <div className="metrics-grid">
              <MetricCard label="Patrimônio" value={money(state.account.equityCents)} detail={`${state.snapshots.length} snapshots locais`} />
              <MetricCard label="Caixa disponível" value={money(state.account.availableCashCents)} detail={`${money(state.account.cashCents - state.account.availableCashCents)} reservado`} />
              <MetricCard label="P&L total" value={money(pnlTotal)} detail={`${money(state.account.realizedPnlCents)} realizado`} tone={pnlTotal >= 0 ? "positive" : "negative"} />
              <MetricCard label="Exposição" value={`${state.account.exposurePct.toFixed(1)}%`} detail={`${money(state.account.marketValueCents)} investidos`} />
            </div>
            {analytics ? <div className="decision-strip"><button onClick={() => setTab('performance')}><span>Excesso vs {analytics.benchmark}</span><strong className={(analytics.performance.excessReturnPct ?? 0) >= 0 ? 'positive' : 'negative'}>{percent(analytics.performance.excessReturnPct)}</strong></button><button onClick={() => setTab('performance')}><span>Drawdown atual</span><strong className={analytics.performance.currentDrawdownPct < 0 ? 'negative' : ''}>{percent(analytics.performance.currentDrawdownPct)}</strong></button><button onClick={() => setTab('risk')}><span>Risco nos stops</span><strong>{money(analytics.risk.lossAtStopsCents)}</strong></button><button onClick={() => setTab('risk')}><span>Alertas ativos</span><strong className={analytics.alerts.some((alert) => alert.severity === 'HIGH') ? 'negative' : ''}>{analytics.alerts.length}</strong></button><div><span>Saúde dos dados</span><strong className={analytics.health.yahoo === 'OK' && analytics.health.staleQuotes === 0 ? 'positive' : 'negative'}>{analytics.health.yahoo === 'OK' && analytics.health.staleQuotes === 0 ? 'Normal' : 'Atenção'}</strong></div></div> : null}
            <div className="visual-grid">
              <article className="panel equity-panel"><div className="panel-head"><div><p className="panel-kicker">PERFORMANCE</p><h2>Curva de patrimônio</h2></div><span className="period-chip">Desde o início</span></div><div className="chart-summary"><strong>{money(state.account.equityCents)}</strong><span className={pnlTotal >= 0 ? "positive" : "negative"}>{pnlTotal >= 0 ? '+' : ''}{money(pnlTotal)}</span></div><EquityChart points={state.snapshots} /></article>
              <article className="panel allocation-panel"><div className="panel-head"><div><p className="panel-kicker">RISCO</p><h2>Alocação</h2></div></div><div className="allocation-body"><div className="donut" style={{ background: allocationBackground }}><div><strong>{state.account.exposurePct.toFixed(0)}%</strong><span>exposto</span></div></div><div className="legend">{state.positions.slice(0, 5).map((position, index) => <div key={position.symbol}><span className="legend-dot" style={{ background: colors[index % colors.length] }} /><strong>{position.symbol}</strong><em>{position.allocationPct.toFixed(1)}%</em></div>)}{!state.positions.length ? <p>Sem posições abertas</p> : null}</div></div></article>
            </div>
            <PositionsTable state={state} analytics={analytics} activeTab={tab} onNavigate={setTab} onReduce={reducePosition} onOpen={openPositionDetail} />
            {state.openOrders.length > 0 ? <OrdersTable orders={state.openOrders} onCancel={cancel} compact /> : null}
            <MarketIntelligencePreview intelligence={intelligence} loading={intelligenceLoading} onOpen={() => setTab('news')} />
          </>}

          {tab === "performance" && <PerformanceView state={state} analytics={analytics} />}
          {tab === "risk" && <RiskView state={state} analytics={analytics} />}
          {tab === "orders" && <><PositionsTable state={state} analytics={analytics} activeTab={tab} onNavigate={setTab} onReduce={reducePosition} onOpen={openPositionDetail} /><OrdersTable orders={state.openOrders} onCancel={cancel} /><RecentOrders state={state} /></>}
          {tab === "activity" && <ActivityView state={state} analytics={analytics} />}
          {tab === "news" && <NewsView state={state} intelligence={intelligence} loading={intelligenceLoading} onRefresh={loadIntelligence} onNavigate={setTab} />}
          {tab === "settings" && <section className="settings-grid">
            <article className="panel settings-card"><div className="panel-head"><div><p className="panel-kicker">MARKET DATA</p><h2>Cotação manual</h2></div></div><p>Use esta opção quando o Yahoo estiver indisponível ou para testar gatilhos offline.</p><div className="inline-fields"><label>Ticker<input value={manualSymbol} onChange={(e) => setManualSymbol(e.target.value.toUpperCase())} /></label><label>Preço USD<input inputMode="decimal" value={manualPrice} onChange={(e) => setManualPrice(e.target.value)} placeholder="190.50" /></label><button className="primary-button" disabled={!manualSymbol || !Number(manualPrice) || busy} onClick={() => void syncMarket({ [manualSymbol]: Number(manualPrice.replace(',', '.')) })}>Salvar e processar</button></div></article>
            <article className="panel settings-card"><div className="panel-head"><div><p className="panel-kicker">LLM LOCAL</p><h2>Ollama</h2></div><span className="local-chip">127.0.0.1</span></div><p>O modelo apenas converte texto em JSON. Se estiver desligado, o parser determinístico assume.</p><label>Modelo<input value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} /></label><small>Endpoint fixo: http://127.0.0.1:11434</small></article>
            <article className="panel settings-card wide"><div className="panel-head"><div><p className="panel-kicker">CORPORATE ACTIONS</p><h2>Dividendos e splits</h2></div></div><form className="corp-form" onSubmit={applyCorp}><label>Ticker<input required value={corp.symbol} onChange={(e) => setCorp({ ...corp, symbol: e.target.value.toUpperCase() })} /></label><label>Evento<select value={corp.actionType} onChange={(e) => setCorp({ ...corp, actionType: e.target.value as 'DIVIDEND' | 'SPLIT' })}><option value="DIVIDEND">Dividendo por ação</option><option value="SPLIT">Split (proporção)</option></select></label><label>{corp.actionType === 'DIVIDEND' ? 'USD por ação' : 'Proporção nova/antiga'}<input required value={corp.value} onChange={(e) => setCorp({ ...corp, value: e.target.value })} /></label><label>Data efetiva<input type="date" required value={corp.effectiveDate} onChange={(e) => setCorp({ ...corp, effectiveDate: e.target.value })} /></label><button className="primary-button" disabled={busy}>Aplicar evento</button></form><div className="action-list">{state.corporateActions.map((action) => <div key={action.id}><strong>{action.symbol}</strong><span>{action.action_type}</span><span>{action.value_text}</span><time>{action.effective_date}</time></div>)}{!state.corporateActions.length ? <p>Nenhum evento aplicado.</p> : null}</div></article>
            <article className="panel settings-card wide adapter-card"><div><p className="panel-kicker">ADAPTER OPCIONAL</p><h2>Alpaca Paper</h2><p>A interface do provider já está preparada no código. As credenciais não são salvas nesta versão para manter o MVP sem chaves e sem risco de envio real.</p></div><span className="coming-soon">Desativado por segurança</span></article>
          </section>}
        </section>

        <aside className="ticket-panel" id="order-ticket"><div className="ticket-head"><div><p className="panel-kicker">ORDER TICKET</p><h2>Nova ordem</h2></div><span className="paper-pill">PAPER</span></div>
          {notice ? <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.kind === 'success' ? '✓' : notice.kind === 'error' ? '!' : 'i'}</span><p>{notice.text}</p><button type="button" aria-label="Fechar aviso" onClick={() => setNotice(null)}>×</button></div> : null}
          <div className="segmented"><button className={ticketMode === 'chat' ? 'active' : ''} onClick={() => setTicketMode('chat')}>⌁ Conversa</button><button className={ticketMode === 'manual' ? 'active' : ''} onClick={() => setTicketMode('manual')}>Manual</button></div>
          {ticketMode === 'chat' ? <form className="chat-ticket" onSubmit={submitChat}><label htmlFor="chat-command">O que você quer simular?</label><textarea id="chat-command" value={chat} disabled={chatStage !== null || voiceStage !== null} onChange={(e) => { setChat(e.target.value); setSymbolResolution(null); setAssetSuggestions([]); setInterpreterResult(null); }} rows={6} />{voiceStage ? <div className={`voice-status ${voiceStage.toLowerCase()}`} role="status" aria-live="polite"><span className="voice-level" aria-hidden="true"><i /><i /><i /><i /></span><div><strong>{voiceStage === 'RECORDING' ? `Ouvindo · ${voiceSeconds}s` : 'Transcrevendo localmente…'}</strong><small>{voiceStage === 'RECORDING' ? 'Fale o pedido e toque no microfone para concluir. Limite: 30s.' : 'Whisper está convertendo sua voz em texto editável.'}</small></div>{voiceStage === 'RECORDING' ? <button type="button" onClick={() => stopVoiceCapture(true)}>Cancelar</button> : null}</div> : null}{chatStage ? <div className="ai-work-status" role="status" aria-live="polite"><div className="ai-work-head"><span className="ai-pulse" aria-hidden="true"><i /><i /><i /></span><div><small>{chatStage === 'OLLAMA' ? `OLLAMA LOCAL · ${ollamaModel}` : 'MOTOR FINANCEIRO'}</small><strong>{chatStage === 'OLLAMA' ? 'Interpretando seu pedido' : 'Preparando o preview'}</strong><em>{chatStage === 'OLLAMA' ? 'Entendendo ativo, direção, tamanho e condições…' : 'Validando cotação, caixa e quantidade…'}</em></div></div><div className="ai-pipeline" aria-hidden="true"><span className="active">OLLAMA</span><span className={chatStage === 'PREVIEW' ? 'done' : ''}>BINANCE/YAHOO</span><span className={chatStage === 'PREVIEW' ? 'active' : ''}>PREVIEW</span></div></div> : interpreterResult ? <div className={`interpreter-result ${interpreterResult.parser === 'OLLAMA' ? 'ollama' : 'fallback'}`} role="status"><span>{interpreterResult.parser === 'OLLAMA' ? 'AI' : 'RF'}</span><div><small>{interpreterResult.parser === 'OLLAMA' ? 'INTERPRETADO PELO OLLAMA' : 'FALLBACK LOCAL UTILIZADO'}</small><strong>{interpreterResult.parser === 'OLLAMA' ? interpreterResult.model : 'Parser determinístico'}</strong><em>{(interpreterResult.durationMs / 1000).toFixed(1)}s · {interpreterResult.attempts} {interpreterResult.attempts === 1 ? 'tentativa' : 'tentativas'}</em></div></div> : null}{symbolResolution ? <div className="symbol-resolution" role="status"><span>{symbolResolution.source === 'BINANCE_SPOT' ? 'BN' : 'YF'}</span><div><small>ATIVO RESOLVIDO · {symbolResolution.assetClass}</small><strong>{symbolResolution.name} → {symbolResolution.symbol}</strong><em>{symbolResolution.exchange} · {symbolResolution.source === 'BINANCE_SPOT' ? 'Binance Spot' : symbolResolution.source === 'YAHOO_SEARCH' ? 'Yahoo Finance' : 'fallback local'}</em></div></div> : null}{assetSuggestions.length ? <div className="asset-suggestions" role="region" aria-label="Alternativas relacionadas"><div><strong>Alternativas encontradas</strong><small>Escolha um instrumento para continuar. Não é recomendação.</small></div>{assetSuggestions.map((suggestion) => <button type="button" key={suggestion.symbol} onClick={() => void chooseAsset(suggestion)} disabled={busy}><span><b>{suggestion.symbol}</b><em>{suggestion.assetClass} · {suggestion.exchange}</em></span><small>{suggestion.name}</small><i>USAR</i></button>)}</div> : null}<div className="example-chips"><button type="button" onClick={() => { setChat('Compre ações da Apple a mercado'); setSymbolResolution(null); setAssetSuggestions([]); setInterpreterResult(null); }}>Apple → ticker</button><button type="button" onClick={() => { setChat('Compre US$ 1.000 de Bitcoin a mercado'); setSymbolResolution(null); setAssetSuggestions([]); setInterpreterResult(null); }}>Bitcoin</button><button type="button" onClick={() => { setChat('Invista US$ 1.000 em urânio a mercado'); setSymbolResolution(null); setAssetSuggestions([]); setInterpreterResult(null); }}>Tema → alternativas</button></div><div className="ticket-actions"><button className="ticket-submit" disabled={busy || voiceStage !== null || !chat.trim()}>{chatStage === 'OLLAMA' ? 'OLLAMA ANALISANDO…' : chatStage === 'PREVIEW' ? 'VALIDANDO PREVIEW…' : voiceStage === 'TRANSCRIBING' ? 'TRANSCREVENDO…' : 'GERAR PREVIEW'}<span>{chatStage || voiceStage ? '···' : 'GO'}</span></button><button type="button" className={`voice-submit ${voiceStage === 'RECORDING' ? 'recording' : ''}`} onClick={() => voiceStage === 'RECORDING' ? stopVoiceCapture(false) : void startVoiceCapture()} disabled={busy || chatStage !== null || voiceStage === 'TRANSCRIBING'} aria-pressed={voiceStage === 'RECORDING'} aria-label={voiceStage === 'RECORDING' ? 'Parar gravação' : 'Ditar nova ordem'} title={voiceStage === 'RECORDING' ? 'Parar e transcrever' : 'Ditar nova ordem'}><span className="mic-glyph" aria-hidden="true" /></button></div><p className="safety-note"><span>✓</span>Nada será executado antes da confirmação.</p></form> : <ManualTicket intent={intent} setIntent={setIntent} onSubmit={submitManual} busy={busy} />}
        </aside>
      </div>
    </main>

    {preview ? <PreviewDialog preview={preview} busy={busy} onClose={() => setPreview(null)} onConfirm={confirm} /> : null}
    {selectedSymbol ? <PositionDetailDrawer detail={positionDetail} loading={positionDetailLoading} error={positionDetailError} onClose={closePositionDetail} onReduce={reduceFromDetail} onClosePosition={closeFromDetail} /> : null}
  </div>;
}

function ManualTicket({ intent, setIntent, onSubmit, busy }: { intent: OrderIntent; setIntent: (intent: OrderIntent) => void; onSubmit: (event: FormEvent) => void; busy: boolean }) {
  return <form className="manual-ticket" onSubmit={onSubmit}><div className="side-switch"><button type="button" className={intent.action === 'BUY' ? 'buy active' : ''} onClick={() => setIntent({ ...intent, action: 'BUY', sizingType: intent.sizingType === 'POSITION_PCT' ? 'SHARES' : intent.sizingType })}>Comprar</button><button type="button" className={intent.action === 'SHORT' ? 'sell active' : ''} onClick={() => setIntent({ ...intent, action: 'SHORT', sizingType: intent.sizingType === 'POSITION_PCT' ? 'NOTIONAL' : intent.sizingType })}>Short</button><button type="button" className={['REDUCE', 'CLOSE'].includes(intent.action) ? 'sell active' : ''} onClick={() => setIntent({ ...intent, action: 'REDUCE', sizingType: 'POSITION_PCT', sizingValue: '50', stopLossPct: null, takeProfitPct: null })}>Reduzir</button></div><label>Ticker<input required value={intent.symbol} onChange={(e) => setIntent({ ...intent, symbol: e.target.value.toUpperCase() })} /></label><label>Tamanho<select value={intent.sizingType} onChange={(e) => setIntent({ ...intent, sizingType: e.target.value as OrderIntent['sizingType'] })}><option value="SHARES">Número de ações</option><option value="NOTIONAL">Valor em USD</option><option value="CASH_PCT">% do caixa</option><option value="POSITION_PCT">% da posição</option></select></label><label>{intent.sizingType === 'NOTIONAL' ? 'Valor USD' : intent.sizingType === 'SHARES' ? 'Ações' : 'Percentual'}<input required inputMode="decimal" value={intent.sizingValue} onChange={(e) => setIntent({ ...intent, sizingValue: e.target.value })} /></label><label>Tipo de ordem<select value={intent.orderType} onChange={(e) => setIntent({ ...intent, orderType: e.target.value as OrderIntent['orderType'] })}><option value="MARKET">Market</option><option value="LIMIT">Limit</option><option value="STOP">Stop</option></select></label>{intent.orderType !== 'MARKET' ? <label>Preço gatilho<input required inputMode="decimal" value={intent.triggerPrice ?? ''} onChange={(e) => setIntent({ ...intent, triggerPrice: e.target.value })} /></label> : null}{intent.action === 'BUY' || intent.action === 'SHORT' ? <div className="dual-fields"><label>Stop-loss %<input inputMode="decimal" value={intent.stopLossPct ?? ''} onChange={(e) => setIntent({ ...intent, stopLossPct: e.target.value })} /></label><label>Take profit %<input inputMode="decimal" value={intent.takeProfitPct ?? ''} onChange={(e) => setIntent({ ...intent, takeProfitPct: e.target.value })} /></label></div> : null}<button className="ticket-submit" disabled={busy}>{busy ? 'Calculando…' : 'Gerar preview'}<span>→</span></button></form>;
}

function PreviewDialog({ preview, busy, onClose, onConfirm }: { preview: OrderPreview; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const label = preview.action === 'SHORT' ? 'Abrir short' : preview.side === 'BUY' && (preview.action === 'REDUCE' || preview.action === 'CLOSE') ? 'Cobrir short' : preview.side === 'BUY' ? 'Comprar' : 'Vender';
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-title"><div className="preview-top"><div><p className="panel-kicker">CONFIRMAÇÃO OBRIGATÓRIA</p><h2 id="preview-title">Revise a ordem</h2></div><button className="modal-close" onClick={onClose} aria-label="Fechar">×</button></div><div className="order-hero"><div className={`asset-avatar ${preview.side.toLowerCase()}`}>{preview.symbol.slice(0, 2)}</div><div><strong>{label} {preview.symbol}</strong><span>{preview.orderType} · {preview.sizingLabel}</span></div><em className={preview.side === 'BUY' ? 'positive' : 'negative'}>{preview.action}</em></div><dl className="preview-grid"><div><dt>Quantidade</dt><dd>{shares(preview.quantityMicros)}</dd></div><div><dt>Notional estimado</dt><dd>{money(preview.estimatedNotionalCents)}</dd></div><div><dt>{preview.triggerPriceCents ? 'Preço gatilho' : 'Cotação de referência'}</dt><dd>{priceMoney(preview.triggerPriceCents ?? preview.referencePriceCents)}</dd></div><div><dt>Fonte / horário</dt><dd>{preview.quote.source} · {compactDate(preview.quote.observedAt)}</dd></div><div><dt>Stop-loss</dt><dd>{preview.stopLossPriceCents ? priceMoney(preview.stopLossPriceCents) : 'Sem stop'}</dd></div><div><dt>Take profit</dt><dd>{preview.takeProfitPriceCents ? priceMoney(preview.takeProfitPriceCents) : 'Sem alvo'}</dd></div><div><dt>Caixa antes</dt><dd>{money(preview.availableCashBeforeCents)}</dd></div><div><dt>Caixa estimado depois</dt><dd>{money(preview.availableCashAfterCents)}</dd></div></dl>{preview.warnings.length ? <div className="warning-box">{preview.warnings.map((warning) => <p key={warning}><span>!</span>{warning}</p>)}</div> : <div className="confirmation-note"><span>✓</span><p><strong>Validação concluída</strong>Caixa, posição e tamanho foram recalculados pelo motor determinístico.</p></div>}<div className="preview-actions"><button className="ghost-button" onClick={onClose} disabled={busy}>Voltar e editar</button><button className="confirm-button" onClick={onConfirm} disabled={busy}>{busy ? 'Confirmando…' : 'Confirmar ordem paper'}</button></div><p className="expiry">Preview válido até {compactDate(preview.expiresAt)}</p></section></div>;
}

function ComparisonChart({ points, benchmark }: { points: PortfolioAnalytics["performance"]["series"]; benchmark: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, rect.width * ratio);
    canvas.height = Math.max(1, rect.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(180,180,180,.13)";
    ctx.lineWidth = 1;
    for (let index = 1; index < 5; index += 1) {
      const y = height / 5 * index;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    const source = points.length > 1 ? points : [{ date: "start", portfolioPct: 0, benchmarkPct: 0 }, ...(points.length ? points : [{ date: "now", portfolioPct: 0, benchmarkPct: 0 }])];
    const values = source.flatMap((point) => [point.portfolioPct, ...(point.benchmarkPct === null ? [] : [point.benchmarkPct])]);
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const range = Math.max(1, max - min);
    const draw = (selector: (point: typeof source[number]) => number | null, color: string, dashed = false) => {
      ctx.beginPath();
      ctx.setLineDash(dashed ? [5, 4] : []);
      let started = false;
      source.forEach((point, index) => {
        const value = selector(point);
        if (value === null) return;
        const x = index / Math.max(1, source.length - 1) * width;
        const y = height - 20 - (value - min) / range * (height - 40);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.stroke(); ctx.setLineDash([]);
    };
    draw((point) => point.portfolioPct, "#ff9f1c");
    draw((point) => point.benchmarkPct, "#b0b0b0", true);
  }, [points]);
  return <div className="comparison-chart"><canvas ref={ref} aria-label={`Retorno acumulado da carteira comparado a ${benchmark}`} /><div><span><i className="portfolio-line" />Brok.ai</span><span><i className="benchmark-line" />{benchmark}</span></div></div>;
}

function AnalyticsLoading() {
  return <article className="panel analytics-loading"><span className="spin">↻</span><div><strong>Calculando analytics</strong><p>Carregando histórico do Yahoo e reconciliando com o ledger local.</p></div></article>;
}

function PerformanceView({ state, analytics }: { state: DashboardState; analytics: PortfolioAnalytics | null }) {
  if (!analytics) return <AnalyticsLoading />;
  const performance = analytics.performance;
  return <section className="analytics-view">
    <div className="metrics-grid analytics-metrics">
      <MetricCard label="Hoje" value={percent(performance.returnTodayPct)} detail="Retorno observado nos snapshots do dia" tone={(performance.returnTodayPct ?? 0) >= 0 ? 'positive' : 'negative'} />
      <MetricCard label="Desde o início" value={percent(performance.returnSinceStartPct)} detail={`${state.snapshots.length} snapshots`} tone={performance.returnSinceStartPct >= 0 ? 'positive' : 'negative'} />
      <MetricCard label={`Excesso sobre ${analytics.benchmark}`} value={percent(performance.excessReturnPct)} detail={`${analytics.benchmark} ${percent(performance.benchmarkSinceStartPct)}`} tone={(performance.excessReturnPct ?? 0) >= 0 ? 'positive' : 'negative'} />
      <MetricCard label="Max drawdown" value={percent(performance.maxDrawdownPct)} detail={`Atual ${percent(performance.currentDrawdownPct)}`} tone={performance.maxDrawdownPct < 0 ? 'negative' : 'neutral'} />
    </div>
    <article className="panel performance-chart-panel"><div className="panel-head"><div><p className="panel-kicker">BENCHMARK</p><h2>Retorno acumulado versus {analytics.benchmark}</h2></div><span className="period-chip">Desde o início</span></div><ComparisonChart points={performance.series} benchmark={analytics.benchmark} /></article>
    <div className="analytics-two-column">
      <article className="panel period-panel"><div className="panel-head"><div><p className="panel-kicker">JANELAS</p><h2>Retorno por período</h2></div></div><dl className="analytics-list"><div><dt>Hoje</dt><dd className={(performance.returnTodayPct ?? 0) >= 0 ? 'positive' : 'negative'}>{percent(performance.returnTodayPct)}</dd></div><div><dt>7 dias</dt><dd className={(performance.returnWeekPct ?? 0) >= 0 ? 'positive' : 'negative'}>{percent(performance.returnWeekPct)}</dd></div><div><dt>30 dias</dt><dd className={(performance.returnMonthPct ?? 0) >= 0 ? 'positive' : 'negative'}>{percent(performance.returnMonthPct)}</dd></div><div><dt>Desde o início</dt><dd className={performance.returnSinceStartPct >= 0 ? 'positive' : 'negative'}>{percent(performance.returnSinceStartPct)}</dd></div></dl></article>
      <article className="panel methodology-panel"><div className="panel-head"><div><p className="panel-kicker">QUALIDADE</p><h2>Confiabilidade das métricas</h2></div><span className={`health-pill ${analytics.health.historyPoints >= 20 ? 'ok' : ''}`}>{analytics.health.historyPoints} pontos</span></div><p>{analytics.health.note}</p><ul><li>Retornos usam apenas snapshots efetivamente registrados.</li><li>Benchmark usa fechamentos diários do SPY.</li><li>Períodos sem histórico suficiente aparecem explicitamente como indisponíveis.</li></ul></article>
    </div>
  </section>;
}

function RiskView({ state, analytics }: { state: DashboardState; analytics: PortfolioAnalytics | null }) {
  if (!analytics) return <AnalyticsLoading />;
  const risk = analytics.risk;
  return <section className="analytics-view">
    <div className="metrics-grid analytics-metrics">
      <MetricCard label="Perda até os stops" value={money(risk.lossAtStopsCents)} detail={`${risk.protectedPositions} posições protegidas`} tone={risk.lossAtStopsCents > 0 ? 'negative' : 'neutral'} />
      <MetricCard label="Valor sem proteção" value={money(risk.unprotectedValueCents)} detail={`${risk.unprotectedPositions} posições sem stop`} tone={risk.unprotectedPositions ? 'negative' : 'neutral'} />
      <MetricCard label="Maior posição" value={`${risk.largestPositionPct.toFixed(1)}%`} detail={`Top 5: ${risk.topFiveConcentrationPct.toFixed(1)}%`} tone={risk.largestPositionPct >= 25 ? 'negative' : 'neutral'} />
      <MetricCard label="Volatilidade anual" value={risk.annualizedVolatilityPct === null ? 'Dados insuficientes' : `${risk.annualizedVolatilityPct.toFixed(1)}%`} detail={`Beta SPY: ${risk.betaVsSpy === null ? '—' : risk.betaVsSpy.toFixed(2)}`} />
    </div>
    <div className="analytics-two-column risk-top-grid">
      <article className="panel alerts-panel"><div className="panel-head"><div><p className="panel-kicker">GUARDRAILS</p><h2>Alertas ativos</h2></div><span className="count-chip">{analytics.alerts.length}</span></div><div className="alerts-list">{analytics.alerts.map((alert, index) => <div className={`alert-row ${alert.severity.toLowerCase()}`} key={`${alert.title}-${index}`}><span>{alert.severity === 'HIGH' ? '!' : alert.severity === 'MEDIUM' ? '•' : 'i'}</span><p><strong>{alert.title}</strong><small>{alert.detail}</small></p></div>)}{!analytics.alerts.length ? <div className="all-clear"><span>✓</span><p><strong>Nenhum alerta material</strong><small>Stops, concentração e cotações estão dentro dos limites.</small></p></div> : null}</div></article>
      <article className="panel scenario-panel"><div className="panel-head"><div><p className="panel-kicker">STRESS TEST</p><h2>Cenários lineares</h2></div></div><div className="scenario-list">{risk.scenarios.map((scenario) => <div key={scenario.shockPct}><strong>{scenario.shockPct}% mercado</strong><span className="negative">{money(scenario.estimatedPnlCents)}</span><em>{money(scenario.estimatedEquityCents)} patrimônio</em></div>)}</div><p className="panel-note">Estimativa simples aplicada somente ao valor investido; não modela correlação, gaps ou liquidez.</p></article>
    </div>
    <article className="panel table-panel"><div className="panel-head"><div><p className="panel-kicker">RISCO POR POSIÇÃO</p><h2>Stops, alvos e capital em risco</h2></div></div><div className="table-wrap"><table><thead><tr><th>Ativo</th><th>Stop</th><th>Distância stop</th><th>Alvo</th><th>Distância alvo</th><th>Capital em risco</th><th>Idade da cotação</th></tr></thead><tbody>{analytics.positions.map((position) => <tr key={position.symbol}><td><strong>{position.symbol}</strong></td><td className={position.stopPriceCents ? '' : 'negative'}>{position.stopPriceCents ? money(position.stopPriceCents) : 'Sem stop'}</td><td>{position.stopDistancePct === null ? '—' : percent(position.stopDistancePct)}</td><td>{position.targetPriceCents ? money(position.targetPriceCents) : 'Sem alvo'}</td><td>{position.targetDistancePct === null ? '—' : percent(position.targetDistancePct)}</td><td>{position.capitalAtRiskCents === null ? 'Não limitado' : money(position.capitalAtRiskCents)}</td><td>{position.quoteAgeMinutes === null ? '—' : `${position.quoteAgeMinutes.toFixed(0)} min`}</td></tr>)}{!analytics.positions.length ? <tr><td colSpan={7} className="empty-state"><strong>Sem posições para analisar</strong><span>As métricas aparecerão depois do primeiro fill.</span></td></tr> : null}</tbody></table></div></article>
    <div className="analytics-two-column">
      <article className="panel correlations-panel"><div className="panel-head"><div><p className="panel-kicker">CORRELAÇÃO 60D</p><h2>Pares concentrados</h2></div></div><div className="correlation-list">{risk.highCorrelationPairs.map((pair) => <div key={`${pair.left}-${pair.right}`}><span>{pair.left} / {pair.right}</span><strong>{pair.correlation.toFixed(2)}</strong><i><b style={{ width: `${Math.abs(pair.correlation) * 100}%` }} /></i></div>)}{!risk.highCorrelationPairs.length ? <p>Sem pares acima de |0,75| ou histórico insuficiente.</p> : null}</div></article>
      <article className="panel health-panel"><div className="panel-head"><div><p className="panel-kicker">SISTEMA</p><h2>Saúde dos dados</h2></div><span className={`health-pill ${analytics.health.yahoo === 'OK' && analytics.health.staleQuotes === 0 ? 'ok' : ''}`}>{analytics.health.yahoo}</span></div><dl className="analytics-list"><div><dt>Yahoo histórico</dt><dd>{analytics.health.yahoo}</dd></div><div><dt>Cotações antigas</dt><dd>{analytics.health.staleQuotes}</dd></div><div><dt>Maior idade</dt><dd>{analytics.health.quoteAgeMinutes === null ? '—' : `${analytics.health.quoteAgeMinutes.toFixed(0)} min`}</dd></div><div><dt>Monitor de gatilhos</dt><dd className="positive">Ativo nesta tela</dd></div></dl></article>
    </div>
    <article className="panel calendar-panel"><div className="panel-head"><div><p className="panel-kicker">CALENDÁRIO</p><h2>Eventos registrados</h2></div><span className="count-chip">{state.corporateActions.length}</span></div><div className="calendar-events">{state.corporateActions.slice(0, 8).map((event) => <div key={event.id}><time>{event.effective_date}</time><strong>{event.symbol}</strong><span>{event.action_type}</span><em>{event.value_text}</em></div>)}{!state.corporateActions.length ? <p>Nenhum dividendo ou split registrado.</p> : null}</div><p className="panel-note">Resultados trimestrais e datas ex-dividendo automáticas exigem um provider fundamental autenticado; o Yahoo público não expõe esses campos de forma confiável.</p></article>
  </section>;
}

function PortfolioCommandBar({ state, activeTab, onNavigate }: { state: DashboardState; activeTab: Tab; onNavigate: (tab: Tab) => void }) {
  return <nav className="portfolio-command-bar" aria-label="Navegação do monitor de portfólio"><button type="button" className="portfolio-command-home" onClick={() => onNavigate('overview')} aria-label="Abrir monitor do portfólio">PORT &lt;GO&gt;</button><button type="button" className={`portfolio-command-link ${activeTab === 'overview' ? 'active' : ''}`} aria-current={activeTab === 'overview' ? 'page' : undefined} onClick={() => onNavigate('overview')}><b>1</b> POSIÇÕES</button><button type="button" className={`portfolio-command-link ${activeTab === 'risk' ? 'active' : ''}`} aria-current={activeTab === 'risk' ? 'page' : undefined} onClick={() => onNavigate('risk')}><b>2</b> RISCO</button><button type="button" className={`portfolio-command-link ${activeTab === 'orders' ? 'active' : ''}`} aria-current={activeTab === 'orders' ? 'page' : undefined} onClick={() => onNavigate('orders')}><b>3</b> ORDENS</button><button type="button" className={`portfolio-command-link ${activeTab === 'activity' ? 'active' : ''}`} aria-current={activeTab === 'activity' ? 'page' : undefined} onClick={() => onNavigate('activity')}><b>4</b> HISTÓRICO</button><button type="button" className={`portfolio-command-link ${activeTab === 'news' ? 'active' : ''}`} aria-current={activeTab === 'news' ? 'page' : undefined} onClick={() => onNavigate('news')}><b>5</b> NOTÍCIAS</button><em>{state.market.isOpen ? 'LIVE' : 'CLOSED'} · USD</em></nav>;
}

function PositionsTable({ state, analytics, activeTab, onNavigate, onReduce, onOpen }: { state: DashboardState; analytics: PortfolioAnalytics | null; activeTab: Tab; onNavigate: (tab: Tab) => void; onReduce: (symbol: string, pct: number) => void; onOpen: (symbol: string) => void }) {
  const totalCostBasis = state.positions.reduce((total, position) => total + Math.round(Math.abs(position.quantityMicros) * position.averageCostCents / 1_000_000), 0);
  const totalUnrealized = state.positions.reduce((total, position) => total + position.unrealizedPnlCents, 0);
  const totalReturnPct = totalCostBasis > 0 ? totalUnrealized / totalCostBasis * 100 : 0;
  const largestPosition = state.positions.reduce<(typeof state.positions)[number] | null>((largest, position) => !largest || position.allocationPct > largest.allocationPct ? position : largest, null);
  const analyticsBySymbol = new Map(analytics?.positions.map((position) => [position.symbol, position]) ?? []);

  return <article className="panel table-panel portfolio-terminal" id="portfolio-monitor">
    <PortfolioCommandBar state={state} activeTab={activeTab} onNavigate={onNavigate} />
    <div className="portfolio-titlebar"><div><p>PAPER USD // PORTFÓLIO CONSOLIDADO</p><h2>Monitor de posições</h2></div><div className="portfolio-asof"><span>AS OF</span><strong>{state.market.newYorkTime}</strong></div></div>
    <div className="portfolio-summary" aria-label="Resumo do portfólio">
      <div><span>MV TOTAL</span><strong>{money(state.account.marketValueCents)}</strong><small>MARKET VALUE</small></div>
      <div><span>CUSTO BASE</span><strong>{money(totalCostBasis)}</strong><small>BOOK COST</small></div>
      <div><span>P&amp;L NÃO REAL.</span><strong className={totalUnrealized >= 0 ? 'positive' : 'negative'}>{totalUnrealized >= 0 ? '+' : ''}{money(totalUnrealized)}</strong><small className={totalReturnPct >= 0 ? 'positive' : 'negative'}>{totalReturnPct >= 0 ? '+' : ''}{totalReturnPct.toFixed(2)}%</small></div>
      <div><span>CAIXA DISP.</span><strong>{money(state.account.availableCashCents)}</strong><small>{(100 - state.account.exposurePct).toFixed(1)}% LIQUIDEZ</small></div>
      <div><span>MAIOR POSIÇÃO</span><strong>{largestPosition?.symbol ?? '—'}</strong><small>{largestPosition ? `${largestPosition.allocationPct.toFixed(1)}% DO PL` : 'SEM EXPOSIÇÃO'}</small></div>
    </div>
    <div className="table-wrap"><table className="portfolio-table analytics-positions" aria-label="Posições abertas do portfólio"><thead><tr><th>#</th><th>Security</th><th className="numeric">Quantity</th><th className="numeric">Avg Px</th><th className="numeric">Last Px</th><th className="numeric">Day P&amp;L</th><th className="numeric">Total P&amp;L</th><th className="numeric">Return</th><th className="numeric">Contrib.</th><th>Stop / Alvo</th><th>Weight</th><th className="numeric">Dias</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{state.positions.map((position, index) => {
      const costBasis = Math.round(Math.abs(position.quantityMicros) * position.averageCostCents / 1_000_000);
      const returnPct = costBasis > 0 ? position.unrealizedPnlCents / costBasis * 100 : 0;
      const detail = analyticsBySymbol.get(position.symbol);
      return <tr key={position.symbol}>
        <td className="row-number">{String(index + 1).padStart(2, '0')}</td>
        <td><button type="button" className="terminal-security security-detail-button" onClick={() => onOpen(position.symbol)} aria-label={`Abrir detalhes da posição ${position.symbol}`}><strong>{position.symbol}</strong><small>{position.direction} · {position.assetClass} · {position.exchange || position.quoteSource} · {compactDate(position.quoteObservedAt)}</small></button></td>
        <td className="numeric">{shares(Math.abs(position.quantityMicros))}</td><td className="numeric">{priceMoney(position.averageCostCents)}</td><td className="numeric last-price">{priceMoney(position.lastPriceCents)}</td><td className={`numeric ${(detail?.dayPnlCents ?? 0) >= 0 ? 'positive' : 'negative'}`}>{detail?.dayPnlCents === null || detail?.dayPnlCents === undefined ? '—' : `${detail.dayPnlCents >= 0 ? '+' : ''}${money(detail.dayPnlCents)}`}</td><td className={`numeric ${position.unrealizedPnlCents >= 0 ? 'positive' : 'negative'}`}>{position.unrealizedPnlCents >= 0 ? '+' : ''}{money(position.unrealizedPnlCents)}</td><td className={`numeric ${returnPct >= 0 ? 'positive' : 'negative'}`}>{returnPct >= 0 ? '+' : ''}{returnPct.toFixed(2)}%</td><td className={`numeric ${(detail?.contributionPct ?? 0) >= 0 ? 'positive' : 'negative'}`}>{detail ? percent(detail.contributionPct, 1) : '—'}</td><td><div className="protection-cell"><span className={detail?.stopPriceCents ? '' : 'missing'}>{detail?.stopPriceCents ? `S ${priceMoney(detail.stopPriceCents)}` : 'SEM STOP'}</span><small>{detail?.targetPriceCents ? `T ${priceMoney(detail.targetPriceCents)}` : 'Sem alvo'}</small></div></td><td><div className="terminal-weight"><span>{position.allocationPct.toFixed(1)}%</span><i><b style={{ width: `${Math.min(100, position.allocationPct)}%` }} /></i></div></td><td className="numeric">{detail?.daysHeld ?? '—'}</td><td><button className="row-action" onClick={() => onReduce(position.symbol, 50)}>RED 50</button></td>
      </tr>;
    })}{!state.positions.length ? <tr><td colSpan={13} className="terminal-empty"><strong>NO ACTIVE POSITIONS</strong><span>Digite uma instrução no ticket para iniciar a carteira simulada.</span><kbd>ORDER &lt;GO&gt;</kbd></td></tr> : null}</tbody></table></div>
    <div className="portfolio-statusbar"><span><i className={state.market.isOpen ? 'live' : ''} /> {state.market.label.toUpperCase()}</span><span>{state.positions.length} SECURITIES</span><span>GROSS EXP {state.account.exposurePct.toFixed(1)}%</span><span>P&amp;L REAL {money(state.account.realizedPnlCents)}</span><em>DATA: LOCAL / BINANCE / YAHOO</em></div>
  </article>;
}

function MarketIntelligencePreview({ intelligence, loading, onOpen }: { intelligence: MarketIntelligence | null; loading: boolean; onOpen: () => void }) {
  const headlines = intelligence?.news.slice(0, 6) ?? [];
  const events = intelligence?.calendar.slice(0, 6) ?? [];
  return <section className="intelligence-preview" aria-label="Notícias e calendário econômico">
    <article className="panel intelligence-preview-card"><div className="panel-head"><div><p className="panel-kicker">INTEL // FJ + GDELT + OFICIAL + YAHOO</p><h2>Notícias de mercado e geopolítica</h2></div><button type="button" className="preview-open" onClick={onOpen}>VER TODAS &lt;GO&gt;</button></div><div className="preview-news-list">{headlines.map((item) => <div className={`impact-${item.impact.toLowerCase()}`} key={item.id}><time>{compactDate(item.publishedAt)}</time><span className={item.category === "GEOPOLITICS" ? "geo" : ""}>{item.category === "GEOPOLITICS" ? "GEO" : "MKT"}</span><p>{item.link ? <a href={item.link} target="_blank" rel="noopener noreferrer">{item.title}</a> : item.title}<small>{item.impact === "HIGH" ? "ALTO IMPACTO · " : ""}{item.source}{item.portfolioRelated ? " · CARTEIRA" : ""}</small></p></div>)}{!headlines.length ? <div className="preview-intelligence-empty"><strong>{loading ? "ATUALIZANDO NOTÍCIAS…" : "SEM NOTÍCIAS DISPONÍVEIS"}</strong><span>Consultando as fontes abertas, o histórico local e o Yahoo.</span></div> : null}</div></article>
    <article className="panel intelligence-preview-card calendar-preview"><div className="panel-head"><div><p className="panel-kicker">ECONOMIC CALENDAR // FJ LIVE + NASDAQ</p><h2>Próximos eventos macro</h2></div><button type="button" className="preview-open" onClick={onOpen}>ABRIR &lt;GO&gt;</button></div><div className="preview-calendar-list">{events.map((event) => <div key={event.id}><time>{compactDate(event.scheduledAt)}</time><strong>{event.countryCode}</strong><span className={`impact-${event.impact.toLowerCase().replace(/[^a-z0-9]/g, "")}`}>{event.impact}</span><p>{event.title}<small>{event.source}</small></p><em>{event.actual ?? event.forecast ?? "—"}</em></div>)}{!events.length ? <div className="preview-intelligence-empty"><strong>{loading ? "ATUALIZANDO CALENDÁRIO…" : "CALENDÁRIO INDISPONÍVEL"}</strong><span>O Brok.ai tentará novamente pelo snapshot público da Nasdaq.</span></div> : null}</div></article>
  </section>;
}

function NewsView({ state, intelligence, loading, onRefresh, onNavigate }: { state: DashboardState; intelligence: MarketIntelligence | null; loading: boolean; onRefresh: () => Promise<void>; onNavigate: (tab: Tab) => void }) {
  const [filter, setFilter] = useState<"ALL" | "HIGH" | "MARKET" | "GEOPOLITICS" | "PORTFOLIO">("ALL");
  const news = intelligence?.news.filter((item) => filter === "ALL" || (filter === "HIGH" && item.impact === "HIGH") || (filter === "PORTFOLIO" && item.portfolioRelated) || item.category === filter) ?? [];
  const statusLabel = intelligence?.status.connection === "DELAYED" ? "STREAM · DELAY 10M" : intelligence?.status.connection === "OFFLINE" ? "STREAM OFFLINE" : "CHAVE PENDENTE";
  return <section className="market-intelligence" aria-labelledby="market-intelligence-title">
    <article className="panel intelligence-terminal">
      <PortfolioCommandBar state={state} activeTab="news" onNavigate={onNavigate} />
      <header className="intelligence-titlebar"><div><p>INTEL &lt;GO&gt; // FJ + GDELT + OFICIAL + YAHOO</p><h2 id="market-intelligence-title">Mercado e geopolítica</h2></div><div className="intelligence-status"><span className={intelligence?.status.connection === "DELAYED" ? "online" : ""}>{statusLabel}</span><small>{intelligence?.status.lastReceivedAt ? `ÚLTIMO PACOTE ${compactDate(intelligence.status.lastReceivedAt)}` : "AGUARDANDO STREAM"}</small></div></header>
      {!intelligence?.status.configured ? <div className="provider-callout" role="status"><strong>FinancialJuice ainda não configurado</strong><span>Copie <code>.env.example</code> para <code>.env.local</code>, informe <code>FINANCIALJUICE_API_KEY</code> e reinicie o Brok.ai. GDELT, fontes oficiais e Yahoo continuam ativos.</span></div> : null}
      {intelligence?.status.configured && intelligence.status.connection === "OFFLINE" ? <div className="provider-callout warning" role="status"><strong>Stream temporariamente offline</strong><span>{intelligence.status.message} Os dados recebidos anteriormente permanecem salvos localmente.</span></div> : null}
      <div className="news-toolbar"><div role="group" aria-label="Filtrar notícias">{([['ALL', 'TODAS'], ['HIGH', 'ALTO IMPACTO'], ['MARKET', 'MERCADO'], ['GEOPOLITICS', 'GEOPOLÍTICA'], ['PORTFOLIO', 'CARTEIRA']] as const).map(([key, label]) => <button key={key} type="button" className={filter === key ? "active" : ""} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div><button type="button" className="news-refresh" disabled={loading} onClick={() => void onRefresh()}>{loading ? "ATUALIZANDO…" : "↻ ATUALIZAR"}</button></div>
      <div className="news-feed" aria-live="polite">
        {news.map((item) => <article className={`news-row impact-${item.impact.toLowerCase()}`} key={item.id}><time>{item.publishedAt ? compactDate(item.publishedAt) : "—"}</time><span className={`news-category ${item.category.toLowerCase()}`}>{item.category === "GEOPOLITICS" ? "GEO" : "MKT"}</span><div>{item.impact === "HIGH" ? <span className="news-impact">ALTO IMPACTO</span> : null}<h3>{item.link ? <a href={item.link} target="_blank" rel="noopener noreferrer">{item.title}</a> : item.title}</h3>{item.description ? <p>{item.description}</p> : null}<small>{item.source}{item.labels.length ? ` · ${item.labels.slice(0, 4).join(" · ")}` : ""}{item.portfolioRelated ? " · CARTEIRA" : ""}</small></div></article>)}
        {!loading && !news.length ? <div className="intelligence-empty"><strong>SEM NOTÍCIAS NESTE FILTRO</strong><span>{state.positions.length ? "O Yahoo será consultado novamente na próxima atualização." : "Abra uma posição para ativar o fallback Yahoo por ticker."}</span></div> : null}
        {loading && !intelligence ? <div className="intelligence-empty"><strong>CARREGANDO INTELIGÊNCIA…</strong><span>Consultando o histórico local e os tickers da carteira.</span></div> : null}
      </div>
    </article>
    <article className="panel economic-calendar"><div className="panel-head"><div><p className="panel-kicker">ECONOMIC CALENDAR // FINANCIALJUICE LIVE + NASDAQ SNAPSHOT</p><h2>Próximos eventos macro</h2></div><span className="count-chip">{intelligence?.calendar.length ?? 0} eventos</span></div><div className="table-wrap"><table><thead><tr><th>Data / hora</th><th>País</th><th>Impacto</th><th>Evento</th><th>Atual</th><th>Consenso</th><th>Anterior</th><th>Fonte</th></tr></thead><tbody>{intelligence?.calendar.map((event) => <tr key={event.id}><td>{compactDate(event.scheduledAt)}</td><td><strong>{event.countryCode}</strong></td><td><span className={`impact-badge impact-${event.impact.toLowerCase().replace(/[^a-z0-9]/g, "")}`}>{event.impact}</span></td><td>{event.title}</td><td>{event.actual ?? "—"}</td><td>{event.forecast ?? "—"}</td><td>{event.previous ?? "—"}</td><td><span className="calendar-source">{event.source}</span></td></tr>)}{!intelligence?.calendar.length ? <tr><td colSpan={8} className="empty-state"><strong>Calendário temporariamente indisponível</strong><span>O snapshot Nasdaq será consultado novamente; as atualizações do FinancialJuice continuam ativas.</span></td></tr> : null}</tbody></table></div></article>
  </section>;
}

function OrdersTable({ orders, onCancel, compact = false }: { orders: DashboardState['openOrders']; onCancel: (id: string) => void; compact?: boolean }) {
  return <article className="panel table-panel"><div className="panel-head"><div><p className="panel-kicker">EXECUÇÃO</p><h2>Ordens pendentes</h2></div><span className="count-chip live">{orders.length} abertas</span></div><div className="table-wrap"><table><thead><tr><th>Ativo</th><th>Lado</th><th>Tipo</th><th>Quantidade</th><th>Gatilho</th><th>Função</th><th>Criada</th><th /></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td><strong>{order.symbol}</strong></td><td><span className={`side-badge ${order.side.toLowerCase()}`}>{order.side}</span></td><td>{order.order_type}</td><td>{shares(order.remaining_micros)}</td><td>{order.trigger_price_cents ? money(order.trigger_price_cents) : 'Mercado'}</td><td>{order.role.replace('_', ' ')}</td><td>{compactDate(order.created_at)}</td><td><button className="cancel-button" onClick={() => onCancel(order.id)}>Cancelar</button></td></tr>)}{!orders.length ? <tr><td colSpan={8} className="empty-state"><strong>Sem ordens pendentes</strong><span>Market orders são processadas assim que confirmadas.</span></td></tr> : null}</tbody></table></div>{compact ? null : <p className="table-footnote">Stops e take profits do mesmo grupo são OCO: ao executar uma perna, a outra é cancelada.</p>}</article>;
}

function RecentOrders({ state }: { state: DashboardState }) {
  return <article className="panel table-panel"><div className="panel-head"><div><p className="panel-kicker">LIFECYCLE</p><h2>Todas as ordens</h2></div></div><div className="table-wrap"><table><thead><tr><th>Ativo</th><th>Lado</th><th>Tipo</th><th>Função</th><th>Status</th><th>Preço médio</th><th>Atualizada</th></tr></thead><tbody>{state.recentOrders.map((order) => <tr key={order.id}><td><strong>{order.symbol}</strong></td><td>{order.side}</td><td>{order.order_type}</td><td>{order.role}</td><td><span className={`status-badge ${order.status.toLowerCase()}`}>{order.status}</span></td><td>{order.average_fill_price_cents ? money(order.average_fill_price_cents) : '—'}</td><td>{compactDate(order.updated_at)}</td></tr>)}</tbody></table></div></article>;
}

function ActivityView({ state, analytics }: { state: DashboardState; analytics: PortfolioAnalytics | null }) {
  return <section className="analytics-view">{analytics ? <div className="metrics-grid analytics-metrics"><MetricCard label="Fill rate" value={analytics.execution.fillRatePct === null ? '—' : `${analytics.execution.fillRatePct.toFixed(1)}%`} detail={`${analytics.execution.filledOrders} executadas`} /><MetricCard label="Turnover" value={`${analytics.execution.turnoverPct.toFixed(1)}%`} detail="Notional negociado / patrimônio" /><MetricCard label="Slippage médio" value={analytics.execution.averageSlippageBps === null ? '—' : `${analytics.execution.averageSlippageBps.toFixed(1)} bps`} detail="Ordens com preço de referência" tone={(analytics.execution.averageSlippageBps ?? 0) > 0 ? 'negative' : 'neutral'} /><MetricCard label="Custos acumulados" value={money(analytics.execution.feesCents)} detail={`${analytics.execution.cancelledOrders} canceladas · ${analytics.execution.rejectedOrders} rejeitadas`} /></div> : null}<div className="activity-grid"><article className="panel table-panel"><div className="panel-head"><div><p className="panel-kicker">FILLS</p><h2>Execuções</h2></div><span className="count-chip">{state.fills.length}</span></div><div className="table-wrap"><table><thead><tr><th>Ativo</th><th>Lado</th><th>Quantidade</th><th>Preço</th><th>Notional</th><th>Horário</th></tr></thead><tbody>{state.fills.map((fill) => <tr key={fill.id}><td><strong>{fill.symbol}</strong></td><td><span className={`side-badge ${fill.side.toLowerCase()}`}>{fill.side}</span></td><td>{shares(fill.quantity_micros)}</td><td>{money(fill.price_cents)}</td><td>{money(Math.round(fill.quantity_micros * fill.price_cents / 1_000_000))}</td><td>{compactDate(fill.created_at)}</td></tr>)}{!state.fills.length ? <tr><td colSpan={6} className="empty-state"><strong>Nenhum fill</strong><span>As execuções aparecerão aqui.</span></td></tr> : null}</tbody></table></div></article><article className="panel audit-panel"><div className="panel-head"><div><p className="panel-kicker">AUDITORIA</p><h2>Linha do tempo</h2></div></div><div className="timeline">{state.audit.map((event) => <div key={event.id}><span className="timeline-dot" /><p><strong>{event.message}</strong><small>{event.event_type.replaceAll('_', ' ')} · {compactDate(event.created_at)}</small></p></div>)}</div></article></div></section>;
}
