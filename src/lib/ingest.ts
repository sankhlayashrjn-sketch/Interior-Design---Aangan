import "@/lib/runtime";
import { and, desc, eq, gte, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { db, one, schema } from "@/db";
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
  /** Link to the recording, if the provider has one. http(s) only. */
  recording_url: z
    .string()
    .nullable()
    .optional()
    .refine((u) => !u || /^https?:\/\/\S+$/i.test(u), "recording_url must be an http(s) link"),
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

const getCall = async (id: number) => (await one(db.select().from(schema.calls).where(eq(schema.calls.id, id))))!;
const findByExternalId = (externalId: string) => one(db.select().from(schema.calls).where(eq(schema.calls.externalId, externalId)));

/** A worker that claimed a call and then died is considered gone after this long, and another worker may take over. */
const CLAIM_TIMEOUT_MS = 5 * 60_000;

/**
 * Save a call as "yet_to_be_processed" and (by default) process it straight away.
 * Idempotent on external_id: a repeat returns the stored call and does nothing else.
 */
export async function ingestCall(raw: unknown, opts: { process?: boolean } = {}): Promise<IngestResult> {
  const payload = IngestPayloadSchema.parse(raw);

  const existing = await findByExternalId(payload.external_id);
  if (existing) return { outcome: "duplicate", call: existing };

  const startedAt = new Date(payload.started_at);
  const phone = normalizePhone(payload.caller_phone);

  // A redial shortly after a very short call is the same enquiry.
  let linkedCallId: number | null = null;
  if (phone) {
    const prev = await one(
      db
        .select()
        .from(schema.calls)
        .where(and(eq(schema.calls.callerPhone, phone), gte(schema.calls.startedAt, new Date(startedAt.getTime() - 15 * 60_000)), lt(schema.calls.startedAt, startedAt)))
        .orderBy(desc(schema.calls.startedAt))
        .limit(1),
    );
    if (prev && prev.durationSec < 120) linkedCallId = prev.id;
  }

  // The unique index on external_id decides if two identical requests race: the loser inserts nothing.
  const inserted = await db
    .insert(schema.calls)
    .values({
      externalId: payload.external_id,
      callerPhone: phone,
      startedAt,
      durationSec: payload.duration_sec,
      transcript: payload.transcript,
      rawPayload: raw as object,
      recordingUrl: payload.recording_url ?? null,
      receivedAt: new Date(),
      status: "yet_to_be_processed",
      linkedCallId,
    })
    .onConflictDoNothing({ target: schema.calls.externalId })
    .returning();
  if (inserted.length === 0) return { outcome: "duplicate", call: (await findByExternalId(payload.external_id))! };
  let call = inserted[0];

  await attachBookingFromPayload(call, payload);
  await emit("call.received", { callId: call.id });

  if (opts.process !== false) {
    try {
      call = await processCall(call.id);
    } catch (e) {
      // Stays "yet_to_be_processed" and is picked up by processPending().
      await audit("process.error", { error: e instanceof Error ? e.message : String(e) }, call.id);
      call = await getCall(call.id);
    }
  }
  return { outcome: "created", call };
}

/** Link a booking given on the ingest payload, or one the Cal.com webhook delivered earlier. */
async function attachBookingFromPayload(call: Call, payload: IngestPayload) {
  const now = new Date();
  let booking = payload.booking_id ? await one(db.select().from(schema.bookings).where(eq(schema.bookings.calcomUid, payload.booking_id))) : undefined;

  if (!booking && call.callerPhone) {
    booking = await one(
      db
        .select()
        .from(schema.bookings)
        .where(and(isNull(schema.bookings.callId), eq(schema.bookings.attendeePhone, call.callerPhone)))
        .orderBy(desc(schema.bookings.createdAt))
        .limit(1),
    );
  }

  if (!booking && payload.booked_slot) {
    const uid = payload.booking_id ?? `mock-${payload.external_id}`;
    booking = await one(
      db
        .insert(schema.bookings)
        .values({ calcomUid: uid, callId: call.id, startTime: new Date(payload.booked_slot), status: "booked", attendeePhone: call.callerPhone, createdAt: now, updatedAt: now })
        .returning(),
    );
  }
  if (!booking) return;

  await db.update(schema.bookings).set({ callId: call.id, updatedAt: now }).where(eq(schema.bookings.id, booking.id));
  await db
    .update(schema.calls)
    .set({ bookingId: booking.calcomUid, bookedSlot: booking.startTime, bookingStatus: booking.status })
    .where(eq(schema.calls.id, call.id));
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

/** Everything derived from the model output + booking state. Rerun when a booking changes. */
async function outcomeFor(call: Call, o: AiOutput) {
  const result = finalizeScore(rubricInputFor(call, o));
  const guarded = guardFields({ summary: o.summary, reason: result.reason, already_asked: o.already_asked, suggested_next_step: o.suggested_next_step }, call.transcript);
  const hits = [...guarded.hits];
  for (const p of agentQuotedPrices(call.transcript)) hits.push(`agent quoted a price on the call: ${p}`);
  if (hits.length) await audit("guardrail.price_flagged", { hits }, call.id);
  for (const n of result.notes) await audit("rubric.note", { note: n }, call.id);
  return { result, guarded: guarded.fields, hits };
}

/**
 * Run the AI on a saved call, assign a designer, compute the SLA and write cost.
 * Safe to call from several servers at once: the call is claimed first, so it is processed exactly once.
 */
export async function processCall(callId: number): Promise<Call> {
  const claimed = await db
    .update(schema.calls)
    .set({ processingStartedAt: new Date() })
    .where(
      and(
        eq(schema.calls.id, callId),
        isNull(schema.calls.processedAt),
        or(isNull(schema.calls.processingStartedAt), lt(schema.calls.processingStartedAt, new Date(Date.now() - CLAIM_TIMEOUT_MS))),
      ),
    )
    .returning();
  if (claimed.length === 0) return getCall(callId); // already processed, or another worker has it

  const call = claimed[0];
  const settings = await getSettings();
  const hours = hoursConfig(settings);
  const hasBooking = !!call.bookedSlot && call.bookingStatus !== "cancelled";

  let scored;
  try {
    scored = await scoreTranscript(
      { transcript: call.transcript, startedAt: call.startedAt, durationSec: call.durationSec, hasPhone: !!call.callerPhone, bookedSlot: hasBooking ? call.bookedSlot : null },
      settings.aiModel || env.ANTHROPIC_MODEL,
    );
  } catch (e) {
    await db.update(schema.calls).set({ processingStartedAt: null }).where(eq(schema.calls.id, callId)); // release the claim so it can be retried
    throw e;
  }

  const bookingRow = call.bookingId ? await one(db.select().from(schema.bookings).where(eq(schema.bookings.calcomUid, call.bookingId))) : undefined;
  const plan = planReminder(call.startedAt, settings.slaMinutes, hours);
  const o = scored.output;

  const update: Partial<Call> = { processedAt: new Date(), dueAt: plan.dueAt, afterHours: plan.afterHours };
  let escalate = false;

  if (o) {
    const { result, guarded, hits } = await outcomeFor(call, o);
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
    await audit("ai.failed", { error: scored.error }, call.id);
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

  update.assignedDesignerId = await assignDesigner({ callId, bookingHostDesignerId: bookingRow?.hostDesignerId ?? null, escalate });

  await db.transaction(async (tx) => {
    await tx.update(schema.calls).set(update).where(eq(schema.calls.id, callId));
    const tel = telephonyCost(call.durationSec);
    await tx
      .insert(schema.callsCost)
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
      .onConflictDoNothing();
  });

  // Mock Cal.com: the "host" of a simulated booking is whoever the round-robin picked.
  if (env.CALCOM_MODE === "mock" && bookingRow && !bookingRow.hostDesignerId && update.assignedDesignerId) {
    await db.update(schema.bookings).set({ hostDesignerId: update.assignedDesignerId }).where(eq(schema.bookings.id, bookingRow.id));
  }

  await emit("call.processed", { callId });
  return getCall(callId);
}

/** Process anything still "yet_to_be_processed" (for example after a crash). */
export async function processPending(): Promise<number> {
  const rows = await db.select().from(schema.calls).where(and(eq(schema.calls.status, "yet_to_be_processed"), isNull(schema.calls.processedAt)));
  for (const r of rows) {
    try {
      await processCall(r.id);
    } catch (e) {
      await audit("process.error", { error: e instanceof Error ? e.message : String(e) }, r.id);
    }
  }
  return rows.length;
}

/**
 * Recompute score and status after a booking was made, moved or cancelled. A booking never
 * qualifies a call by itself: it only changes the next-step points. If a designer has overridden the status,
 * it is left alone.
 */
export async function rescoreCall(callId: number) {
  const call = await getCall(callId);
  const o = call.aiOutput as AiOutput | null;
  if (!o || !call.processedAt) return call;
  const { result, guarded, hits } = await outcomeFor(call, o);
  const overridden = !!(await one(db.select().from(schema.statusOverrides).where(eq(schema.statusOverrides.callId, callId)).limit(1)));
  const patch: Partial<Call> = { score: result.score, scoreBreakdown: result.breakdown, guardrailHits: hits.length ? hits : null };
  if (!overridden) {
    patch.status = result.status;
    patch.reason = result.reason;
    patch.suggestedNextStep = guarded.suggested_next_step;
  }
  await db.update(schema.calls).set(patch).where(eq(schema.calls.id, callId));
  return getCall(callId);
}
