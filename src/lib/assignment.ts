import { and, asc, count, eq, isNotNull, isNull } from "drizzle-orm";
import { db, one, schema } from "@/db";

export interface AssignmentContext {
  callId: number;
  /** The Cal.com host of this call's booking, if one is known. */
  bookingHostDesignerId: number | null;
  /** Existing-client complaints go to the studio head, not into the normal rotation. */
  escalate: boolean;
}

/** Return the designer id to give a call to, or null if nobody can take it. Must not change anything. */
export type Assigner = (ctx: AssignmentContext) => Promise<number | null> | number | null;

type Designer = typeof schema.designers.$inferSelect;

/** People who can be given a call: active, and a designer (front desk officers assign calls, they do not receive them). */
export async function eligibleDesigners(): Promise<Designer[]> {
  return db
    .select()
    .from(schema.designers)
    .where(and(eq(schema.designers.active, true), eq(schema.designers.role, "designer")))
    .orderBy(asc(schema.designers.rrOrder), asc(schema.designers.id));
}

/** How many calls each designer currently holds that they have not acknowledged yet. */
export async function workloads(): Promise<Map<number, number>> {
  const rows = await db
    .select({ id: schema.calls.assignedDesignerId, n: count() })
    .from(schema.calls)
    .where(and(isNotNull(schema.calls.assignedDesignerId), isNull(schema.calls.acknowledgedAt)))
    .groupBy(schema.calls.assignedDesignerId);
  return new Map(rows.map((r) => [r.id!, Number(r.n)]));
}

/**
 * Default rule, used for the front desk's pre-selected suggestion and for automatic assignment:
 * the Cal.com host if there is one, the studio head for a complaint, otherwise the designer with the fewest
 * unacknowledged calls (ties go to whoever comes first in the rotation order). It changes nothing, so asking
 * for a suggestion costs nothing and two people asking at once get the same answer.
 */
export const workloadAssigner: Assigner = async (ctx) => {
  if (ctx.bookingHostDesignerId) return ctx.bookingHostDesignerId;
  const all = await eligibleDesigners();
  if (ctx.escalate) {
    const head = all.find((d) => d.isEscalation);
    if (head) return head.id;
  }
  const pool = all.filter((d) => !d.isEscalation);
  if (pool.length === 0) return null;
  const load = await workloads();
  return pool.reduce((best, d) => ((load.get(d.id) ?? 0) < (load.get(best.id) ?? 0) ? d : best)).id;
};

let current: Assigner = workloadAssigner;

/** Swap the rule (for example, by skill or by area) without touching the pipeline. */
export function setAssigner(fn: Assigner) {
  current = fn;
}

export const defaultAssigner = workloadAssigner;

export async function assignDesigner(ctx: AssignmentContext): Promise<number | null> {
  return current(ctx);
}

/** The designer to pre-select for a call in the front desk inbox. */
export async function suggestDesignerFor(call: { id: number; flag: string; bookingId: string | null }): Promise<number | null> {
  const booking = call.bookingId ? await one(db.select().from(schema.bookings).where(eq(schema.bookings.calcomUid, call.bookingId))) : undefined;
  return assignDesigner({ callId: call.id, bookingHostDesignerId: booking?.hostDesignerId ?? null, escalate: call.flag === "existing_client" });
}
