import "@/lib/runtime";
import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import type { CallFlag } from "@/db/schema";
import { scoreTranscript, type AiOutput } from "@/lib/ai";
import { assignDesigner } from "@/lib/assignment";
import { audit } from "@/lib/audit";
import { aiCostInr, telephonyCost } from "@/lib/cost";
import { env } from "@/lib/env";
import { agentQuotedPrices, guardFields } from "@/lib/guardrail";
import { emit } from "@/lib/hooks";
import { normalizePhone } from "@/lib/phone";
import { CRITERIA, finalizeScore, type CriterionKey, type RubricInput } from "@/lib/rubric";
import { getSettings, hoursConfig } from "@/lib/settings";
import { planReminder } from "@/lib/working-hours";

export type Call = typeof schema.calls.$inferSelect;

/** The one shape every call source feeds in: Vaani adapter, Simulate screen, future channels. */
export const IngestPayloadSchema = z.object({
  external_id: z.string().min(1),
  caller_phone: z.string().nullable().optional(),
  started_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "started_at must be an ISO date-time"),
  duration_sec: z.number().int().min(0),
  transcript: z.string(),
  booking_id: z.string().nullable().optional(),
  booked_slot: z
    .string()
    .nullable()
    .optional()
    .refine((s) => !s || !Number.isNaN(Date.parse(s)), "booked_slot must be an ISO date-time"),
});
export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

export interface IngestResult {
  outcome: "created" | "duplicate";
  call: Call;
}

const getCall = (id: number) => db.select().from(schema.calls).where(eq(schema.calls.id, id)).get()!;

/**
 * Save a call as "yet_to_be_processed" and (by default) process it straight away.
 * Idempotent on external_id: a repeat returns the stored call and does nothing else.
 */
export async function ingestCall(raw: unknown, opts: { process?: boolean } = {}): Promise<IngestResult> {
  const payload = IngestPayloadSchema.parse(raw);

  const existing = db.select().from(schema.calls).where(eq(schema.calls.externalId, payload.external_id)).get();
  if (existing) return { outcome: "duplicate", call: existing };

  const startedAt = new Date(payload.started_at);
  const phone = normalizePhone(payload.caller_phone);

  // A redial shortly after a very short call is the same enquiry.
  let linkedCallId: number | null = null;
  if (phone) {
    const prev = db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.callerPhone, phone), gte(schema.calls.startedAt, new Date(startedAt.getTime() - 15 * 60_000)), lt(schema.calls.startedAt, startedAt)))
      .orderBy(desc(schema.calls.startedAt))
      .get();
    if (prev && prev.durationSec < 120) linkedCallId = prev.id;
  }

  let call: Call;
  try {
    call = db
      .insert(schema.calls)
      .values({
        externalId: payload.external_id,
        callerPhone: phone,
        startedAt,
        durationSec: payload.duration_sec,
        transcript: payload.transcript,
        rawPayload: raw as object,
        receivedAt: new Date(),
        status: "yet_to_be_processed",
        linkedCallId,
      })
      .returning()
      .get();
  } catch (e) {
    // Two identical requests racing: the unique index on external_id decides.
    const again = db.select().from(schema.calls).where(eq(schema.calls.externalId, payload.external_id)).get();
    if (again) return { outcome: "duplicate", call: again };
    throw e;
  }

  attachBookingFromPayload(call, payload);
  await emit("call.received", { callId: call.id });

  if (opts.process !== false) {
    try {
      call = await processCall(call.id);
    } catch (e) {
      // Stays "yet_to_be_processed" and is picked up by processPending().
      audit("process.error", { error: e instanceof Error ? e.message : String(e) }, call.id);
      call = getCall(call.id);
    }
  }
  return { outcome: "created", call };
}

