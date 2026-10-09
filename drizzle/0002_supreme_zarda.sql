CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `hubspot_sync` ADD `last_seen_owner` text;--> statement-breakpoint
ALTER TABLE `hubspot_sync` ADD `dirty` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `hubspot_sync` ADD `attempts` integer DEFAULT 0 NOT NULL;