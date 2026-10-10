import "@/lib/runtime";
import { and, asc, desc, eq, exists, gte, ilike, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, one, schema } from "@/db";
import { CALL_STATUSES, type AssignHow, type CallStatus } from "@/db/schema";
import { audit } from "@/lib/audit";
import { emit } from "@/lib/hooks";
import { IST } from "@/lib/working-hours";

export type Call = typeof schema.calls.$inferSelect;
export type Designer = typeof schema.designers.$inferSelect;

export class UserError extends Error {}

const getCall = (id: number) => one(db.select().from(schema.calls).where(eq(schema.calls.id, id)));

/**
 * The designer a call is assigned to confirms they have read and understood the handoff. Nobody else can: an
 * unassigned call has no one to acknowledge it, and a call that was moved to someone else is theirs now. Idempotent: the first
 * acknowledgement wins and later ones change nothing. Emits an event so reminders are cancelled
 * and HubSpot is updated.
 */
export async function acknowledgeCall(callId: number, designerId: number, now: Date = new Date()): Promise<Call> {
  const call = await getCall(callId);
  if (!call) throw new UserError("Call not found");
  if (call.status === "yet_to_be_processed") throw new UserError("This call is still being processed");
  if (call.acknowledgedAt) return call;
  if (!call.assignedDesignerId) throw new UserError("This call has not been assigned to a designer yet");
  if (call.assignedDesignerId !== designerId) {
    const owner = await one(db.select().from(schema.designers).where(eq(schema.designers.id, call.assignedDesignerId)));
    throw new UserError(`This call is assigned to ${owner?.name ?? "another designer"}, so only they can acknowledge it`);
  }

  // The condition makes this safe if two people tap at once: only one UPDATE matches, and only that one announces it.
  const won = await db
    .update(schema.calls)
    .set({ acknowledgedAt: now, acknowledgedBy: designerId })
      .where(and(eq(schema.calls.id, callId), isNull(schema.calls.acknowledgedAt), eq(schema.calls.assignedDesignerId, designerId)))
    .returning({ id: schema.calls.id });
  if (won.length > 0) await emit("call.acknowledged", { callId });
  return (await getCall(callId))!;
}

export const MIN_OVERRIDE_REASON = 5;

/**
 * Change a call's status by hand. A reason is required and every override is logged in
 * status_overrides (never deleted). The call itself is never removed or hidden by a status change.
 */
export async function overrideStatus(callId: number, designerId: number, toStatus: string, reason: string, now: Date = new Date()): Promise<Call> {
  const call = await getCall(callId);
  if (!call) throw new UserError("Call not found");
  if (call.status === "yet_to_be_processed") throw new UserError("This call is still being processed");
  if (!(CALL_STATUSES as readonly string[]).includes(toStatus) || toStatus === "yet_to_be_processed") throw new UserError("Choose a status");
  const cleaned = reason.trim();
  if (cleaned.length < MIN_OVERRIDE_REASON) throw new UserError(`A reason is required (at least ${MIN_OVERRIDE_REASON} characters)`);
  if (toStatus === call.status) throw new UserError(`This call is already ${call.status.replace(/_/g, " ")}`);

  await db.transaction(async (tx) => {
    await tx.insert(schema.statusOverrides).values({ callId, fromStatus: call.status, toStatus: toStatus as CallStatus, reason: cleaned, byDesignerId: designerId, at: now });
    await tx.update(schema.calls).set({ status: toStatus as CallStatus }).where(eq(schema.calls.id, callId));
  });
  await audit("override", { from: call.status, to: toStatus, by: designerId }, callId);
  await emit("call.overridden", { callId });
  return (await getCall(callId))!;
}

export type Tab = "pending" | "acknowledged" | "all";

/** Dashboard ordering: needs-a-human-now first, then by status priority. Disqualified only sorts lower; it is never hidden. */
function rank(c: Call): number {
  if (c.flag === "existing_client" || c.flag === "upset_caller") return 0;
  return { qualified: 1, needs_attention: 2, yet_to_be_processed: 3, disqualified: 4 }[c.status];
}

export type SortKey = "priority" | "newest" | "due" | "score";