/** Link a booking given on the ingest payload, or one the Cal.com webhook delivered earlier. */
function attachBookingFromPayload(call: Call, payload: IngestPayload) {
  const now = new Date();
  let booking = payload.booking_id ? db.select().from(schema.bookings).where(eq(schema.bookings.calcomUid, payload.booking_id)).get() : undefined;

  if (!booking && call.callerPhone) {
    booking = db
      .select()
      .from(schema.bookings)
      .where(and(isNull(schema.bookings.callId), eq(schema.bookings.attendeePhone, call.callerPhone)))
      .orderBy(desc(schema.bookings.createdAt))
      .get();
  }

  if (!booking && payload.booked_slot) {
    const uid = payload.booking_id ?? `mock-${payload.external_id}`;
    booking = db
      .insert(schema.bookings)
      .values({ calcomUid: uid, callId: call.id, startTime: new Date(payload.booked_slot), status: "booked", attendeePhone: call.callerPhone, createdAt: now, updatedAt: now })
      .returning()
      .get();
  }
  if (!booking) return;

  db.update(schema.bookings).set({ callId: call.id, updatedAt: now }).where(eq(schema.bookings.id, booking.id)).run();
  db.update(schema.calls)
    .set({ bookingId: booking.calcomUid, bookedSlot: booking.startTime, bookingStatus: booking.status })
    .where(eq(schema.calls.id, call.id))
    .run();
}

const FLAG_ORDER: CallFlag[] = ["existing_client", "no_transcript", "upset_caller"];

function flagFor(o: AiOutput): CallFlag {
  const set: Record<string, boolean> = { existing_client: o.existing_client, no_transcript: o.no_transcript, upset_caller: o.upset_caller };
  return FLAG_ORDER.find((f) => set[f]) ?? "none";
}

/** Turn the stored model output into the rubric's input. `next_step` is decided by the code from the booking, not the model. */
function rubricInputFor(call: Call, o: AiOutput): RubricInput {
  const hasBooking = !!call.bookedSlot && call.bookingStatus !== "cancelled";
  const criteria = {} as RubricInput["criteria"];
  for (const { key } of CRITERIA) {
    const c = o.criteria[key as CriterionKey];
    criteria[key] = { points: c.points, evidence: c.evidence, clearNo: c.clear_no };
  }
  criteria.next_step = {
    points: hasBooking ? 5 : Math.min(criteria.next_step.points, 3),
    evidence: hasBooking ? "consultation slot booked" : criteria.next_step.evidence,
  };
  return {
    criteria,
    notALead: o.not_a_lead,
    existingClient: o.existing_client,
    proxyNoAuthority: o.proxy_no_authority,
    hasPhone: !!call.callerPhone,
    hasBooking,
    transcript: call.transcript,
    llmReason: o.reason ?? undefined,
  };
}

/** Everything derived from the model output + booking state. Pure, so it can be rerun when a booking changes. */
function outcomeFor(call: Call, o: AiOutput) {
  const result = finalizeScore(rubricInputFor(call, o));
  const guarded = guardFields({ summary: o.summary, reason: result.reason, already_asked: o.already_asked, suggested_next_step: o.suggested_next_step }, call.transcript);
  const hits = [...guarded.hits];
  for (const p of agentQuotedPrices(call.transcript)) hits.push(`agent quoted a price on the call: ${p}`);
  if (hits.length) audit("guardrail.price_flagged", { hits }, call.id);
  for (const n of result.notes) audit("rubric.note", { note: n }, call.id);
  return { result, guarded: guarded.fields, hits };
}

