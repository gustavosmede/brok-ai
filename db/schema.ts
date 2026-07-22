import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const cashLedger = sqliteTable("cash_ledger", {
  id: text("id").primaryKey(),
  deltaCents: integer("delta_cents").notNull(),
  entryType: text("entry_type").notNull(),
  referenceId: text("reference_id"),
  description: text("description").notNull(),
  createdAt: text("created_at").notNull(),
});

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  orderType: text("order_type").notNull(),
  role: text("role").notNull(),
  status: text("status").notNull(),
  quantityMicros: integer("quantity_micros").notNull(),
  remainingMicros: integer("remaining_micros").notNull(),
  triggerPriceCents: integer("trigger_price_cents"),
  averageFillPriceCents: integer("average_fill_price_cents"),
  parentOrderId: text("parent_order_id"),
  ocoGroupId: text("oco_group_id"),
  stopLossBps: integer("stop_loss_bps"),
  takeProfitBps: integer("take_profit_bps"),
  note: text("note"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const fills = sqliteTable("fills", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  quantityMicros: integer("quantity_micros").notNull(),
  priceCents: integer("price_cents").notNull(),
  feeCents: integer("fee_cents").notNull(),
  createdAt: text("created_at").notNull(),
});

export const quotes = sqliteTable("quotes", {
  symbol: text("symbol").primaryKey(),
  priceCents: integer("price_cents").notNull(),
  source: text("source").notNull(),
  observedAt: text("observed_at").notNull(),
  assetClass: text("asset_class").notNull().default("OTHER"),
  name: text("name"),
  exchange: text("exchange"),
});

export const commandDrafts = sqliteTable("command_drafts", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  originalText: text("original_text"),
  intentJson: text("intent_json").notNull(),
  previewJson: text("preview_json").notNull(),
  status: text("status").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const portfolioSnapshots = sqliteTable("portfolio_snapshots", {
  id: text("id").primaryKey(),
  cashCents: integer("cash_cents").notNull(),
  equityCents: integer("equity_cents").notNull(),
  realizedPnlCents: integer("realized_pnl_cents").notNull(),
  unrealizedPnlCents: integer("unrealized_pnl_cents").notNull(),
  createdAt: text("created_at").notNull(),
});

export const snapshotMetadata = sqliteTable("snapshot_metadata", {
  snapshotId: text("snapshot_id").primaryKey(),
  source: text("source").notNull(),
  coveragePct: real("coverage_pct").notNull().default(100),
  note: text("note"),
});

export const priceBars = sqliteTable("price_bars", {
  symbol: text("symbol").notNull(),
  observedAt: text("observed_at").notNull(),
  priceCents: integer("price_cents").notNull(),
  interval: text("interval").notNull(),
  source: text("source").notNull(),
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  message: text("message").notNull(),
  payloadJson: text("payload_json"),
  createdAt: text("created_at").notNull(),
});

export const corporateActions = sqliteTable("corporate_actions", {
  id: text("id").primaryKey(),
  symbol: text("symbol").notNull(),
  actionType: text("action_type").notNull(),
  effectiveDate: text("effective_date").notNull(),
  valueText: text("value_text").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const marketNews = sqliteTable("market_news", {
  id: text("id").primaryKey(),
  providerId: text("provider_id"),
  publishedAt: text("published_at").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  labelsJson: text("labels_json").notNull().default("[]"),
  link: text("link"),
  source: text("source").notNull(),
  category: text("category").notNull(),
  rawJson: text("raw_json"),
  receivedAt: text("received_at").notNull(),
});

export const economicEvents = sqliteTable("economic_events", {
  id: text("id").primaryKey(),
  providerId: text("provider_id"),
  scheduledAt: text("scheduled_at").notNull(),
  title: text("title").notNull(),
  countryCode: text("country_code").notNull(),
  impact: text("impact").notNull(),
  actual: text("actual"),
  forecast: text("forecast"),
  previous: text("previous"),
  status: text("status").notNull(),
  source: text("source").notNull(),
  rawJson: text("raw_json"),
  receivedAt: text("received_at").notNull(),
});
