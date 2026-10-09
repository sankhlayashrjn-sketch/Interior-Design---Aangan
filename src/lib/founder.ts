import { DateTime } from "luxon";
import { and, desc, eq, gte, lt, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import type { CallStatus } from "@/db/schema";
import { getSettings, hoursConfig } from "@/lib/settings";
import { IST, workingMinutesBetween } from "@/lib/working-hours";

type Call = typeof schema.calls.$inferSelect;

export type Range = "today" | "7d" | "30d";
export const RANGES: { key: Range; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

export const parseRange = (v: string | undefined): Range => (RANGES.some((r) => r.key === v) ? (v as Range) : "30d");

const at = (d: Date) => DateTime.fromJSDate(d, { zone: IST });

/** Start of the range, at 00:00 IST. "7d" and "30d" include today. */
export function rangeStart(range: Range, now: Date): Date {
  const days = range === "today" ? 0 : range === "7d" ? 6 : 29;
  return at(now).startOf("day").minus({ days }).toJSDate();
}

const callsSince = (start: Date, end?: Date) =>
  db
    .select()
    .from(schema.calls)
    .where(and(gte(schema.calls.startedAt, start), end ? lt(schema.calls.startedAt, end) : undefined))
    .all();

export interface FounderMetrics {
  callsToday: number;
  callsInRange: number;
  /** Of calls whose acknowledgement deadline has passed or that were acknowledged: how many were acknowledged on time. */
  sla: { pct: number | null; met: number; total: number };
  /** Calls that arrived outside working hours, and how many of those have since been acknowledged. */
  afterHours: { count: number; acknowledged: number };
  /** Average WORKING minutes from the call to its acknowledgement (nights and Sundays don't count). */
  avgAckMinutes: number | null;
  ackCount: number;
  booked: number;
}

export function founderMetrics(range: Range, now: Date = new Date()): FounderMetrics {
  const today = callsSince(at(now).startOf("day").toJSDate());
  const rows = callsSince(rangeStart(range, now)).filter((c) => c.status !== "yet_to_be_processed");
  const cfg = hoursConfig();

  // SLA: judged only once it can be judged (acknowledged, or past due and still waiting).
  const judged = rows.filter((c) => c.acknowledgedAt || (c.dueAt && c.dueAt.getTime() < now.getTime()));
  const met = judged.filter((c) => c.acknowledgedAt && c.dueAt && c.acknowledgedAt.getTime() <= c.dueAt.getTime()).length;

  const acked = rows.filter((c) => c.acknowledgedAt);
  const minutes = acked.map((c) => workingMinutesBetween(c.startedAt, c.acknowledgedAt!, cfg));
  const afterHours = rows.filter((c) => c.afterHours);

  return {
    callsToday: today.length,
    callsInRange: rows.length,
    sla: { pct: judged.length ? Math.round((met / judged.length) * 100) : null, met, total: judged.length },
    afterHours: { count: afterHours.length, acknowledged: afterHours.filter((c) => c.acknowledgedAt).length },
    avgAckMinutes: minutes.length ? minutes.reduce((a, b) => a + b, 0) / minutes.length : null,
    ackCount: acked.length,
    booked: rows.filter((c) => c.bookedSlot && c.bookingStatus !== "cancelled").length,
  };
}

export interface CostPanel {
  /** Averages over calls in the range that have a cost row. */
  perCall: { calls: number; ai: number; telephonyMinutes: number; telephony: number; total: number } | null;
  /** The current calendar month (IST). */
  month: { label: string; calls: number; ai: number; telephony: number; total: number; qualified: number; perQualified: number | null };
  /** True if any figure in view comes from the mock AI's token estimates rather than a real model. */
  estimated: boolean;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function costPanel(range: Range, now: Date = new Date()): CostPanel {
  const costs = (start: Date, end?: Date) =>
    db
      .select({ call: schema.calls, cost: schema.callsCost })
      .from(schema.calls)
      .innerJoin(schema.callsCost, eq(schema.callsCost.callId, schema.calls.id))
      .where(and(gte(schema.calls.startedAt, start), end ? lt(schema.calls.startedAt, end) : undefined))
      .all();

  const inRange = costs(rangeStart(range, now));
  const monthStart = at(now).startOf("month");
  const month = costs(monthStart.toJSDate(), monthStart.plus({ months: 1 }).toJSDate());

  const ai = month.reduce((s, r) => s + r.cost.aiCostInr, 0);
  const tel = month.reduce((s, r) => s + r.cost.telephonyCostInr, 0);
  const qualified = month.filter((r) => r.call.status === "qualified").length;

  return {
    perCall: inRange.length
      ? {
          calls: inRange.length,
          ai: avg(inRange.map((r) => r.cost.aiCostInr)),
          telephonyMinutes: avg(inRange.map((r) => r.cost.telephonyMinutes)),
          telephony: avg(inRange.map((r) => r.cost.telephonyCostInr)),
          total: avg(inRange.map((r) => r.cost.aiCostInr + r.cost.telephonyCostInr)),
        }
      : null,
    month: { label: monthStart.toFormat("LLLL yyyy"), calls: month.length, ai, telephony: tel, total: ai + tel, qualified, perQualified: qualified ? (ai + tel) / qualified : null },
    estimated: [...inRange, ...month].some((r) => r.cost.model.startsWith("mock")),
  };
}


export function founderList(status: CallStatus, limit = 200): (Call & { designerName: string | null })[] {
  const designers = db.select().from(schema.designers).all();
  return db
    .select()
    .from(schema.calls)
    .where(eq(schema.calls.status, status))
    .orderBy(desc(schema.calls.startedAt))
    .limit(limit)
    .all()
    .map((c) => ({ ...c, designerName: designers.find((d) => d.id === c.assignedDesignerId)?.name ?? null }));
}

export function statusCounts(): Record<CallStatus, number> {
  const out: Record<CallStatus, number> = { qualified: 0, disqualified: 0, needs_attention: 0, yet_to_be_processed: 0 };
  for (const c of db.select({ s: schema.calls.status }).from(schema.calls).where(ne(schema.calls.status, "yet_to_be_processed")).all()) out[c.s]++;
  out.yet_to_be_processed = db.select().from(schema.calls).where(eq(schema.calls.status, "yet_to_be_processed")).all().length;
  return out;
}

export { getSettings };
