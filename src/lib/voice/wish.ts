import { DateTime } from "luxon";
import { IST } from "@/lib/working-hours";

/**
 * Pure helpers for reading what a caller asked for. Kept apart from the booking code on purpose: they import nothing
 * heavy, so the Vaani adapter can use them without pulling in the whole pipeline (which would be a circular import).
 */

export interface BookingWish {
  name: string | null;
  email: string | null;
  day: string | null;
  time: string | null;
}

const clean = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && !/^(n\/?a|none|null|not (stated|provided|given)|unknown)$/i.test(t) ? t : null;
};

/** The data points Vaani extracts (names are set on the agent by scripts/vaani-setup). */
export function wishFromEntities(entities: unknown): BookingWish {
  const e = (entities && typeof entities === "object" ? entities : {}) as Record<string, unknown>;
  return { name: clean(e.customer_name), email: clean(e.customer_email)?.toLowerCase().replace(/\s+/g, "") ?? null, day: clean(e.preferred_day), time: clean(e.preferred_time_24h) };
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** "tomorrow", "Monday", "next Friday", "14 October", "2026-10-14" -> a date, counted from the day of the call. */
export function resolveDay(text: string | null, from: DateTime): DateTime | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  const day0 = from.startOf("day");
  if (/^today$/.test(t)) return day0;
  if (/^tomorrow$/.test(t)) return day0.plus({ days: 1 });
  if (/^day after tomorrow$/.test(t)) return day0.plus({ days: 2 });
  const wd = WEEKDAYS.findIndex((d) => t.includes(d));
  if (wd >= 0) {
    // A weekday name means its next occurrence ("Monday" said on a Monday means a week from now).
    const add = (wd + 1 - day0.weekday + 7) % 7 || 7;
    return day0.plus({ days: add });
  }
  for (const fmt of ["yyyy-MM-dd", "d MMMM yyyy", "d MMMM", "MMMM d", "d MMM", "MMM d", "d/M/yyyy", "d/M"]) {
    let d = DateTime.fromFormat(text.trim(), fmt, { zone: IST });
    if (!d.isValid) continue;
    if (!/y{2,4}/.test(fmt)) {
      d = d.set({ year: day0.year });
      if (d < day0) d = d.plus({ years: 1 });
    }
    return d.startOf("day");
  }
  return null;
}

export function resolveTime(text: string | null): { hour: number; minute: number } | null {
  const m = text && /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/** When the caller asked for, in IST, or null if they did not say a usable day and time. */
export function wantedStart(wish: BookingWish, calledAt: Date): DateTime | null {
  const day = resolveDay(wish.day, DateTime.fromJSDate(calledAt, { zone: IST }));
  const time = resolveTime(wish.time);
  return day && time ? day.set(time) : null;
}

