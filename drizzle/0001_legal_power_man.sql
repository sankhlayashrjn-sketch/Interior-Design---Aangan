ALTER TABLE `reminder_jobs` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reminder_jobs` ADD `note` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `slot_alert_minutes` integer DEFAULT 30 NOT NULL;