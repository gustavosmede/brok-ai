import type { EconomicEvent, MarketNewsItem, NewsCategory, NewsImpact, NewsSource } from "./market-intelligence.ts";

export type FinancialJuiceNews = { newsId?: string | number; datePublished?: string | number; title?: string; description?: string; labels?: unknown; link?: string };
export type UnknownRecord = Record<string, unknown>;

const geopoliticalTerms = ["attack", "ceasefire", "china", "conflict", "gaza", "geopolit", "iran", "israel", "military", "missile", "nato", "red sea", "russia", "sanction", "tariff", "taiwan", "trade war", "ukraine", "war", "guerra", "sanções", "tarifa", "oriente médio", "opec"];
const urgentTerms = ["breaking", "flash", "alert", "just in", "urgente", "emergency", "unexpectedly", "surpresa", "halts trading", "trading halted", "suspende negociação"];
const systemicTerms = ["interest rate decision", "rate decision", "fomc", "central bank", "cpi", "consumer price", "inflation", "nonfarm payroll", "payrolls", "unemployment rate", "default", "bankruptcy", "bank failure", "capital controls", "ceasefire", "invasion", "airstrike", "missile", "sanction", "tariff", "embargo", "attack", "guerra", "sanções", "falência", "juros", "inflação"];
const companyMovingTerms = ["earnings", "guidance", "profit warning", "acquisition", "merger", "takeover", "dividend cut", "dividend suspension", "fraud", "investigation", "downgrade", "resultados", "projeção", "aquisição", "fusão"];
const officialSources = new Set<NewsSource>(["FED", "ECB", "BLS", "EIA", "SEC_EDGAR"]);

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value);
}

function first(record: UnknownRecord, keys: string[]): unknown {
  return keys.map((key) => record[key]).find((value) => value !== undefined && value !== null && value !== "");
}

function isoDate(value: unknown, fallback = new Date().toISOString()): string {
  if (typeof value === "number") {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }
  const date = new Date(text(value));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function safeUrl(value: unknown): string | null {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

export function parseLabels(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => text(typeof item === "object" && item ? first(item as UnknownRecord, ["name", "label", "title"]) : item)).filter(Boolean);
  const valueText = text(value);
  if (!valueText) return [];
  try {
    const parsed = JSON.parse(valueText) as unknown;
    if (Array.isArray(parsed)) return parseLabels(parsed);
  } catch { /* plain comma-separated label list */ }
  return valueText.split(",").map((item) => item.trim()).filter(Boolean);
}

export function classifyNews(title: string, description = "", itemLabels: string[] = []): NewsCategory {
  const haystack = `${title} ${description} ${itemLabels.join(" ")}`.toLocaleLowerCase("pt-BR");
  return geopoliticalTerms.some((term) => haystack.includes(term)) ? "GEOPOLITICS" : "MARKET";
}

export function assessNewsImpact(item: { title: string; description?: string; labels?: string[]; source: NewsSource; category: NewsCategory; portfolioRelated?: boolean }): NewsImpact {
  const haystack = `${item.title} ${item.description ?? ""} ${(item.labels ?? []).join(" ")}`.toLocaleLowerCase("pt-BR");
  let score = 0;
  if (/^\s*[*!•]/.test(item.title) || urgentTerms.some((term) => haystack.includes(term))) score += 3;
  const systemic = systemicTerms.some((term) => haystack.includes(term));
  if (systemic) score += 3;
  if (companyMovingTerms.some((term) => haystack.includes(term))) score += item.portfolioRelated ? 4 : 2;
  if (officialSources.has(item.source)) score += 1;
  if (item.category === "GEOPOLITICS" && systemic) score += 1;
  if (item.source === "FINANCIALJUICE") score += 1;
  return score >= 4 ? "HIGH" : score >= 2 ? "MEDIUM" : "LOW";
}

export function normalizeFinancialJuiceNews(item: FinancialJuiceNews): MarketNewsItem | null {
  const title = text(item.title);
  if (!title) return null;
  const publishedAt = isoDate(item.datePublished);
  const itemLabels = parseLabels(item.labels);
  const description = text(item.description);
  const category = classifyNews(title, description, itemLabels);
  return { id: `fj-${text(item.newsId) || `${publishedAt}-${title}`}`, publishedAt, title, description, labels: itemLabels, link: safeUrl(item.link), source: "FINANCIALJUICE", category, impact: assessNewsImpact({ title, description, labels: itemLabels, source: "FINANCIALJUICE", category }), portfolioRelated: false };
}

export function normalizeFinancialJuiceCalendar(item: UnknownRecord): EconomicEvent | null {
  const title = text(first(item, ["title", "name", "event", "Title"]));
  const scheduled = first(item, ["date", "dateTime", "scheduledAt", "eventDate", "Date", "timestamp"]);
  if (!title || scheduled === undefined) return null;
  const scheduledAt = isoDate(scheduled, "");
  if (!scheduledAt) return null;
  const rawId = text(first(item, ["eventId", "calendarId", "id"]));
  return { id: `fj-cal-${rawId || `${scheduledAt}-${title}`}`, scheduledAt, title, countryCode: text(first(item, ["countryCode", "country", "CountryCode", "currency"])).toUpperCase() || "—", impact: text(first(item, ["impact", "importance", "level", "ImpID"])).toUpperCase() || "—", actual: text(first(item, ["actual", "Actual"])) || null, forecast: text(first(item, ["forecast", "consensus", "Forecast"])) || null, previous: text(first(item, ["previous", "prior", "Previous"])) || null, status: text(first(item, ["status", "eventStatus"])) || "SCHEDULED", source: "FINANCIALJUICE" };
}
