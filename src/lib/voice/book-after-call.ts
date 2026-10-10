import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { emit, on } from "@/lib/hooks";
import { rescoreCall } from "@/lib/ingest";
import { IST } from "@/lib/working-hours";

import { resolveDay, resolveTime, wantedStart, wishFromEntities, type BookingWish } from "./wish";

// Re-exported so the booking code and its tests keep one import.
export { resolveDay, resolveTime, wantedStart, wishFromEntities };
export type { BookingWish };

/**
 * Booking after the call. The voice agent collects the caller's name, email and the day and time they would like;
 * Vaani extracts those into the call_postprocessing event. They are saved on the call, and the Cal.com booking is made
 * once a designer is assigned, so the invite can name that designer.
 */

/** What the caller asked for, saved on the call until a designer is assigned. */
export interface StoredWish {
  name: string | null;
  email: string;
  /** ISO time the caller asked for (IST). */
  wantedAt: string;
  /** The Cal.com booking this app made for the call, so it can be replaced if the call is given to someone else. */
  appBookingUid?: string;
  appBookingDesignerId?: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Called when the voice call's details arrive. Saves the caller's email and preferred time on the call if they gave
 * both. The booking itself waits until a designer is assigned, so the invite can name that designer.
 */
export async function rememberBookingWish(callId: number, entities: unknown): Promise<boolean> {
  const call = (await db.select().from(schema.calls).where(eq(schema.calls.id, callId)))[0];
  if (!call) return false;
  const wish = wishFromEntities(entities);
  const wanted = wantedStart(wish, call.startedAt);
  if (!wish.email || !EMAIL.test(wish.email) || !wanted) {
    await audit("booking.wish", { saved: false, reason: !wish.email || !EMAIL.test(wish.email) ? "no usable email" : "no usable day and time" }, callId);
    return false;
  }
  const stored: StoredWish = { name: wish.name, email: wish.email, wantedAt: wanted.toISO()! };
  await db.update(schema.calls).set({ bookingWish: stored }).where(eq(schema.calls.id, callId));
  await audit("booking.wish", { saved: true, wantedAt: stored.wantedAt }, callId);
  return true;
}

export type BookOutcome = { state: "booked"; uid: string; start: string } | { state: "skipped" | "failed"; reason: string };

const api = (path: string, init: RequestInit = {}, version = "2024-08-13") =>
  fetch(`https://api.cal.com/v2${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.CALCOM_API_KEY}`, "cal-api-version": version, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });

/**
 * Book the call's consultation once a designer has it. The Cal.com invite is titled with the designer's name. The nearest
 * free slot at or after what the caller asked for (and not in the past) is used. If this app already booked one for
 * a different designer, that booking is cancelled and replaced. A booking made by anyone else is never touched.
 */
export async function bookAfterCall(callId: number, now: Date = new Date()): Promise<BookOutcome> {
  const skip = async (reason: string, state: "skipped" | "failed" = "skipped"): Promise<BookOutcome> => {
    await audit("booking.auto", { state, reason }, callId);
    return { state, reason };
  };
  if (env.CALCOM_MODE !== "live" || !env.CALCOM_API_KEY || !env.CALCOM_EVENT_TYPE_ID) return { state: "skipped", reason: "Cal.com is not live" };

  const call = (await db.select().from(schema.calls).where(eq(schema.calls.id, callId)))[0];
  if (!call) return { state: "skipped", reason: "no such call" };
  const wish = call.bookingWish as StoredWish | null;
  if (!wish) return { state: "skipped", reason: "the caller gave no email and time" };
  if (!call.assignedDesignerId) return { state: "skipped", reason: "not assigned yet" };
  if (call.status === "disqualified" || call.status === "yet_to_be_processed") return skip(`status is ${call.status}`);

  const designer = (await db.select().from(schema.designers).where(eq(schema.designers.id, call.assignedDesignerId)))[0];
  if (!designer) return skip("designer not found");

  const active = !!call.bookingId && call.bookingStatus !== "cancelled";
  const ours = !!wish.appBookingUid && wish.appBookingUid === call.bookingId;
  if (active && !ours) return skip("already has a booking made elsewhere");
  if (active && ours && wish.appBookingDesignerId === designer.id) return skip("already booked for this designer");

  try {
    if (active && ours) {
      const c = await api(`/bookings/${wish.appBookingUid}/cancel`, { method: "POST", body: JSON.stringify({ cancellationReason: "The call was given to another designer" }) });
      if (!c.ok) return skip(`could not replace the earlier booking (Cal.com ${c.status})`, "failed");
    }

    const asked = DateTime.fromISO(wish.wantedAt, { zone: IST });
    const from = DateTime.max(asked, DateTime.fromJSDate(now, { zone: IST }).plus({ hours: 1 }));
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
    const book = await api("/bookings", {
      method: "POST",
      body: JSON.stringify({ start: slot.toUTC().toISO(), eventTypeId: Number(env.CALCOM_EVENT_TYPE_ID), attendee, bookingFieldsResponses: { designer: designer.name } }),
    });
    const out = (await book.json()) as { data?: { uid?: string }; error?: { message?: string } };
    if (!book.ok || !out.data?.uid) return skip(`Cal.com refused: ${out.error?.message ?? book.status}`, "failed");

    // Link it to the call right now. Cal.com's webhook arrives later and finds it already linked (a phone-less caller
    // could not be matched by it at all).
    const startTime = new Date(slot.toISO()!);
    const stamp = new Date();
    await db
      .insert(schema.bookings)
      .values({ calcomUid: out.data.uid, callId, startTime, status: "booked", attendeePhone: call.callerPhone, raw: { source: "app", designerId: designer.id }, createdAt: stamp, updatedAt: stamp })
      .onConflictDoUpdate({ target: schema.bookings.calcomUid, set: { callId, startTime, status: "booked", updatedAt: stamp } });
    await db
      .update(schema.calls)
      .set({ bookingId: out.data.uid, bookedSlot: startTime, bookingStatus: "booked", bookingWish: { ...wish, appBookingUid: out.data.uid, appBookingDesignerId: designer.id } satisfies StoredWish })
      .where(eq(schema.calls.id, callId));
    await rescoreCall(callId);
    await emit("booking.changed", { callId, kind: "booked" });
    await audit("booking.auto", { state: "booked", uid: out.data.uid, start: slot.toISO(), asked: wish.wantedAt, designer: designer.name }, callId);
    return { state: "booked", uid: out.data.uid, start: slot.toISO()! };
  } catch (e) {
    return skip(e instanceof Error ? e.message : String(e), "failed");
  }
}

/** Book (or re-book) whenever a call is given to a designer. Registered once, from runtime.ts. */
export function registerBookingHandlers() {
  on("call.assigned", async ({ callId }) => {
    await bookAfterCall(callId);
  });
}
