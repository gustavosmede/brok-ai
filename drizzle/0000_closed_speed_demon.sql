CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`message` text NOT NULL,
	`payload_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cash_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`delta_cents` integer NOT NULL,
	`entry_type` text NOT NULL,
	`reference_id` text,
	`description` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `command_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`original_text` text,
	`intent_json` text NOT NULL,
	`preview_json` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `corporate_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`action_type` text NOT NULL,
	`effective_date` text NOT NULL,
	`value_text` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fills` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`quantity_micros` integer NOT NULL,
	`price_cents` integer NOT NULL,
	`fee_cents` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`order_type` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`quantity_micros` integer NOT NULL,
	`remaining_micros` integer NOT NULL,
	`trigger_price_cents` integer,
	`average_fill_price_cents` integer,
	`parent_order_id` text,
	`oco_group_id` text,
	`stop_loss_bps` integer,
	`take_profit_bps` integer,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `portfolio_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`cash_cents` integer NOT NULL,
	`equity_cents` integer NOT NULL,
	`realized_pnl_cents` integer NOT NULL,
	`unrealized_pnl_cents` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quotes` (
	`symbol` text PRIMARY KEY NOT NULL,
	`price_cents` integer NOT NULL,
	`source` text NOT NULL,
	`observed_at` text NOT NULL
);
