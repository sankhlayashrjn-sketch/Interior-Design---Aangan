import { boolean, doublePrecision, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const CALL_STATUSES = ["yet_to_be_processed", "qualified", "disqualified", "needs_attention"] as const;
export const ROLES = ["designer", "front_desk"] as const;
export type Role = (typeof ROLES)[number];

export const ASSIGN_HOW = ["front_desk", "auto", "booking_host", "hubspot"] as const;
export type AssignHow = (typeof ASSIGN_HOW)[number];

export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_FLAGS = ["none", "existing_client", "no_transcript", "ai_failed", "upset_caller"] as const;
export type CallFlag = (typeof CALL_FLAGS)[number];

export type CriterionKey = "service_fit" | "scale" | "budget" | "location" | "timeline" | "property_dm" | "next_step";
export type Verdict = "pass" | "unclear" | "fail";
export type ScoreBreakdown = Record<CriterionKey, { verdict: Verdict; points: number; max: number; evidence: string }>;

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const designers = pgTable("designers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  telegramChatId: text("telegram_chat_id"),
  hubspotOwnerId: text("hubspot_owner_id"),
  /** Cal.com username or email, used to map a booking host to this designer. */
  calcomUser: text("calcom_user"),
  /** designer: takes calls. front_desk: reviews the inbox and assigns calls to designers. */
  role: text("role", { enum: ROLES }).notNull().default("designer"),
  active: boolean("active").notNull().default(true),
  isEscalation: boolean("is_escalation").notNull().default(false),
  rrOrder: integer("rr_order").notNull().default(0),
});

/** Single-row table (id = 1). */
export const settings = pgTable("settings", {
  id: integer("id").primaryKey(),
  workStart: text("work_start").notNull().default("09:00"),
  workEnd: text("work_end").notNull().default("18:00"),
  /** ISO weekdays, 1 = Mon ... 7 = Sun. */
  workDays: jsonb("work_days").$type<number[]>().notNull().$defaultFn(() => [1, 2, 3, 4, 5, 6]),
  holidays: jsonb("holidays").$type<string[]>().notNull().$defaultFn(() => []),
  /** How long the front desk has to assign a call (working minutes from when it arrived). */
  assignSlaMinutes: integer("assign_sla_minutes").notNull().default(60),
  /** If still unassigned this long after that deadline, the app assigns it by workload. 0 = never. */
  autoAssignAfterMinutes: integer("auto_assign_after_minutes").notNull().default(60),
  /** manual: the front desk assigns every call. auto: the app assigns each call as it is scored. */
  assignmentMode: text("assignment_mode", { enum: ["manual", "auto"] }).notNull().default("manual"),
  /** How long the designer has to acknowledge (working minutes from when the call was assigned to them). */
  slaMinutes: integer("sla_minutes").notNull().default(60),
  /** Urgent alert this many minutes before a booked slot if still unacknowledged. */
  slotAlertMinutes: integer("slot_alert_minutes").notNull().default(30),
  aiModel: text("ai_model").notNull().default("claude-sonnet-5-5"),
  minCommercialSqft: integer("min_commercial_sqft").notNull().default(500),
  maxCommercialSqft: integer("max_commercial_sqft").notNull().default(3000),
  minLeadWeeks: integer("min_lead_weeks").notNull().default(6),
  rrPointer: integer("rr_pointer").notNull().default(0),
});

