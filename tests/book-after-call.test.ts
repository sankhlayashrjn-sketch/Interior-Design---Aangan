import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { ingestCall } from "@/lib/ingest";
import { bookAfterCall, resolveDay, resolveTime, wantedStart, wishFromEntities } from "@/lib/voice/book-after-call";
import { payloadFor, resetDb } from "./helpers";

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

describe("booking after the call", () => {
  const entities = { customer_name: "Priya", customer_email: "priya@example.com", preferred_day: "Monday", preferred_time_24h: "11:00" };
  let booked: { start: string; attendee: Record<string, string> } | null;

  function stubCal(slots: string[], refuse = false) {
    booked = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/slots")) return new Response(JSON.stringify({ data: { "2026-10-12": slots.map((start) => ({ start })) } }), { status: 200 });
        if (u.includes("/bookings")) {
          if (refuse) return new Response(JSON.stringify({ error: { message: "slot taken" } }), { status: 400 });
          const b = JSON.parse(String(init?.body));
          booked = { start: b.start, attendee: b.attendee };
          return new Response(JSON.stringify({ data: { uid: "uid-1" } }), { status: 201 });
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

  it("books the free slot nearest to the requested time, with name, email and caller ID", async () => {
    stubCal(["2026-10-12T10:00:00.000+05:30", "2026-10-12T11:30:00.000+05:30", "2026-10-12T12:00:00.000+05:30"]);
    const call = await aCall();
    const r = await bookAfterCall(call.id, entities, sat.toJSDate());
    expect(r).toMatchObject({ state: "booked", uid: "uid-1" });
    expect(booked!.start).toBe("2026-10-12T06:00:00.000Z"); // 11:30 IST: the first free slot at or after 11:00
    expect(booked!.attendee).toMatchObject({ name: "Priya", email: "priya@example.com", phoneNumber: "+919822000111" });
  });

  it("does nothing without a usable email or time, for a disqualified call, or when a booking exists", async () => {
    stubCal(["2026-10-12T11:00:00.000+05:30"]);
    const call = await aCall();
    expect((await bookAfterCall(call.id, { ...entities, customer_email: "not an email" }, sat.toJSDate())).state).toBe("skipped");
    expect((await bookAfterCall(call.id, { ...entities, preferred_time_24h: null }, sat.toJSDate())).state).toBe("skipped");
    const bad = await aCall("T03");
    expect(bad.status).toBe("disqualified");
    expect((await bookAfterCall(bad.id, entities, sat.toJSDate())).state).toBe("skipped");
    await db.update(schema.calls).set({ bookingId: "x", bookingStatus: "booked" });
    expect((await bookAfterCall(call.id, entities, sat.toJSDate())).state).toBe("skipped");
    expect(booked).toBeNull();
  });

  it("reports failure, and never throws, when Cal.com has no slot or refuses", async () => {
    const call = await aCall();
    stubCal([]);
    expect((await bookAfterCall(call.id, entities, sat.toJSDate())).state).toBe("failed");
    stubCal(["2026-10-12T11:00:00.000+05:30"], true);
    expect(await bookAfterCall(call.id, entities, sat.toJSDate())).toMatchObject({ state: "failed" });
  });

  it("is off unless Cal.com is live", async () => {
    env.CALCOM_MODE = "mock";
    stubCal(["2026-10-12T11:00:00.000+05:30"]);
    const call = await aCall();
    expect((await bookAfterCall(call.id, entities, sat.toJSDate())).state).toBe("skipped");
    expect(booked).toBeNull();
  });
});
