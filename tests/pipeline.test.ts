import { createHmac } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { applyCalEvent } from "@/lib/bookings";
import { ingestCall, processPending } from "@/lib/ingest";
import { setAssigner, defaultAssigner } from "@/lib/assignment";
import { verifyCalSignature } from "@/lib/bookings";
import { GOLD } from "./fixtures/gold-scores";
import { istIso, payloadFor, resetDb, sample } from "./helpers";

beforeEach(() => {
  resetDb();
  setAssigner(defaultAssigner);
});

const rows = () => db.select().from(schema.calls).all();

describe("call dedupe on external_id", () => {
  it("a repeat POST returns the stored call and does not create or reprocess anything", async () => {
    const p = payloadFor("T01");
    const first = await ingestCall(p);
    const second = await ingestCall({ ...p, transcript: "something different" });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("duplicate");
    expect(second.call.id).toBe(first.call.id);
    expect(second.call.transcript).toBe(sample("T01").transcript); // original kept
    expect(rows()).toHaveLength(1);
    expect(db.select({ n: count() }).from(schema.callsCost).get()!.n).toBe(1);
  });

  it("different external_ids are different calls", async () => {
    await ingestCall(payloadFor("T01"));
    await ingestCall(payloadFor("T01"));
    expect(rows()).toHaveLength(2);
  });

  it("stores the raw payload exactly as received", async () => {
    const p = { ...payloadFor("T02"), extra_vendor_field: { a: 1 } };
    const { call } = await ingestCall(p);
    expect(call.rawPayload).toEqual(p);
  });

  it("rejects an invalid payload without saving anything", async () => {
    await expect(ingestCall({ external_id: "x", started_at: "not a date", duration_sec: 1, transcript: "" })).rejects.toThrow();
    expect(rows()).toHaveLength(0);
  });

  it("accepts a null caller_phone (caller ID withheld)", async () => {
    const { call } = await ingestCall(payloadFor("T01", { caller_phone: null }));
    expect(call.callerPhone).toBeNull();
  });
});

describe("workflow", () => {
  it("is saved as yet_to_be_processed first and left that way if processing cannot run", async () => {
    const { call } = await ingestCall(payloadFor("T01"), { process: false });
    expect(call.status).toBe("yet_to_be_processed");
    expect(await processPending()).toBe(1);
    expect(db.select().from(schema.calls).get()!.status).toBe("qualified");
  });

  it("writes a cost row with telephony minutes", async () => {
    const { call } = await ingestCall(payloadFor("T02", { duration_sec: 300 }));
    const c = db.select().from(schema.callsCost).where(eq(schema.callsCost.callId, call.id)).get()!;
    expect(c.telephonyMinutes).toBe(5);
    expect(c.aiCostInr).toBeGreaterThan(0);
  });
});

describe("mock AI reproduces the calibrated status for all 20 phone transcripts", () => {
  for (const g of GOLD) {
    it(`${g.id} -> ${g.expected}`, async () => {
      const startedAt = istIso(`2026-09-${String(sample(g.id).day).padStart(2, "0")} ${sample(g.id).time}`);
      const { call } = await ingestCall(payloadFor(g.id, { started_at: startedAt }));
      expect(call.status).toBe(g.expected);
      if (call.status !== "qualified") expect(call.reason).toBeTruthy();
      if (g.tag === "existing_client") expect(call.flag).toBe("existing_client");
      if (g.tag === "upset_caller") expect(call.flag).toBe("upset_caller");
    });
  }
});

describe("no auto-reject", () => {
  it("a disqualified call is still stored, assigned to a designer, with its reason", async () => {
    const { call } = await ingestCall(payloadFor("T03"));
    expect(call.status).toBe("disqualified");
    expect(call.reason).toMatch(/Nashik/);
    expect(call.assignedDesignerId).not.toBeNull();
    expect(call.summary).toBeTruthy();
    expect(rows()).toHaveLength(1);
  });

  it("budget far below scope is needs_attention, never disqualified", async () => {
    expect((await ingestCall(payloadFor("T10"))).call.status).toBe("needs_attention");
  });

  it("an unreadable call is needs_attention, not disqualified", async () => {
    const { call } = await ingestCall(payloadFor("T08"));
    expect(call.status).toBe("needs_attention");
    expect(call.flag).toBe("no_transcript");
  });

  it("withheld caller ID and no booking stops a good call being qualified", async () => {
    const { call } = await ingestCall(payloadFor("T01", { caller_phone: null }));
    expect(call.status).toBe("needs_attention");
    expect(call.reason).toBe("No way to reach caller");
  });

  it("price enquiries stay qualified and nothing in the note contains a price", async () => {
    const { call } = await ingestCall(payloadFor("T13"));
    expect(call.status).toBe("qualified");
    expect(`${call.summary} ${call.suggestedNextStep} ${call.reason ?? ""}`).not.toMatch(/₹|lakh|per sq/i);
  });

  it("a caller's own stated budget appears only in the attributed form", async () => {
    const { call } = await ingestCall(payloadFor("T10"));
    expect(call.budget).toMatch(/1.5 lakh/);
    expect(call.summary).toMatch(/Caller stated/);
    expect(call.guardrailHits).toBeNull();
  });
});

describe("assignment", () => {
  it("round-robins across active designers and skips the studio head", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await ingestCall(payloadFor("T01"))).call.assignedDesignerId!);
    const names = ids.map((id) => db.select().from(schema.designers).where(eq(schema.designers.id, id)).get()!.name);
    expect(names).toEqual(["Aryan", "Meera", "Rohan", "Kavya", "Aryan"]);
  });

  it("existing-client complaints go to the studio head", async () => {
    const { call } = await ingestCall(payloadFor("T09"));
    expect(db.select().from(schema.designers).where(eq(schema.designers.id, call.assignedDesignerId!)).get()!.name).toBe("Nikhil");
  });

  it("is pluggable", async () => {
    setAssigner(() => 3);
    expect((await ingestCall(payloadFor("T01"))).call.assignedDesignerId).toBe(3);
  });
});

