import assert from "node:assert/strict";
import test from "node:test";
import { inferEconomicImpact, newYorkTimeToUtc, normalizeNasdaqEvent } from "../lib/nasdaq-economic-calendar.ts";

test("converts Nasdaq Eastern time to UTC with daylight saving time", () => {
  assert.equal(newYorkTimeToUtc("2026-07-21", "08:30"), "2026-07-21T12:30:00.000Z");
  assert.equal(newYorkTimeToUtc("2026-01-15", "08:30"), "2026-01-15T13:30:00.000Z");
});

test("normalizes empty fields and Nasdaq calendar values", () => {
  const event = normalizeNasdaqEvent("2026-07-21", { gmt: "08:30", country: "Canada", eventName: "Core CPI", actual: "&nbsp;", consensus: "2.5%", previous: "2.7%" });
  assert.ok(event);
  assert.equal(event.countryCode, "CA");
  assert.equal(event.scheduledAt, "2026-07-21T12:30:00.000Z");
  assert.equal(event.actual, null);
  assert.equal(event.forecast, "2.5%");
  assert.equal(event.impact, "HIGH");
  assert.equal(event.source, "NASDAQ");
});

test("infers macro impact without replacing FinancialJuice updates", () => {
  assert.equal(inferEconomicImpact("FOMC Interest Rate Decision"), "HIGH");
  assert.equal(inferEconomicImpact("German PPI"), "MEDIUM");
  assert.equal(inferEconomicImpact("Wholesale Inventories"), "LOW");
});
