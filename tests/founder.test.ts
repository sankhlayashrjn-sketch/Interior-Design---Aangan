import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema, one } from "@/db";
import { acknowledgeCall } from "@/lib/calls";
import { addDesigner, telegramLinkFor, updateDesigner } from "@/lib/designers";
import { costPanel, founderList, founderMetrics, parseRange, rangeStart, statusCounts } from "@/lib/founder";
import { ingestCall } from "@/lib/ingest";
import { istIso, payloadFor, resetDb } from "./helpers";

const at = (s: string) => new Date(istIso(s));
const NOW = at("2026-10-09 12:00"); // Friday noon
const call = async (id: string, when: string, over: Record<string, unknown> = {}) => (await ingestCall(payloadFor(id, { started_at: istIso(when), ...over }))).call;
const setCost = async (callId: number, ai: number, minutes: number, tel: number, model = "claude-test") => {
  await db.update(schema.callsCost).set({ aiCostInr: ai, telephonyMinutes: minutes, telephonyCostInr: tel, model }).where(eq(schema.callsCost.callId, callId));
};

beforeEach(resetDb);

/**
 * The scenario (Wed 7 / Thu 8 / Fri 9 Oct 2026, "now" is Fri 12:00):
 *  A Wed 11:00  in hours, due 12:00, acknowledged 11:30            -> on time, 30 working min
 *  B Thu 17:30  in hours, due Fri 09:30, acknowledged Fri 09:45    -> late, 30 + 45 = 75 working min
 *  C Thu 21:00  after hours, due Fri 10:00, acknowledged Fri 09:10 -> on time, 10 working min, has a booked slot
 *  D Fri 10:00  in hours, due 11:00, still waiting                 -> past due, a miss
 *  E Fri 11:30  in hours, due 12:30, still waiting                 -> not due yet: not judged
 */
async function scenario() {
  const A = await call("T01", "2026-10-07 11:00");
  const B = await call("T02", "2026-10-08 17:30");
  const C = await call("T06", "2026-10-08 21:00", { booking_id: "bk", booked_slot: istIso("2026-10-12 11:00") });
  const D = await call("T03", "2026-10-09 10:00");
  const E = await call("T07", "2026-10-09 11:30");
  await acknowledgeCall(A.id, A.assignedDesignerId!, at("2026-10-07 11:30"));
  await acknowledgeCall(B.id, B.assignedDesignerId!, at("2026-10-09 09:45"));
  await acknowledgeCall(C.id, C.assignedDesignerId!, at("2026-10-09 09:10"));
  return { A, B, C, D, E };
}

