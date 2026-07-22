"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PositionDetail } from "../../lib/position-detail";

type DetailTab = "overview" | "performance" | "risk" | "execution";

function money(cents: number | null, sign = false): string {
  if (cents === null) return "—";
  const formatted = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(cents) / 100);
  return `${sign && cents !== 0 ? cents > 0 ? "+" : "−" : cents < 0 ? "−" : ""}${formatted}`;
}

function priceMoney(cents: number | null): string {
  if (cents === null) return "—";
  const dollars = cents / 100;
  const digits = dollars !== 0 && Math.abs(dollars) < 0.01 ? 8 : 2;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(dollars);
}

function shares(micros: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(micros / 1_000_000);
}

function percent(value: number | null, sign = false): string {
  if (value === null) return "—";
  return `${sign && value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function dateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function tone(value: number | null): string {
  return (value ?? 0) >= 0 ? "positive" : "negative";
}

function PositionChart({ detail }: { detail: PositionDetail }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [period, setPeriod] = useState<30 | 90 | 365>(90);
  const bars = useMemo(() => detail.history.bars.slice(-period), [detail.history.bars, period]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bars.length) return;
    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const guides = [detail.position.averageCostCents, detail.risk.stopPriceCents, detail.risk.targetPriceCents].filter((value): value is number => value !== null);
      const values = [...bars.map((bar) => bar.closeCents), ...guides];
      const min = Math.min(...values) * .995;
      const max = Math.max(...values) * 1.005;
      const range = Math.max(1, max - min);
      const left = 8;
      const right = rect.width - 8;
      const top = 12;
      const bottom = rect.height - 18;
      const x = (index: number) => left + index / Math.max(1, bars.length - 1) * (right - left);
      const y = (value: number) => bottom - (value - min) / range * (bottom - top);
      ctx.strokeStyle = "rgba(180,180,180,.13)";
      ctx.lineWidth = 1;
      for (let index = 1; index < 4; index += 1) {
        const guideY = top + (bottom - top) * index / 4;
        ctx.beginPath(); ctx.moveTo(left, guideY); ctx.lineTo(right, guideY); ctx.stroke();
      }
      const drawGuide = (value: number | null, color: string, dash: number[]) => {
        if (value === null) return;
        ctx.beginPath(); ctx.setLineDash(dash); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      };
      drawGuide(detail.position.averageCostCents, "#ff9f1c", [4, 4]);
      drawGuide(detail.risk.stopPriceCents, "#ff4b5c", [3, 4]);
      drawGuide(detail.risk.targetPriceCents, "#35d46f", [3, 4]);
      ctx.beginPath();
      bars.forEach((bar, index) => index ? ctx.lineTo(x(index), y(bar.closeCents)) : ctx.moveTo(x(index), y(bar.closeCents)));
      ctx.strokeStyle = "#f2f2f2"; ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.stroke();
      const barIndex = new Map(bars.map((bar, index) => [bar.date, index]));
      for (const fill of detail.fills) {
        const index = barIndex.get(fill.created_at.slice(0, 10));
        if (index === undefined) continue;
        ctx.beginPath(); ctx.arc(x(index), y(fill.price_cents), 3, 0, Math.PI * 2); ctx.fillStyle = fill.side === "BUY" ? "#35d46f" : "#ff4b5c"; ctx.fill();
      }
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [bars, detail]);

  return <div className="position-chart-wrap">
    <div className="position-chart-toolbar"><div><span><i className="price-key" />Price</span><span><i className="cost-key" />Average price</span><span><i className="stop-key" />Stop</span><span><i className="target-key" />Target</span></div><div>{([30, 90, 365] as const).map((days) => <button type="button" className={period === days ? "active" : ""} key={days} onClick={() => setPeriod(days)}>{days === 30 ? "1M" : days === 90 ? "3M" : "1A"}</button>)}</div></div>
    {bars.length ? <canvas ref={canvasRef} aria-label={`Price history for ${detail.symbol} with average price, stop, and target`} /> : <div className="position-chart-empty"><strong>History unavailable</strong><span>{detail.history.error ?? "The rest of the position remains available."}</span></div>}
  </div>;
}

function PositionPerformanceChart({ detail }: { detail: PositionDetail }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [period, setPeriod] = useState<30 | 90 | 365>(90);
  const points = useMemo(() => {
    const all = detail.pnl.series;
    const lastTime = Date.parse(all.at(-1)?.createdAt ?? "");
    if (!Number.isFinite(lastTime)) return all;
    const cutoff = lastTime - period * 86_400_000;
    const selected = all.filter((point) => Date.parse(point.createdAt) >= cutoff);
    return selected.length ? selected : all.slice(-1);
  }, [detail.pnl.series, period]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return;
    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const values = points.map((point) => point.pnlCents);
      const times = points.map((point) => Date.parse(point.createdAt));
      const firstTime = Math.min(...times);
      const lastTime = Math.max(...times);
      const timeRange = Math.max(1, lastTime - firstTime);
      const rawMin = Math.min(0, ...values);
      const rawMax = Math.max(0, ...values);
      const observedRange = Math.max(10, rawMax - rawMin);
      const min = rawMin - observedRange * .12;
      const max = rawMax + observedRange * .12;
      const range = Math.max(1, max - min);
      const left = rect.width < 520 ? 58 : 76;
      const right = 14;
      const top = 18;
      const bottom = 31;
      const plotWidth = Math.max(1, rect.width - left - right);
      const plotHeight = Math.max(1, rect.height - top - bottom);
      const x = (time: number, index: number) => points.length === 1 ? left + plotWidth / 2 : left + (timeRange === 1 ? index / (points.length - 1) : (time - firstTime) / timeRange) * plotWidth;
      const y = (value: number) => top + (max - value) / range * plotHeight;
      const formatPnl = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value) / 100)}`;
      const spanHours = timeRange / 3_600_000;
      const timeFormat = new Intl.DateTimeFormat("en-US", spanHours <= 24
        ? { hour: "2-digit", minute: "2-digit" }
        : spanHours <= 24 * 14 ? { day: "2-digit", month: "short", hour: "2-digit" }
          : { day: "2-digit", month: "short" });

      ctx.font = "9px Menlo, monospace";
      ctx.textBaseline = "middle";
      for (let index = 0; index <= 4; index += 1) {
        const value = max - range * index / 4;
        const guideY = top + plotHeight * index / 4;
        ctx.strokeStyle = "rgba(180,180,180,.12)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(left, guideY); ctx.lineTo(rect.width - right, guideY); ctx.stroke();
        ctx.fillStyle = "#8f8f8f";
        ctx.textAlign = "right";
        ctx.fillText(formatPnl(value), left - 8, guideY);
      }
      const tickCount = rect.width < 520 ? 3 : 5;
      ctx.textBaseline = "top";
      for (let index = 0; index < tickCount; index += 1) {
        const along = index / Math.max(1, tickCount - 1);
        const tickX = left + along * plotWidth;
        const tickTime = firstTime + along * timeRange;
        ctx.strokeStyle = "rgba(180,180,180,.09)";
        ctx.beginPath(); ctx.moveTo(tickX, top); ctx.lineTo(tickX, top + plotHeight); ctx.stroke();
        ctx.fillStyle = "#8f8f8f";
        ctx.textAlign = index === 0 ? "left" : index === tickCount - 1 ? "right" : "center";
        ctx.fillText(timeFormat.format(new Date(tickTime)).replace(".", ""), tickX, rect.height - bottom + 10);
      }
      const zeroY = y(0);
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "rgba(255,159,28,.38)";
      ctx.beginPath(); ctx.moveTo(left, zeroY); ctx.lineTo(rect.width - right, zeroY); ctx.stroke();
      ctx.setLineDash([]);

      const coordinates = points.map((point, index) => ({ x: x(times[index], index), y: y(point.pnlCents) }));
      const positive = values.at(-1)! >= 0;
      const color = positive ? "#35d46f" : "#ff4b5c";
      const gradient = ctx.createLinearGradient(0, top, 0, top + plotHeight);
      gradient.addColorStop(0, positive ? "rgba(53,212,111,.20)" : "rgba(255,75,92,.18)");
      gradient.addColorStop(1, positive ? "rgba(53,212,111,.01)" : "rgba(255,75,92,.01)");
      ctx.beginPath();
      ctx.moveTo(coordinates[0].x, zeroY);
      coordinates.forEach((point) => ctx.lineTo(point.x, point.y));
      ctx.lineTo(coordinates.at(-1)!.x, zeroY);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.beginPath();
      coordinates.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
      const last = coordinates.at(-1)!;
      ctx.beginPath(); ctx.arc(last.x, last.y, 5, 0, Math.PI * 2); ctx.fillStyle = positive ? "rgba(53,212,111,.20)" : "rgba(255,75,92,.20)"; ctx.fill();
      ctx.beginPath(); ctx.arc(last.x, last.y, 2.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      ctx.fillStyle = "#8f8f8f";
      ctx.font = "8px Menlo, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("P&L ACUMULADO · USD", left, 2);
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [points]);

  const last = points.at(-1);
  return <div className="position-chart-wrap position-performance-chart">
    <div className="position-chart-toolbar"><div><span><i className={last && last.pnlCents < 0 ? "pnl-key negative" : "pnl-key"} />Position P&amp;L</span>{last ? <strong className={tone(last.pnlCents)}>{money(last.pnlCents, true)} · {percent(last.returnPct, true)}</strong> : null}</div><div>{([30, 90, 365] as const).map((days) => <button type="button" className={period === days ? "active" : ""} key={days} onClick={() => setPeriod(days)}>{days === 30 ? "1M" : days === 90 ? "3M" : "1A"}</button>)}</div></div>
    {points.length ? <canvas ref={canvasRef} aria-label={`Position P&L curve for ${detail.symbol} over time`} /> : <div className="position-chart-empty"><strong>Performance still unavailable</strong><span>The curve starts at the first fill of the open cycle.</span></div>}
  </div>;
}