export const calls = pgTable(
  "calls",
  {
    id: serial("id").primaryKey(),
    externalId: text("external_id").notNull(),
    source: text("source").notNull().default("phone"),
    /** Null when caller ID is withheld. */
    callerPhone: text("caller_phone"),
    startedAt: ts("started_at").notNull(),
    durationSec: integer("duration_sec").notNull().default(0),
    transcript: text("transcript").notNull().default(""),
    rawPayload: jsonb("raw_payload").notNull(),
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
    scoreBreakdown: jsonb("score_breakdown").$type<ScoreBreakdown>(),
    reason: text("reason"),
    summary: text("summary"),
    alreadyAsked: text("already_asked"),
    suggestedNextStep: text("suggested_next_step"),
    guardrailHits: jsonb("guardrail_hits").$type<string[]>(),
    linkedCallId: integer("linked_call_id"),
    /** The validated JSON the AI returned, kept for audit. */
    aiOutput: jsonb("ai_output"),

    /** Link to the call recording, when the voice provider gives one. Shown to designers as a play link. */
    recordingUrl: text("recording_url"),

    bookingId: text("booking_id"),
    bookedSlot: ts("booked_slot"),
    bookingStatus: text("booking_status", { enum: ["booked", "rescheduled", "cancelled"] }),

    assignedDesignerId: integer("assigned_designer_id").references(() => designers.id),
    assignedAt: ts("assigned_at"),
    /** The front desk officer who assigned it (null when the app or HubSpot did). */
    assignedBy: integer("assigned_by").references(() => designers.id),
    assignedHow: text("assigned_how", { enum: ASSIGN_HOW }),
    /** When the front desk should have assigned it by. */
    assignDueAt: ts("assign_due_at"),
    afterHours: boolean("after_hours").notNull().default(false),
    /** Set when a worker claims the call for AI processing, so two servers never process the same call. */
    processingStartedAt: ts("processing_started_at"),
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

/** Designers' own notes on a call. Never deleted. */
export const callNotes = pgTable(
  "call_notes",
  {
    id: serial("id").primaryKey(),
    callId: integer("call_id").notNull().references(() => calls.id),
    designerId: integer("designer_id").references(() => designers.id),
    body: text("body").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("call_notes_call_idx").on(t.callId)],
);

/** Cal.com bookings. Kept separately because a booking can arrive before its call is stored. */
export const bookings = pgTable("bookings", {
  id: serial("id").primaryKey(),
  calcomUid: text("calcom_uid").notNull().unique(),
  callId: integer("call_id").references(() => calls.id),
  startTime: ts("start_time").notNull(),
  endTime: ts("end_time"),
  status: text("status", { enum: ["booked", "rescheduled", "cancelled"] }).notNull().default("booked"),
  hostEmail: text("host_email"),
  hostDesignerId: integer("host_designer_id").references(() => designers.id),
  attendeePhone: text("attendee_phone"),
  raw: jsonb("raw"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

/** Every manual change of status. Never deleted. */
export const statusOverrides = pgTable("status_overrides", {
  id: serial("id").primaryKey(),
  callId: integer("call_id").notNull().references(() => calls.id),
  fromStatus: text("from_status", { enum: CALL_STATUSES }).notNull(),
  toStatus: text("to_status", { enum: CALL_STATUSES }).notNull(),
  reason: text("reason").notNull(),
  byDesignerId: integer("by_designer_id").references(() => designers.id),
  at: ts("at").notNull(),
});

/** Persistent reminder queue. A cron tick picks up rows with state = 'pending' and run_at <= now. */
export const reminderJobs = pgTable(
  "reminder_jobs",
  {
    id: serial("id").primaryKey(),
    /** sla: unacknowledged after the SLA. digest: 09:00 summary of pending calls. slot: unacknowledged shortly before a booked slot. */
    kind: text("kind", { enum: ["sla", "digest", "slot", "assign", "autoassign"] }).notNull(),
    callId: integer("call_id").references(() => calls.id),
    /** Who gets the message. Null for system actions (auto-assign). */
    designerId: integer("designer_id").references(() => designers.id),
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

export const callsCost = pgTable("calls_cost", {
  callId: integer("call_id").primaryKey().references(() => calls.id),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  aiCostInr: doublePrecision("ai_cost_inr").notNull().default(0),
  telephonyMinutes: doublePrecision("telephony_minutes").notNull().default(0),
  telephonyCostInr: doublePrecision("telephony_cost_inr").notNull().default(0),
  createdAt: ts("created_at").notNull(),
});

/** Last state pushed to / seen in HubSpot, so the 60s poll detects real changes and doesn't echo our own writes. */
export const hubspotSync = pgTable("hubspot_sync", {
  callId: integer("call_id").primaryKey().references(() => calls.id),
  lastPushedHash: text("last_pushed_hash"),
  lastSeenStage: text("last_seen_stage"),
  lastSeenAckAt: text("last_seen_ack_at"),
  lastSeenOwner: text("last_seen_owner"),
  /** True while the app has changes HubSpot has not received yet. The app wins until they are pushed. */
  dirty: boolean("dirty").notNull().default(true),
  attempts: integer("attempts").notNull().default(0),
  lastSyncedAt: ts("last_synced_at"),
  lastError: text("last_error"),
});

/** Telegram /start linking: one-time code a designer sends to the bot. */
export const telegramLinkCodes = pgTable("telegram_link_codes", {
  code: text("code").primaryKey(),
  designerId: integer("designer_id").notNull().references(() => designers.id),
  createdAt: ts("created_at").notNull(),
});

/** Guardrail hits, mock-mode "would have sent" entries, sync errors. */
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  at: ts("at").notNull(),
  kind: text("kind").notNull(),
  callId: integer("call_id"),
  detail: jsonb("detail"),
});

/** Small key/value store (for example the HubSpot poll cursor). */
export const appState = pgTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
