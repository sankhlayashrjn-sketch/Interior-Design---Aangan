import Link from "next/link";
import type { ReactNode } from "react";
import { FlagChip, StatusChip } from "@/components/Chip";
import type { Call } from "@/lib/calls";
import { fmtDue, fmtWhen } from "@/lib/format";

const ROW = "grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 sm:grid-cols-[5.5rem_minmax(0,1fr)_2.5rem_8.75rem_5.5rem_8rem]";

/** What the last column says for a call: a deadline, or who has it. */
export interface LastCell {
  text: string;
  overdue: boolean;
}

/**
 * Calls as an accordion. Each row is a plain link that opens it (?open=<id>) and the open call's detail
 * appears directly under it, so it works without JavaScript and every open call has a shareable URL.
 */
export function CallList({
  rows,
  now,
  openId,
  hrefFor,
  detail,
  lastLabel,
  lastCell,
  subline,
}: {
  rows: Call[];
  now: Date;
  openId: number | null;
  /** Link for a row: pass the id to open it, or null to close the open one. */
  hrefFor: (id: number | null) => string;
  /** The rendered detail of the open call. */
  detail: ReactNode;
  lastLabel: string;
  lastCell: (c: Call) => LastCell;
  subline?: (c: Call) => string;
}) {
  return (
    <>
      <div className={`${ROW} hidden border-b border-line py-2 text-small text-mute sm:grid`} aria-hidden="true">
        <span>Time</span>
        <span>Caller</span>
        <span>Score</span>
        <span>Status</span>
        <span>Booked</span>
        <span>{lastLabel}</span>
      </div>
      <ul>
        {rows.map((c) => {
          const open = c.id === openId;
          const last = lastCell(c);
          return (
            <li key={c.id} className="border-b border-line">
              <Link href={hrefFor(open ? null : c.id)} aria-expanded={open} className={`${ROW} items-baseline py-3 ${open ? "bg-[#f1f1ee]" : "hover:bg-[#f5f5f3]"}`}>
                <span className="text-small text-mute">{fmtWhen(c.startedAt, now)}</span>
                <span className="col-start-1 row-start-2 min-w-0 sm:col-start-auto sm:row-start-auto">
                  <span className="block truncate font-medium">{c.callerName ?? c.callerPhone ?? "Unknown caller"}</span>
                  <span className="block truncate text-small text-mute">{subline ? subline(c) : c.callerName ? (c.callerPhone ?? "Caller ID withheld") : (c.location ?? "")}</span>
                </span>
                <span className="tabular-nums sm:text-left">{c.score ?? "–"}</span>
                <span className="col-span-2 flex flex-wrap items-center gap-1 sm:col-span-1">
                  <StatusChip status={c.status} />
                  <FlagChip flag={c.flag} />
                </span>
                <span className={`text-small text-mute ${c.bookedSlot ? "" : "hidden sm:block"}`}>
                  {c.bookedSlot && c.bookingStatus !== "cancelled" ? fmtWhen(c.bookedSlot, now) : c.bookingStatus === "cancelled" ? "Cancelled" : "–"}
                </span>
                <span className={`text-small ${last.overdue ? "font-medium text-accent" : "text-mute"}`}>{last.text}</span>
              </Link>
              {open && <div className="border-t border-line bg-paper px-0 pb-4 sm:px-4">{detail}</div>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** "Assign within 1h" / "Overdue by 2h" style text for the front desk's deadline. */
export function assignCell(c: Call, now: Date): LastCell {
  if (!c.assignDueAt) return { text: "–", overdue: false };
  const d = fmtDue(c.assignDueAt, null, now);
  return { text: d.text, overdue: d.state === "overdue" };
}

export function ackCell(c: Call, now: Date): LastCell {
  const d = fmtDue(c.dueAt, c.acknowledgedAt, now);
  return { text: d.text, overdue: d.state === "overdue" };
}
