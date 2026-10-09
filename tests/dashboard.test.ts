import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { acknowledgeCall, countsForDesigner, listForDesigner, overrideStatus, UserError } from "@/lib/calls";
import { fmtDue, fmtWhen } from "@/lib/format";
import { on } from "@/lib/hooks";
import { ingestCall } from "@/lib/ingest";
import { istIso, payloadFor, resetDb } from "./helpers";

beforeEach(resetDb);

const ist = (s: string) => new Date(istIso(s));
const callRow = (id: number) => db.select().from(schema.calls).where(eq(schema.calls.id, id)).get()!;

describe("acknowledge", () => {
  it("records who and when, and the first acknowledgement wins", async () => {
    const { call } = await ingestCall(payloadFor("T01"));
    const first = await acknowledgeCall(call.id, 1, ist("2026-10-07 11:20"));
    const second = await acknowledgeCall(call.id, 2, ist("2026-10-07 12:00"));
    expect(first.acknowledgedBy).toBe(1);
    expect(second.acknowledgedBy).toBe(1);
    expect(second.acknowledgedAt!.toISOString()).toBe(istIso("2026-10-07 11:20"));
  });

  it("emits call.acknowledged once (reminders and HubSpot listen to it)", async () => {
    const seen: number[] = [];
    on("call.acknowledged", ({ callId }) => void seen.push(callId));
    const { call } = await ingestCall(payloadFor("T01"));
    await acknowledgeCall(call.id, 1);
    await acknowledgeCall(call.id, 1);
    expect(seen).toEqual([call.id]);
  });

  it("cannot acknowledge a call that has not been processed", async () => {
    const { call } = await ingestCall(payloadFor("T01"), { process: false });
    await expect(acknowledgeCall(call.id, 1)).rejects.toBeInstanceOf(UserError);
  });
});

describe("status override", () => {
  it("requires a reason: empty, blank or too-short reasons are rejected and nothing changes", async () => {
    const { call } = await ingestCall(payloadFor("T03"));
    for (const bad of ["", "   ", "ok"]) {
      await expect(overrideStatus(call.id, 1, "qualified", bad)).rejects.toThrow(/reason/i);
    }
    expect(callRow(call.id).status).toBe("disqualified");
    expect(db.select().from(schema.statusOverrides).all()).toHaveLength(0);
  });

  it("changes the status and logs who, when, from, to and why", async () => {
    const { call } = await ingestCall(payloadFor("T03"));
    await overrideStatus(call.id, 2, "qualified", "Caller also owns a flat in Pune", ist("2026-10-07 12:00"));
    expect(callRow(call.id).status).toBe("qualified");
    const log = db.select().from(schema.statusOverrides).all();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ callId: call.id, fromStatus: "disqualified", toStatus: "qualified", reason: "Caller also owns a flat in Pune", byDesignerId: 2 });
  });

  it("every override is logged, and the log is kept when the status changes again", async () => {
    const { call } = await ingestCall(payloadFor("T03"));
    await overrideStatus(call.id, 1, "qualified", "Has a Pune property too");
    await overrideStatus(call.id, 1, "needs_attention", "Checking with the caller first");
    expect(db.select().from(schema.statusOverrides).all()).toHaveLength(2);
  });

  it("rejects a no-op, an invalid status, and 'yet_to_be_processed'", async () => {
    const { call } = await ingestCall(payloadFor("T03"));
    await expect(overrideStatus(call.id, 1, "disqualified", "same status again")).rejects.toThrow(/already/);
    await expect(overrideStatus(call.id, 1, "banana", "some good reason")).rejects.toBeInstanceOf(UserError);
    await expect(overrideStatus(call.id, 1, "yet_to_be_processed", "some good reason")).rejects.toBeInstanceOf(UserError);
  });

  it("a later booking update does not undo a designer's override", async () => {
    const { rescoreCall } = await import("@/lib/ingest");
    const { call } = await ingestCall(payloadFor("T03"));
    await overrideStatus(call.id, 1, "qualified", "Confirmed they have a Pune site");
    rescoreCall(call.id);
    expect(callRow(call.id).status).toBe("qualified");
  });
});