export function PositionDetailDrawer({ detail, loading, error, onClose, onReduce, onClosePosition }: {
  detail: PositionDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onReduce: (symbol: string, pct: number) => void;
  onClosePosition: (symbol: string) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); document.body.style.overflow = originalOverflow; previous?.focus(); };
  }, [onClose]);

  return <div className="position-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside ref={drawerRef} className="position-drawer" role="dialog" aria-modal="true" aria-labelledby="position-detail-title">
      <header className="position-drawer-header"><div><p>POSITION &lt;GO&gt; // DETAIL</p><h2 id="position-detail-title">{detail?.symbol ?? "Loading position"}</h2>{detail ? <span>{detail.direction} · {detail.name} · {detail.assetClass} · {detail.exchange}</span> : null}</div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close position detail">×</button></header>
      {loading ? <div className="position-drawer-state"><span className="spin">↻</span><strong>Reconciling position</strong><p>Loading asset history, orders, and fills.</p></div> : error ? <div className="position-drawer-state error"><span>!</span><strong>Could not open the position detail</strong><p>{error}</p><button type="button" onClick={onClose}>Back</button></div> : detail ? <>
        <div className="position-live-strip"><span><i />{detail.assetClass === "CRYPTOCURRENCY" ? "24/7" : "YAHOO"}</span><strong>{priceMoney(detail.quote.priceCents)}</strong><em>{detail.quote.source} · {dateTime(detail.quote.observedAt)}{detail.quote.ageMinutes === null ? "" : ` · ${detail.quote.ageMinutes.toFixed(0)} min`}</em></div>
        <nav className="position-detail-tabs" aria-label="Position detail sections">{([['overview', '1 Overview'], ['performance', '2 Performance'], ['risk', '3 Risk'], ['execution', '4 Execution']] as const).map(([key, label]) => <button type="button" key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>)}</nav>
        <div className="position-drawer-body">
          {tab === "overview" ? <>
            <section className="position-detail-metrics"><div><span>MARKET VALUE</span><strong>{money(detail.position.marketValueCents)}</strong><small>{percent(detail.position.allocationPct)} OF EQUITY</small></div><div><span>COST BASIS</span><strong>{money(detail.position.costBasisCents)}</strong><small>AVG PX {priceMoney(detail.position.averageCostCents)}</small></div><div><span>OPEN P&amp;L</span><strong className={tone(detail.pnl.unrealizedCents)}>{money(detail.pnl.unrealizedCents, true)}</strong><small className={tone(detail.pnl.unrealizedPct)}>{percent(detail.pnl.unrealizedPct, true)}</small></div><div><span>QUANTITY · {detail.direction}</span><strong>{shares(Math.abs(detail.position.quantityMicros))}</strong><small>{detail.cycle.daysHeld === null ? "UNDEFINED CYCLE" : `${detail.cycle.daysHeld} DAYS`}</small></div></section>
            <PositionChart detail={detail} />
            <section className="position-facts"><div><span>Cycle opened</span><strong>{dateTime(detail.cycle.openedAt)}</strong></div><div><span>Break-even price</span><strong>{money(detail.risk.breakEvenCents)}</strong></div><div><span>P&amp;L contribution</span><strong className={tone(detail.pnl.contributionPct)}>{percent(detail.pnl.contributionPct, true)}</strong></div><div><span>Total P&amp;L</span><strong className={tone(detail.pnl.totalCents)}>{money(detail.pnl.totalCents, true)}</strong></div></section>
          </> : null}
          {tab === "performance" ? <>
            <section className="position-detail-metrics"><div><span>DAY P&amp;L</span><strong className={tone(detail.pnl.dayCents)}>{money(detail.pnl.dayCents, true)}</strong><small className={tone(detail.pnl.dayPct)}>{percent(detail.pnl.dayPct, true)}</small></div><div><span>UNREALIZED</span><strong className={tone(detail.pnl.unrealizedCents)}>{money(detail.pnl.unrealizedCents, true)}</strong><small>{percent(detail.pnl.unrealizedPct, true)}</small></div><div><span>HIST. REALIZED</span><strong className={tone(detail.pnl.realizedHistoricalCents)}>{money(detail.pnl.realizedHistoricalCents, true)}</strong><small>TICKER LIFETIME</small></div><div><span>TOTAL</span><strong className={tone(detail.pnl.totalCents)}>{money(detail.pnl.totalCents, true)}</strong><small>REAL. + UNREAL.</small></div></section>
            <PositionPerformanceChart detail={detail} />
            <p className="position-method-note">Realized P&L is lifetime history for the ticker. Open return compares current value with the open-cycle cost basis.</p>
          </> : null}
          {tab === "risk" ? <>
            <section className="position-detail-metrics"><div><span>STOP</span><strong className={detail.risk.stopPriceCents ? "" : "negative"}>{money(detail.risk.stopPriceCents)}</strong><small>{detail.risk.stopDistancePct === null ? "UNPROTECTED" : `${percent(detail.risk.stopDistancePct)} ${detail.direction === "SHORT" ? "ABOVE" : "BELOW"}`}</small></div><div><span>ALVO</span><strong>{money(detail.risk.targetPriceCents)}</strong><small>{detail.risk.targetDistancePct === null ? "NO TARGET" : `${percent(detail.risk.targetDistancePct)} ${detail.direction === "SHORT" ? "BELOW" : "ABOVE"}`}</small></div><div><span>CAPITAL AT RISK</span><strong className={detail.risk.capitalAtRiskCents === null ? "negative" : ""}>{detail.risk.capitalAtRiskCents === null ? "UNLIMITED" : money(detail.risk.capitalAtRiskCents)}</strong><small>TO STOP</small></div><div><span>REWARD / RISK</span><strong>{detail.risk.rewardRiskRatio === null ? "—" : `${detail.risk.rewardRiskRatio.toFixed(2)}x`}</strong><small>TARGET VS STOP</small></div></section>
            <section className="position-scenarios"><div className="position-section-title"><span>STRESS TEST</span><strong>Linear position scenarios</strong></div>{detail.risk.scenarios.map((scenario) => <div key={scenario.shockPct}><span className={tone(scenario.shockPct)}>{scenario.shockPct > 0 ? "+" : ""}{scenario.shockPct}%</span><strong className={tone(scenario.pnlCents)}>{money(scenario.pnlCents, true)}</strong><em>{money(scenario.resultingValueCents)} resulting value</em></div>)}</section>
          </> : null}
          {tab === "execution" ? <>
            <section className="position-execution-section"><div className="position-section-title"><span>FILLS</span><strong>Full ticker history</strong></div><div className="position-mini-table"><div className="head"><span>Side</span><span>Quantity</span><span>Price</span><span>Notional</span><span>Date</span></div>{detail.fills.map((fill) => <div key={fill.id}><span className={fill.side === "BUY" ? "positive" : "negative"}>{fill.side}</span><span>{shares(fill.quantity_micros)}</span><span>{money(fill.price_cents)}</span><span>{money(Math.round(fill.quantity_micros * fill.price_cents / 1_000_000))}</span><span>{dateTime(fill.created_at)}</span></div>)}</div></section>
            <section className="position-execution-section"><div className="position-section-title"><span>ORDERS</span><strong>Entries, reductions, and OCO protection</strong></div><div className="position-order-list">{detail.orders.map((order) => <div key={order.id}><span className={`status-badge ${order.status.toLowerCase()}`}>{order.status}</span><strong>{order.side} · {order.order_type}</strong><small>{order.role.replaceAll("_", " ")} · {order.trigger_price_cents ? money(order.trigger_price_cents) : "Market"} · {dateTime(order.created_at)}</small></div>)}</div></section>
            {detail.corporateActions.length ? <section className="position-execution-section"><div className="position-section-title"><span>EVENTOS</span><strong>Corporate actions registradas</strong></div><div className="position-order-list">{detail.corporateActions.map((action) => <div key={action.id}><span>{action.effective_date}</span><strong>{action.action_type}</strong><small>{action.value_text} · {action.status}</small></div>)}</div></section> : null}
          </> : null}
          <section className="position-news-section" aria-labelledby="position-news-title">
            <div className="position-news-heading"><div><span>NEWS // YAHOO</span><h3 id="position-news-title">Latest news about {detail.symbol}</h3><p>Sorted by ticker relevance and recency.</p></div><a href={detail.tradingViewUrl} target="_blank" rel="noopener noreferrer">Open chart on TradingView <b>↗</b></a></div>
            {detail.news.length ? <div className="position-news-list">{detail.news.map((article) => <a key={article.id} href={article.url} target="_blank" rel="noopener noreferrer"><span className={article.priority ? "highlight" : ""}>{article.priority ? "FEATURED" : "RECENT"}</span><div><strong>{article.title}</strong><small>{article.publisher} · {dateTime(article.publishedAt)}</small></div><b aria-hidden="true">↗</b></a>)}</div> : <div className="position-news-empty"><strong>No recent news available</strong><span>{detail.newsError ?? "Yahoo did not return articles related to this ticker."}</span></div>}
            <p className="position-news-disclaimer">External links are informational only. Brok.ai does not summarize or alter headlines and does not use them as recommendations.</p>
          </section>
        </div>
        <footer className="position-drawer-actions"><button type="button" onClick={() => onReduce(detail.symbol, 25)}>Reduce 25%</button><button type="button" onClick={() => onReduce(detail.symbol, 50)}>Reduce 50%</button><button type="button" className="danger" onClick={() => onClosePosition(detail.symbol)}>Close position</button><span>Actions open the mandatory preview.</span></footer>
      </> : null}
    </aside>
  </div>;
}
