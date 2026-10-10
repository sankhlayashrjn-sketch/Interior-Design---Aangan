import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as vaaniWebhook } from "@/app/api/vaani/webhook/route";
import { db, schema } from "@/db";
import { applyCalEvent } from "@/lib/bookings";
import { assignCall } from "@/lib/calls";
import { env } from "@/lib/env";
import { ingestCall, processPending } from "@/lib/ingest";
import { runDueJobs, scheduleForCall } from "@/lib/reminders";
import { saveSettings } from "@/lib/settings";
import { bookAfterCall, rememberBookingWish } from "@/lib/voice/book-after-call";
import { callById, istIso, payloadFor, resetDb, sample } from "./helpers";

const entities = { customer_name: "Priya", customer_email: "priya@example.com", preferred_day: "Monday", preferred_time_24h: "11:00" };

function stubCal(opts: { slots?: string[]; cancelOk?: boolean } = {}) {
  const slots = opts.slots ?? ["2026-10-12T11:00:00.000+05:30"];
  const log = { booked: [] as string[], cancelled: [] as string[] };
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/slots")) return new Response(JSON.stringify({ data: { "2026-10-12": slots.map((start) => ({ start })) } }), { status: 200 });
      const c = /\/bookings\/([^/]+)\/cancel/.exec(u);
      if (c) {
        log.cancelled.push(c[1]);
        return new Response("{}", { status: opts.cancelOk === false ? 400 : 200 });
      }
      if (u.endsWith("/bookings")) {
        await new Promise((r) => setTimeout(r, 30)); // a slow Cal.com, so concurrent attempts really overlap
        const uid = `uid-${++n}`;
        log.booked.push(uid);
        return new Response(JSON.stringify({ data: { uid } }), { status: 201 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return log;
}

beforeEach(async () => {
  await resetDb();
  await saveSettings({ assignmentMode: "manual" });
  env.CALCOM_MODE = "live";
  env.CALCOM_API_KEY = "k";
  env.CALCOM_EVENT_TYPE_ID = "42";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  env.CALCOM_MODE = "mock";
  env.CALCOM_API_KEY = "";
  env.CALCOM_EVENT_TYPE_ID = "";
  env.VAANI_WEBHOOK_SECRET = "";
});

describe("booking: one at a time", () => {
  it("two assignments at once create ONE booking, not two", async () => {
    const log = stubCal();
    const { call } = await ingestCall(payloadFor("T01", { started_at: new Date().toISOString(), caller_phone: "+919822000111" }));
    await rememberBookingWish(call.id, entities);
    await db.update(schema.calls).set({ assignedDesignerId: 2 }).where(eq(schema.calls.id, call.id));
    const [a, b] = await Promise.all([bookAfterCall(call.id), bookAfterCall(call.id)]);
    expect(log.booked).toHaveLength(1);
    expect([a.state, b.state].sort()).toEqual(["booked", "skipped"]);
  });

  it("if replacing a booking fails after the cancel, the next attempt starts clean and does not cancel again", async () => {
    const log = stubCal();
    const { call } = await ingestCall(payloadFor("T01", { started_at: new Date().toISOString(), caller_phone: "+919822000111" }));
    await rememberBookingWish(call.id, entities);
    await db.update(schema.calls).set({ assignedDesignerId: 2 }).where(eq(schema.calls.id, call.id));
    await bookAfterCall(call.id); // booked for Meera, linked to the call
    expect((await callById(call.id)).bookingId).toBe("uid-1");

    // Move to Rohan, but Cal.com has no free slot this time: the old booking is cancelled, the new one fails.
    stubCal({ slots: [] });
    await db.update(schema.calls).set({ assignedDesignerId: 3 }).where(eq(schema.calls.id, call.id));
    expect((await bookAfterCall(call.id)).state).toBe("failed");
    expect((await callById(call.id)).bookingStatus).toBe("cancelled");

    // Slots are back: it books for Rohan, and does not try to cancel the already-cancelled booking.
    const again = stubCal();
    expect((await bookAfterCall(call.id)).state).toBe("booked");
    expect(again.cancelled).toHaveLength(0);
    void log;
  });
});

describe("Vaani webhook retries", () => {
  const evt = (withEntities: boolean) =>
    JSON.stringify({
      event: "call_postprocessing",
      call_id: "inbound-retry-1",
      timestamp: "2026-10-09T05:40:00",
      data: { call_id: "inbound-retry-1", call_duration: 120000, transcript: sample("T01").transcript.split("\n").join("\n\n").replace(/Caller:/g, "USER:").replace(/Agent:/g, "AGENT:"), entities: withEntities ? entities : {} },
    });
  const post = (body: string) => vaaniWebhook(new Request("http://x/api/vaani/webhook?key=k", { method: "POST", body }));

  it("a retry still saves the email and time even though the call already exists", async () => {
    env.VAANI_WEBHOOK_SECRET = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 }))); // Vaani history unavailable
    await post(evt(false)); // first delivery: the call is saved, the details did not make it
    expect((await db.select().from(schema.calls))[0].bookingWish).toBeNull();
    const retry = await post(evt(true));
    expect((await retry.json()).created).toBe(0); // a duplicate call, but...
    expect((await db.select().from(schema.calls))[0].bookingWish).toMatchObject({ email: "priya@example.com" });
  });

  it("a timestamp with no zone is read as UTC, and an unreadable one does not crash", async () => {
    env.VAANI_WEBHOOK_SECRET = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const ok = await post(evt(false));
    expect(ok.status).toBe(200);
    const c = (await db.select().from(schema.calls))[0];
    expect(c.startedAt.toISOString()).toBe("2026-10-09T05:38:00.000Z"); // 05:40 UTC minus 120 s
    const bad = await post(evt(false).replace("2026-10-09T05:40:00", "not a time").replace("inbound-retry-1", "inbound-retry-2").replace("inbound-retry-1", "inbound-retry-2"));
    expect(bad.status).toBe(200);
  });
});

