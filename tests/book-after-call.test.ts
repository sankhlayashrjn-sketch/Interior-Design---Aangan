import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import { assignCall } from "@/lib/calls";
import { env } from "@/lib/env";
import { ingestCall } from "@/lib/ingest";
import { saveSettings } from "@/lib/settings";
import { bookAfterCall, rememberBookingWish, resolveDay, resolveTime, wantedStart, wishFromEntities } from "@/lib/voice/book-after-call";
import { callById, payloadFor, resetDb } from "./helpers";

const IST = "Asia/Kolkata";
const sat = DateTime.fromISO("2026-10-10T13:00", { zone: IST }); // Saturday

describe("reading what the caller asked for", () => {
  it("resolves days relative to the day of the call", () => {
    expect(resolveDay("tomorrow", sat)?.toISODate()).toBe("2026-10-11");
    expect(resolveDay("today", sat)?.toISODate()).toBe("2026-10-10");
    expect(resolveDay("Monday", sat)?.toISODate()).toBe("2026-10-12");
    expect(resolveDay("Saturday", sat)?.toISODate()).toBe("2026-10-17"); // not today: a week from now
    expect(resolveDay("next Friday", sat)?.toISODate()).toBe("2026-10-16");
    expect(resolveDay("14 October", sat)?.toISODate()).toBe("2026-10-14");
    expect(resolveDay("2026-10-20", sat)?.toISODate()).toBe("2026-10-20");
    expect(resolveDay("whenever", sat)).toBeNull();
    expect(resolveDay(null, sat)).toBeNull();
  });

  it("reads 24-hour times and rejects nonsense", () => {
    expect(resolveTime("11:30")).toEqual({ hour: 11, minute: 30 });
    expect(resolveTime("9:00")).toEqual({ hour: 9, minute: 0 });
    expect(resolveTime("25:00")).toBeNull();
    expect(resolveTime("morning")).toBeNull();
  });

  it("ignores placeholders like N/A and tidies the email", () => {
    const w = wishFromEntities({ customer_name: "Priya", customer_email: " Priya@Example.com ", preferred_day: "N/A", preferred_time_24h: "null" });
    expect(w).toEqual({ name: "Priya", email: "priya@example.com", day: null, time: null });
    expect(wantedStart(w, sat.toJSDate())).toBeNull();
    expect(wantedStart({ ...w, day: "Monday", time: "11:00" }, sat.toJSDate())?.toISO()).toBe("2026-10-12T11:00:00.000+05:30");
  });
});