/** Run the AI on a saved call, assign a designer, compute the SLA and write cost. */
export async function processCall(callId: number): Promise<Call> {
  const call = getCall(callId);
  if (call.processedAt) return call;

  const settings = getSettings();
  const hours = hoursConfig(settings);
  const hasBooking = !!call.bookedSlot && call.bookingStatus !== "cancelled";

  const scored = await scoreTranscript(
    { transcript: call.transcript, startedAt: call.startedAt, durationSec: call.durationSec, hasPhone: !!call.callerPhone, bookedSlot: hasBooking ? call.bookedSlot : null },
    settings.aiModel || env.ANTHROPIC_MODEL,
  );

  const bookingRow = call.bookingId ? db.select().from(schema.bookings).where(eq(schema.bookings.calcomUid, call.bookingId)).get() : undefined;
  const plan = planReminder(call.startedAt, settings.slaMinutes, hours);
  const o = scored.output;

  const update: Partial<Call> = { processedAt: new Date(), dueAt: plan.dueAt, afterHours: plan.afterHours };
  let escalate = false;

  if (o) {
    const { result, guarded, hits } = outcomeFor(call, o);
    escalate = o.existing_client;
    Object.assign(update, {
      status: result.status,
      flag: flagFor(o),
      callerName: o.caller_name,
      location: o.location,
      propertyType: o.property_type === "unknown" ? null : o.property_type,
      areaSqft: o.area_sqft,
      scope: o.scope,
      timeline: o.timeline,
      budget: o.budget,
      score: result.score,
      scoreBreakdown: result.breakdown,
      reason: result.reason,
      summary: guarded.summary,
      alreadyAsked: guarded.already_asked,
      suggestedNextStep: guarded.suggested_next_step,
      guardrailHits: hits.length ? hits : null,
      aiOutput: o,
    });
    if (result.status !== "qualified" && !update.reason) update.reason = "Review needed";
  } else {
    // AI failed twice. Never guess: park it for a human.
    audit("ai.failed", { error: scored.error }, call.id);
    Object.assign(update, {
      status: "needs_attention",
      flag: "ai_failed",
      score: null,
      reason: "Automatic analysis failed. Read the transcript.",
      summary: "The AI could not analyse this call. Please read the transcript and call the person back.",
      alreadyAsked: "unknown",
      suggestedNextStep: call.callerPhone ? "Read the transcript, then ring the caller back." : "Read the transcript. Caller ID was withheld, so there may be no way to reach them.",
    });
  }

  update.assignedDesignerId = assignDesigner({ callId, bookingHostDesignerId: bookingRow?.hostDesignerId ?? null, escalate });

  db.transaction((tx) => {
    tx.update(schema.calls).set(update).where(eq(schema.calls.id, callId)).run();
    const tel = telephonyCost(call.durationSec);
    tx.insert(schema.callsCost)
      .values({
        callId,
        model: scored.model,
        inputTokens: scored.usage.inputTokens,
        outputTokens: scored.usage.outputTokens,
        aiCostInr: aiCostInr(scored.usage.inputTokens, scored.usage.outputTokens),
        telephonyMinutes: tel.minutes,
        telephonyCostInr: tel.costInr,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .run();
  });

  // Mock Cal.com: the "host" of a simulated booking is whoever the round-robin picked.
  if (env.CALCOM_MODE === "mock" && bookingRow && !bookingRow.hostDesignerId && update.assignedDesignerId) {
    db.update(schema.bookings).set({ hostDesignerId: update.assignedDesignerId }).where(eq(schema.bookings.id, bookingRow.id)).run();
  }

  await emit("call.processed", { callId });
  return getCall(callId);
}

/** Process anything still "yet_to_be_processed" (for example after a crash). */
export async function processPending(): Promise<number> {
  const rows = db.select().from(schema.calls).where(and(eq(schema.calls.status, "yet_to_be_processed"), isNull(schema.calls.processedAt))).all();
  for (const r of rows) {
    try {
      await processCall(r.id);
    } catch (e) {
      audit("process.error", { error: e instanceof Error ? e.message : String(e) }, r.id);
    }
  }
  return rows.length;
}

/**
 * Recompute score and status after a booking was made, moved or cancelled. A booking never
 * qualifies a call by itself: it only changes the next-step points. If a designer has overridden the status,
 * it is left alone.
 */
export function rescoreCall(callId: number) {
  const call = getCall(callId);
  const o = call.aiOutput as AiOutput | null;
  if (!o || !call.processedAt) return call;
  const { result, guarded, hits } = outcomeFor(call, o);
  const overridden = !!db.select().from(schema.statusOverrides).where(eq(schema.statusOverrides.callId, callId)).get();
  const patch: Partial<Call> = { score: result.score, scoreBreakdown: result.breakdown, guardrailHits: hits.length ? hits : null };
  if (!overridden) {
    patch.status = result.status;
    patch.reason = result.reason;
    patch.suggestedNextStep = guarded.suggested_next_step;
  }
  db.update(schema.calls).set(patch).where(eq(schema.calls.id, callId)).run();
  return getCall(callId);
}
