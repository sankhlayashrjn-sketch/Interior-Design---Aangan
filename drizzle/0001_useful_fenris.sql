CREATE TABLE "call_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"call_id" integer NOT NULL,
	"designer_id" integer,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "recording_url" text;--> statement-breakpoint
ALTER TABLE "call_notes" ADD CONSTRAINT "call_notes_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_notes" ADD CONSTRAINT "call_notes_designer_id_designers_id_fk" FOREIGN KEY ("designer_id") REFERENCES "public"."designers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_notes_call_idx" ON "call_notes" USING btree ("call_id");