describe("founder metrics", () => {
  it("calls today counts only today's calls", async () => {
    await scenario();
    expect((await founderMetrics("30d", NOW)).callsToday).toBe(2);
  });

  it("% acknowledged within SLA: judged only once it can be judged", async () => {
    await scenario();
    const m = await founderMetrics("7d", NOW);
    expect(m.sla).toEqual({ pct: 50, met: 2, total: 4 }); // A and C on time; B late; D missed; E not yet due
  });

  it("uses working time for the deadline: the 17:30 call acknowledged at 09:45 is late, the overnight call at 09:10 is on time", async () => {
    const { B, C } = await scenario();
    const row = async (id: number) => (await one(db.select().from(schema.calls).where(eq(schema.calls.id, id))))!;
    expect((await row(B.id)).dueAt!.toISOString()).toBe(istIso("2026-10-09 09:30"));
    expect((await row(C.id)).dueAt!.toISOString()).toBe(istIso("2026-10-09 10:00"));
  });

  it("average time to acknowledge is in WORKING minutes (nights do not count)", async () => {
    await scenario();
    const m = await founderMetrics("7d", NOW);
    expect(m.ackCount).toBe(3);
    expect(m.avgAckMinutes).toBeCloseTo((30 + 75 + 10) / 3, 5);
  });

  it("after-hours calls caught, and how many were acknowledged", async () => {
    await scenario();
    expect((await founderMetrics("7d", NOW)).afterHours).toEqual({ count: 1, acknowledged: 1 });
  });

  it("calls with a booked slot", async () => {
    await scenario();
    expect((await founderMetrics("7d", NOW)).booked).toBe(1);
  });

  it("the range changes what is counted", async () => {
    await scenario();
    const today = await founderMetrics("today", NOW);
    expect(today.callsInRange).toBe(2);
    expect(today.sla).toEqual({ pct: 0, met: 0, total: 1 }); // only D is judged, and it missed
    expect((await founderMetrics("7d", NOW)).callsInRange).toBe(5);
  });

  it("with no data nothing divides by zero", async () => {
    const m = await founderMetrics("30d", NOW);
    expect(m).toMatchObject({ callsToday: 0, callsInRange: 0, sla: { pct: null, total: 0 }, avgAckMinutes: null, booked: 0, afterHours: { count: 0, acknowledged: 0 } });
    expect((await costPanel("30d", NOW)).perCall).toBeNull();
    expect((await costPanel("30d", NOW)).month.perQualified).toBeNull();
  });

  it("unprocessed calls are not judged against the SLA", async () => {
    await ingestCall(payloadFor("T01", { started_at: istIso("2026-10-09 09:00") }), { process: false });
    expect((await founderMetrics("today", NOW)).sla.total).toBe(0);
    expect((await founderMetrics("today", NOW)).callsToday).toBe(1);
  });

  it("range helpers", async () => {
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("junk")).toBe("30d");
    expect(rangeStart("today", NOW).toISOString()).toBe(istIso("2026-10-09 00:00"));
    expect(rangeStart("7d", NOW).toISOString()).toBe(istIso("2026-10-03 00:00"));
  });
});

describe("cost panel", () => {
  it("per-call averages, monthly total, and cost per qualified lead", async () => {
    const { A, B, D } = await scenario(); // A and B qualified, D disqualified; C qualified too
    await setCost(A.id, 1, 2, 3);
    await setCost(B.id, 2, 4, 6);
    await setCost(D.id, 3, 6, 9);
    const rows = (await db.select().from(schema.calls));
    for (const r of rows.filter((x) => ![A.id, B.id, D.id].includes(x.id))) setCost(r.id, 0, 0, 0);

    const p = await costPanel("7d", NOW);
    expect(p.perCall!.calls).toBe(5);
    expect(p.perCall!.ai).toBeCloseTo((1 + 2 + 3) / 5);
    expect(p.perCall!.telephonyMinutes).toBeCloseTo((2 + 4 + 6) / 5);
    expect(p.perCall!.telephony).toBeCloseTo((3 + 6 + 9) / 5);
    expect(p.perCall!.total).toBeCloseTo((4 + 8 + 12) / 5);

    expect(p.month.label).toBe("October 2026");
    expect(p.month.total).toBeCloseTo(24);
    expect(p.month.ai).toBeCloseTo(6);
    expect(p.month.telephony).toBeCloseTo(18);
    const qualified = (await db.select().from(schema.calls)).filter((c) => c.status === "qualified").length;
    expect(p.month.qualified).toBe(qualified);
    expect(p.month.perQualified).toBeCloseTo(24 / qualified);
    expect(p.estimated).toBe(false);
  });

  it("the month is the calendar month: last month's calls are excluded from the total", async () => {
    const old = await call("T01", "2026-09-25 11:00");
    const cur = await call("T02", "2026-10-02 11:00");
    await setCost(old.id, 10, 1, 10);
    await setCost(cur.id, 1, 1, 1);
    expect((await costPanel("30d", NOW)).month.total).toBeCloseTo(2);
    expect((await costPanel("30d", NOW)).perCall!.calls).toBe(2); // the 30-day window spans both
  });

  it("flags figures that come from the mock AI's estimates", async () => {
    await call("T01", "2026-10-07 11:00"); // mock AI in tests
    expect((await costPanel("30d", NOW)).estimated).toBe(true);
  });
});