describe("dashboard lists", () => {
  it("a disqualified call is still shown in the designer's pending list, below the others", async () => {
    // Rotation: T01 -> Aryan(1), T03 -> Meera(2), so send them to the same designer explicitly.
    const a = (await ingestCall(payloadFor("T03"))).call;
    const b = (await ingestCall(payloadFor("T01"))).call;
    db.update(schema.calls).set({ assignedDesignerId: 1 }).run();
    const list = listForDesigner(1, "pending");
    expect(list.map((c) => c.id)).toContain(a.id);
    expect(list.find((c) => c.id === a.id)!.status).toBe("disqualified");
    expect(list.map((c) => c.id).indexOf(b.id)).toBeLessThan(list.map((c) => c.id).indexOf(a.id));
  });

  it("overdue calls come first, and complaints outrank a normal qualified call", async () => {
    const t = ist("2026-10-07 11:00");
    const good = (await ingestCall(payloadFor("T01", { started_at: t.toISOString() }))).call;
    const angry = (await ingestCall(payloadFor("T16", { started_at: t.toISOString() }))).call;
    db.update(schema.calls).set({ assignedDesignerId: 1 }).run();
    const order = listForDesigner(1, "pending", ist("2026-10-07 11:30")).map((c) => c.id);
    expect(order.indexOf(angry.id)).toBeLessThan(order.indexOf(good.id));
  });

  it("tabs split by acknowledgement, and 'all' has both", async () => {
    const a = (await ingestCall(payloadFor("T01"))).call;
    const b = (await ingestCall(payloadFor("T02"))).call;
    db.update(schema.calls).set({ assignedDesignerId: 1 }).run();
    await acknowledgeCall(a.id, 1);
    expect(listForDesigner(1, "pending").map((c) => c.id)).toEqual([b.id]);
    expect(listForDesigner(1, "acknowledged").map((c) => c.id)).toEqual([a.id]);
    expect(listForDesigner(1, "all")).toHaveLength(2);
    expect(countsForDesigner(1)).toEqual({ pending: 1, acknowledged: 1, all: 2 });
  });

  it("only shows the selected designer's calls", async () => {
    await ingestCall(payloadFor("T01")); // Aryan (1)
    await ingestCall(payloadFor("T02")); // Meera (2)
    expect(listForDesigner(1, "all")).toHaveLength(1);
    expect(listForDesigner(2, "all")).toHaveLength(1);
  });
});

describe("due-in / overdue indicator", () => {
  const now = ist("2026-10-07 12:00");
  it("counts down inside the window", () => {
    expect(fmtDue(ist("2026-10-07 12:25"), null, now)).toEqual({ text: "Due in 25 min", state: "ok" });
  });
  it("flips to overdue (the accent state) once past due", () => {
    expect(fmtDue(ist("2026-10-07 11:30"), null, now)).toEqual({ text: "Overdue 30 min", state: "overdue" });
    expect(fmtDue(ist("2026-10-07 09:00"), null, now).text).toBe("Overdue 3h");
  });
  it("shows a clock time when it is more than a day away", () => {
    expect(fmtDue(ist("2026-10-12 10:00"), null, now)).toEqual({ text: "Due Mon 10:00", state: "ok" });
  });
  it("is never overdue once acknowledged", () => {
    const r = fmtDue(ist("2026-10-07 09:00"), ist("2026-10-07 11:50"), now);
    expect(r.state).toBe("done");
    expect(r.text).toBe("Acknowledged Today 11:50");
  });
  it("formats times in IST regardless of server timezone", () => {
    expect(fmtWhen(new Date("2026-10-07T05:30:00Z"), now)).toBe("Today 11:00");
  });
});