export interface ListOptions {
  /** Free text: matches name, phone, area, scope or the handoff note. */
  q?: string;
  status?: CallStatus;
  booked?: boolean;
  overdue?: boolean;
  afterHours?: boolean;
  sort?: SortKey;
}

/** Turn what a person typed into a safe ILIKE pattern: % and _ are ordinary characters here. */
const likePattern = (q: string) => `%${q.trim().replace(/[\\%_]/g, (c) => "\\" + c)}%`;

type Cond = ReturnType<typeof eq>;

/** Search, filters and sorting shared by every list. */
async function listCalls(base: Cond[], now: Date, opts: ListOptions, defaultSort: SortKey, overdueOf: (c: Call) => boolean): Promise<Call[]> {
  const conds = [...base];
  const q = opts.q?.trim();
  if (q) {
    const p = likePattern(q);
    const inNotes = exists(db.select({ one: schema.callNotes.id }).from(schema.callNotes).where(and(eq(schema.callNotes.callId, schema.calls.id), ilike(schema.callNotes.body, p))));
    conds.push(or(ilike(schema.calls.callerName, p), ilike(schema.calls.callerPhone, p), ilike(schema.calls.location, p), ilike(schema.calls.scope, p), ilike(schema.calls.summary, p), inNotes)!);
  }
  if (opts.status) conds.push(eq(schema.calls.status, opts.status));
  if (opts.booked) conds.push(isNotNull(schema.calls.bookedSlot), or(isNull(schema.calls.bookingStatus), inArray(schema.calls.bookingStatus, ["booked", "rescheduled"]))!);
  if (opts.afterHours) conds.push(eq(schema.calls.afterHours, true));

  let rows = await db.select().from(schema.calls).where(and(...conds)).orderBy(desc(schema.calls.startedAt));
  if (opts.overdue) rows = rows.filter(overdueOf);
  const sort = opts.sort ?? defaultSort;
  const od = (c: Call) => (overdueOf(c) ? 0 : 1);
  const due = (c: Call) => (c.acknowledgedAt || c.assignedDesignerId ? c.dueAt : c.assignDueAt)?.getTime() ?? Infinity;
  if (sort === "priority") return rows.sort((x, y) => od(x) - od(y) || rank(x) - rank(y) || due(x) - due(y));
  if (sort === "due") return rows.sort((x, y) => due(x) - due(y));
  if (sort === "score") return rows.sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
  return rows; // newest first, as fetched
}

/**
 * A designer's calls (or every designer's, with "all"). Pending means assigned to them and not yet acknowledged.
 */
export async function listForDesigner(designerId: number | "all", tab: Tab, now: Date = new Date(), opts: ListOptions = {}): Promise<Call[]> {
  const base: Cond[] = [designerId === "all" ? isNotNull(schema.calls.assignedDesignerId) : eq(schema.calls.assignedDesignerId, designerId)];
  if (tab === "pending") base.push(isNull(schema.calls.acknowledgedAt), inArray(schema.calls.status, ["qualified", "needs_attention", "disqualified"]));
  if (tab === "acknowledged") base.push(isNotNull(schema.calls.acknowledgedAt));
  const t = now.getTime();
  const overdueOf = (c: Call) => !!c.dueAt && !c.acknowledgedAt && c.dueAt.getTime() < t;
  return listCalls(base, now, opts, tab === "pending" ? "priority" : "newest", overdueOf);
}

export type FrontDeskTab = "assign" | "disqualified" | "assigned" | "all";

/** What the front desk sees: calls waiting to be assigned, disqualified calls to double-check, and calls already handed over. */
export async function listForFrontDesk(tab: FrontDeskTab, now: Date = new Date(), opts: ListOptions = {}): Promise<Call[]> {
  const base: Cond[] =
    tab === "assign"
      ? [isNull(schema.calls.assignedDesignerId), inArray(schema.calls.status, ["qualified", "needs_attention"])]
      : tab === "disqualified"
        ? [eq(schema.calls.status, "disqualified")]
        : tab === "assigned"
          ? [isNotNull(schema.calls.assignedDesignerId)]
          : [ne(schema.calls.status, "yet_to_be_processed")]; // "all": the full call log
  const t = now.getTime();
  const overdueOf = (c: Call) => (tab === "assign" ? !!c.assignDueAt && c.assignDueAt.getTime() < t : !!c.dueAt && !c.acknowledgedAt && c.dueAt.getTime() < t);
  return listCalls(base, now, opts, tab === "assign" ? "priority" : "newest", overdueOf);
}

