import { asc, eq, sql } from "drizzle-orm";
import { db, one, schema } from "@/db";
import { getSettings } from "@/lib/settings";

export interface AssignmentContext {
  callId: number;
  /** The Cal.com host of this call's booking, if one is known. */
  bookingHostDesignerId: number | null;
  /** Existing-client complaints go to the studio head, not into rotation. */
  escalate: boolean;
}

/** Return the designer id to assign, or null if nobody is available. */
export type Assigner = (ctx: AssignmentContext) => Promise<number | null> | number | null;

/**
 * Round-robin over active, non-escalation designers in rr_order. The pointer lives in settings and is
 * advanced with one atomic UPDATE, so two calls arriving at the same moment on different servers never get the same slot.
 */
export const roundRobin: Assigner = async () => {
  const designers = await db
    .select()
    .from(schema.designers)
    .where(eq(schema.designers.active, true))
    .orderBy(asc(schema.designers.rrOrder), asc(schema.designers.id));
  const pool = designers.filter((d) => !d.isEscalation);
  if (pool.length === 0) return null;
  await getSettings(); // makes sure the row exists
  const [row] = await db
    .update(schema.settings)
    .set({ rrPointer: sql`(${schema.settings.rrPointer} + 1) % ${pool.length}` })
    .where(eq(schema.settings.id, 1))
    .returning({ pointer: schema.settings.rrPointer });
  const before = (row.pointer - 1 + pool.length) % pool.length; // the slot this call takes
  return pool[before].id;
};

/** Default strategy: booking host, then escalation designer for complaints, then round-robin. */
export const defaultAssigner: Assigner = async (ctx) => {
  if (ctx.bookingHostDesignerId) return ctx.bookingHostDesignerId;
  if (ctx.escalate) {
    const head = await one(db.select().from(schema.designers).where(eq(schema.designers.isEscalation, true)));
    if (head) return head.id;
  }
  return roundRobin(ctx);
};

let current: Assigner = defaultAssigner;

/** Swap the assignment strategy (for example, by workload or by skill) without touching the pipeline. */
export function setAssigner(fn: Assigner) {
  current = fn;
}

export async function assignDesigner(ctx: AssignmentContext): Promise<number | null> {
  return current(ctx);
}
