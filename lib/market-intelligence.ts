import { ensureDatabase, getDatabase } from "../db";
import { fetchYahooNews } from "./position-detail";
import { assessNewsImpact, classifyNews, normalizeFinancialJuiceCalendar, normalizeFinancialJuiceNews, parseLabels, text, type FinancialJuiceNews, type UnknownRecord } from "./market-intelligence-normalize";
import { fetchNasdaqEconomicCalendar } from "./nasdaq-economic-calendar";
import { fetchGdeltNews, fetchOfficialNews } from "./open-news-sources";

export { classifyNews, normalizeFinancialJuiceCalendar, normalizeFinancialJuiceNews } from "./market-intelligence-normalize";

export type NewsCategory = "MARKET" | "GEOPOLITICS";
export type NewsImpact = "HIGH" | "MEDIUM" | "LOW";
export type NewsSource = "FINANCIALJUICE" | "YAHOO" | "GDELT" | "FED" | "ECB" | "BLS" | "EIA" | "SEC_EDGAR";

export type MarketNewsItem = {
  id: string;
  publishedAt: string;
  title: string;
  description: string;
  labels: string[];
  link: string | null;
  source: NewsSource;
  category: NewsCategory;
  impact: NewsImpact;
  portfolioRelated: boolean;
};

export type EconomicEvent = {
  id: string;
  scheduledAt: string;
  title: string;
  countryCode: string;
  impact: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  status: string;
  source: "FINANCIALJUICE" | "NASDAQ";
};

export type MarketIntelligence = {
  news: MarketNewsItem[];
  calendar: EconomicEvent[];
  status: {
    configured: boolean;
    connection: "DELAYED" | "OFFLINE" | "NOT_CONFIGURED";
    delayMinutes: number;
    lastReceivedAt: string | null;
    message: string;
  };
  yahooFallback: boolean;
};

function portfolioMatch(item: Pick<MarketNewsItem, "title" | "description" | "labels">, holdings: Array<{ symbol: string; name: string }>): boolean {
  const haystack = `${item.title} ${item.description} ${item.labels.join(" ")}`.toUpperCase();
  return holdings.some(({ symbol, name }) => haystack.includes(symbol.toUpperCase()) || (name.length >= 4 && haystack.includes(name.toUpperCase())));
}

