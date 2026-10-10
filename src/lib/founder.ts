import { DateTime } from "luxon";
import { and, count, desc, eq, gte, lt } from "drizzle-orm";
import { db, schema } from "@/db";
import type { CallStatus } from "@/db/schema";
import { getSettings, loadHours } from "@/lib/settings";
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
    .where(and(gte(schema.calls.startedAt, start), end ? lt(schema.calls.startedAt, end) : undefined));

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

export async function founderMetrics(range: Range, now: Date = new Date()): Promise<FounderMetrics> {
  const today = await callsSince(at(now).startOf("day").toJSDate());
  const rows = (await callsSince(rangeStart(range, now))).filter((c) => c.status !== "yet_to_be_processed");
  const cfg = await loadHours();

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

export async function costPanel(range: Range, now: Date = new Date()): Promise<CostPanel> {
  const costs = (start: Date, end?: Date) =>
    db
      .select({ call: schema.calls, cost: schema.callsCost })
      .from(schema.calls)
      .innerJoin(schema.callsCost, eq(schema.callsCost.callId, schema.calls.id))
      .where(and(gte(schema.calls.startedAt, start), end ? lt(schema.calls.startedAt, end) : undefined));

  const inRange = await costs(rangeStart(range, now));
  const monthStart = at(now).startOf("month");
  const month = await costs(monthStart.toJSDate(), monthStart.plus({ months: 1 }).toJSDate());

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

export async function founderList(status: CallStatus, limit = 200): Promise<(Call & { designerName: string | null })[]> {
  const designers = await db.select().from(schema.designers);
  const rows = await db.select().from(schema.calls).where(eq(schema.calls.status, status)).orderBy(desc(schema.calls.startedAt)).limit(limit);
  return rows.map((c) => ({ ...c, designerName: designers.find((d) => d.id === c.assignedDesignerId)?.name ?? null }));
}

export async function statusCounts(): Promise<Record<CallStatus, number>> {
  const out: Record<CallStatus, number> = { qualified: 0, disqualified: 0, needs_attention: 0, yet_to_be_processed: 0 };
  const rows = await db.select({ status: schema.calls.status, n: count() }).from(schema.calls).groupBy(schema.calls.status);
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export { getSettings };

export interface TrendDay {
  /** IST date, YYYY-MM-DD */
  date: string;
  label: string;
  total: number;
  qualified: number;
  needsAttention: number;
  disqualified: number;
}

/** Calls per day for the chart: last 7 days for "today" and "7 days", last 30 for "30 days". Days with no calls are included as zero. */
export async function founderTrend(range: Range, now: Date = new Date()): Promise<TrendDay[]> {
  const days = range === "30d" ? 30 : 7;
  const first = at(now).startOf("day").minus({ days: days - 1 });
  const rows = await callsSince(first.toJSDate());
  const out: TrendDay[] = [];
  for (let i = 0; i < days; i++) {
    const day = first.plus({ days: i });
    const next = day.plus({ days: 1 }).toMillis();
    const mine = rows.filter((c) => c.startedAt.getTime() >= day.toMillis() && c.startedAt.getTime() < next);
    out.push({
      date: day.toISODate()!,
      label: day.toFormat("ccc d"),
      total: mine.length,
      qualified: mine.filter((c) => c.status === "qualified").length,
      needsAttention: mine.filter((c) => c.status === "needs_attention").length,
      disqualified: mine.filter((c) => c.status === "disqualified").length,
    });
  }
  return out;
}

export interface DesignerLoad {
  id: number;
  name: string;
  isEscalation: boolean;
  /** Calls assigned in the period. */
  assigned: number;
  /** Waiting for acknowledgement right now (any age). */
  waiting: number;
  /** Waiting and already past the deadline. */
  overdue: number;
  acknowledged: number;
  /** Of the calls that could be judged, the share acknowledged on time. Null if none could be. */
  onTimePct: number | null;
  /** Average working minutes from call to acknowledgement. */
  avgAckMinutes: number | null;
}

export async function designerWorkload(range: Range, now: Date = new Date()): Promise<DesignerLoad[]> {
  const designers = await db.select().from(schema.designers).where(eq(schema.designers.active, true));
  const inRange = (await callsSince(rangeStart(range, now))).filter((c) => c.status !== "yet_to_be_processed");
  const everyone = await db.select().from(schema.calls);
  const cfg = await loadHours();
  const t = now.getTime();

  return designers
    .map((d) => {
      const mine = inRange.filter((c) => c.assignedDesignerId === d.id);
      const waiting = everyone.filter((c) => c.assignedDesignerId === d.id && !c.acknowledgedAt && c.status !== "yet_to_be_processed");
      const judged = mine.filter((c) => c.acknowledgedAt || (c.dueAt && c.dueAt.getTime() < t));
      const onTime = judged.filter((c) => c.acknowledgedAt && c.dueAt && c.acknowledgedAt.getTime() <= c.dueAt.getTime()).length;
      const acked = mine.filter((c) => c.acknowledgedAt);
      const minutes = acked.map((c) => workingMinutesBetween(c.startedAt, c.acknowledgedAt!, cfg));
      return {
        id: d.id,
        name: d.name,
        isEscalation: d.isEscalation,
        assigned: mine.length,
        waiting: waiting.length,
        overdue: waiting.filter((c) => c.dueAt && c.dueAt.getTime() < t).length,
        acknowledged: acked.length,
        onTimePct: judged.length ? Math.round((onTime / judged.length) * 100) : null,
        avgAckMinutes: minutes.length ? minutes.reduce((a, b) => a + b, 0) / minutes.length : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface FunnelStep {
  label: string;
  count: number;
  /** Share of all calls in the period. */
  pct: number | null;
}

/** Calls -> qualified -> acknowledged -> booked a slot, for the period. */
export async function funnel(range: Range, now: Date = new Date()): Promise<FunnelStep[]> {
  const rows = (await callsSince(rangeStart(range, now))).filter((c) => c.status !== "yet_to_be_processed");
  const total = rows.length;
  const step = (label: string, count: number): FunnelStep => ({ label, count, pct: total ? Math.round((count / total) * 100) : null });
  return [
    step("Calls", total),
    step("Qualified", rows.filter((c) => c.status === "qualified").length),
    step("Acknowledged by a designer", rows.filter((c) => c.acknowledgedAt).length),
    step("Booked a consultation", rows.filter((c) => c.bookedSlot && c.bookingStatus !== "cancelled").length),
  ];
}