describe("reminders", () => {
  it("the urgent slot alert is sent once for a slot, not again after a later change", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = (s: string) => new Date(istIso(s));
    vi.setSystemTime(at("2026-10-07 10:00"));
    await db.update(schema.designers).set({ telegramChatId: "11111" }).where(eq(schema.designers.id, 1));
    const { call } = await ingestCall(payloadFor("T01", { started_at: istIso("2026-10-07 10:00"), booked_slot: istIso("2026-10-07 15:00") }));
    await assignCall(call.id, 1, { id: null, how: "front_desk" }, at("2026-10-07 10:05"));
    const slotJobs = async (state: string) => (await db.select().from(schema.reminderJobs)).filter((j) => j.kind === "slot" && j.state === state);
    expect(await slotJobs("pending")).toHaveLength(1);

    vi.setSystemTime(at("2026-10-07 14:35"));
    await runDueJobs(at("2026-10-07 14:35")); // 25 minutes before the slot: the alert goes out
    expect(await slotJobs("sent")).toHaveLength(1);

    await scheduleForCall(call.id, at("2026-10-07 14:40")); // any later change (an override, a settings save...)
    expect(await slotJobs("pending")).toHaveLength(0); // no second alert for the same slot
  });
});

describe("the AI is not retried forever", () => {
  it("after repeated failures a call is parked for a human instead of retried every minute", async () => {
    const { call } = await ingestCall(payloadFor("T01"), { process: false });
    expect(call.status).toBe("yet_to_be_processed");
    for (let i = 0; i < 5; i++) await db.insert(schema.auditLog).values({ at: new Date(), kind: "process.error", callId: call.id, detail: { error: "boom" } });
    expect(await processPending()).toBe(1);
    const after = await callById(call.id);
    expect(after.status).toBe("needs_attention");
    expect(after.flag).toBe("ai_failed");
  });
});

void applyCalEvent;
