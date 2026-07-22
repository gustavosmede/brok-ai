type DateParts = { year: number; month: number; day: number; weekday: string; hour: number; minute: number };

function newYorkParts(date: Date): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    weekday: parts.weekday, hour: Number(parts.hour), minute: Number(parts.minute),
  };
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nthWeekday(year: number, month: number, weekday: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day = 1 + ((7 + weekday - first.getUTCDay()) % 7) + (nth - 1) * 7;
  return iso(year, month, day);
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const day = last.getUTCDate() - ((7 + last.getUTCDay() - weekday) % 7);
  return iso(year, month, day);
}

function observedFixed(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function marketHolidays(year: number): Map<string, string> {
  const goodFriday = easterSunday(year);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  return new Map([
    [observedFixed(year, 1, 1), "Ano Novo"],
    [nthWeekday(year, 1, 1, 3), "Martin Luther King Jr. Day"],
    [nthWeekday(year, 2, 1, 3), "Presidents Day"],
    [iso(goodFriday.getUTCFullYear(), goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()), "Good Friday"],
    [lastWeekday(year, 5, 1), "Memorial Day"],
    [observedFixed(year, 6, 19), "Juneteenth"],
    [observedFixed(year, 7, 4), "Independence Day"],
    [nthWeekday(year, 9, 1, 1), "Labor Day"],
    [nthWeekday(year, 11, 4, 4), "Thanksgiving"],
    [observedFixed(year, 12, 25), "Natal"],
  ]);
}

export function getUsEquityMarketStatus(date = new Date()): { isOpen: boolean; label: string; reason: string; newYorkTime: string } {
  const parts = newYorkParts(date);
  const dateKey = iso(parts.year, parts.month, parts.day);
  const holiday = marketHolidays(parts.year).get(dateKey);
  const weekend = parts.weekday === "Sat" || parts.weekday === "Sun";
  const minutes = parts.hour * 60 + parts.minute;
  const withinRegularSession = minutes >= 9 * 60 + 30 && minutes < 16 * 60;
  const isOpen = !weekend && !holiday && withinRegularSession;
  const reason = weekend ? "Weekend" : holiday ?? (withinRegularSession ? "NYSE/Nasdaq regular session" : "Outside regular session");
  return {
    isOpen,
    label: isOpen ? "Market aberto" : "Market fechado",
    reason,
    newYorkTime: `${dateKey} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")} ET`,
  };
}

