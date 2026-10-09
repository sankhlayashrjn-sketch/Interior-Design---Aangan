import "@/lib/runtime";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { CALL_STATUSES, type CallStatus } from "@/db/schema";
import { audit } from "@/lib/audit";
import { emit } from "@/lib/hooks";

export type Call = typeof schema.calls.$inferSelect;
export type Designer = typeof schema.designers.$inferSelect;

export class UserError extends Error {}

const getCall = (id: number) => db.select().from(schema.calls).where(eq(schema.calls.id, id)).get();

/**
 * A designer confirms they have read and understood the handoff. Idempotent: the first
 * acknowledgement wins and later ones change nothing. Emits an event so reminders are cancelled
 * and HubSpot is updated.
 */
export async function acknowledgeCall(callId: number, designerId: number, now: Date = new Date()): Promise<Call> {
  const call = getCall(callId);
  if (!call) throw new UserError("Call not found");
  if (call.status === "yet_to_be_processed") throw new UserError("This call is still being processed");
  if (call.acknowledgedAt) return call;

  db.update(schema.calls).set({ acknowledgedAt: now, acknowledgedBy: designerId }).where(and(eq(schema.calls.id, callId), isNull(schema.calls.acknowledgedAt))).run();
  await emit("call.acknowledged", { callId });
  return getCall(callId)!;
}

export const MIN_OVERRIDE_REASON = 5;

/**
 * Change a call's status by hand. A reason is required and every override is logged in
 * status_overrides (never deleted). The call itself is never removed or hidden by a status change.
 */
export async function overrideStatus(callId: number, designerId: number, toStatus: string, reason: string, now: Date = new Date()): Promise<Call> {
  const call = getCall(callId);
  if (!call) throw new UserError("Call not found");
  if (call.status === "yet_to_be_processed") throw new UserError("This call is still being processed");
  if (!(CALL_STATUSES as readonly string[]).includes(toStatus) || toStatus === "yet_to_be_processed") throw new UserError("Choose a status");
  const cleaned = reason.trim();
  if (cleaned.length < MIN_OVERRIDE_REASON) throw new UserError(`A reason is required (at least ${MIN_OVERRIDE_REASON} characters)`);
  if (toStatus === call.status) throw new UserError(`This call is already ${call.status.replace(/_/g, " ")}`);

  db.transaction((tx) => {
    tx.insert(schema.statusOverrides).values({ callId, fromStatus: call.status, toStatus: toStatus as CallStatus, reason: cleaned, byDesignerId: designerId, at: now }).run();
    tx.update(schema.calls).set({ status: toStatus as CallStatus }).where(eq(schema.calls.id, callId)).run();
  });
  audit("override", { from: call.status, to: toStatus, by: designerId }, callId);
  await emit("call.overridden", { callId });
  return getCall(callId)!;
}

export type Tab = "pending" | "acknowledged" | "all";

/** Dashboard ordering: needs-a-human-now first, then by status priority. Disqualified only sorts lower; it is never hidden. */
function rank(c: Call): number {
  if (c.flag === "existing_client" || c.flag === "upset_caller") return 0;
  return { qualified: 1, needs_attention: 2, yet_to_be_processed: 3, disqualified: 4 }[c.status];
}

export function listForDesigner(designerId: number, tab: Tab, now: Date = new Date()): Call[] {
  const base = [eq(schema.calls.assignedDesignerId, designerId)];
  if (tab === "pending") base.push(isNull(schema.calls.acknowledgedAt), inArray(schema.calls.status, ["qualified", "needs_attention", "disqualified"]));
  if (tab === "acknowledged") base.push(isNotNull(schema.calls.acknowledgedAt));
  const rows = db.select().from(schema.calls).where(and(...base)).orderBy(desc(schema.calls.startedAt)).all();
  if (tab === "pending") {
    const t = now.getTime();
    const overdue = (c: Call) => (c.dueAt && c.dueAt.getTime() < t ? 0 : 1);
    return rows.sort((a, b) => overdue(a) - overdue(b) || rank(a) - rank(b) || (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0));
  }
  return rows;
}

export function countsForDesigner(designerId: number) {
  const mine = db.select().from(schema.calls).where(eq(schema.calls.assignedDesignerId, designerId)).all();
  return {
    pending: mine.filter((c) => !c.acknowledgedAt && c.status !== "yet_to_be_processed").length,
    acknowledged: mine.filter((c) => c.acknowledgedAt).length,
    all: mine.length,
  };
}

export function getDetail(callId: number) {
  const call = getCall(callId);
  if (!call) return null;
  const designers = db.select().from(schema.designers).all();
  const name = (id: number | null) => designers.find((d) => d.id === id)?.name ?? null;
  const overrides = db.select().from(schema.statusOverrides).where(eq(schema.statusOverrides.callId, callId)).orderBy(asc(schema.statusOverrides.at)).all();
  const linked = call.linkedCallId ? getCall(call.linkedCallId) : null;
  return {
    call,
    assignedTo: name(call.assignedDesignerId),
    acknowledgedByName: name(call.acknowledgedBy),
    overrides: overrides.map((o) => ({ ...o, byName: name(o.byDesignerId) })),
    linked,
  };
}

export function activeDesigners(): Designer[] {
  return db.select().from(schema.designers).where(eq(schema.designers.active, true)).orderBy(asc(schema.designers.rrOrder), asc(schema.designers.id)).all();
}

/**
 * A status change that came from outside the dashboard (a deal moved to another stage in HubSpot).
 * It is logged exactly like a designer override, with the reason saying where it came from.
 */
export async function applyExternalStatus(callId: number, toStatus: CallStatus, reason: string, byDesignerId: number | null, now: Date = new Date()): Promise<Call | null> {
  const call = getCall(callId);
  if (!call || call.status === "yet_to_be_processed" || toStatus === "yet_to_be_processed" || toStatus === call.status) return call ?? null;
  db.transaction((tx) => {
    tx.insert(schema.statusOverrides).values({ callId, fromStatus: call.status, toStatus, reason, byDesignerId, at: now }).run();
    tx.update(schema.calls).set({ status: toStatus }).where(eq(schema.calls.id, callId)).run();
  });
  audit("override.external", { from: call.status, to: toStatus, reason }, callId);
  await emit("call.overridden", { callId });
  return getCall(callId)!;
}

/** Hand a call to another designer. Reminders move with it. */
export async function reassignCall(callId: number, designerId: number): Promise<void> {
  const call = getCall(callId);
  if (!call || call.assignedDesignerId === designerId) return;
  db.update(schema.calls).set({ assignedDesignerId: designerId }).where(eq(schema.calls.id, callId)).run();
  audit("reassigned", { from: call.assignedDesignerId, to: designerId }, callId);
  await emit("call.reassigned", { callId });
}
