import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";

export interface AssignmentContext {
  callId: number;
  /** The Cal.com host of this call's booking, if one is known. */
  bookingHostDesignerId: number | null;
  /** Existing-client complaints go to the studio head, not into rotation. */
  escalate: boolean;
}

/** Return the designer id to assign, or null if nobody is available. Must be synchronous and side-effect free apart from its own bookkeeping. */
export type Assigner = (ctx: AssignmentContext) => number | null;

/** Round-robin over active, non-escalation designers in rr_order. The pointer lives in settings so it survives restarts. */
export const roundRobin: Assigner = () => {
  const pool = db
    .select()
    .from(schema.designers)
    .where(eq(schema.designers.active, true))
    .orderBy(asc(schema.designers.rrOrder), asc(schema.designers.id))
    .all()
    .filter((d) => !d.isEscalation);
  if (pool.length === 0) return null;
  const s = db.select().from(schema.settings).where(eq(schema.settings.id, 1)).get();
  const pointer = s?.rrPointer ?? 0;
  const pick = pool[pointer % pool.length];
  db.update(schema.settings).set({ rrPointer: (pointer + 1) % pool.length }).where(eq(schema.settings.id, 1)).run();
  return pick.id;
};

/** Default strategy: booking host, then escalation designer for complaints, then round-robin. */
export const defaultAssigner: Assigner = (ctx) => {
  if (ctx.bookingHostDesignerId) return ctx.bookingHostDesignerId;
  if (ctx.escalate) {
    const head = db.select().from(schema.designers).where(eq(schema.designers.isEscalation, true)).get();
    if (head) return head.id;
  }
  return roundRobin(ctx);
};

let current: Assigner = defaultAssigner;

/** Swap the assignment strategy (for example, by workload or by skill) without touching the pipeline. */
export function setAssigner(fn: Assigner) {
  current = fn;
}

export function assignDesigner(ctx: AssignmentContext): number | null {
  return current(ctx);
}
