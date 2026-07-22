import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGdeltArticle, parseRssFeed } from "../lib/open-news-sources.ts";

test("normaliza data compacta e conflito crítico do GDELT", () => {
  const item = normalizeGdeltArticle({
    title: "Missile attack triggers emergency response",
    url: "https://example.com/geopolitics/1",
    seendate: "20260719143000",
    domain: "example.com",
    sourcecountry: "US",
    language: "English",
  });
  assert.ok(item);
  assert.equal(item.publishedAt, "2026-07-19T14:30:00.000Z");
  assert.equal(item.category, "GEOPOLITICS");
  assert.equal(item.impact, "HIGH");
});

test("lê RSS e Atom sem incorporar HTML no texto", () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[US CPI &amp; markets]]></title><link>https://example.com/cpi</link><pubDate>Sun, 19 Jul 2026 12:00:00 GMT</pubDate><description><![CDATA[<b>Official release</b>]]></description></item></channel></rss>`;
  const atom = `<feed><entry><title>ECB statement</title><link href="https://example.com/ecb"/><updated>2026-07-19T13:00:00Z</updated><summary>Policy update</summary></entry></feed>`;
  const rssItems = parseRssFeed(rss, "BLS", ["OFFICIAL"]);
  const atomItems = parseRssFeed(atom, "ECB", ["OFFICIAL"]);
  assert.equal(rssItems[0]?.title, "US CPI & markets");
  assert.equal(rssItems[0]?.description, "Official release");
  assert.equal(rssItems[0]?.impact, "HIGH");
  assert.equal(atomItems[0]?.link, "https://example.com/ecb");
});