describe("booking once a designer is assigned", () => {
  const entities = { customer_name: "Priya", customer_email: "priya@example.com", preferred_day: "Monday", preferred_time_24h: "11:00" };
  const ISHA = 1; // created below; any number works as "assigned by"
  let bookings: { start: string; attendee: Record<string, string>; designer: string }[];
  let cancelled: string[];
  let n: number;

  function stubCal(slots: string[], refuse = false) {
    bookings = [];
    cancelled = [];
    n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/slots")) return new Response(JSON.stringify({ data: { "2026-10-12": slots.map((start) => ({ start })) } }), { status: 200 });
        const c = /\/bookings\/([^/]+)\/cancel/.exec(u);
        if (c) {
          cancelled.push(c[1]);
          return new Response("{}", { status: 200 });
        }
        if (u.endsWith("/bookings")) {
          if (refuse) return new Response(JSON.stringify({ error: { message: "slot taken" } }), { status: 400 });
          const b = JSON.parse(String(init?.body));
          bookings.push({ start: b.start, attendee: b.attendee, designer: b.bookingFieldsResponses?.designer });
          return new Response(JSON.stringify({ data: { uid: `uid-${++n}` } }), { status: 201 });
        }
        return new Response("{}", { status: 404 });
      }),
    );
  }

  async function aCall(id = "T01") {
    const { call } = await ingestCall(payloadFor(id, { started_at: sat.toUTC().toISO(), caller_phone: "+919822000111" }));
    return call;
  }

  beforeEach(async () => {
    await resetDb();
    await saveSettings({ assignmentMode: "manual" });
    await db.insert(schema.designers).values({ name: "Isha", role: "front_desk", rrOrder: 50 });
    env.CALCOM_MODE = "live";
    env.CALCOM_API_KEY = "k";
    env.CALCOM_EVENT_TYPE_ID = "42";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    env.CALCOM_MODE = "mock";
    env.CALCOM_API_KEY = "";
    env.CALCOM_EVENT_TYPE_ID = "";
  });

  const flush = () => new Promise((r) => setTimeout(r, 50)); // the booking runs from the call.assigned event

  it("nothing is booked while the call is unassigned; assigning books it, with the designer's name on the invite", async () => {
    stubCal(["2026-10-12T10:00:00.000+05:30", "2026-10-12T11:30:00.000+05:30", "2026-10-12T12:00:00.000+05:30"]);
    const call = await aCall();
    expect(await rememberBookingWish(call.id, entities)).toBe(true);
    expect((await bookAfterCall(call.id, sat.toJSDate())).state).toBe("skipped"); // not assigned yet
    expect(bookings).toHaveLength(0);

    await assignCall(call.id, 2, { id: ISHA, how: "front_desk" }, sat.toJSDate());
    await flush();
    expect(bookings).toHaveLength(1);
    expect(bookings[0].designer).toBe("Meera");
    expect(bookings[0].start).toBe("2026-10-12T06:00:00.000Z"); // 11:30 IST: the first free slot at or after 11:00
    expect(bookings[0].attendee).toMatchObject({ name: "Priya", email: "priya@example.com", phoneNumber: "+919822000111" });
    // linked to the call at once, without waiting for Cal.com's webhook
    const linked = await callById(call.id);
    expect(linked.bookingId).toBe("uid-1");
    expect(linked.bookingStatus).toBe("booked");
    expect(linked.bookedSlot!.toISOString()).toBe("2026-10-12T06:00:00.000Z");
  });

  it("moving the call to another designer replaces the booking, so the invite names the new designer", async () => {
    stubCal(["2026-10-12T11:00:00.000+05:30"]);
    const call = await aCall();
    await rememberBookingWish(call.id, entities);
    await assignCall(call.id, 1 + 1, { id: ISHA, how: "front_desk" }, sat.toJSDate()); // Meera
    await flush();
    // Cal.com's webhook would link the booking to the call; simulate that link.
    await db.update(schema.calls).set({ bookingId: "uid-1", bookingStatus: "booked" }).where(eq(schema.calls.id, call.id));
    await assignCall(call.id, 3, { id: ISHA, how: "front_desk" }, sat.toJSDate()); // Rohan
    await flush();
    expect(cancelled).toEqual(["uid-1"]);
    expect(bookings.map((b) => b.designer)).toEqual(["Meera", "Rohan"]);
  });

  it("never touches a booking someone else made, and never books twice for the same designer", async () => {
    stubCal(["2026-10-12T11:00:00.000+05:30"]);
    const call = await aCall();
    await rememberBookingWish(call.id, entities);
    await db.update(schema.calls).set({ bookingId: "made-by-hand", bookingStatus: "booked" }).where(eq(schema.calls.id, call.id));
    await assignCall(call.id, 2, { id: ISHA, how: "front_desk" }, sat.toJSDate());
    await flush();
    expect(bookings).toHaveLength(0);
    expect(cancelled).toHaveLength(0);
  });

  it("books straight away if the call already has a designer when the details arrive (automatic mode)", async () => {
    await saveSettings({ assignmentMode: "auto" });
    stubCal(["2026-10-12T11:00:00.000+05:30"]);
    const call = await aCall();
    expect(call.assignedDesignerId).not.toBeNull();
    await rememberBookingWish(call.id, entities);
    expect((await bookAfterCall(call.id, sat.toJSDate())).state).toBe("booked");
    expect(bookings).toHaveLength(1);
  });

  it("saves nothing without a usable email or time; skips disqualified calls; reports Cal.com failures without throwing", async () => {
    stubCal(["2026-10-12T11:00:00.000+05:30"]);
    const call = await aCall();
    expect(await rememberBookingWish(call.id, { ...entities, customer_email: "not an email" })).toBe(false);
    expect(await rememberBookingWish(call.id, { ...entities, preferred_time_24h: null })).toBe(false);
    expect((await callById(call.id)).bookingWish).toBeNull();

    const bad = await aCall("T03");
    expect(bad.status).toBe("disqualified");
    await rememberBookingWish(bad.id, entities);
    await db.update(schema.calls).set({ assignedDesignerId: 2 }).where(eq(schema.calls.id, bad.id));
    expect((await bookAfterCall(bad.id, sat.toJSDate())).state).toBe("skipped");

    stubCal([]);
    await rememberBookingWish(call.id, entities);
    await db.update(schema.calls).set({ assignedDesignerId: 2 }).where(eq(schema.calls.id, call.id));
    expect((await bookAfterCall(call.id, sat.toJSDate())).state).toBe("failed");
    stubCal(["2026-10-12T11:00:00.000+05:30"], true);
    expect(await bookAfterCall(call.id, sat.toJSDate())).toMatchObject({ state: "failed" });
  });

  it("is off unless Cal.com is live", async () => {
    env.CALCOM_MODE = "mock";
    stubCal(["2026-10-12T11:00:00.000+05:30"]);
    const call = await aCall();
    await rememberBookingWish(call.id, entities);
    await db.update(schema.calls).set({ assignedDesignerId: 2 }).where(eq(schema.calls.id, call.id));
    expect((await bookAfterCall(call.id, sat.toJSDate())).state).toBe("skipped");
    expect(bookings).toHaveLength(0);
  });
});
