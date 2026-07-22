import { assessNewsImpact, classifyNews, text } from "./market-intelligence-normalize.ts";
import type { MarketNewsItem, NewsSource } from "./market-intelligence.ts";

type GdeltArticle = {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  sourcecountry?: string;
  language?: string;
};

type RssSource = {
  source: Exclude<NewsSource, "FINANCIALJUICE" | "YAHOO" | "GDELT">;
  url: string;
  labels: string[];
};

const OFFICIAL_FEEDS: RssSource[] = [
  { source: "FED", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", labels: ["FED", "CENTRAL BANK", "OFFICIAL"] },
  { source: "ECB", url: "https://www.ecb.europa.eu/rss/press.html", labels: ["ECB", "CENTRAL BANK", "OFFICIAL"] },
  { source: "BLS", url: "https://www.bls.gov/feed/bls_latest.rss", labels: ["US MACRO", "OFFICIAL"] },
  { source: "EIA", url: "https://www.eia.gov/rss/press_rss.xml", labels: ["ENERGY", "OIL", "OFFICIAL"] },
  { source: "SEC_EDGAR", url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&count=40&output=atom", labels: ["SEC", "FILINGS", "OFFICIAL"] },
];

function safeUrl(value: unknown): string | null {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

function stableId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function isoDate(value: unknown): string {
  const raw = text(value);
  if (/^\d{14}$/.test(raw)) {
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`;
    const gdeltDate = new Date(formatted);
    if (!Number.isNaN(gdeltDate.getTime())) return gdeltDate.toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function element(block: string, names: string[]): string {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match) return decodeXml(match[1]);
  }
  return "";
}

function linkFrom(block: string): string | null {
  const atom = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1];
  return safeUrl(atom ?? element(block, ["link"]));
}

export function normalizeGdeltArticle(article: GdeltArticle): MarketNewsItem | null {
  const title = text(article.title);
  const link = safeUrl(article.url);
  if (!title || !link) return null;
  const publishedAt = isoDate(article.seendate);
  const labels = [text(article.domain), text(article.sourcecountry), text(article.language)].filter(Boolean);
  const category = classifyNews(title, "", labels);
  return {
    id: stableId("gdelt", link),
    publishedAt,
    title,
    description: "",
    labels,
    link,
    source: "GDELT",
    category,
    impact: assessNewsImpact({ title, description: "", labels, source: "GDELT", category }),
    portfolioRelated: false,
  };
}

export function parseRssFeed(xml: string, source: RssSource["source"], sourceLabels: string[]): MarketNewsItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => match[2]);
  return blocks.flatMap((block) => {
    const title = element(block, ["title"]);
    const link = linkFrom(block);
    if (!title || !link) return [];
    const publishedAt = isoDate(element(block, ["pubDate", "published", "updated", "dc:date"]));
    const description = element(block, ["description", "summary", "content"]).slice(0, 600);
    const labels = [...sourceLabels, ...[...block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)].map((match) => decodeXml(match[1])).filter(Boolean)].slice(0, 8);
    const category = classifyNews(title, description, labels);
    return [{
      id: stableId(source.toLowerCase(), link),
      publishedAt,
      title,
      description,
      labels,
      link,
      source,
      category,
      impact: assessNewsImpact({ title, description, labels, source, category }),
      portfolioRelated: false,
    } satisfies MarketNewsItem];
  });
}

export async function fetchGdeltNews(): Promise<MarketNewsItem[]> {
  const query = '(markets OR stocks OR inflation OR "interest rate" OR oil OR bitcoin OR tariff OR sanctions OR war OR conflict)';
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("maxrecords", "60");
  url.searchParams.set("timespan", "1d");
  url.searchParams.set("sort", "HybridRel");
  url.searchParams.set("format", "json");
  const response = await fetch(url, { headers: { "User-Agent": "Brok.ai/1.0 market-intelligence" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`GDELT returned ${response.status}`);
  const payload = await response.json() as { articles?: GdeltArticle[] };
  return (payload.articles ?? []).flatMap((article) => normalizeGdeltArticle(article) ?? []);
}

async function fetchRssSource(feed: RssSource): Promise<MarketNewsItem[]> {
  const userAgent = feed.source === "SEC_EDGAR" ? "Brok.ai/1.0 local-market-research" : "Brok.ai/1.0 market-intelligence";
  const response = await fetch(feed.url, { headers: { "User-Agent": userAgent, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`${feed.source} returned ${response.status}`);
  return parseRssFeed(await response.text(), feed.source, feed.labels);
}

export async function fetchOfficialNews(): Promise<MarketNewsItem[]> {
  const results = await Promise.allSettled(OFFICIAL_FEEDS.map(fetchRssSource));
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}