describe("founder lists", () => {
  it("shows every call of a status across all designers, with the disqualification reason", async () => {
    await call("T03", "2026-10-08 11:00");
    await call("T04", "2026-10-08 12:00");
    await call("T01", "2026-10-08 13:00");
    const disq = await founderList("disqualified");
    expect(disq).toHaveLength(2);
    for (const c of disq) {
      expect(c.reason).toBeTruthy();
      expect(c.designerName).toBeTruthy();
    }
    expect(await founderList("qualified")).toHaveLength(1);
  });

  it("counts by tab, with unprocessed calls in their own bucket", async () => {
    await call("T01", "2026-10-08 11:00");
    await call("T03", "2026-10-08 12:00");
    await ingestCall(payloadFor("T02"), { process: false });
    expect(await statusCounts()).toEqual({ qualified: 1, disqualified: 1, needs_attention: 0, yet_to_be_processed: 1 });
    expect(await founderList("yet_to_be_processed")).toHaveLength(1);
  });
});

describe("designers (Settings)", () => {
  const base = { name: "Aryan", telegramChatId: null, hubspotOwnerId: null, calcomUser: null, active: true, isEscalation: false };
  const get = async (id: number) => (await one(db.select().from(schema.designers).where(eq(schema.designers.id, id))))!;

  it("saves name, Telegram chat ID, HubSpot owner ID and Cal.com user, normalised", async () => {
    await updateDesigner(1, { ...base, name: "  Aryan K ", telegramChatId: " 123456789 ", hubspotOwnerId: "98765", calcomUser: " Aryan@Aangan.Test " });
    expect(await get(1)).toMatchObject({ name: "Aryan K", telegramChatId: "123456789", hubspotOwnerId: "98765", calcomUser: "aryan@aangan.test" });
  });

  it("blank optional fields become null", async () => {
    await updateDesigner(1, { ...base, telegramChatId: "  ", hubspotOwnerId: "", calcomUser: "" });
    expect(await get(1)).toMatchObject({ telegramChatId: null, hubspotOwnerId: null, calcomUser: null });
  });

  it("rejects bad values with a plain message", async () => {
    await expect(updateDesigner(1, { ...base, name: " " })).rejects.toThrow(/name/);
    await expect(updateDesigner(1, { ...base, telegramChatId: "abc" })).rejects.toThrow(/number/);
    await expect(updateDesigner(1, { ...base, hubspotOwnerId: "owner-1" })).rejects.toThrow(/number/);
    await expect(updateDesigner(1, { ...base, calcomUser: "has space" })).rejects.toThrow(/Cal.com/);
  });

  it("one Telegram chat cannot belong to two designers", async () => {
    await updateDesigner(1, { ...base, telegramChatId: "111222333" });
    await expect(updateDesigner(2, { ...base, name: "Meera", telegramChatId: "111222333" })).rejects.toThrow(/already linked to Aryan/);
  });

  it("the rotation can never be emptied", async () => {
    for (const id of [2, 3, 4]) await updateDesigner(id, { ...base, name: `D${id}`, active: false });
    await expect(updateDesigner(1, { ...base, active: false })).rejects.toThrow(/At least one active designer/);
    await expect(updateDesigner(1, { ...base, isEscalation: true })).rejects.toThrow(/At least one active designer/);
  });

  it("an inactive designer is skipped by round-robin", async () => {
    await updateDesigner(2, { ...base, name: "Meera", active: false });
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await ingestCall(payloadFor("T01"))).call.assignedDesignerId!);
    expect(ids).not.toContain(2);
  });

  it("adds a designer to the end of the rotation", async () => {
    const id = await addDesigner({ ...base, name: "Isha Rao", hubspotOwnerId: "555" });
    expect(await get(id)).toMatchObject({ name: "Isha Rao", hubspotOwnerId: "555", active: true });
    expect((await get(id)).rrOrder).toBeGreaterThan((await get(4)).rrOrder);
  });

  it("makes a one-time Telegram link", async () => {
    const link = await telegramLinkFor(1);
    expect(link.url).toContain(`start=${link.code}`);
    expect((await one(db.select().from(schema.telegramLinkCodes).where(eq(schema.telegramLinkCodes.designerId, 1))))!.code).toBe(link.code);
    await expect(telegramLinkFor(999)).rejects.toThrow(/not found/);
  });
});
