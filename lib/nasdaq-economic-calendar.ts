export type NasdaqEconomicEvent = {
  id: string;
  scheduledAt: string;
  title: string;
  countryCode: string;
  impact: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  status: string;
  source: "NASDAQ";
  raw: Record<string, unknown>;
};

type NasdaqRow = { gmt?: string; country?: string; eventName?: string; actual?: string; consensus?: string; previous?: string; description?: string };
type NasdaqResponse = { data?: { rows?: NasdaqRow[] | null } };

const countryCodes: Record<string, string> = {
  "australia": "AU", "brazil": "BR", "canada": "CA", "china": "CN", "euro zone": "EU",
  "france": "FR", "germany": "DE", "india": "IN", "italy": "IT", "japan": "JP",
  "new zealand": "NZ", "south korea": "KR", "spain": "ES", "switzerland": "CH",
  "united kingdom": "GB", "united states": "US",
};

function clean(value: string | undefined): string | null {
  const normalized = (value ?? "").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function dateInNewYork(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

export function newYorkTimeToUtc(date: string, time: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match || !clock) return null;
  const values = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(clock[1]), minute: Number(clock[2]) };
  let guess = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute);
  for (let index = 0; index < 2; index += 1) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? 0);
    const representedAsUtc = Date.UTC(number("year"), number("month") - 1, number("day"), number("hour"), number("minute"));
    guess += Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute) - representedAsUtc;
  }
  return new Date(guess).toISOString();
}

export function inferEconomicImpact(title: string): "HIGH" | "MEDIUM" | "LOW" {
  const value = title.toLowerCase();
  if (/(interest rate|rate decision|cpi|consumer price|gdp|nonfarm|payroll|unemployment rate|employment change|pce|fomc)/.test(value)) return "HIGH";
  if (/(pmi|retail sales|industrial production|trade balance|jobless claims|confidence|ppi|producer price)/.test(value)) return "MEDIUM";
  return "LOW";
}

function hash(value: string): string {
  let result = 5381;
  for (let index = 0; index < value.length; index += 1) result = ((result << 5) + result) ^ value.charCodeAt(index);
  return (result >>> 0).toString(36);
}

export function normalizeNasdaqEvent(date: string, row: NasdaqRow): NasdaqEconomicEvent | null {
  const title = clean(row.eventName);
  const time = clean(row.gmt);
  const scheduledAt = time ? newYorkTimeToUtc(date, time) : null;
  if (!title || !scheduledAt) return null;
  const country = clean(row.country) ?? "—";
  const actual = clean(row.actual);
  return {
    id: `nasdaq-${hash(`${scheduledAt}|${country}|${title}|${clean(row.previous) ?? ""}|${clean(row.consensus) ?? ""}`)}`,
    scheduledAt,
    title,
    countryCode: countryCodes[country.toLowerCase()] ?? country.slice(0, 3).toUpperCase(),
    impact: inferEconomicImpact(title),
    actual,
    forecast: clean(row.consensus),
    previous: clean(row.previous),
    status: actual ? "RELEASED" : "SCHEDULED",
    source: "NASDAQ",
    raw: row as Record<string, unknown>,
  };
}

export async function fetchNasdaqEconomicCalendar(days = 7, now = new Date()): Promise<NasdaqEconomicEvent[]> {
  const dates = [...new Set(Array.from({ length: days }, (_, index) => dateInNewYork(new Date(now.getTime() + index * 86_400_000))))];
  const results = await Promise.allSettled(dates.map(async (date) => {
    // Nasdaq's public calendar endpoint resolves the requested ISO date to the
    // preceding U.S. economic session, so request D+1 and normalize rows as D.
    const requestDate = addCalendarDays(date, 1);
    const response = await fetch(`https://api.nasdaq.com/api/calendar/economicevents?date=${requestDate}`, {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0 Brok.ai/1.0 personal-research" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Nasdaq Calendar respondeu ${response.status}`);
    const payload = await response.json() as NasdaqResponse;
    return (payload.data?.rows ?? []).flatMap((row) => {
      const normalized = normalizeNasdaqEvent(date, row);
      return normalized ? [normalized] : [];
    });
  }));
  const events = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (!events.length) throw new Error("Nasdaq Calendar returned no events");
  return events.sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
}
