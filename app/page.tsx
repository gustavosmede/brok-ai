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
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
}

function priceMoney(cents: number): string {
  const dollars = cents / 100;
  const digits = dollars !== 0 && Math.abs(dollars) < 0.01 ? 8 : 2;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(dollars);
}

function shares(micros: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(micros / 1_000_000);
}

function compactDate(value?: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function percent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "Insufficient data";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "The operation failed");
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
      const yFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: yDigits, maximumFractionDigits: yDigits });
      const spanHours = timeRange / 3_600_000;
      const timeFormat = new Intl.DateTimeFormat("en-US", spanHours <= 24
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
          ctx.fillText("NO DATA", (gapStart + gapEnd) / 2, top + 8);
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
      ctx.fillText("EQUITY · USD", left, 3);
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [points]);
  const first = points[0];
  const last = points.at(-1);
  return <canvas ref={ref} className="equity-canvas" aria-label={`Historical equity curve${first && last ? ` from ${compactDate(first.created_at)} to ${compactDate(last.created_at)}` : ""}`} />;
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
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Failed to load" });
    }
  }, [loadAnalytics]);

  const loadIntelligence = useCallback(async () => {
    setIntelligenceLoading(true);
    try {
      const body = await api<{ intelligence: MarketIntelligence }>("/api/intelligence");
      setIntelligence(body.intelligence);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Failed to load news" });
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
    if (command) command.placeholder = "Buy US$1,000 of Netflix at market, with a 5% stop and a 12% target.";
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
      if (!response.ok) throw new Error(body.error ?? "Could not transcribe audio");
      const text = body.text?.trim();
      if (!text) throw new Error("No speech was detected in the recording. Try again closer to the microphone.");
      setChat(text);
      setSymbolResolution(null);
      setAssetSuggestions([]);
      setInterpreterResult(null);
      setPreview(null);
      setNotice({ kind: "success", text: "Transcription ready. Review the request and generate the preview." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Local transcription failed" });
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
      setNotice({ kind: "error", text: "This browser does not support audio recording. Use a current version of Chrome, Safari, or Edge." });
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
        setNotice({ kind: "error", text: "The recording was interrupted by the browser." });
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
          setNotice({ kind: "error", text: "No audio was captured. Check microphone permission." });
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
      setNotice({ kind: "error", text: denied ? "Allow microphone access in browser settings and try again." : "Could not access the Mac microphone." });
    }
  }

  async function draftOrder(orderIntent: OrderIntent, source = "MANUAL", originalText?: string) {
    setBusy(true);
    try {
      const body = await api<{ preview: OrderPreview }>("/api/drafts", { method: "POST", body: JSON.stringify({ intent: orderIntent, source, originalText }) });
      setPreview(body.preview);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Failed to prepare order" });
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
        setNotice({ kind: "info", text: "No direct instrument was found. Choose a Yahoo alternative before generating the preview - this is not a recommendation." });
        return;
      }
      setChatStage("PREVIEW");
      const body = await api<{ preview: OrderPreview }>("/api/drafts", { method: "POST", body: JSON.stringify({ intent: parsed.intent, source: parsed.parser, originalText: chat }) });
      setPreview(body.preview);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not interpret" });
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
      setState(body.state); void loadAnalytics(); setPreview(null); setNotice({ kind: "success", text: "Order confirmada e registrada no paper broker." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Failed to confirm" });
    } finally { setBusy(false); }
  }

  async function syncMarket(manual?: Record<string, number>) {
    setBusy(true);
    try {
      const symbols = [...new Set([...(state?.positions.map((p) => p.symbol) ?? []), ...(state?.openOrders.map((o) => o.symbol) ?? []), intent.symbol].filter(Boolean))];
      const body = await api<{ state: DashboardState; filled: number; errors: string[] }>("/api/market", { method: "POST", body: JSON.stringify({ symbols, manualQuotes: manual }) });
      setState(body.state);
      void loadAnalytics();
      const message = body.filled ? `${body.filled} order(s) executed.` : "Quotes updated; no order reached its trigger.";
      setNotice({ kind: body.errors.length ? "info" : "success", text: body.errors.length ? `${message} ${body.errors.join(" · ")}` : message });
    } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : "Update failed" }); }
    finally { setBusy(false); }
  }

  async function cancel(orderId: string) {
    setBusy(true);
    try {
      const body = await api<{ state: DashboardState }>("/api/orders/cancel", { method: "POST", body: JSON.stringify({ orderId }) });
      setState(body.state); void loadAnalytics(); setNotice({ kind: "success", text: "Order cancelada." });
    } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : "Failed to cancel" }); }
    finally { setBusy(false); }
  }

  async function applyCorp(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const body = await api<{ state: DashboardState }>("/api/corporate-actions", { method: "POST", body: JSON.stringify(corp) });
      setState(body.state); void loadAnalytics(); setNotice({ kind: "success", text: "Event corporativo aplicado e auditado." });
    } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : "Failed to apply event" }); }
    finally { setBusy(false); }
  }

  function reducePosition(symbol: string, pct: number) {
    void draftOrder({ action: "REDUCE", symbol, sizingType: "POSITION_PCT", sizingValue: String(pct), orderType: "MARKET", triggerPrice: null, stopLossPct: null, takeProfitPct: null, note: `Quick reduction of ${pct}%` }, "QUICK_ACTION");
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
      setPositionDetailError(error instanceof Error ? error.message : "Failed to load the position");
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
    void draftOrder({ action: "CLOSE", symbol, sizingType: "POSITION_PCT", sizingValue: "100", orderType: "MARKET", triggerPrice: null, stopLossPct: null, takeProfitPct: null, note: "Close requested from position detail" }, "POSITION_DETAIL");
  }

  if (!state) return <main className="boot-screen"><div className="boot-mark">B</div><p>Preparing your paper account...</p></main>;
  const hasCrypto = state.positions.some((position) => position.assetClass === "CRYPTOCURRENCY");
  const onlyCrypto = state.positions.length > 0 && state.positions.every((position) => position.assetClass === "CRYPTOCURRENCY");
  const marketLabel = onlyCrypto ? "Market 24/7" : hasCrypto ? "Mixed sessions" : state.market.label;
  const marketTitle = onlyCrypto ? "Crypto assets trade continuously" : hasCrypto ? "Portfolio contains assets with different calendars" : `${state.market.reason} · ${state.market.newYorkTime}`;
  const marketOpen = onlyCrypto || hasCrypto || state.market.isOpen;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand" aria-label="Brok.ai"><div className="brand-mark" aria-hidden="true">B</div><div className="brand-wordmark"><strong>Brok<span>.ai</span></strong><small>Broker // Intelligence</small></div></div>
      <nav aria-label="Main navigation">
        {([['overview', 'Overview', '⌁'], ['performance', 'Performance', '⌁'], ['risk', 'Risk', '◇'], ['orders', 'Orders', '⇄'], ['activity', 'Execution', '◴'], ['news', 'News', '▤'], ['settings', 'Settings', '⚙']] as const).map(([key, label, icon]) => <button key={key} className={tab === key ? "nav-item active" : "nav-item"} onClick={() => { if (key === "overview") setTerminalTarget("overview"); setTab(key); }}><span>{icon}</span>{label}{key === 'orders' && state.openOrders.length > 0 ? <em>{state.openOrders.length}</em> : key === 'risk' && analytics?.alerts.length ? <em>{analytics.alerts.length}</em> : null}</button>)}
      </nav>
      <div className="mode-card"><div className="mode-row"><span className="status-dot" />Paper mode</div><p>No real order can leave this app. Triggers are updated while the dashboard is open.</p></div>
      <div className="sidebar-footer"><span>Account</span><strong>Paper USD</strong><small>Local data · SQLite</small></div>
    </aside>

    <main className="workspace">
      <nav className="terminal-strip" aria-label="Terminal shortcuts"><button type="button" className="terminal-strip-brand" onClick={() => navigateTerminal("overview")} aria-label="Back to overview">BROK.AI</button>{([['overview', 'F1', 'OVERVIEW', '⌥1'], ['portfolio', 'F2', 'PORTFOLIO', '⌥2'], ['orders', 'F3', 'ORDERS', '⌥3'], ['news', 'F4', 'NEWS', '⌥4']] as const).map(([target, key, label, macKey]) => { const active = target === "portfolio" ? tab === "overview" && terminalTarget === "portfolio" : target === "overview" ? tab === "overview" && terminalTarget !== "portfolio" : tab === target; return <button type="button" key={target} className={`terminal-shortcut ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} title={`${label} - ${key} or ${macKey}`} onClick={() => navigateTerminal(target)}><b>{key}</b> {label}<kbd>{macKey}</kbd></button>; })}<em>LOCAL // USD</em></nav>
      <header className="topbar"><div><p className="eyebrow">SIMULATED PORTFOLIO</p><h1>{tab === 'overview' ? 'Overview' : tab === 'performance' ? 'Performance and benchmark' : tab === 'risk' ? 'Risk and alerts' : tab === 'orders' ? 'Orders and positions' : tab === 'activity' ? 'Execution and audit' : tab === 'news' ? 'News and calendar' : 'Local settings'}</h1></div><div className="top-actions"><div className={`market-clock ${marketOpen ? 'open' : ''}`} title={marketTitle}><span className="status-dot" />{marketLabel}</div><div className="quote-status"><span>Last quote</span><strong>{compactDate(state.lastQuoteAt)}</strong></div><button className="ghost-button" disabled={busy} onClick={() => void syncMarket()}><span className={busy ? "spin" : ""}>↻</span> Refresh</button><button className="primary-button" onClick={() => { setTab('overview'); document.getElementById('order-ticket')?.scrollIntoView({ behavior: 'smooth' }); }}>+ New order</button></div></header>

      <div className="content-layout">
        <section className="content-main">
          {tab === "overview" && <>
            <div className="metrics-grid">
              <MetricCard label="Equity" value={money(state.account.equityCents)} detail={`${state.snapshots.length} local snapshots`} />
              <MetricCard label="Available cash" value={money(state.account.availableCashCents)} detail={`${money(state.account.cashCents - state.account.availableCashCents)} reserved`} />
              <MetricCard label="P&L total" value={money(pnlTotal)} detail={`${money(state.account.realizedPnlCents)} realized`} tone={pnlTotal >= 0 ? "positive" : "negative"} />
              <MetricCard label="Exposure" value={`${state.account.exposurePct.toFixed(1)}%`} detail={`${money(state.account.marketValueCents)} invested`} />
            </div>
            {analytics ? <div className="decision-strip"><button onClick={() => setTab('performance')}><span>Excess vs {analytics.benchmark}</span><strong className={(analytics.performance.excessReturnPct ?? 0) >= 0 ? 'positive' : 'negative'}>{percent(analytics.performance.excessReturnPct)}</strong></button><button onClick={() => setTab('performance')}><span>Current drawdown</span><strong className={analytics.performance.currentDrawdownPct < 0 ? 'negative' : ''}>{percent(analytics.performance.currentDrawdownPct)}</strong></button><button onClick={() => setTab('risk')}><span>Stop risk</span><strong>{money(analytics.risk.lossAtStopsCents)}</strong></button><button onClick={() => setTab('risk')}><span>Active alerts</span><strong className={analytics.alerts.some((alert) => alert.severity === 'HIGH') ? 'negative' : ''}>{analytics.alerts.length}</strong></button><div><span>Data health</span><strong className={analytics.health.yahoo === 'OK' && analytics.health.staleQuotes === 0 ? 'positive' : 'negative'}>{analytics.health.yahoo === 'OK' && analytics.health.staleQuotes === 0 ? 'Normal' : 'Attention'}</strong></div></div> : null}
            <div className="visual-grid">
              <article className="panel equity-panel"><div className="panel-head"><div><p className="panel-kicker">PERFORMANCE</p><h2>Equity curve</h2></div><span className="period-chip">Last 24h</span></div><div className="chart-summary"><strong>{money(state.account.equityCents)}</strong><span className={pnlTotal >= 0 ? "positive" : "negative"}>{pnlTotal >= 0 ? '+' : ''}{money(pnlTotal)}</span></div><EquityChart points={state.performanceSnapshots.length ? state.performanceSnapshots : state.snapshots} /></article>
              <article className="panel allocation-panel"><div className="panel-head"><div><p className="panel-kicker">RISK</p><h2>Allocation</h2></div></div><div className="allocation-body"><div className="donut" style={{ background: allocationBackground }}><div><strong>{state.account.exposurePct.toFixed(0)}%</strong><span>exposed</span></div></div><div className="legend">{state.positions.slice(0, 5).map((position, index) => <div key={position.symbol}><span className="legend-dot" style={{ background: colors[index % colors.length] }} /><strong>{position.symbol}</strong><em>{position.allocationPct.toFixed(1)}%</em></div>)}{!state.positions.length ? <p>No open positions</p> : null}</div></div></article>
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
            <article className="panel settings-card"><div className="panel-head"><div><p className="panel-kicker">MARKET DATA</p><h2>Manual quote</h2></div></div><p>Use this option when Yahoo is unavailable or to test offline triggers.</p><div className="inline-fields"><label>Ticker<input value={manualSymbol} onChange={(e) => setManualSymbol(e.target.value.toUpperCase())} /></label><label>Price USD<input inputMode="decimal" value={manualPrice} onChange={(e) => setManualPrice(e.target.value)} placeholder="190.50" /></label><button className="primary-button" disabled={!manualSymbol || !Number(manualPrice) || busy} onClick={() => void syncMarket({ [manualSymbol]: Number(manualPrice.replace(',', '.')) })}>Save and process</button></div></article>
            <article className="panel settings-card"><div className="panel-head"><div><p className="panel-kicker">LLM LOCAL</p><h2>Ollama</h2></div><span className="local-chip">127.0.0.1</span></div><p>The model only converts text into JSON. If it is offline, the deterministic parser takes over.</p><label>Modelo<input value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} /></label><small>Fixed endpoint: http://127.0.0.1:11434</small></article>
            <article className="panel settings-card wide"><div className="panel-head"><div><p className="panel-kicker">CORPORATE ACTIONS</p><h2>Dividends and splits</h2></div></div><form className="corp-form" onSubmit={applyCorp}><label>Ticker<input required value={corp.symbol} onChange={(e) => setCorp({ ...corp, symbol: e.target.value.toUpperCase() })} /></label><label>Event<select value={corp.actionType} onChange={(e) => setCorp({ ...corp, actionType: e.target.value as 'DIVIDEND' | 'SPLIT' })}><option value="DIVIDEND">Dividend per share</option><option value="SPLIT">Split (ratio)</option></select></label><label>{corp.actionType === 'DIVIDEND' ? 'USD per share' : 'New/old ratio'}<input required value={corp.value} onChange={(e) => setCorp({ ...corp, value: e.target.value })} /></label><label>Effective date<input type="date" required value={corp.effectiveDate} onChange={(e) => setCorp({ ...corp, effectiveDate: e.target.value })} /></label><button className="primary-button" disabled={busy}>Apply event</button></form><div className="action-list">{state.corporateActions.map((action) => <div key={action.id}><strong>{action.symbol}</strong><span>{action.action_type}</span><span>{action.value_text}</span><time>{action.effective_date}</time></div>)}{!state.corporateActions.length ? <p>No event applied.</p> : null}</div></article>
            <article className="panel settings-card wide adapter-card"><div><p className="panel-kicker">OPTIONAL ADAPTER</p><h2>Alpaca Paper</h2><p>The provider interface is already prepared in code. Credentials are not stored in this version to keep the MVP keyless and free from real-order transmission risk.</p></div><span className="coming-soon">Disabled for safety</span></article>
          </section>}
        </section>

        <aside className="ticket-panel" id="order-ticket"><div className="ticket-head"><div><p className="panel-kicker">ORDER TICKET</p><h2>New order</h2></div><span className="paper-pill">PAPER</span></div>
          {notice ? <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.kind === 'success' ? '✓' : notice.kind === 'error' ? '!' : 'i'}</span><p>{notice.text}</p><button type="button" aria-label="Close notice" onClick={() => setNotice(null)}>×</button></div> : null}
          <div className="segmented"><button className={ticketMode === 'chat' ? 'active' : ''} onClick={() => setTicketMode('chat')}>⌁ Conversation</button><button className={ticketMode === 'manual' ? 'active' : ''} onClick={() => setTicketMode('manual')}>Manual</button></div>
          {ticketMode === 'chat' ? <form className="chat-ticket" onSubmit={submitChat}><label htmlFor="chat-command">What do you want to simulate?</label><textarea id="chat-command" value={chat} disabled={chatStage !== null || voiceStage !== null} onChange={(e) => { setChat(e.target.value); setSymbolResolution(null); setAssetSuggestions([]); setInterpreterResult(null); }} rows={6} />{voiceStage ? <div className={`voice-status ${voiceStage.toLowerCase()}`} role="status" aria-live="polite"><span className="voice-level" aria-hidden="true"><i /><i /><i /><i /></span><div><strong>{voiceStage === 'RECORDING' ? `Listening · ${voiceSeconds}s` : 'Transcribing locally...'}</strong><small>{voiceStage === 'RECORDING' ? 'Speak the request and tap the microphone to finish. Limit: 30s.' : 'Whisper is converting your voice into editable text.'}</small></div>{voiceStage === 'RECORDING' ? <button type="button" onClick={() => stopVoiceCapture(true)}>Cancel</button> : null}</div> : null}{chatStage ? <div className="ai-work-status" role="status" aria-live="polite"><div className="ai-work-head"><span className="ai-pulse" aria-hidden="true"><i /><i /><i /></span><div><small>{chatStage === 'OLLAMA' ? `OLLAMA LOCAL · ${ollamaModel}` : 'MOTOR FINANCEIRO'}</small><strong>{chatStage === 'OLLAMA' ? 'Interpreting your request' : 'Preparing the preview'}</strong><em>{chatStage === 'OLLAMA' ? 'Understanding asset, direction, size, and conditions...' : 'Validating quote, cash, and quantity...'}</em></div></div><div className="ai-pipeline" aria-hidden="true"><span className="active">OLLAMA</span><span className={chatStage === 'PREVIEW' ? 'done' : ''}>BINANCE/YAHOO</span><span className={chatStage === 'PREVIEW' ? 'active' : ''}>PREVIEW</span></div></div> : interpreterResult ? <div className={`interpreter-result ${interpreterResult.parser === 'OLLAMA' ? 'ollama' : 'fallback'}`} role="status"><span>{interpreterResult.parser === 'OLLAMA' ? 'AI' : 'RF'}</span><div><small>{interpreterResult.parser === 'OLLAMA' ? 'INTERPRETED BY OLLAMA' : 'LOCAL FALLBACK USED'}</small><strong>{interpreterResult.parser === 'OLLAMA' ? interpreterResult.model : 'Deterministic parser'}</strong><em>{(interpreterResult.durationMs / 1000).toFixed(1)}s · {interpreterResult.attempts} {interpreterResult.attempts === 1 ? 'attempt' : 'attempts'}</em></div></div> : null}{symbolResolution ? <div className="symbol-resolution" role="status"><span>{symbolResolution.source === 'BINANCE_SPOT' ? 'BN' : 'YF'}</span><div><small>ASSET RESOLVED · {symbolResolution.assetClass}</small><strong>{symbolResolution.name} → {symbolResolution.symbol}</strong><em>{symbolResolution.exchange} · {symbolResolution.source === 'BINANCE_SPOT' ? 'Binance Spot' : symbolResolution.source === 'YAHOO_SEARCH' ? 'Yahoo Finance' : 'fallback local'}</em></div></div> : null}{assetSuggestions.length ? <div className="asset-suggestions" role="region" aria-label="Related alternatives"><div><strong>Related alternatives found</strong><small>Choose an instrument to continue. Not investment advice.</small></div>{assetSuggestions.map((suggestion) => <button type="button" key={suggestion.symbol} onClick={() => void chooseAsset(suggestion)} disabled={busy}><span><b>{suggestion.symbol}</b><em>{suggestion.assetClass} · {suggestion.exchange}</em></span><small>{suggestion.name}</small><i>USE</i></button>)}</div> : null}<div className="example-chips"><button type="button" onClick={() => { setChat('Buy Apple shares at market'); setSymbolResolution(null); setAssetSuggestions([]); setInterpreterResult(null); }}>Apple → ticker</button><button type="button" onClick={() => { setChat('Buy US$1,000 of Bitcoin at market'); setSymbolResolution(null); setAssetSuggestions([]); setInterpreterResult(null); }}>Bitcoin</button><button type="button" onClick={() => { setChat('Invest US$1,000 in uranium at market'); setSymbolResolution(null); setAssetSuggestions([]); setInterpreterResult(null); }}>Theme → alternatives</button></div><div className="ticket-actions"><button className="ticket-submit" disabled={busy || voiceStage !== null || !chat.trim()}>{chatStage === 'OLLAMA' ? 'OLLAMA ANALYZING...' : chatStage === 'PREVIEW' ? 'VALIDATING PREVIEW...' : voiceStage === 'TRANSCRIBING' ? 'TRANSCRIBING...' : 'GENERATE PREVIEW'}<span>{chatStage || voiceStage ? '···' : 'GO'}</span></button><button type="button" className={`voice-submit ${voiceStage === 'RECORDING' ? 'recording' : ''}`} onClick={() => voiceStage === 'RECORDING' ? stopVoiceCapture(false) : void startVoiceCapture()} disabled={busy || chatStage !== null || voiceStage === 'TRANSCRIBING'} aria-pressed={voiceStage === 'RECORDING'} aria-label={voiceStage === 'RECORDING' ? 'Stop recording' : 'Dictate new order'} title={voiceStage === 'RECORDING' ? 'Stop and transcribe' : 'Dictate new order'}><span className="mic-glyph" aria-hidden="true" /></button></div><p className="safety-note"><span>✓</span>Nothing executes before confirmation.</p></form> : <ManualTicket intent={intent} setIntent={setIntent} onSubmit={submitManual} busy={busy} />}
        </aside>
      </div>
    </main>

    {preview ? <PreviewDialog preview={preview} busy={busy} onClose={() => setPreview(null)} onConfirm={confirm} /> : null}
    {selectedSymbol ? <PositionDetailDrawer detail={positionDetail} loading={positionDetailLoading} error={positionDetailError} onClose={closePositionDetail} onReduce={reduceFromDetail} onClosePosition={closeFromDetail} /> : null}
  </div>;
}

function ManualTicket({ intent, setIntent, onSubmit, busy }: { intent: OrderIntent; setIntent: (intent: OrderIntent) => void; onSubmit: (event: FormEvent) => void; busy: boolean }) {
  return <form className="manual-ticket" onSubmit={onSubmit}><div className="side-switch"><button type="button" className={intent.action === 'BUY' ? 'buy active' : ''} onClick={() => setIntent({ ...intent, action: 'BUY', sizingType: intent.sizingType === 'POSITION_PCT' ? 'SHARES' : intent.sizingType })}>Buy</button><button type="button" className={intent.action === 'SHORT' ? 'sell active' : ''} onClick={() => setIntent({ ...intent, action: 'SHORT', sizingType: intent.sizingType === 'POSITION_PCT' ? 'NOTIONAL' : intent.sizingType })}>Short</button><button type="button" className={['REDUCE', 'CLOSE'].includes(intent.action) ? 'sell active' : ''} onClick={() => setIntent({ ...intent, action: 'REDUCE', sizingType: 'POSITION_PCT', sizingValue: '50', stopLossPct: null, takeProfitPct: null })}>Reduce</button></div><label>Ticker<input required value={intent.symbol} onChange={(e) => setIntent({ ...intent, symbol: e.target.value.toUpperCase() })} /></label><label>Size<select value={intent.sizingType} onChange={(e) => setIntent({ ...intent, sizingType: e.target.value as OrderIntent['sizingType'] })}><option value="SHARES">Number of shares</option><option value="NOTIONAL">USD value</option><option value="CASH_PCT">% of cash</option><option value="POSITION_PCT">% of position</option></select></label><label>{intent.sizingType === 'NOTIONAL' ? 'USD value' : intent.sizingType === 'SHARES' ? 'Actions' : 'Percentage'}<input required inputMode="decimal" value={intent.sizingValue} onChange={(e) => setIntent({ ...intent, sizingValue: e.target.value })} /></label><label>Order type<select value={intent.orderType} onChange={(e) => setIntent({ ...intent, orderType: e.target.value as OrderIntent['orderType'] })}><option value="MARKET">Market</option><option value="LIMIT">Limit</option><option value="STOP">Stop</option></select></label>{intent.orderType !== 'MARKET' ? <label>Trigger price<input required inputMode="decimal" value={intent.triggerPrice ?? ''} onChange={(e) => setIntent({ ...intent, triggerPrice: e.target.value })} /></label> : null}{intent.action === 'BUY' || intent.action === 'SHORT' ? <div className="dual-fields"><label>Stop-loss %<input inputMode="decimal" value={intent.stopLossPct ?? ''} onChange={(e) => setIntent({ ...intent, stopLossPct: e.target.value })} /></label><label>Take profit %<input inputMode="decimal" value={intent.takeProfitPct ?? ''} onChange={(e) => setIntent({ ...intent, takeProfitPct: e.target.value })} /></label></div> : null}<button className="ticket-submit" disabled={busy}>{busy ? 'Calculating...' : 'Generate preview'}<span>→</span></button></form>;
}

function PreviewDialog({ preview, busy, onClose, onConfirm }: { preview: OrderPreview; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const label = preview.action === 'SHORT' ? 'Open short' : preview.side === 'BUY' && (preview.action === 'REDUCE' || preview.action === 'CLOSE') ? 'Cover short' : preview.side === 'BUY' ? 'Buy' : 'Sell';
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-title"><div className="preview-top"><div><p className="panel-kicker">MANDATORY CONFIRMATION</p><h2 id="preview-title">Review order</h2></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div><div className="order-hero"><div className={`asset-avatar ${preview.side.toLowerCase()}`}>{preview.symbol.slice(0, 2)}</div><div><strong>{label} {preview.symbol}</strong><span>{preview.orderType} · {preview.sizingLabel}</span></div><em className={preview.side === 'BUY' ? 'positive' : 'negative'}>{preview.action}</em></div><dl className="preview-grid"><div><dt>Quantity</dt><dd>{shares(preview.quantityMicros)}</dd></div><div><dt>Estimated notional</dt><dd>{money(preview.estimatedNotionalCents)}</dd></div><div><dt>{preview.triggerPriceCents ? 'Trigger price' : 'Reference quote'}</dt><dd>{priceMoney(preview.triggerPriceCents ?? preview.referencePriceCents)}</dd></div><div><dt>Source / time</dt><dd>{preview.quote.source} · {compactDate(preview.quote.observedAt)}</dd></div><div><dt>Stop-loss</dt><dd>{preview.stopLossPriceCents ? priceMoney(preview.stopLossPriceCents) : 'No stop'}</dd></div><div><dt>Take profit</dt><dd>{preview.takeProfitPriceCents ? priceMoney(preview.takeProfitPriceCents) : 'No target'}</dd></div><div><dt>Cash before</dt><dd>{money(preview.availableCashBeforeCents)}</dd></div><div><dt>Estimated cash after</dt><dd>{money(preview.availableCashAfterCents)}</dd></div></dl>{preview.warnings.length ? <div className="warning-box">{preview.warnings.map((warning) => <p key={warning}><span>!</span>{warning}</p>)}</div> : <div className="confirmation-note"><span>✓</span><p><strong>Validation complete</strong>Cash, position, and size were recalculated by the deterministic engine.</p></div>}<div className="preview-actions"><button className="ghost-button" onClick={onClose} disabled={busy}>Back and edit</button><button className="confirm-button" onClick={onConfirm} disabled={busy}>{busy ? 'Confirming...' : 'Confirm paper order'}</button></div><p className="expiry">Preview valid until {compactDate(preview.expiresAt)}</p></section></div>;
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
  return <div className="comparison-chart"><canvas ref={ref} aria-label={`Portfolio cumulative return compared with ${benchmark}`} /><div><span><i className="portfolio-line" />Brok.ai</span><span><i className="benchmark-line" />{benchmark}</span></div></div>;
}

function AnalyticsLoading() {
  return <article className="panel analytics-loading"><span className="spin">↻</span><div><strong>Calculating analytics</strong><p>Loading Yahoo history and reconciling it with the local ledger.</p></div></article>;
}

function PerformanceView({ state, analytics }: { state: DashboardState; analytics: PortfolioAnalytics | null }) {
  if (!analytics) return <AnalyticsLoading />;
  const performance = analytics.performance;
  return <section className="analytics-view">
    <div className="metrics-grid analytics-metrics">
      <MetricCard label="Today" value={percent(performance.returnTodayPct)} detail="Observed return from today's snapshots" tone={(performance.returnTodayPct ?? 0) >= 0 ? 'positive' : 'negative'} />
      <MetricCard label="Since inception" value={percent(performance.returnSinceStartPct)} detail={`${state.snapshots.length} snapshots`} tone={performance.returnSinceStartPct >= 0 ? 'positive' : 'negative'} />
      <MetricCard label={`Excess over ${analytics.benchmark}`} value={percent(performance.excessReturnPct)} detail={`${analytics.benchmark} ${percent(performance.benchmarkSinceStartPct)}`} tone={(performance.excessReturnPct ?? 0) >= 0 ? 'positive' : 'negative'} />
      <MetricCard label="Max drawdown" value={percent(performance.maxDrawdownPct)} detail={`Actual ${percent(performance.currentDrawdownPct)}`} tone={performance.maxDrawdownPct < 0 ? 'negative' : 'neutral'} />
    </div>
    <article className="panel performance-chart-panel"><div className="panel-head"><div><p className="panel-kicker">BENCHMARK</p><h2>Cumulative return versus {analytics.benchmark}</h2></div><span className="period-chip">Last 24h</span></div><ComparisonChart points={performance.series} benchmark={analytics.benchmark} /></article>
    <div className="analytics-two-column">
      <article className="panel period-panel"><div className="panel-head"><div><p className="panel-kicker">WINDOWS</p><h2>Return by period</h2></div></div><dl className="analytics-list"><div><dt>Today</dt><dd className={(performance.returnTodayPct ?? 0) >= 0 ? 'positive' : 'negative'}>{percent(performance.returnTodayPct)}</dd></div><div><dt>7 days</dt><dd className={(performance.returnWeekPct ?? 0) >= 0 ? 'positive' : 'negative'}>{percent(performance.returnWeekPct)}</dd></div><div><dt>30 days</dt><dd className={(performance.returnMonthPct ?? 0) >= 0 ? 'positive' : 'negative'}>{percent(performance.returnMonthPct)}</dd></div><div><dt>Since inception</dt><dd className={performance.returnSinceStartPct >= 0 ? 'positive' : 'negative'}>{percent(performance.returnSinceStartPct)}</dd></div></dl></article>
      <article className="panel methodology-panel"><div className="panel-head"><div><p className="panel-kicker">QUALITY</p><h2>Metric reliability</h2></div><span className={`health-pill ${analytics.health.historyPoints >= 20 ? 'ok' : ''}`}>{analytics.health.historyPoints} points</span></div><p>{analytics.health.note}</p><ul><li>Returns use only actually recorded snapshots.</li><li>Benchmark uses daily SPY closes.</li><li>Periods without enough history are explicitly shown as unavailable.</li></ul></article>
    </div>
  </section>;
}

function RiskView({ state, analytics }: { state: DashboardState; analytics: PortfolioAnalytics | null }) {
  if (!analytics) return <AnalyticsLoading />;
  const risk = analytics.risk;
  return <section className="analytics-view">
    <div className="metrics-grid analytics-metrics">
      <MetricCard label="Loss to stops" value={money(risk.lossAtStopsCents)} detail={`${risk.protectedPositions} protected positions`} tone={risk.lossAtStopsCents > 0 ? 'negative' : 'neutral'} />
      <MetricCard label="Unprotected value" value={money(risk.unprotectedValueCents)} detail={`${risk.unprotectedPositions} positions without stop`} tone={risk.unprotectedPositions ? 'negative' : 'neutral'} />
      <MetricCard label="Largest position" value={`${risk.largestPositionPct.toFixed(1)}%`} detail={`Top 5: ${risk.topFiveConcentrationPct.toFixed(1)}%`} tone={risk.largestPositionPct >= 25 ? 'negative' : 'neutral'} />
      <MetricCard label="Annualized volatility" value={risk.annualizedVolatilityPct === null ? 'Insufficient data' : `${risk.annualizedVolatilityPct.toFixed(1)}%`} detail={`Beta SPY: ${risk.betaVsSpy === null ? '—' : risk.betaVsSpy.toFixed(2)}`} />
    </div>
    <div className="analytics-two-column risk-top-grid">
      <article className="panel alerts-panel"><div className="panel-head"><div><p className="panel-kicker">GUARDRAILS</p><h2>Active alerts</h2></div><span className="count-chip">{analytics.alerts.length}</span></div><div className="alerts-list">{analytics.alerts.map((alert, index) => <div className={`alert-row ${alert.severity.toLowerCase()}`} key={`${alert.title}-${index}`}><span>{alert.severity === 'HIGH' ? '!' : alert.severity === 'MEDIUM' ? '•' : 'i'}</span><p><strong>{alert.title}</strong><small>{alert.detail}</small></p></div>)}{!analytics.alerts.length ? <div className="all-clear"><span>✓</span><p><strong>No material alerts</strong><small>Stops, concentration, and quotes are within limits.</small></p></div> : null}</div></article>
      <article className="panel scenario-panel"><div className="panel-head"><div><p className="panel-kicker">STRESS TEST</p><h2>Linear scenarios</h2></div></div><div className="scenario-list">{risk.scenarios.map((scenario) => <div key={scenario.shockPct}><strong>{scenario.shockPct}% market</strong><span className="negative">{money(scenario.estimatedPnlCents)}</span><em>{money(scenario.estimatedEquityCents)} equity</em></div>)}</div><p className="panel-note">Simple estimate applied only to invested value; it does not model correlation, gaps, or liquidity.</p></article>
    </div>
    <article className="panel table-panel"><div className="panel-head"><div><p className="panel-kicker">RISK BY POSITION</p><h2>Stops, targets, and capital at risk</h2></div></div><div className="table-wrap"><table><thead><tr><th>Asset</th><th>Stop</th><th>Stop distance</th><th>Target</th><th>Target distance</th><th>Capital at risk</th><th>Quote age</th></tr></thead><tbody>{analytics.positions.map((position) => <tr key={position.symbol}><td><strong>{position.symbol}</strong></td><td className={position.stopPriceCents ? '' : 'negative'}>{position.stopPriceCents ? money(position.stopPriceCents) : 'No stop'}</td><td>{position.stopDistancePct === null ? '—' : percent(position.stopDistancePct)}</td><td>{position.targetPriceCents ? money(position.targetPriceCents) : 'No target'}</td><td>{position.targetDistancePct === null ? '—' : percent(position.targetDistancePct)}</td><td>{position.capitalAtRiskCents === null ? 'Unlimited' : money(position.capitalAtRiskCents)}</td><td>{position.quoteAgeMinutes === null ? '—' : `${position.quoteAgeMinutes.toFixed(0)} min`}</td></tr>)}{!analytics.positions.length ? <tr><td colSpan={7} className="empty-state"><strong>No positions to analyze</strong><span>Metrics will appear after the first fill.</span></td></tr> : null}</tbody></table></div></article>
    <div className="analytics-two-column">
      <article className="panel correlations-panel"><div className="panel-head"><div><p className="panel-kicker">60D CORRELATION</p><h2>Concentrated pairs</h2></div></div><div className="correlation-list">{risk.highCorrelationPairs.map((pair) => <div key={`${pair.left}-${pair.right}`}><span>{pair.left} / {pair.right}</span><strong>{pair.correlation.toFixed(2)}</strong><i><b style={{ width: `${Math.abs(pair.correlation) * 100}%` }} /></i></div>)}{!risk.highCorrelationPairs.length ? <p>No pairs above |0.75| or insufficient history.</p> : null}</div></article>
      <article className="panel health-panel"><div className="panel-head"><div><p className="panel-kicker">SYSTEM</p><h2>Data health</h2></div><span className={`health-pill ${analytics.health.yahoo === 'OK' && analytics.health.staleQuotes === 0 ? 'ok' : ''}`}>{analytics.health.yahoo}</span></div><dl className="analytics-list"><div><dt>Yahoo history</dt><dd>{analytics.health.yahoo}</dd></div><div><dt>Stale quotes</dt><dd>{analytics.health.staleQuotes}</dd></div><div><dt>Oldest age</dt><dd>{analytics.health.quoteAgeMinutes === null ? '—' : `${analytics.health.quoteAgeMinutes.toFixed(0)} min`}</dd></div><div><dt>Trigger monitor</dt><dd className="positive">Active on this screen</dd></div></dl></article>
    </div>
    <article className="panel calendar-panel"><div className="panel-head"><div><p className="panel-kicker">CALENDAR</p><h2>Registered events</h2></div><span className="count-chip">{state.corporateActions.length}</span></div><div className="calendar-events">{state.corporateActions.slice(0, 8).map((event) => <div key={event.id}><time>{event.effective_date}</time><strong>{event.symbol}</strong><span>{event.action_type}</span><em>{event.value_text}</em></div>)}{!state.corporateActions.length ? <p>No dividend or split registered.</p> : null}</div><p className="panel-note">Automatic earnings and ex-dividend dates require an authenticated fundamentals provider; public Yahoo does not expose these fields reliably.</p></article>
  </section>;
}

function PortfolioCommandBar({ state, activeTab, onNavigate }: { state: DashboardState; activeTab: Tab; onNavigate: (tab: Tab) => void }) {
  return <nav className="portfolio-command-bar" aria-label="Portfolio monitor navigation"><button type="button" className="portfolio-command-home" onClick={() => onNavigate('overview')} aria-label="Open portfolio monitor">PORT &lt;GO&gt;</button><button type="button" className={`portfolio-command-link ${activeTab === 'overview' ? 'active' : ''}`} aria-current={activeTab === 'overview' ? 'page' : undefined} onClick={() => onNavigate('overview')}><b>1</b> POSITIONS</button><button type="button" className={`portfolio-command-link ${activeTab === 'risk' ? 'active' : ''}`} aria-current={activeTab === 'risk' ? 'page' : undefined} onClick={() => onNavigate('risk')}><b>2</b> RISK</button><button type="button" className={`portfolio-command-link ${activeTab === 'orders' ? 'active' : ''}`} aria-current={activeTab === 'orders' ? 'page' : undefined} onClick={() => onNavigate('orders')}><b>3</b> ORDERS</button><button type="button" className={`portfolio-command-link ${activeTab === 'activity' ? 'active' : ''}`} aria-current={activeTab === 'activity' ? 'page' : undefined} onClick={() => onNavigate('activity')}><b>4</b> HISTORY</button><button type="button" className={`portfolio-command-link ${activeTab === 'news' ? 'active' : ''}`} aria-current={activeTab === 'news' ? 'page' : undefined} onClick={() => onNavigate('news')}><b>5</b> NEWS</button><em>{state.market.isOpen ? 'LIVE' : 'CLOSED'} · USD</em></nav>;
}

function PositionsTable({ state, analytics, activeTab, onNavigate, onReduce, onOpen }: { state: DashboardState; analytics: PortfolioAnalytics | null; activeTab: Tab; onNavigate: (tab: Tab) => void; onReduce: (symbol: string, pct: number) => void; onOpen: (symbol: string) => void }) {
  const totalCostBasis = state.positions.reduce((total, position) => total + Math.round(Math.abs(position.quantityMicros) * position.averageCostCents / 1_000_000), 0);
  const totalUnrealized = state.positions.reduce((total, position) => total + position.unrealizedPnlCents, 0);
  const totalReturnPct = totalCostBasis > 0 ? totalUnrealized / totalCostBasis * 100 : 0;
  const largestPosition = state.positions.reduce<(typeof state.positions)[number] | null>((largest, position) => !largest || position.allocationPct > largest.allocationPct ? position : largest, null);
  const analyticsBySymbol = new Map(analytics?.positions.map((position) => [position.symbol, position]) ?? []);

  return <article className="panel table-panel portfolio-terminal" id="portfolio-monitor">
    <PortfolioCommandBar state={state} activeTab={activeTab} onNavigate={onNavigate} />
    <div className="portfolio-titlebar"><div><p>PAPER USD // CONSOLIDATED PORTFOLIO</p><h2>Position monitor</h2></div><div className="portfolio-asof"><span>AS OF</span><strong>{state.market.newYorkTime}</strong></div></div>
    <div className="portfolio-summary" aria-label="Portfolio summary">
      <div><span>MV TOTAL</span><strong>{money(state.account.marketValueCents)}</strong><small>MARKET VALUE</small></div>
      <div><span>COST BASIS</span><strong>{money(totalCostBasis)}</strong><small>BOOK COST</small></div>
      <div><span>UNREALIZED P&amp;L</span><strong className={totalUnrealized >= 0 ? 'positive' : 'negative'}>{totalUnrealized >= 0 ? '+' : ''}{money(totalUnrealized)}</strong><small className={totalReturnPct >= 0 ? 'positive' : 'negative'}>{totalReturnPct >= 0 ? '+' : ''}{totalReturnPct.toFixed(2)}%</small></div>
      <div><span>CASH AVAIL.</span><strong>{money(state.account.availableCashCents)}</strong><small>{(100 - state.account.exposurePct).toFixed(1)}% LIQUIDITY</small></div>
      <div><span>LARGEST POSITION</span><strong>{largestPosition?.symbol ?? '—'}</strong><small>{largestPosition ? `${largestPosition.allocationPct.toFixed(1)}% OF EQUITY` : 'NO EXPOSURE'}</small></div>
    </div>
    <div className="table-wrap"><table className="portfolio-table analytics-positions" aria-label="Open portfolio positions"><thead><tr><th>#</th><th>Security</th><th className="numeric">Quantity</th><th className="numeric">Avg Px</th><th className="numeric">Last Px</th><th className="numeric">Day P&amp;L</th><th className="numeric">Total P&amp;L</th><th className="numeric">Return</th><th className="numeric">Contrib.</th><th>Stop / Target</th><th>Weight</th><th className="numeric">Days</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{state.positions.map((position, index) => {
      const costBasis = Math.round(Math.abs(position.quantityMicros) * position.averageCostCents / 1_000_000);
      const returnPct = costBasis > 0 ? position.unrealizedPnlCents / costBasis * 100 : 0;
      const detail = analyticsBySymbol.get(position.symbol);
      return <tr key={position.symbol}>
        <td className="row-number">{String(index + 1).padStart(2, '0')}</td>
        <td><button type="button" className="terminal-security security-detail-button" onClick={() => onOpen(position.symbol)} aria-label={`Open details for position ${position.symbol}`}><strong>{position.symbol}</strong><small>{position.direction} · {position.assetClass} · {position.exchange || position.quoteSource} · {compactDate(position.quoteObservedAt)}</small></button></td>
        <td className="numeric">{shares(Math.abs(position.quantityMicros))}</td><td className="numeric">{priceMoney(position.averageCostCents)}</td><td className="numeric last-price">{priceMoney(position.lastPriceCents)}</td><td className={`numeric ${(detail?.dayPnlCents ?? 0) >= 0 ? 'positive' : 'negative'}`}>{detail?.dayPnlCents === null || detail?.dayPnlCents === undefined ? '—' : `${detail.dayPnlCents >= 0 ? '+' : ''}${money(detail.dayPnlCents)}`}</td><td className={`numeric ${position.unrealizedPnlCents >= 0 ? 'positive' : 'negative'}`}>{position.unrealizedPnlCents >= 0 ? '+' : ''}{money(position.unrealizedPnlCents)}</td><td className={`numeric ${returnPct >= 0 ? 'positive' : 'negative'}`}>{returnPct >= 0 ? '+' : ''}{returnPct.toFixed(2)}%</td><td className={`numeric ${(detail?.contributionPct ?? 0) >= 0 ? 'positive' : 'negative'}`}>{detail ? percent(detail.contributionPct, 1) : '—'}</td><td><div className="protection-cell"><span className={detail?.stopPriceCents ? '' : 'missing'}>{detail?.stopPriceCents ? `S ${priceMoney(detail.stopPriceCents)}` : 'NO STOP'}</span><small>{detail?.targetPriceCents ? `T ${priceMoney(detail.targetPriceCents)}` : 'No target'}</small></div></td><td><div className="terminal-weight"><span>{position.allocationPct.toFixed(1)}%</span><i><b style={{ width: `${Math.min(100, position.allocationPct)}%` }} /></i></div></td><td className="numeric">{detail?.daysHeld ?? '—'}</td><td><button className="row-action" onClick={() => onReduce(position.symbol, 50)}>RED 50</button></td>
      </tr>;
    })}{!state.positions.length ? <tr><td colSpan={13} className="terminal-empty"><strong>NO ACTIVE POSITIONS</strong><span>Type an instruction in the ticket to start the simulated portfolio.</span><kbd>ORDER &lt;GO&gt;</kbd></td></tr> : null}</tbody></table></div>
    <div className="portfolio-statusbar"><span><i className={state.market.isOpen ? 'live' : ''} /> {state.market.label.toUpperCase()}</span><span>{state.positions.length} SECURITIES</span><span>GROSS EXP {state.account.exposurePct.toFixed(1)}%</span><span>P&amp;L REAL {money(state.account.realizedPnlCents)}</span><em>DATA: LOCAL / BINANCE / YAHOO</em></div>
  </article>;
}

function MarketIntelligencePreview({ intelligence, loading, onOpen }: { intelligence: MarketIntelligence | null; loading: boolean; onOpen: () => void }) {
  const headlines = intelligence?.news.slice(0, 6) ?? [];
  const events = intelligence?.calendar.slice(0, 6) ?? [];
  return <section className="intelligence-preview" aria-label="News and economic calendar">
    <article className="panel intelligence-preview-card"><div className="panel-head"><div><p className="panel-kicker">INTEL // FJ + GDELT + OFFICIAL + YAHOO</p><h2>Market and geopolitical news</h2></div><button type="button" className="preview-open" onClick={onOpen}>VIEW ALL &lt;GO&gt;</button></div><div className="preview-news-list">{headlines.map((item) => <div className={`impact-${item.impact.toLowerCase()}`} key={item.id}><time>{compactDate(item.publishedAt)}</time><span className={item.category === "GEOPOLITICS" ? "geo" : ""}>{item.category === "GEOPOLITICS" ? "GEO" : "MKT"}</span><p>{item.link ? <a href={item.link} target="_blank" rel="noopener noreferrer">{item.title}</a> : item.title}<small>{item.impact === "HIGH" ? "HIGH IMPACT · " : ""}{item.source}{item.portfolioRelated ? " · PORTFOLIO" : ""}</small></p></div>)}{!headlines.length ? <div className="preview-intelligence-empty"><strong>{loading ? "UPDATING NEWS..." : "NO NEWS AVAILABLE"}</strong><span>Checking open sources, local history, and Yahoo.</span></div> : null}</div></article>
    <article className="panel intelligence-preview-card calendar-preview"><div className="panel-head"><div><p className="panel-kicker">ECONOMIC CALENDAR // FJ LIVE + NASDAQ</p><h2>Upcoming macro events</h2></div><button type="button" className="preview-open" onClick={onOpen}>OPEN &lt;GO&gt;</button></div><div className="preview-calendar-list">{events.map((event) => <div key={event.id}><time>{compactDate(event.scheduledAt)}</time><strong>{event.countryCode}</strong><span className={`impact-${event.impact.toLowerCase().replace(/[^a-z0-9]/g, "")}`}>{event.impact}</span><p>{event.title}<small>{event.source}</small></p><em>{event.actual ?? event.forecast ?? "—"}</em></div>)}{!events.length ? <div className="preview-intelligence-empty"><strong>{loading ? "UPDATING CALENDAR..." : "CALENDAR UNAVAILABLE"}</strong><span>Brok.ai will retry through the public Nasdaq snapshot.</span></div> : null}</div></article>
  </section>;
}

function NewsView({ state, intelligence, loading, onRefresh, onNavigate }: { state: DashboardState; intelligence: MarketIntelligence | null; loading: boolean; onRefresh: () => Promise<void>; onNavigate: (tab: Tab) => void }) {
  const [filter, setFilter] = useState<"ALL" | "HIGH" | "MARKET" | "GEOPOLITICS" | "PORTFOLIO">("ALL");
  const news = intelligence?.news.filter((item) => filter === "ALL" || (filter === "HIGH" && item.impact === "HIGH") || (filter === "PORTFOLIO" && item.portfolioRelated) || item.category === filter) ?? [];
  const statusLabel = intelligence?.status.connection === "DELAYED" ? "STREAM · DELAY 10M" : intelligence?.status.connection === "OFFLINE" ? "STREAM OFFLINE" : "KEY PENDING";
  return <section className="market-intelligence" aria-labelledby="market-intelligence-title">
    <article className="panel intelligence-terminal">
      <PortfolioCommandBar state={state} activeTab="news" onNavigate={onNavigate} />
      <header className="intelligence-titlebar"><div><p>INTEL &lt;GO&gt; // FJ + GDELT + OFFICIAL + YAHOO</p><h2 id="market-intelligence-title">Market and geopolitics</h2></div><div className="intelligence-status"><span className={intelligence?.status.connection === "DELAYED" ? "online" : ""}>{statusLabel}</span><small>{intelligence?.status.lastReceivedAt ? `LAST PACKET ${compactDate(intelligence.status.lastReceivedAt)}` : "WAITING FOR STREAM"}</small></div></header>
      {!intelligence?.status.configured ? <div className="provider-callout" role="status"><strong>FinancialJuice is not configured yet</strong><span>Copy <code>.env.example</code> to <code>.env.local</code>, set <code>FINANCIALJUICE_API_KEY</code> and restart Brok.ai. GDELT, official feeds, and Yahoo remain active.</span></div> : null}
      {intelligence?.status.configured && intelligence.status.connection === "OFFLINE" ? <div className="provider-callout warning" role="status"><strong>Stream temporarily offline</strong><span>{intelligence.status.message} Previously received data remains saved locally.</span></div> : null}
      <div className="news-toolbar"><div role="group" aria-label="Filter news">{([['ALL', 'ALL'], ['HIGH', 'HIGH IMPACT'], ['MARKET', 'MARKET'], ['GEOPOLITICS', 'GEOPOLITICS'], ['PORTFOLIO', 'PORTFOLIO']] as const).map(([key, label]) => <button key={key} type="button" className={filter === key ? "active" : ""} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div><button type="button" className="news-refresh" disabled={loading} onClick={() => void onRefresh()}>{loading ? "UPDATING..." : "↻ REFRESH"}</button></div>
      <div className="news-feed" aria-live="polite">
        {news.map((item) => <article className={`news-row impact-${item.impact.toLowerCase()}`} key={item.id}><time>{item.publishedAt ? compactDate(item.publishedAt) : "—"}</time><span className={`news-category ${item.category.toLowerCase()}`}>{item.category === "GEOPOLITICS" ? "GEO" : "MKT"}</span><div>{item.impact === "HIGH" ? <span className="news-impact">HIGH IMPACT</span> : null}<h3>{item.link ? <a href={item.link} target="_blank" rel="noopener noreferrer">{item.title}</a> : item.title}</h3>{item.description ? <p>{item.description}</p> : null}<small>{item.source}{item.labels.length ? ` · ${item.labels.slice(0, 4).join(" · ")}` : ""}{item.portfolioRelated ? " · PORTFOLIO" : ""}</small></div></article>)}
        {!loading && !news.length ? <div className="intelligence-empty"><strong>NO NEWS IN THIS FILTER</strong><span>{state.positions.length ? "Yahoo will be checked again on the next refresh." : "Open a position to enable Yahoo fallback by ticker."}</span></div> : null}
        {loading && !intelligence ? <div className="intelligence-empty"><strong>LOADING INTELLIGENCE...</strong><span>Checking local history and portfolio tickers.</span></div> : null}
      </div>
    </article>
    <article className="panel economic-calendar"><div className="panel-head"><div><p className="panel-kicker">ECONOMIC CALENDAR // FINANCIALJUICE LIVE + NASDAQ SNAPSHOT</p><h2>Upcoming macro events</h2></div><span className="count-chip">{intelligence?.calendar.length ?? 0} events</span></div><div className="table-wrap"><table><thead><tr><th>Date / time</th><th>Country</th><th>Impact</th><th>Event</th><th>Actual</th><th>Consensus</th><th>Previous</th><th>Source</th></tr></thead><tbody>{intelligence?.calendar.map((event) => <tr key={event.id}><td>{compactDate(event.scheduledAt)}</td><td><strong>{event.countryCode}</strong></td><td><span className={`impact-badge impact-${event.impact.toLowerCase().replace(/[^a-z0-9]/g, "")}`}>{event.impact}</span></td><td>{event.title}</td><td>{event.actual ?? "—"}</td><td>{event.forecast ?? "—"}</td><td>{event.previous ?? "—"}</td><td><span className="calendar-source">{event.source}</span></td></tr>)}{!intelligence?.calendar.length ? <tr><td colSpan={8} className="empty-state"><strong>Calendar temporarily unavailable</strong><span>The Nasdaq snapshot will be checked again; FinancialJuice updates remain active.</span></td></tr> : null}</tbody></table></div></article>
  </section>;
}

function OrdersTable({ orders, onCancel, compact = false }: { orders: DashboardState['openOrders']; onCancel: (id: string) => void; compact?: boolean }) {
  return <article className="panel table-panel"><div className="panel-head"><div><p className="panel-kicker">EXECUTION</p><h2>Pending orders</h2></div><span className="count-chip live">{orders.length} open</span></div><div className="table-wrap"><table><thead><tr><th>Asset</th><th>Side</th><th>Type</th><th>Quantity</th><th>Trigger</th><th>Role</th><th>Created</th><th /></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td><strong>{order.symbol}</strong></td><td><span className={`side-badge ${order.side.toLowerCase()}`}>{order.side}</span></td><td>{order.order_type}</td><td>{shares(order.remaining_micros)}</td><td>{order.trigger_price_cents ? money(order.trigger_price_cents) : 'Market'}</td><td>{order.role.replace('_', ' ')}</td><td>{compactDate(order.created_at)}</td><td><button className="cancel-button" onClick={() => onCancel(order.id)}>Cancel</button></td></tr>)}{!orders.length ? <tr><td colSpan={8} className="empty-state"><strong>No pending orders</strong><span>Market orders are processed as soon as they are confirmed.</span></td></tr> : null}</tbody></table></div>{compact ? null : <p className="table-footnote">Stops and take profits in the same group are OCO: when one leg executes, the sibling is cancelled.</p>}</article>;
}

function RecentOrders({ state }: { state: DashboardState }) {
  return <article className="panel table-panel"><div className="panel-head"><div><p className="panel-kicker">LIFECYCLE</p><h2>All orders</h2></div></div><div className="table-wrap"><table><thead><tr><th>Asset</th><th>Side</th><th>Type</th><th>Role</th><th>Status</th><th>Average price</th><th>Updated</th></tr></thead><tbody>{state.recentOrders.map((order) => <tr key={order.id}><td><strong>{order.symbol}</strong></td><td>{order.side}</td><td>{order.order_type}</td><td>{order.role}</td><td><span className={`status-badge ${order.status.toLowerCase()}`}>{order.status}</span></td><td>{order.average_fill_price_cents ? money(order.average_fill_price_cents) : '—'}</td><td>{compactDate(order.updated_at)}</td></tr>)}</tbody></table></div></article>;
}

function ActivityView({ state, analytics }: { state: DashboardState; analytics: PortfolioAnalytics | null }) {
  return <section className="analytics-view">{analytics ? <div className="metrics-grid analytics-metrics"><MetricCard label="Fill rate" value={analytics.execution.fillRatePct === null ? '—' : `${analytics.execution.fillRatePct.toFixed(1)}%`} detail={`${analytics.execution.filledOrders} filled`} /><MetricCard label="Turnover" value={`${analytics.execution.turnoverPct.toFixed(1)}%`} detail="Notional traded / equity" /><MetricCard label="Average slippage" value={analytics.execution.averageSlippageBps === null ? '—' : `${analytics.execution.averageSlippageBps.toFixed(1)} bps`} detail="Orders with reference price" tone={(analytics.execution.averageSlippageBps ?? 0) > 0 ? 'negative' : 'neutral'} /><MetricCard label="Accumulated costs" value={money(analytics.execution.feesCents)} detail={`${analytics.execution.cancelledOrders} cancelled · ${analytics.execution.rejectedOrders} rejected`} /></div> : null}<div className="activity-grid"><article className="panel table-panel"><div className="panel-head"><div><p className="panel-kicker">FILLS</p><h2>Executions</h2></div><span className="count-chip">{state.fills.length}</span></div><div className="table-wrap"><table><thead><tr><th>Asset</th><th>Side</th><th>Quantity</th><th>Price</th><th>Notional</th><th>Time</th></tr></thead><tbody>{state.fills.map((fill) => <tr key={fill.id}><td><strong>{fill.symbol}</strong></td><td><span className={`side-badge ${fill.side.toLowerCase()}`}>{fill.side}</span></td><td>{shares(fill.quantity_micros)}</td><td>{money(fill.price_cents)}</td><td>{money(Math.round(fill.quantity_micros * fill.price_cents / 1_000_000))}</td><td>{compactDate(fill.created_at)}</td></tr>)}{!state.fills.length ? <tr><td colSpan={6} className="empty-state"><strong>No fills</strong><span>Executions will appear here.</span></td></tr> : null}</tbody></table></div></article><article className="panel audit-panel"><div className="panel-head"><div><p className="panel-kicker">AUDIT</p><h2>Timeline</h2></div></div><div className="timeline">{state.audit.map((event) => <div key={event.id}><span className="timeline-dot" /><p><strong>{event.message}</strong><small>{event.event_type.replaceAll('_', ' ')} · {compactDate(event.created_at)}</small></p></div>)}</div></article></div></section>;
}
