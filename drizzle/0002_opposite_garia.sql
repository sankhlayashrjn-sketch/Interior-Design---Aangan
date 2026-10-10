ALTER TABLE "reminder_jobs" ALTER COLUMN "designer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "assigned_by" integer;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "assigned_how" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "assign_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "designers" ADD COLUMN "role" text DEFAULT 'designer' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "assign_sla_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "auto_assign_after_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "assignment_mode" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_assigned_by_designers_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."designers"("id") ON DELETE no action ON UPDATE no action;