export async function countsForFrontDesk() {
  const rows = await db.select().from(schema.calls);
  const processed = rows.filter((c) => c.status !== "yet_to_be_processed");
  return {
    assign: processed.filter((c) => !c.assignedDesignerId && (c.status === "qualified" || c.status === "needs_attention")).length,
    disqualified: processed.filter((c) => c.status === "disqualified").length,
    assigned: processed.filter((c) => !!c.assignedDesignerId).length,
    all: processed.length,
  };
}

export interface FrontDeskToday {
  /** Qualified or needs-attention calls nobody has assigned yet. */
  toAssign: number;
  /** Of those, past the assignment deadline. */
  overdue: number;
  /** Of those, calls that came in outside working hours. */
  afterHours: number;
  /** Unassigned calls with a consultation booked for today (IST). */
  bookedToday: number;
}

export async function todayForFrontDesk(now: Date = new Date()): Promise<FrontDeskToday> {
  const waiting = await listForFrontDesk("assign", now);
  const t = now.getTime();
  const dayStart = DateTime.fromJSDate(now, { zone: IST }).startOf("day");
  const dayEnd = dayStart.plus({ days: 1 }).toMillis();
  return {
    toAssign: waiting.length,
    overdue: waiting.filter((c) => c.assignDueAt && c.assignDueAt.getTime() < t).length,
    afterHours: waiting.filter((c) => c.afterHours).length,
    bookedToday: waiting.filter((c) => c.bookedSlot && c.bookingStatus !== "cancelled" && c.bookedSlot.getTime() >= dayStart.toMillis() && c.bookedSlot.getTime() < dayEnd).length,
  };
}

export interface TodaySummary {
  /** Waiting for acknowledgement and past the deadline. */
  overdue: number;
  /** Waiting, and the deadline falls within the next hour. */
  dueSoon: number;
  /** Consultations booked for today (IST). */
  bookedToday: number;
  /** Waiting calls that arrived outside working hours. */
  afterHoursWaiting: number;
}

/** The "what needs me right now" line at the top of a designer's dashboard. */
export async function todayForDesigner(designerId: number | "all", now: Date = new Date()): Promise<TodaySummary> {
  const mine = await db.select().from(schema.calls).where(designerId === "all" ? isNotNull(schema.calls.assignedDesignerId) : eq(schema.calls.assignedDesignerId, designerId));
  const t = now.getTime();
  const waiting = mine.filter((c) => !c.acknowledgedAt && c.status !== "yet_to_be_processed");
  const dayStart = DateTime.fromJSDate(now, { zone: IST }).startOf("day");
  const dayEnd = dayStart.plus({ days: 1 }).toMillis();
  return {
    overdue: waiting.filter((c) => c.dueAt && c.dueAt.getTime() < t).length,
    dueSoon: waiting.filter((c) => c.dueAt && c.dueAt.getTime() >= t && c.dueAt.getTime() < t + 3_600_000).length,
    bookedToday: mine.filter((c) => c.bookedSlot && c.bookingStatus !== "cancelled" && c.bookedSlot.getTime() >= dayStart.toMillis() && c.bookedSlot.getTime() < dayEnd).length,
    afterHoursWaiting: waiting.filter((c) => c.afterHours).length,
  };
}

export async function countsForDesigner(designerId: number | "all") {
  const mine = await db.select().from(schema.calls).where(designerId === "all" ? isNotNull(schema.calls.assignedDesignerId) : eq(schema.calls.assignedDesignerId, designerId));
  return {
    pending: mine.filter((c) => !c.acknowledgedAt && c.status !== "yet_to_be_processed").length,
    acknowledged: mine.filter((c) => c.acknowledgedAt).length,
    all: mine.length,
  };
}

export interface TimelineEvent {
  at: Date;
  text: string;
}

export const MAX_NOTE = 2000;

