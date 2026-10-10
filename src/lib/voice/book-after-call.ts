import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { IST } from "@/lib/working-hours";

/**
 * Booking after the call. The voice agent collects the caller's name, email and the day and time they would like;
 * Vaani extracts those into the call_postprocessing event (see the agent's data points). This module then books the
 * nearest free Cal.com slot, so the voice agent never needs a calendar tool and the Cal.com key stays in this app.
 * The Cal.com webhook then links the booking to the call as usual.
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

export type BookOutcome = { state: "booked"; uid: string; start: string } | { state: "skipped" | "failed"; reason: string };

const api = (path: string, init: RequestInit = {}, version = "2024-08-13") =>
  fetch(`https://api.cal.com/v2${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.CALCOM_API_KEY}`, "cal-api-version": version, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });

/** Book the free slot nearest to (and not before) what the caller asked for. */
export async function bookAfterCall(callId: number, entities: unknown, now: Date = new Date()): Promise<BookOutcome> {
  const skip = async (reason: string, state: "skipped" | "failed" = "skipped"): Promise<BookOutcome> => {
    await audit("booking.auto", { state, reason }, callId);
    return { state, reason };
  };
  if (env.CALCOM_MODE !== "live" || !env.CALCOM_API_KEY || !env.CALCOM_EVENT_TYPE_ID) return { state: "skipped", reason: "Cal.com is not live" };

  const call = (await db.select().from(schema.calls).where(eq(schema.calls.id, callId)))[0];
  if (!call) return { state: "skipped", reason: "no such call" };
  if (call.bookingId && call.bookingStatus !== "cancelled") return skip("already has a booking");
  if (call.status === "disqualified" || call.status === "yet_to_be_processed") return skip(`status is ${call.status}`);

  const wish = wishFromEntities(entities);
  if (!wish.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wish.email)) return skip("no usable email");
  const wanted = wantedStart(wish, call.startedAt);
  if (!wanted) return skip("no usable day and time");

  try {
    const from = DateTime.max(wanted, DateTime.fromJSDate(now, { zone: IST }).plus({ hours: 1 }));
    const res = await api(`/slots?eventTypeId=${env.CALCOM_EVENT_TYPE_ID}&start=${from.toISODate()}&end=${from.plus({ days: 7 }).toISODate()}&timeZone=Asia/Kolkata`, {}, "2024-09-04");
    const body = (await res.json()) as { data?: Record<string, { start: string }[]> };
    const slot = Object.values(body.data ?? {})
      .flat()
      .map((s) => DateTime.fromISO(s.start, { setZone: true }))
      .filter((d) => d.isValid && d >= from)
      .sort((a, b) => a.toMillis() - b.toMillis())[0];
    if (!slot) return skip("no free slot in the next 7 days", "failed");

    const attendee: Record<string, string> = { name: wish.name ?? call.callerName ?? "Caller", email: wish.email, timeZone: "Asia/Kolkata" };
    if (call.callerPhone && /^\+\d{8,15}$/.test(call.callerPhone)) attendee.phoneNumber = call.callerPhone;
    const book = await api("/bookings", { method: "POST", body: JSON.stringify({ start: slot.toUTC().toISO(), eventTypeId: Number(env.CALCOM_EVENT_TYPE_ID), attendee }) });
    const out = (await book.json()) as { data?: { uid?: string }; error?: { message?: string } };
    if (!book.ok || !out.data?.uid) return skip(`Cal.com refused: ${out.error?.message ?? book.status}`, "failed");
    await audit("booking.auto", { state: "booked", uid: out.data.uid, start: slot.toISO(), asked: wanted.toISO() }, callId);
    return { state: "booked", uid: out.data.uid, start: slot.toISO()! };
  } catch (e) {
    return skip(e instanceof Error ? e.message : String(e), "failed");
  }
}