export async function ingestFinancialJuiceMessage(message: UnknownRecord): Promise<void> {
  const db = getDatabase();
  await ensureDatabase(db);
  const now = new Date().toISOString();
  const type = text(message.type).toLowerCase();
  const event = text(message.event).toLowerCase();
  const payload = Array.isArray(message.data) ? message.data : message.data && typeof message.data === "object" ? [message.data] : [];

  if (type === "news") {
    for (const raw of payload) {
      if (!raw || typeof raw !== "object") continue;
      const providerId = text((raw as FinancialJuiceNews).newsId);
      if (event === "deleted" && providerId) {
        await db.prepare("DELETE FROM market_news WHERE provider_id = ? OR id = ?").bind(providerId, `fj-${providerId}`).run();
        continue;
      }
      const normalized = normalizeFinancialJuiceNews(raw as FinancialJuiceNews);
      if (!normalized) continue;
      await db.prepare("INSERT INTO market_news (id, provider_id, published_at, title, description, labels_json, link, source, category, raw_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'FINANCIALJUICE', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET published_at=excluded.published_at, title=excluded.title, description=excluded.description, labels_json=excluded.labels_json, link=excluded.link, category=excluded.category, raw_json=excluded.raw_json, received_at=excluded.received_at")
        .bind(normalized.id, text((raw as FinancialJuiceNews).newsId), normalized.publishedAt, normalized.title, normalized.description, JSON.stringify(normalized.labels), normalized.link, normalized.category, JSON.stringify(raw), now).run();
    }
  } else if (type === "calendar") {
    for (const raw of payload) {
      if (!raw || typeof raw !== "object") continue;
      const calendarRecord = raw as UnknownRecord;
      const providerId = text(calendarRecord.eventId ?? calendarRecord.calendarId ?? calendarRecord.id);
      if (event === "deleted" && providerId) {
        await db.prepare("DELETE FROM economic_events WHERE provider_id = ? OR id = ?").bind(providerId, `fj-cal-${providerId}`).run();
        continue;
      }
      const normalized = normalizeFinancialJuiceCalendar(raw as UnknownRecord);
      if (!normalized) continue;
      await db.prepare("INSERT INTO economic_events (id, provider_id, scheduled_at, title, country_code, impact, actual, forecast, previous, status, source, raw_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FINANCIALJUICE', ?, ?) ON CONFLICT(id) DO UPDATE SET scheduled_at=excluded.scheduled_at, title=excluded.title, country_code=excluded.country_code, impact=excluded.impact, actual=excluded.actual, forecast=excluded.forecast, previous=excluded.previous, status=excluded.status, raw_json=excluded.raw_json, received_at=excluded.received_at")
        .bind(normalized.id, normalized.id.slice(7), normalized.scheduledAt, normalized.title, normalized.countryCode, normalized.impact, normalized.actual, normalized.forecast, normalized.previous, normalized.status, JSON.stringify(raw), now).run();
    }
  }

  await db.batch([
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('financialjuice_last_received_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(now),
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('financialjuice_status', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({ type, event, receivedAt: now })),
    db.prepare("DELETE FROM market_news WHERE published_at < datetime('now', '-30 days')"),
    db.prepare("DELETE FROM economic_events WHERE scheduled_at < datetime('now', '-7 days')"),
  ]);
}

type NewsRow = { id: string; published_at: string; title: string; description: string; labels_json: string; link: string | null; source: NewsSource; category: NewsCategory };
type CalendarRow = { id: string; scheduled_at: string; title: string; country_code: string; impact: string; actual: string | null; forecast: string | null; previous: string | null; status: string; source: "FINANCIALJUICE" | "NASDAQ" };

async function refreshNasdaqCalendarIfNeeded(db: D1Database): Promise<void> {
  const [lastSuccess, lastAttempt, upcoming, schemaVersion] = await Promise.all([
    db.prepare("SELECT value FROM app_meta WHERE key='nasdaq_calendar_last_sync'").first<{ value: string }>(),
    db.prepare("SELECT value FROM app_meta WHERE key='nasdaq_calendar_last_attempt'").first<{ value: string }>(),
    db.prepare("SELECT COUNT(*) AS count FROM economic_events WHERE source='NASDAQ' AND scheduled_at >= ?").bind(new Date().toISOString()).first<{ count: number }>(),
    db.prepare("SELECT value FROM app_meta WHERE key='nasdaq_calendar_schema'").first<{ value: string }>(),
  ]);
  const now = Date.now();
  const currentSchema = schemaVersion?.value === "2";
  if (currentSchema && (upcoming?.count ?? 0) > 0 && lastSuccess?.value && now - Date.parse(lastSuccess.value) < 6 * 60 * 60_000) return;
  if (currentSchema && lastAttempt?.value && now - Date.parse(lastAttempt.value) < 15 * 60_000) return;
  const attemptedAt = new Date(now).toISOString();
  await db.prepare("INSERT INTO app_meta (key, value) VALUES ('nasdaq_calendar_last_attempt', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(attemptedAt).run();
  try {
    const events = await fetchNasdaqEconomicCalendar(7, new Date(now));
    await db.prepare("DELETE FROM economic_events WHERE source='NASDAQ'").run();
    const statements = events.map((event) => db.prepare("INSERT INTO economic_events (id, provider_id, scheduled_at, title, country_code, impact, actual, forecast, previous, status, source, raw_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NASDAQ', ?, ?) ON CONFLICT(id) DO UPDATE SET scheduled_at=excluded.scheduled_at, title=excluded.title, country_code=excluded.country_code, impact=excluded.impact, actual=excluded.actual, forecast=excluded.forecast, previous=excluded.previous, status=excluded.status, raw_json=excluded.raw_json, received_at=excluded.received_at")
      .bind(event.id, event.id.slice(7), event.scheduledAt, event.title, event.countryCode, event.impact, event.actual, event.forecast, event.previous, event.status, JSON.stringify(event.raw), attemptedAt));
    for (let index = 0; index < statements.length; index += 50) await db.batch(statements.slice(index, index + 50));
    await db.batch([
      db.prepare("INSERT INTO app_meta (key, value) VALUES ('nasdaq_calendar_last_sync', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(attemptedAt),
      db.prepare("INSERT INTO app_meta (key, value) VALUES ('nasdaq_calendar_schema', '2') ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
      db.prepare("DELETE FROM economic_events WHERE source='NASDAQ' AND scheduled_at < datetime('now', '-1 day')"),
    ]);
  } catch {
    // Calendar failure must never interrupt the portfolio or FinancialJuice feed.
  }
}

async function refreshOpenNewsIfNeeded(db: D1Database): Promise<void> {
  const [lastSuccess, lastAttempt] = await Promise.all([
    db.prepare("SELECT value FROM app_meta WHERE key='open_news_last_sync'").first<{ value: string }>(),
    db.prepare("SELECT value FROM app_meta WHERE key='open_news_last_attempt'").first<{ value: string }>(),
  ]);
  const now = Date.now();
  if (lastSuccess?.value && now - Date.parse(lastSuccess.value) < 15 * 60_000) return;
  if (lastAttempt?.value && now - Date.parse(lastAttempt.value) < 5 * 60_000) return;
  const attemptedAt = new Date(now).toISOString();
  await db.prepare("INSERT INTO app_meta (key, value) VALUES ('open_news_last_attempt', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(attemptedAt).run();

  const results = await Promise.allSettled([fetchGdeltNews(), fetchOfficialNews()]);
  const items = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (!items.length) return;

  const statements = items.map((item) => db.prepare("INSERT INTO market_news (id, provider_id, published_at, title, description, labels_json, link, source, category, raw_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET published_at=excluded.published_at, title=excluded.title, description=excluded.description, labels_json=excluded.labels_json, link=excluded.link, source=excluded.source, category=excluded.category, raw_json=excluded.raw_json, received_at=excluded.received_at")
    .bind(item.id, item.id, item.publishedAt, item.title, item.description, JSON.stringify(item.labels), item.link, item.source, item.category, JSON.stringify(item), attemptedAt));
  for (let index = 0; index < statements.length; index += 50) await db.batch(statements.slice(index, index + 50));
  await db.batch([
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('open_news_last_sync', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(attemptedAt),
    db.prepare("DELETE FROM market_news WHERE source IN ('GDELT','FED','ECB','BLS','EIA','SEC_EDGAR') AND published_at < datetime('now', '-7 days')"),
  ]);
}

export async function getMarketIntelligence(holdings: Array<{ symbol: string; name: string }>, configured: boolean): Promise<MarketIntelligence> {
  const db = getDatabase();
  await ensureDatabase(db);
  await Promise.all([refreshNasdaqCalendarIfNeeded(db), refreshOpenNewsIfNeeded(db)]);
  const [newsResult, calendarResult, lastReceived, lastStatus] = await Promise.all([
    db.prepare("SELECT id, published_at, title, description, labels_json, link, source, category FROM market_news ORDER BY published_at DESC LIMIT 120").all<NewsRow>(),
    db.prepare("SELECT id, scheduled_at, title, country_code, impact, actual, forecast, previous, status, source FROM economic_events WHERE scheduled_at >= datetime('now', '-12 hours') ORDER BY scheduled_at ASC, CASE source WHEN 'FINANCIALJUICE' THEN 0 ELSE 1 END LIMIT 160").all<CalendarRow>(),
    db.prepare("SELECT value FROM app_meta WHERE key='financialjuice_last_received_at'").first<{ value: string }>(),
    db.prepare("SELECT value FROM app_meta WHERE key='financialjuice_status'").first<{ value: string }>(),
  ]);
  const storedNews = (newsResult.results ?? []).map((row): MarketNewsItem => {
    const labels = parseLabels(row.labels_json);
    const portfolioRelated = portfolioMatch({ title: row.title, description: row.description, labels }, holdings);
    return {
      id: row.id, publishedAt: row.published_at, title: row.title, description: row.description,
      labels, link: row.link, source: row.source, category: row.category, portfolioRelated,
      impact: assessNewsImpact({ title: row.title, description: row.description, labels, source: row.source, category: row.category, portfolioRelated }),
    };
  });

  const yahooGroups = await Promise.all(holdings.slice(0, 12).map(async ({ symbol, name }) => {
    try {
      return (await fetchYahooNews(symbol, name)).map((item): MarketNewsItem => ({
        id: `yf-${item.id}`, publishedAt: item.publishedAt, title: item.title, description: "",
        labels: [symbol], link: item.url, source: "YAHOO", category: classifyNews(item.title), portfolioRelated: true,
        impact: assessNewsImpact({ title: item.title, labels: [symbol], source: "YAHOO", category: classifyNews(item.title), portfolioRelated: true }),
      }));
    } catch { return []; }
  }));
  const seen = new Set<string>();
  const news = [...storedNews, ...yahooGroups.flat()].filter((item) => {
    const key = (item.link || item.title).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 120);
  const lastReceivedAt = lastReceived?.value ?? null;
  const fresh = Boolean(lastReceivedAt && Date.now() - Date.parse(lastReceivedAt) < 20 * 60_000);
  let explicitlyClosed = false;
  try {
    const status = JSON.parse(lastStatus?.value ?? "{}") as { type?: string; event?: string };
    explicitlyClosed = status.type === "connection" && status.event === "closed";
  } catch { /* malformed legacy status is treated as unknown */ }
  const seenCalendar = new Set<string>();
  const calendar = [...(calendarResult.results ?? [])].sort((left, right) => Number(right.source === "FINANCIALJUICE") - Number(left.source === "FINANCIALJUICE") || left.scheduled_at.localeCompare(right.scheduled_at)).filter((row) => {
    const timeBucket = Math.round(Date.parse(row.scheduled_at) / (15 * 60_000));
    const key = `${row.country_code}|${row.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}|${timeBucket}`;
    if (seenCalendar.has(key)) return false;
    seenCalendar.add(key);
    return true;
  }).map((row) => ({ id: row.id, scheduledAt: row.scheduled_at, title: row.title, countryCode: row.country_code, impact: row.impact, actual: row.actual, forecast: row.forecast, previous: row.previous, status: row.status, source: row.source })).sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
  return {
    news,
    calendar,
    status: {
      configured,
      connection: !configured ? "NOT_CONFIGURED" : fresh && !explicitlyClosed ? "DELAYED" : "OFFLINE",
      delayMinutes: 10,
      lastReceivedAt,
      message: !configured ? "Adicione a chave gratuita para ativar o stream; fontes abertas e Yahoo continuam ativos." : fresh ? "Stream gratuito ativo com atraso de 10 minutos." : "Stream sem atualização recente; fontes abertas e Yahoo continuam ativos.",
    },
    yahooFallback: yahooGroups.some((group) => group.length > 0),
  };
}
