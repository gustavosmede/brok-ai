import { env } from "cloudflare:workers";

export function getDatabase(): D1Database {
  if (!env.DB) {
    throw new Error("The local database is not available. Restart the development server.");
  }
  return env.DB;
}

export async function ensureDatabase(db: D1Database = getDatabase()): Promise<void> {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS cash_ledger (id TEXT PRIMARY KEY, delta_cents INTEGER NOT NULL, entry_type TEXT NOT NULL, reference_id TEXT, description TEXT NOT NULL, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL, order_type TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, quantity_micros INTEGER NOT NULL, remaining_micros INTEGER NOT NULL, trigger_price_cents INTEGER, average_fill_price_cents INTEGER, parent_order_id TEXT, oco_group_id TEXT, stop_loss_bps INTEGER, take_profit_bps INTEGER, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS fills (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, quantity_micros INTEGER NOT NULL, price_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS quotes (symbol TEXT PRIMARY KEY, price_cents INTEGER NOT NULL, source TEXT NOT NULL, observed_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS command_drafts (id TEXT PRIMARY KEY, source TEXT NOT NULL, original_text TEXT, intent_json TEXT NOT NULL, preview_json TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS portfolio_snapshots (id TEXT PRIMARY KEY, cash_cents INTEGER NOT NULL, equity_cents INTEGER NOT NULL, realized_pnl_cents INTEGER NOT NULL, unrealized_pnl_cents INTEGER NOT NULL, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS snapshot_metadata (snapshot_id TEXT PRIMARY KEY, source TEXT NOT NULL, coverage_pct REAL NOT NULL DEFAULT 100, note TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS price_bars (symbol TEXT NOT NULL, observed_at TEXT NOT NULL, price_cents INTEGER NOT NULL, interval TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY (symbol, observed_at, interval))"),
    db.prepare("CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, message TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS corporate_actions (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, action_type TEXT NOT NULL, effective_date TEXT NOT NULL, value_text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS market_news (id TEXT PRIMARY KEY, provider_id TEXT, published_at TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', labels_json TEXT NOT NULL DEFAULT '[]', link TEXT, source TEXT NOT NULL, category TEXT NOT NULL, raw_json TEXT, received_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS economic_events (id TEXT PRIMARY KEY, provider_id TEXT, scheduled_at TEXT NOT NULL, title TEXT NOT NULL, country_code TEXT NOT NULL, impact TEXT NOT NULL, actual TEXT, forecast TEXT, previous TEXT, status TEXT NOT NULL, source TEXT NOT NULL, raw_json TEXT, received_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS fills_symbol_idx ON fills (symbol, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_events (created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS snapshots_created_idx ON portfolio_snapshots (created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS price_bars_observed_idx ON price_bars (observed_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS market_news_published_idx ON market_news (published_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS economic_events_scheduled_idx ON economic_events (scheduled_at)"),
  ]);

  const quoteColumns = await db.prepare("PRAGMA table_info(quotes)").all<{ name: string }>();
  const existingQuoteColumns = new Set((quoteColumns.results ?? []).map((column) => column.name));
  if (!existingQuoteColumns.has("asset_class")) await db.prepare("ALTER TABLE quotes ADD COLUMN asset_class TEXT NOT NULL DEFAULT 'OTHER'").run();
  if (!existingQuoteColumns.has("name")) await db.prepare("ALTER TABLE quotes ADD COLUMN name TEXT").run();
  if (!existingQuoteColumns.has("exchange")) await db.prepare("ALTER TABLE quotes ADD COLUMN exchange TEXT").run();

  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('schema_version', '1')"),
    db.prepare("INSERT OR IGNORE INTO cash_ledger (id, delta_cents, entry_type, reference_id, description, created_at) VALUES ('initial-deposit', 10000000, 'DEPOSIT', NULL, 'Capital inicial da conta paper', ?)").bind(now),
    db.prepare("INSERT OR IGNORE INTO audit_events (id, event_type, entity_type, entity_id, message, payload_json, created_at) VALUES ('initial-audit', 'ACCOUNT_CREATED', 'ACCOUNT', 'paper-usd', 'Conta paper criada com US$ 100.000', NULL, ?)").bind(now),
  ]);
}
