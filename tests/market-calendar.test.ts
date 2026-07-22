import assert from "node:assert/strict";
import test from "node:test";
import { getUsEquityMarketStatus } from "../lib/market-calendar.ts";

test("closes the US equity market on weekends and observed holidays", () => {
  assert.equal(getUsEquityMarketStatus(new Date("2026-07-18T15:00:00Z")).isOpen, false);
  assert.equal(getUsEquityMarketStatus(new Date("2026-07-03T15:00:00Z")).reason, "Independence Day");
});

test("opens during a regular New York weekday session", () => {
  const status = getUsEquityMarketStatus(new Date("2026-07-20T15:00:00Z"));
  assert.equal(status.isOpen, true);
  assert.equal(status.reason, "NYSE/Nasdaq regular session");
});