/** A designer's note on a call. Notes are never edited or deleted, only added. */
export async function addNote(callId: number, designerId: number, body: string, now: Date = new Date()): Promise<void> {
  if (!(await getCall(callId))) throw new UserError("Call not found");
  const text = body.trim();
  if (text.length === 0) throw new UserError("Write something first");
  if (text.length > MAX_NOTE) throw new UserError(`Keep notes under ${MAX_NOTE} characters`);
  await db.insert(schema.callNotes).values({ callId, designerId, body: text, createdAt: now });
}

/** Everything that happened to a call, oldest first, assembled from what the app already records. */
async function timelineFor(call: Call, name: (id: number | null) => string | null, overrides: (typeof schema.statusOverrides.$inferSelect)[]): Promise<TimelineEvent[]> {
  const ev: TimelineEvent[] = [{ at: call.startedAt, text: call.afterHours ? "Call received (outside working hours)" : "Call received" }];
  // The status the AI gave it, not the current one: a designer may have changed it since (the first override remembers the original).
  const scoredAs = overrides[0]?.fromStatus ?? call.status;
  if (call.processedAt) ev.push({ at: call.processedAt, text: `Scored: ${scoredAs.replace(/_/g, " ")}${call.score !== null ? `, ${call.score} / 100` : ""}.` });

  for (const b of await db.select().from(schema.bookings).where(eq(schema.bookings.callId, call.id))) {
    ev.push({ at: b.updatedAt, text: `Booking ${b.status}${b.hostDesignerId ? ` with ${name(b.hostDesignerId)}` : ""}` });
  }
  for (const j of await db.select().from(schema.reminderJobs).where(and(eq(schema.reminderJobs.callId, call.id), eq(schema.reminderJobs.state, "sent")))) {
    if (j.sentAt) ev.push({ at: j.sentAt, text: `${j.kind === "slot" ? "Urgent slot alert" : "Reminder"} sent to ${name(j.designerId) ?? "designer"} on Telegram` });
  }
  if (call.assignedAt && call.assignedDesignerId) {
    const how = call.assignedHow === "front_desk" ? `by ${name(call.assignedBy) ?? "the front desk"}` : call.assignedHow === "auto" ? "automatically" : call.assignedHow === "hubspot" ? "from HubSpot" : call.assignedHow === "booking_host" ? "as the booking host" : "";
    ev.push({ at: call.assignedAt, text: `Assigned to ${name(call.assignedDesignerId) ?? "a designer"} ${how}`.trim() });
  }
  if (call.acknowledgedAt) ev.push({ at: call.acknowledgedAt, text: `Acknowledged by ${name(call.acknowledgedBy) ?? "someone"}` });
  for (const o of overrides) ev.push({ at: o.at, text: `Status changed from ${o.fromStatus.replace(/_/g, " ")} to ${o.toStatus.replace(/_/g, " ")} by ${name(o.byDesignerId) ?? "HubSpot"}: ${o.reason}` });
  const sync = await one(db.select().from(schema.hubspotSync).where(eq(schema.hubspotSync.callId, call.id)));
  if (sync?.lastSyncedAt) ev.push({ at: sync.lastSyncedAt, text: "Last synced with HubSpot" });
  return ev.sort((x, y) => x.at.getTime() - y.at.getTime());
}

export async function getDetail(callId: number) {
  const call = await getCall(callId);
  if (!call) return null;
  const designers = await db.select().from(schema.designers);
  const name = (id: number | null) => designers.find((d) => d.id === id)?.name ?? null;
  const overrides = await db.select().from(schema.statusOverrides).where(eq(schema.statusOverrides.callId, callId)).orderBy(asc(schema.statusOverrides.at));
  const notes = await db.select().from(schema.callNotes).where(eq(schema.callNotes.callId, callId)).orderBy(asc(schema.callNotes.createdAt));
  // Who the consultation is with: the designer who acknowledged the call, else the one it is assigned to, else the Cal.com host (by name if they are one of ours, otherwise by email).
  const booking = call.bookingId ? await one(db.select().from(schema.bookings).where(eq(schema.bookings.calcomUid, call.bookingId))) : undefined;
  const bookingWith = booking ? (name(call.acknowledgedBy) ?? name(call.assignedDesignerId) ?? name(booking.hostDesignerId) ?? booking.hostEmail ?? null) : null;
  const linked = call.linkedCallId ? ((await getCall(call.linkedCallId)) ?? null) : null;
  return {
    call,
    assignedTo: name(call.assignedDesignerId),
    acknowledgedByName: name(call.acknowledgedBy),
    assignedByName: name(call.assignedBy),
    bookingWith,
    overrides: overrides.map((o) => ({ ...o, byName: name(o.byDesignerId) })),
    notes: notes.map((n) => ({ ...n, byName: name(n.designerId) })),
    timeline: await timelineFor(call, name, overrides),
    linked,
  };
}

