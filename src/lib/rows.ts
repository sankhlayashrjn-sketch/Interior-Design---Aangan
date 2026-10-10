import type { CallRow } from "@/components/neu/CallTable";
import type { Call } from "@/lib/calls";
import { fmtWhen } from "@/lib/format";

/** Turn a call into the plain row the table draws. `last` is the right-hand cell (a deadline, or who has it). */
export function toRow(c: Call, now: Date, href: string, last: { text: string; overdue: boolean }, sub?: string): CallRow {
  return {
    id: c.id,
    href,
    timeLabel: fmtWhen(c.startedAt, now),
    name: c.callerName ?? c.callerPhone ?? "Unknown caller",
    sub: sub ?? (c.callerName ? (c.callerPhone ?? "Caller ID withheld") : (c.location ?? "")),
    score: c.score,
    status: c.status,
    flag: c.flag,
    bookedLabel: c.bookedSlot && c.bookingStatus !== "cancelled" ? fmtWhen(c.bookedSlot, now) : c.bookingStatus === "cancelled" ? "Cancelled" : "–",
    lastText: last.text,
    lastOverdue: last.overdue,
  };
}
