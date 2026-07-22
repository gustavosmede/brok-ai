import assert from "node:assert/strict";
import test from "node:test";
import { assessNewsImpact, classifyNews, normalizeFinancialJuiceCalendar, normalizeFinancialJuiceNews } from "../lib/market-intelligence-normalize.ts";

test("classifica geopolítica por título e labels", () => {
  assert.equal(classifyNews("Ceasefire talks resume in Gaza"), "GEOPOLITICS");
  assert.equal(classifyNews("Apple reports quarterly earnings"), "MARKET");
});

test("normaliza notícia do FinancialJuice", () => {
  const item = normalizeFinancialJuiceNews({
    newsId: 42,
    datePublished: "2026-07-19T12:00:00Z",
    title: "Oil rises after OPEC statement",
    description: "Supply remains in focus",
    labels: ["Energy", "Oil"],
    link: "https://example.com/news/42",
  });
  assert.ok(item);
  assert.equal(item.id, "fj-42");
  assert.equal(item.category, "GEOPOLITICS");
  assert.deepEqual(item.labels, ["Energy", "Oil"]);
});

test("normaliza variações comuns do calendário", () => {
  const event = normalizeFinancialJuiceCalendar({
    eventId: "cpi-us",
    dateTime: 1784467800,
    name: "US CPI YoY",
    countryCode: "us",
    importance: "high",
    actual: "2.8%",
    consensus: "2.7%",
    prior: "2.6%",
  });
  assert.ok(event);
  assert.equal(event.id, "fj-cal-cpi-us");
  assert.equal(event.countryCode, "US");
  assert.equal(event.impact, "HIGH");
  assert.equal(event.forecast, "2.7%");
});

test("reserva alto impacto para sinais objetivos", () => {
  assert.equal(assessNewsImpact({ title: "* Fed unexpectedly raises interest rate", source: "FINANCIALJUICE", category: "MARKET" }), "HIGH");
  assert.equal(assessNewsImpact({ title: "Apple opens a new store", source: "YAHOO", category: "MARKET" }), "LOW");
  assert.equal(assessNewsImpact({ title: "Apple cuts earnings guidance", source: "YAHOO", category: "MARKET", portfolioRelated: true }), "HIGH");
});