export async function activeDesigners(): Promise<Designer[]> {
  return db.select().from(schema.designers).where(eq(schema.designers.active, true)).orderBy(asc(schema.designers.rrOrder), asc(schema.designers.id));
}

/**
 * A status change that came from outside the dashboard (a deal moved to another stage in HubSpot).
 * It is logged exactly like a designer override, with the reason saying where it came from.
 */
export async function applyExternalStatus(callId: number, toStatus: CallStatus, reason: string, byDesignerId: number | null, now: Date = new Date()): Promise<Call | null> {
  const call = await getCall(callId);
  if (!call || call.status === "yet_to_be_processed" || toStatus === "yet_to_be_processed" || toStatus === call.status) return call ?? null;
  await db.transaction(async (tx) => {
    await tx.insert(schema.statusOverrides).values({ callId, fromStatus: call.status, toStatus, reason, byDesignerId, at: now });
    await tx.update(schema.calls).set({ status: toStatus }).where(eq(schema.calls.id, callId));
  });
  await audit("override.external", { from: call.status, to: toStatus, reason }, callId);
  await emit("call.overridden", { callId });
  return (await getCall(callId))!;
}

export interface AssignBy {
  /** The front desk officer, or null when the app or HubSpot did it. */
  id: number | null;
  how: AssignHow;
}

/**
 * Give a call to a designer (or move it to a different one). Only designers can receive calls. Once a designer
 * has acknowledged a call it can no longer be moved. The designer's own deadline starts now.
 *
 * `onlyIfUnassigned` is for the automatic fallback: it must never overwrite a person's decision made a moment earlier.
 * `assignedAt` lets automatic mode record the assignment as happening when the call arrived.
 */
export async function assignCall(callId: number, designerId: number, by: AssignBy, now: Date = new Date(), opts: { onlyIfUnassigned?: boolean; assignedAt?: Date } = {}): Promise<Call> {
  const call = await getCall(callId);
  if (!call) throw new UserError("Call not found");
  if (call.status === "yet_to_be_processed") throw new UserError("This call is still being processed");
  const d = await one(db.select().from(schema.designers).where(eq(schema.designers.id, designerId)));
  if (!d || !d.active) throw new UserError("Choose an active designer");
  if (d.role !== "designer") throw new UserError("Calls can only be assigned to designers");
  if (call.assignedDesignerId === designerId) return call;
  if (call.acknowledgedAt) {
    const who = (await one(db.select().from(schema.designers).where(eq(schema.designers.id, call.acknowledgedBy ?? -1))))?.name ?? "a designer";
    throw new UserError(`${who} has already acknowledged this call, so it can no longer be moved`);
  }

  const won = await db
    .update(schema.calls)
    .set({ assignedDesignerId: designerId, assignedAt: opts.assignedAt ?? now, assignedBy: by.id, assignedHow: by.how })
    .where(and(eq(schema.calls.id, callId), isNull(schema.calls.acknowledgedAt), opts.onlyIfUnassigned ? isNull(schema.calls.assignedDesignerId) : undefined))
    .returning({ id: schema.calls.id });
  if (won.length === 0) return (await getCall(callId))!; // someone assigned or acknowledged it first
  await audit("assigned", { from: call.assignedDesignerId, to: designerId, how: by.how, by: by.id }, callId);
  await emit("call.assigned", { callId });
  return (await getCall(callId))!;
}

/** HubSpot's deal owner changed: follow it. */
export async function reassignCall(callId: number, designerId: number): Promise<void> {
  await assignCall(callId, designerId, { id: null, how: "hubspot" });
}