describe("SLA fields", () => {
  it("in-hours call: due one working hour later", async () => {
    const { call } = await ingestCall(payloadFor("T01", { started_at: istIso("2026-10-07 11:00") }));
    expect(call.afterHours).toBe(false);
    expect(call.dueAt!.toISOString()).toBe(istIso("2026-10-07 12:00"));
  });
  it("17:30 call is due 09:30 next working day", async () => {
    const { call } = await ingestCall(payloadFor("T01", { started_at: istIso("2026-10-07 17:30") }));
    expect(call.dueAt!.toISOString()).toBe(istIso("2026-10-08 09:30"));
  });
  it("Sunday call is after hours, due Monday 10:00 (one hour after the 09:00 digest)", async () => {
    const { call } = await ingestCall(payloadFor("T01", { started_at: istIso("2026-10-11 14:00") }));
    expect(call.afterHours).toBe(true);
    expect(call.dueAt!.toISOString()).toBe(istIso("2026-10-12 10:00"));
  });
});

describe("bookings", () => {
  it("a booked slot is stored, scores next-step 5, and never qualifies a weak call", async () => {
    const good = (await ingestCall(payloadFor("T01", { booked_slot: istIso("2026-10-09 15:00") }))).call;
    expect(good.bookedSlot).toBeTruthy();
    expect(good.scoreBreakdown!.next_step.points).toBe(5);
    const weak = (await ingestCall(payloadFor("T07", { booked_slot: istIso("2026-10-09 16:00") }))).call;
    expect(weak.status).toBe("needs_attention");
  });

  it("a booking lets a withheld-caller-ID call be qualified", async () => {
    const { call } = await ingestCall(payloadFor("T01", { caller_phone: null, booked_slot: istIso("2026-10-09 15:00") }));
    expect(call.status).toBe("qualified");
  });

  it("Cal.com webhook: reschedule and cancel update the call, and the host takes the call", async () => {
    const { call } = await ingestCall(payloadFor("T01", { booking_id: "bk1", booked_slot: istIso("2026-10-09 15:00") }));
    await applyCalEvent({
      triggerEvent: "BOOKING_RESCHEDULED",
      payload: { uid: "bk2", rescheduleUid: "bk1", startTime: istIso("2026-10-10 11:00"), organizer: { email: "meera@aangan.test" } },
    });
    let c = db.select().from(schema.calls).where(eq(schema.calls.id, call.id)).get()!;
    expect(c.bookingStatus).toBe("rescheduled");
    expect(c.bookedSlot!.toISOString()).toBe(istIso("2026-10-10 11:00"));
    expect(db.select().from(schema.designers).where(eq(schema.designers.id, c.assignedDesignerId!)).get()!.name).toBe("Meera");

    await applyCalEvent({ triggerEvent: "BOOKING_CANCELLED", payload: { uid: "bk2", startTime: istIso("2026-10-10 11:00") } });
    c = db.select().from(schema.calls).where(eq(schema.calls.id, call.id)).get()!;
    expect(c.bookingStatus).toBe("cancelled");
    expect(c.scoreBreakdown!.next_step.points).toBeLessThan(5);
  });

  it("a booking that arrives before its call is linked by phone when the call lands", async () => {
    await applyCalEvent({
      triggerEvent: "BOOKING_CREATED",
      payload: { uid: "early", startTime: istIso("2026-10-09 15:00"), attendees: [{ phoneNumber: "+91 98000 00000" }], organizer: { email: "aryan@aangan.test" } },
    });
    const { call } = await ingestCall(payloadFor("T01"));
    expect(call.bookingId).toBe("early");
    expect(call.bookingStatus).toBe("booked");
  });

  it("an acknowledged call is not reassigned by a later booking host", async () => {
    const { call } = await ingestCall(payloadFor("T01", { booking_id: "bk9", booked_slot: istIso("2026-10-09 15:00") }));
    db.update(schema.calls).set({ acknowledgedAt: new Date() }).where(eq(schema.calls.id, call.id)).run();
    const before = db.select().from(schema.calls).where(eq(schema.calls.id, call.id)).get()!.assignedDesignerId;
    await applyCalEvent({ triggerEvent: "BOOKING_RESCHEDULED", payload: { uid: "bk9", startTime: istIso("2026-10-11 11:00"), organizer: { email: "meera@aangan.test" } } });
    expect(db.select().from(schema.calls).where(eq(schema.calls.id, call.id)).get()!.assignedDesignerId).toBe(before);
  });
});

describe("Cal.com signature", () => {
  const body = JSON.stringify({ a: 1 });
  const sig = createHmac("sha256", "s3cret").update(body).digest("hex");
  it("accepts a correct HMAC", () => expect(verifyCalSignature(body, sig, "s3cret", false)).toBe(true));
  it("rejects a wrong or missing signature", () => {
    expect(verifyCalSignature(body, "0".repeat(64), "s3cret", false)).toBe(false);
    expect(verifyCalSignature(body, null, "s3cret", false)).toBe(false);
    expect(verifyCalSignature(body + " ", sig, "s3cret", false)).toBe(false);
  });
  it("with no secret, only passes while mocking", () => {
    expect(verifyCalSignature(body, null, "", true)).toBe(true);
    expect(verifyCalSignature(body, null, "", false)).toBe(false);
  });
});
