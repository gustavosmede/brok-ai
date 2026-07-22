CREATE TABLE `economic_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text,
	`scheduled_at` text NOT NULL,
	`title` text NOT NULL,
	`country_code` text NOT NULL,
	`impact` text NOT NULL,
	`actual` text,
	`forecast` text,
	`previous` text,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`raw_json` text,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `market_news` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text,
	`published_at` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`labels_json` text DEFAULT '[]' NOT NULL,
	`link` text,
	`source` text NOT NULL,
	`category` text NOT NULL,
	`raw_json` text,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `price_bars` (
	`symbol` text NOT NULL,
	`observed_at` text NOT NULL,
	`price_cents` integer NOT NULL,
	`interval` text NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshot_metadata` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`coverage_pct` real DEFAULT 100 NOT NULL,
	`note` text
);
--> statement-breakpoint
ALTER TABLE `quotes` ADD `asset_class` text DEFAULT 'OTHER' NOT NULL;--> statement-breakpoint
ALTER TABLE `quotes` ADD `name` text;--> statement-breakpoint
ALTER TABLE `quotes` ADD `exchange` text;