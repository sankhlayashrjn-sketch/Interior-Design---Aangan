import { integer, real, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const CALL_STATUSES = ["yet_to_be_processed", "qualified", "disqualified", "needs_attention"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_FLAGS = ["none", "existing_client", "no_transcript", "ai_failed", "upset_caller"] as const;
export type CallFlag = (typeof CALL_FLAGS)[number];

export type CriterionKey = "service_fit" | "scale" | "budget" | "location" | "timeline" | "property_dm" | "next_step";
export type Verdict = "pass" | "unclear" | "fail";
export type ScoreBreakdown = Record<CriterionKey, { verdict: Verdict; points: number; max: number; evidence: string }>;

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

export const designers = sqliteTable("designers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  telegramChatId: text("telegram_chat_id"),
  hubspotOwnerId: text("hubspot_owner_id"),
  /** Cal.com username or email, used to map a booking host to this designer. */
  calcomUser: text("calcom_user"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  isEscalation: integer("is_escalation", { mode: "boolean" }).notNull().default(false),
  rrOrder: integer("rr_order").notNull().default(0),
});

/** Single-row table (id = 1). */
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  workStart: text("work_start").notNull().default("09:00"),
  workEnd: text("work_end").notNull().default("18:00"),
  /** ISO weekdays, 1 = Mon ... 7 = Sun. */
  workDays: text("work_days", { mode: "json" }).$type<number[]>().notNull().$defaultFn(() => [1, 2, 3, 4, 5, 6]),
  holidays: text("holidays", { mode: "json" }).$type<string[]>().notNull().$defaultFn(() => []),
  slaMinutes: integer("sla_minutes").notNull().default(60),
  /** Urgent alert this many minutes before a booked slot if still unacknowledged. */
  slotAlertMinutes: integer("slot_alert_minutes").notNull().default(30),
  aiModel: text("ai_model").notNull().default("claude-sonnet-5-5"),
  minCommercialSqft: integer("min_commercial_sqft").notNull().default(500),
  maxCommercialSqft: integer("max_commercial_sqft").notNull().default(3000),
  minLeadWeeks: integer("min_lead_weeks").notNull().default(6),
  rrPointer: integer("rr_pointer").notNull().default(0),
});

export const calls = sqliteTable(
  "calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    externalId: text("external_id").notNull(),
    source: text("source").notNull().default("phone"),
    /** Null when caller ID is withheld. */
    callerPhone: text("caller_phone"),
    startedAt: ts("started_at").notNull(),
    durationSec: integer("duration_sec").notNull().default(0),
    transcript: text("transcript").notNull().default(""),
    rawPayload: text("raw_payload", { mode: "json" }).notNull(),
    receivedAt: ts("received_at").notNull(),

    status: text("status", { enum: CALL_STATUSES }).notNull().default("yet_to_be_processed"),
    flag: text("flag", { enum: CALL_FLAGS }).notNull().default("none"),

    callerName: text("caller_name"),
    location: text("location"),
    propertyType: text("property_type"),
    areaSqft: integer("area_sqft"),
    scope: text("scope"),
    timeline: text("timeline"),
    budget: text("budget"),

    score: integer("score"),
    scoreBreakdown: text("score_breakdown", { mode: "json" }).$type<ScoreBreakdown>(),
    reason: text("reason"),
    summary: text("summary"),
    alreadyAsked: text("already_asked"),
    suggestedNextStep: text("suggested_next_step"),
    guardrailHits: text("guardrail_hits", { mode: "json" }).$type<string[]>(),
    linkedCallId: integer("linked_call_id"),
    /** The validated JSON the AI returned, kept for audit. */
    aiOutput: text("ai_output", { mode: "json" }),

    bookingId: text("booking_id"),
    bookedSlot: ts("booked_slot"),
    bookingStatus: text("booking_status", { enum: ["booked", "rescheduled", "cancelled"] }),

    assignedDesignerId: integer("assigned_designer_id").references(() => designers.id),
    afterHours: integer("after_hours", { mode: "boolean" }).notNull().default(false),
    processedAt: ts("processed_at"),
    dueAt: ts("due_at"),
    acknowledgedAt: ts("acknowledged_at"),
    acknowledgedBy: integer("acknowledged_by").references(() => designers.id),

    hubspotContactId: text("hubspot_contact_id"),
    hubspotDealId: text("hubspot_deal_id"),
  },
  (t) => [
    uniqueIndex("calls_external_id_uq").on(t.externalId),
    index("calls_status_idx").on(t.status),
    index("calls_designer_idx").on(t.assignedDesignerId),
    index("calls_phone_idx").on(t.callerPhone),
  ],
);

