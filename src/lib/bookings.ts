import "@/lib/runtime";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, one, schema } from "@/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { emit } from "@/lib/hooks";
import { rescoreCall } from "@/lib/ingest";
import { normalizePhone } from "@/lib/phone";

/**
 * Cal.com webhook handling.
 * TODO(verify): the field names below follow Cal.com's documented BOOKING_CREATED / BOOKING_RESCHEDULED /
 * BOOKING_CANCELLED payloads as we understand them. Re-check against the current Cal.com webhook docs
 * (payload shape, signature header name, where the attendee's phone lives) before going live.
 */
export const CalWebhookSchema = z
  .object({
    triggerEvent: z.string(),
    payload: z
      .object({
        uid: z.string(),
        rescheduleUid: z.string().nullish(),
        startTime: z.string(),
        endTime: z.string().nullish(),
        organizer: z.object({ email: z.string().nullish(), username: z.string().nullish() }).partial().nullish(),
        attendees: z.array(z.object({ email: z.string().nullish(), phoneNumber: z.string().nullish() }).partial()).nullish(),
        responses: z.record(z.string(), z.unknown()).nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export type CalWebhook = z.infer<typeof CalWebhookSchema>;

/** HMAC-SHA256 hex of the raw body, compared in constant time. */
export function verifyCalSignature(rawBody: string, header: string | null, secret = env.CALCOM_WEBHOOK_SECRET, mocking = env.CALCOM_MODE === "mock"): boolean {
  if (!secret) return mocking; // no secret: only acceptable while mocking
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header.trim().replace(/^sha256=/i, ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function phoneFrom(p: CalWebhook["payload"]): string | null {
  const fromAttendee = p.attendees?.map((a) => a.phoneNumber).find(Boolean);
  const resp = p.responses?.["attendeePhoneNumber"] as { value?: string } | string | undefined;
  const fromResponses = typeof resp === "string" ? resp : resp?.value;
  return normalizePhone(fromAttendee ?? fromResponses ?? null);
}

async function hostDesigner(email?: string | null, username?: string | null): Promise<number | null> {
  const needles = [email, username].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  if (needles.length === 0) return null;
  const all = await db.select().from(schema.designers);
  return all.find((d) => d.calcomUser && needles.includes(d.calcomUser.toLowerCase()))?.id ?? null;
}

export interface BookingOutcome {
  callId: number | null;
  kind: "booked" | "rescheduled" | "cancelled";
}

/** Apply one verified Cal.com event: store the booking, link it to a call, update the call, rescore, notify. */
export async function applyCalEvent(evt: CalWebhook): Promise<BookingOutcome> {
  const p = evt.payload;
  const kind = /CANCEL/i.test(evt.triggerEvent) ? "cancelled" : /RESCHEDUL/i.test(evt.triggerEvent) ? "rescheduled" : "booked";
  const now = new Date();
  const phone = phoneFrom(p);
  const hostId = await hostDesigner(p.organizer?.email, p.organizer?.username);

  // A reschedule arrives under a new uid and names the old one.
  let booking = await one(
    db
      .select()
      .from(schema.bookings)
      .where(or(eq(schema.bookings.calcomUid, p.uid), p.rescheduleUid ? eq(schema.bookings.calcomUid, p.rescheduleUid) : sql`false`))
      .limit(1),
  );

  const values = {
    calcomUid: p.uid,
    startTime: new Date(p.startTime),
    endTime: p.endTime ? new Date(p.endTime) : null,
    status: kind,
    hostEmail: p.organizer?.email ?? null,
    hostDesignerId: hostId,
    attendeePhone: phone,
    raw: evt as object,
    updatedAt: now,
  } as const;

  if (booking) {
    [booking] = await db
      .update(schema.bookings)
      .set({ ...values, hostDesignerId: hostId ?? booking.hostDesignerId, attendeePhone: phone ?? booking.attendeePhone })
      .where(eq(schema.bookings.id, booking.id))
      .returning();
  } else {
    // A webhook retry arriving at the same moment hits the unique uid and updates instead of duplicating.
    [booking] = await db
      .insert(schema.bookings)
      .values({ ...values, createdAt: now })
      .onConflictDoUpdate({ target: schema.bookings.calcomUid, set: values })
      .returning();
  }

  // Find the call: by booking id first, then by caller phone (most recent call in the last 3 days). A call whose booking was cancelled can take a new one.
  let call = await one(db.select().from(schema.calls).where(eq(schema.calls.bookingId, booking.calcomUid)).limit(1));
  if (!call && p.rescheduleUid) call = await one(db.select().from(schema.calls).where(eq(schema.calls.bookingId, p.rescheduleUid)).limit(1));
  if (!call && booking.attendeePhone) {
    call = await one(
      db
        .select()
        .from(schema.calls)
        .where(and(eq(schema.calls.callerPhone, booking.attendeePhone), or(isNull(schema.calls.bookingId), eq(schema.calls.bookingStatus, "cancelled")), gte(schema.calls.startedAt, new Date(Date.now() - 3 * 86_400_000))))
        .orderBy(desc(schema.calls.startedAt))
        .limit(1),
    );
  }

  if (!call) {
    await audit("booking.orphan", { uid: p.uid, kind }); // the call may not have been ingested yet; it will link on arrival
    return { callId: null, kind };
  }

  await db.update(schema.bookings).set({ callId: call.id }).where(eq(schema.bookings.id, booking.id));
  const patch: Partial<typeof call> = { bookingId: booking.calcomUid, bookedSlot: booking.startTime, bookingStatus: kind };
  // The Cal.com host owns the call, unless someone has already acknowledged it.
  if (booking.hostDesignerId && !call.acknowledgedAt && call.assignedDesignerId !== booking.hostDesignerId) {
    patch.assignedDesignerId = booking.hostDesignerId;
  }
  await db.update(schema.calls).set(patch).where(eq(schema.calls.id, call.id));
  await rescoreCall(call.id);

  await audit("booking.applied", { uid: p.uid, kind, callId: call.id });
  await emit("booking.changed", { callId: call.id, kind });
  return { callId: call.id, kind };
}
