CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`call_id` integer,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`calcom_uid` text NOT NULL,
	`call_id` integer,
	`start_time` integer NOT NULL,
	`end_time` integer,
	`status` text DEFAULT 'booked' NOT NULL,
	`host_email` text,
	`host_designer_id` integer,
	`attendee_phone` text,
	`raw` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`host_designer_id`) REFERENCES `designers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_calcom_uid_unique` ON `bookings` (`calcom_uid`);--> statement-breakpoint
CREATE TABLE `calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`source` text DEFAULT 'phone' NOT NULL,
	`caller_phone` text,
	`started_at` integer NOT NULL,
	`duration_sec` integer DEFAULT 0 NOT NULL,
	`transcript` text DEFAULT '' NOT NULL,
	`raw_payload` text NOT NULL,
	`received_at` integer NOT NULL,
	`status` text DEFAULT 'yet_to_be_processed' NOT NULL,
	`flag` text DEFAULT 'none' NOT NULL,
	`caller_name` text,
	`location` text,
	`property_type` text,
	`area_sqft` integer,
	`scope` text,
	`timeline` text,
	`budget` text,
	`score` integer,
	`score_breakdown` text,
	`reason` text,
	`summary` text,
	`already_asked` text,
	`suggested_next_step` text,
	`guardrail_hits` text,
	`linked_call_id` integer,
	`ai_output` text,
	`booking_id` text,
	`booked_slot` integer,
	`booking_status` text,
	`assigned_designer_id` integer,
	`after_hours` integer DEFAULT false NOT NULL,
	`processed_at` integer,
	`due_at` integer,
	`acknowledged_at` integer,
	`acknowledged_by` integer,
	`hubspot_contact_id` text,
	`hubspot_deal_id` text,
	FOREIGN KEY (`assigned_designer_id`) REFERENCES `designers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`acknowledged_by`) REFERENCES `designers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calls_external_id_uq` ON `calls` (`external_id`);--> statement-breakpoint
CREATE INDEX `calls_status_idx` ON `calls` (`status`);--> statement-breakpoint
CREATE INDEX `calls_designer_idx` ON `calls` (`assigned_designer_id`);--> statement-breakpoint
CREATE INDEX `calls_phone_idx` ON `calls` (`caller_phone`);--> statement-breakpoint
CREATE TABLE `calls_cost` (
	`call_id` integer PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`ai_cost_inr` real DEFAULT 0 NOT NULL,
	`telephony_minutes` real DEFAULT 0 NOT NULL,
	`telephony_cost_inr` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `designers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`telegram_chat_id` text,
	`hubspot_owner_id` text,
	`calcom_user` text,
	`active` integer DEFAULT true NOT NULL,
	`is_escalation` integer DEFAULT false NOT NULL,
	`rr_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hubspot_sync` (
	`call_id` integer PRIMARY KEY NOT NULL,
	`last_pushed_hash` text,
	`last_seen_stage` text,
	`last_seen_ack_at` text,
	`last_synced_at` integer,
	`last_error` text,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reminder_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`call_id` integer,
	`designer_id` integer NOT NULL,
	`run_at` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`designer_id`) REFERENCES `designers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_due_idx` ON `reminder_jobs` (`state`,`run_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`work_start` text DEFAULT '09:00' NOT NULL,
	`work_end` text DEFAULT '18:00' NOT NULL,
	`work_days` text NOT NULL,
	`holidays` text NOT NULL,
	`sla_minutes` integer DEFAULT 60 NOT NULL,
	`ai_model` text DEFAULT 'claude-sonnet-5-5' NOT NULL,
	`min_commercial_sqft` integer DEFAULT 500 NOT NULL,
	`max_commercial_sqft` integer DEFAULT 3000 NOT NULL,
	`min_lead_weeks` integer DEFAULT 6 NOT NULL,
	`rr_pointer` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `status_overrides` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`call_id` integer NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`reason` text NOT NULL,
	`by_designer_id` integer,
	`at` integer NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`by_designer_id`) REFERENCES `designers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `telegram_link_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`designer_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`designer_id`) REFERENCES `designers`(`id`) ON UPDATE no action ON DELETE no action
);
