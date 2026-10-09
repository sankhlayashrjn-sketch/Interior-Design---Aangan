CREATE TABLE "app_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"call_id" integer,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" serial PRIMARY KEY NOT NULL,
	"calcom_uid" text NOT NULL,
	"call_id" integer,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone,
	"status" text DEFAULT 'booked' NOT NULL,
	"host_email" text,
	"host_designer_id" integer,
	"attendee_phone" text,
	"raw" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bookings_calcom_uid_unique" UNIQUE("calcom_uid")
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"source" text DEFAULT 'phone' NOT NULL,
	"caller_phone" text,
	"started_at" timestamp with time zone NOT NULL,
	"duration_sec" integer DEFAULT 0 NOT NULL,
	"transcript" text DEFAULT '' NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'yet_to_be_processed' NOT NULL,
	"flag" text DEFAULT 'none' NOT NULL,
	"caller_name" text,
	"location" text,
	"property_type" text,
	"area_sqft" integer,
	"scope" text,
	"timeline" text,
	"budget" text,
	"score" integer,
	"score_breakdown" jsonb,
	"reason" text,
	"summary" text,
	"already_asked" text,
	"suggested_next_step" text,
	"guardrail_hits" jsonb,
	"linked_call_id" integer,
	"ai_output" jsonb,
	"booking_id" text,
	"booked_slot" timestamp with time zone,
	"booking_status" text,
	"assigned_designer_id" integer,
	"after_hours" boolean DEFAULT false NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" integer,
	"hubspot_contact_id" text,
	"hubspot_deal_id" text
);
--> statement-breakpoint
CREATE TABLE "calls_cost" (
	"call_id" integer PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"ai_cost_inr" double precision DEFAULT 0 NOT NULL,
	"telephony_minutes" double precision DEFAULT 0 NOT NULL,
	"telephony_cost_inr" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "designers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"telegram_chat_id" text,
	"hubspot_owner_id" text,
	"calcom_user" text,
	"active" boolean DEFAULT true NOT NULL,
	"is_escalation" boolean DEFAULT false NOT NULL,
	"rr_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hubspot_sync" (
	"call_id" integer PRIMARY KEY NOT NULL,
	"last_pushed_hash" text,
	"last_seen_stage" text,
	"last_seen_ack_at" text,
	"last_seen_owner" text,
	"dirty" boolean DEFAULT true NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "reminder_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"call_id" integer,
	"designer_id" integer NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"work_start" text DEFAULT '09:00' NOT NULL,
	"work_end" text DEFAULT '18:00' NOT NULL,
	"work_days" jsonb NOT NULL,
	"holidays" jsonb NOT NULL,
	"sla_minutes" integer DEFAULT 60 NOT NULL,
	"slot_alert_minutes" integer DEFAULT 30 NOT NULL,
	"ai_model" text DEFAULT 'claude-sonnet-5-5' NOT NULL,
	"min_commercial_sqft" integer DEFAULT 500 NOT NULL,
	"max_commercial_sqft" integer DEFAULT 3000 NOT NULL,
	"min_lead_weeks" integer DEFAULT 6 NOT NULL,
	"rr_pointer" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"call_id" integer NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason" text NOT NULL,
	"by_designer_id" integer,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_link_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"designer_id" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_host_designer_id_designers_id_fk" FOREIGN KEY ("host_designer_id") REFERENCES "public"."designers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_assigned_designer_id_designers_id_fk" FOREIGN KEY ("assigned_designer_id") REFERENCES "public"."designers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_acknowledged_by_designers_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."designers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls_cost" ADD CONSTRAINT "calls_cost_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubspot_sync" ADD CONSTRAINT "hubspot_sync_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_designer_id_designers_id_fk" FOREIGN KEY ("designer_id") REFERENCES "public"."designers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_overrides" ADD CONSTRAINT "status_overrides_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_overrides" ADD CONSTRAINT "status_overrides_by_designer_id_designers_id_fk" FOREIGN KEY ("by_designer_id") REFERENCES "public"."designers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "telegram_link_codes_designer_id_designers_id_fk" FOREIGN KEY ("designer_id") REFERENCES "public"."designers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calls_external_id_uq" ON "calls" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "calls_status_idx" ON "calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "calls_designer_idx" ON "calls" USING btree ("assigned_designer_id");--> statement-breakpoint
CREATE INDEX "calls_phone_idx" ON "calls" USING btree ("caller_phone");--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "reminder_jobs" USING btree ("state","run_at");