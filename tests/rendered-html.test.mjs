import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("ships the Brok.ai product instead of the starter preview", async () => {
  const [page, drawer, layout, css, manifest] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/position-detail-drawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../dist/client/.vite/manifest.json", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /Brok.ai — Local Trading Intelligence/);
  assert.match(layout, /lang="en"/);
  assert.match(page, /PreviewDialog/);
  assert.match(page, /No real order can leave this app/);
  assert.match(page, /\/api\/drafts\/confirm/);
  assert.match(page, /\/api\/analytics/);
  assert.match(page, /PerformanceView/);
  assert.match(page, /RiskView/);
  assert.match(page, /ASSET RESOLVED/);
  assert.match(page, /Related alternatives found/);
  assert.match(page, /Not investment advice/);
  assert.match(page, /\/api\/position-detail/);
  assert.match(drawer, /POSITION &lt;GO&gt; \/\/ DETAIL/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /Full ticker history/);
  assert.match(drawer, /Actions open the mandatory preview/);
  assert.match(drawer, /Latest news about/);
  assert.match(drawer, /Open chart on TradingView/);
  assert.match(drawer, /noopener noreferrer/);
  assert.match(css, /Brok.ai terminal theme/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(manifest, /app\/page\.tsx/);
  assert.doesNotMatch(page + layout, /codex-preview|SkeletonPreview|Your site is taking shape/i);
  await access(new URL("../dist/client/assets/", import.meta.url));
});