/** Cal.com bookings. Kept separately because a booking can arrive before its call is stored. */
export const bookings = sqliteTable("bookings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  calcomUid: text("calcom_uid").notNull().unique(),
  callId: integer("call_id").references(() => calls.id),
  startTime: ts("start_time").notNull(),
  endTime: ts("end_time"),
  status: text("status", { enum: ["booked", "rescheduled", "cancelled"] }).notNull().default("booked"),
  hostEmail: text("host_email"),
  hostDesignerId: integer("host_designer_id").references(() => designers.id),
  attendeePhone: text("attendee_phone"),
  raw: text("raw", { mode: "json" }),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

/** Every manual change of status. Never deleted. */
export const statusOverrides = sqliteTable("status_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  callId: integer("call_id").notNull().references(() => calls.id),
  fromStatus: text("from_status", { enum: CALL_STATUSES }).notNull(),
  toStatus: text("to_status", { enum: CALL_STATUSES }).notNull(),
  reason: text("reason").notNull(),
  byDesignerId: integer("by_designer_id").references(() => designers.id),
  at: ts("at").notNull(),
});

/** Persistent reminder queue. A cron tick picks up rows with state = 'pending' and run_at <= now. */
export const reminderJobs = sqliteTable(
  "reminder_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** sla: unacknowledged after the SLA. digest: 09:00 summary of pending calls. slot: unacknowledged shortly before a booked slot. */
    kind: text("kind", { enum: ["sla", "digest", "slot"] }).notNull(),
    callId: integer("call_id").references(() => calls.id),
    designerId: integer("designer_id").notNull().references(() => designers.id),
    runAt: ts("run_at").notNull(),
    state: text("state", { enum: ["pending", "sent", "cancelled"] }).notNull().default("pending"),
    createdAt: ts("created_at").notNull(),
    sentAt: ts("sent_at"),
    attempts: integer("attempts").notNull().default(0),
    /** What happened: "sent", "cancelled: acknowledged", "failed: ...". */
    note: text("note"),
  },
  (t) => [index("jobs_due_idx").on(t.state, t.runAt)],
);

export const callsCost = sqliteTable("calls_cost", {
  callId: integer("call_id").primaryKey().references(() => calls.id),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  aiCostInr: real("ai_cost_inr").notNull().default(0),
  telephonyMinutes: real("telephony_minutes").notNull().default(0),
  telephonyCostInr: real("telephony_cost_inr").notNull().default(0),
  createdAt: ts("created_at").notNull(),
});

/** Last state pushed to / seen in HubSpot, so the 60s poll detects real changes and doesn't echo our own writes. */
export const hubspotSync = sqliteTable("hubspot_sync", {
  callId: integer("call_id").primaryKey().references(() => calls.id),
  lastPushedHash: text("last_pushed_hash"),
  lastSeenStage: text("last_seen_stage"),
  lastSeenAckAt: text("last_seen_ack_at"),
  lastSeenOwner: text("last_seen_owner"),
  /** True while the app has changes HubSpot has not received yet. The app wins until they are pushed. */
  dirty: integer("dirty", { mode: "boolean" }).notNull().default(true),
  attempts: integer("attempts").notNull().default(0),
  lastSyncedAt: ts("last_synced_at"),
  lastError: text("last_error"),
});

/** Telegram /start linking: one-time code a designer sends to the bot. */
export const telegramLinkCodes = sqliteTable("telegram_link_codes", {
  code: text("code").primaryKey(),
  designerId: integer("designer_id").notNull().references(() => designers.id),
  createdAt: ts("created_at").notNull(),
});

/** Guardrail hits, mock-mode "would have sent" entries, sync errors. */
export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: ts("at").notNull(),
  kind: text("kind").notNull(),
  callId: integer("call_id"),
  detail: text("detail", { mode: "json" }),
});

/** Small key/value store (for example the HubSpot poll cursor). */
export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
