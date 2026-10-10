import type { schema } from "@/db";
import { fmtWhen, STATUS_LABEL } from "@/lib/format";
import { dashboardLink, deepLink, type OutMessage } from "@/lib/telegram";

type Call = typeof schema.calls.$inferSelect;

const who = (c: Call) => c.callerName ?? c.callerPhone ?? "Unknown caller";

/** "Priya · Qualified · score 93" */
function headline(c: Call): string {
  return `${who(c)} · ${STATUS_LABEL[c.status] ?? c.status} · score ${c.score ?? "n/a"}`;
}

function detailLines(c: Call, now: Date): string[] {
  const lines: string[] = [];
  const where = [c.location, c.propertyType].filter(Boolean).join(", ");
  if (where) lines.push(where);
  if (c.bookedSlot && c.bookingStatus !== "cancelled") lines.push(`Booked: ${fmtWhen(c.bookedSlot, now)}`);
  return lines;
}

const buttonsFor = (c: Call, withAck: boolean) => [[{ text: "Open", url: deepLink(c.id) }, ...(withAck ? [{ text: "Acknowledge", callbackData: `ack:${c.id}` }] : [])]];

/** One call, unacknowledged past the SLA. */
export function slaMessage(c: Call, now: Date): OutMessage {
  return {
    text: ["Reminder: this enquiry is waiting for you", headline(c), ...detailLines(c, now), `Called ${fmtWhen(c.startedAt, now)}`, deepLink(c.id)].join("\n"),
    rows: buttonsFor(c, true),
  };
}

/** The 09:00 digest: ONE message listing every pending call for that designer. */
export function digestMessage(calls: Call[], now: Date): OutMessage {
  const MAX = 8;
  const shown = calls.slice(0, MAX);
  const lines = shown.map((c, i) => {
    const slot = c.bookedSlot && c.bookingStatus !== "cancelled" ? ` · booked ${fmtWhen(c.bookedSlot, now)}` : "";
    return `${i + 1}. ${headline(c)}${slot}\n   ${deepLink(c.id)}`;
  });
  if (calls.length > MAX) lines.push(`and ${calls.length - MAX} more`);
  return {
    text: [`Good morning. ${calls.length} ${calls.length === 1 ? "call is" : "calls are"} waiting for you:`, ...lines].join("\n"),
    // Open only. Acknowledging means you have read the note, so it is not offered here.
    rows: [[{ text: "Open dashboard", url: dashboardLink() }], ...shown.map((c, i) => [{ text: `Open ${i + 1}`, url: deepLink(c.id) }])].slice(0, 6),
  };
}

/** A booked slot is close and nobody has acknowledged the call. */
export function slotMessage(c: Call, minutesLeft: number, now: Date, copyFor?: string): OutMessage {
  const unassigned = !c.assignedDesignerId;
  return {
    text: [
      `URGENT: consultation in ${minutesLeft} min and the call is not ${unassigned ? "assigned to a designer" : "acknowledged"}${copyFor ? ` (copy: assigned to ${copyFor})` : ""}`,
      headline(c),
      ...detailLines(c, now),
      deepLink(c.id),
    ].join("\n"),
    rows: unassigned ? [[{ text: "Open", url: deepLink(c.id) }]] : buttonsFor(c, true),
  };
}

export function bookingChangedMessage(c: Call, kind: "rescheduled" | "cancelled", now: Date): OutMessage {
  const what = kind === "cancelled" ? "Booking cancelled" : `Booking rescheduled to ${c.bookedSlot ? fmtWhen(c.bookedSlot, now) : "a new time"}`;
  return {
    text: [what, headline(c), deepLink(c.id)].join("\n"),
    rows: buttonsFor(c, !c.acknowledgedAt),
  };
}

/** For the front desk: a call has waited too long to be assigned. One button per designer assigns it with a tap. */
export function assignReminderMessage(c: Call, designers: { id: number; name: string }[], now: Date): OutMessage {
  const pick = designers.map((d) => ({ text: d.name, callbackData: `asg:${c.id}:${d.id}` }));
  const rows: { text: string; callbackData: string }[][] = [];
  for (let i = 0; i < pick.length; i += 2) rows.push(pick.slice(i, i + 2));
  return {
    text: ["Waiting to be assigned to a designer", headline(c), ...detailLines(c, now), `Called ${fmtWhen(c.startedAt, now)}`, "Tap a designer to assign it, or open it.", deepLink(c.id)].join("\n"),
    rows: [[{ text: "Open", url: deepLink(c.id) }], ...rows],
  };
}

/** The front desk's 09:00 digest: ONE message listing every call still waiting to be assigned. */
export function assignDigestMessage(calls: Call[], now: Date): OutMessage {
  const MAX = 8;
  const shown = calls.slice(0, MAX);
  const lines = shown.map((c, i) => `${i + 1}. ${headline(c)}\n   ${deepLink(c.id)}`);
  if (calls.length > MAX) lines.push(`and ${calls.length - MAX} more`);
  return {
    text: [`Good morning. ${calls.length} ${calls.length === 1 ? "call is" : "calls are"} waiting to be assigned:`, ...lines].join("\n"),
    rows: [[{ text: "Open inbox", url: dashboardLink("front_desk") }], ...shown.map((c, i) => [{ text: `Open ${i + 1}`, url: deepLink(c.id) }])].slice(0, 6),
  };
}

/** For the designer: a call has just been given to them. */
export function assignedMessage(c: Call, now: Date, byName: string | null): OutMessage {
  return {
    text: [`A call has been assigned to you${byName ? ` by ${byName}` : ""}`, headline(c), ...detailLines(c, now), `Called ${fmtWhen(c.startedAt, now)}`, deepLink(c.id)].join("\n"),
    rows: buttonsFor(c, true),
  };
}
