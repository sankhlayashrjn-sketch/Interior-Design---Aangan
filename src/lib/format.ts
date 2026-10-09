import { DateTime } from "luxon";
import { IST } from "@/lib/working-hours";

const at = (d: Date | number) => DateTime.fromMillis(new Date(d).getTime(), { zone: IST });

/** "Today 11:04", "Yesterday 16:02", "Wed 11:04" (within the last week), else "5 Oct 11:04". All IST. */
export function fmtWhen(d: Date | number, now: Date = new Date()): string {
  const t = at(d);
  const n = at(now);
  const days = Math.round(n.startOf("day").diff(t.startOf("day"), "days").days);
  const hm = t.toFormat("HH:mm");
  if (days === 0) return `Today ${hm}`;
  if (days === 1) return `Yesterday ${hm}`;
  if (days === -1) return `Tomorrow ${hm}`;
  if (days > 1 && days < 7) return `${t.toFormat("ccc")} ${hm}`;
  if (days < -1 && days > -7) return `${t.toFormat("ccc")} ${hm}`;
  return `${t.toFormat("d LLL")} ${hm}`;
}

export const fmtDateTime = (d: Date | number) => at(d).toFormat("ccc d LLL yyyy, HH:mm") + " IST";

function span(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h${min % 60 && h < 6 ? ` ${min % 60}m` : ""}`;
  return `${Math.floor(h / 24)} days`;
}

export type DueState = "ok" | "overdue" | "done" | "none";

/** The "due in" / "overdue" indicator. `dueAt` is an absolute instant (already working-time aware). */
export function fmtDue(dueAt: Date | null, acknowledgedAt: Date | null, now: Date = new Date()): { text: string; state: DueState } {
  if (acknowledgedAt) return { text: `Acknowledged ${fmtWhen(acknowledgedAt, now)}`, state: "done" };
  if (!dueAt) return { text: "Processing", state: "none" };
  const diff = dueAt.getTime() - now.getTime();
  if (diff < 0) return { text: `Overdue ${span(-diff)}`, state: "overdue" };
  if (diff < 24 * 3_600_000) return { text: `Due in ${span(diff)}`, state: "ok" };
  return { text: `Due ${fmtWhen(dueAt, now)}`, state: "ok" };
}

export const STATUS_LABEL: Record<string, string> = {
  yet_to_be_processed: "Processing",
  qualified: "Qualified",
  needs_attention: "Needs attention",
  disqualified: "Disqualified",
};

export const FLAG_LABEL: Record<string, string> = {
  existing_client: "Existing client",
  upset_caller: "Handle with care",
  no_transcript: "No transcript",
  ai_failed: "AI failed",
};

export const PROPERTY_LABEL = (v: string | null) => (v ? v[0].toUpperCase() + v.slice(1) : "Not stated");

/** ₹1,234.50 with Indian digit grouping. */
export const fmtInr = (n: number, digits = 2) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

/** "45 min", "2h 10m". */
export function fmtMinutes(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
