import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, one, schema } from "@/db";
import { defaultAssigner, setAssigner } from "@/lib/assignment";
import { acknowledgeCall, addNote, getDetail, listForDesigner, MAX_NOTE, overrideStatus, todayForDesigner, UserError } from "@/lib/calls";
import { designerWorkload, founderTrend, funnel } from "@/lib/founder";
import { ingestCall } from "@/lib/ingest";
import { runDueJobs } from "@/lib/reminders";
import { istIso, payloadFor, resetDb } from "./helpers";

const at = (s: string) => new Date(istIso(s));
const NOW = at("2026-10-09 12:00"); // Friday noon

beforeEach(async () => {
  await resetDb();
  setAssigner(() => 1); // everything to Aryan, so each test reads one list
});
afterEach(() => setAssigner(defaultAssigner));

let phone = 9000000000;
const call = async (id: string, when: string, over: Record<string, unknown> = {}) =>
  (await ingestCall(payloadFor(id, { started_at: istIso(when), caller_phone: `+91${++phone}`, ...over }))).call;
const ids = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);

/**
 * Four calls, all for Aryan, "now" is Fri 12:00 IST:
 *  P  T01  Wed 11:00  qualified, booked Fri 15:00, waiting, past due       (Priya, Kothrud)
 *  N  T03  Thu 21:00  disqualified (Nashik), after hours, waiting, past due
 *  W  T07  Fri 10:00  needs attention, waiting, past due (due 11:00)
 *  H  T13  Fri 11:30  qualified, waiting, NOT yet due (due 12:30)           (Aundh)
 */
async function four() {
  const P = await call("T01", "2026-10-07 11:00", { booked_slot: istIso("2026-10-09 15:00") });
  const N = await call("T03", "2026-10-08 21:00");
  const W = await call("T07", "2026-10-09 10:00");
  const H = await call("T13", "2026-10-09 11:30");
  return { P, N, W, H };
}

describe("search", () => {
  it("finds by name, area and scope, ignoring case", async () => {
    const { P, H } = await four();
    expect(ids(await listForDesigner(1, "all", NOW, { q: "priya" }))).toEqual([P.id]);
    expect(ids(await listForDesigner(1, "all", NOW, { q: "AUNDH" }))).toEqual([H.id]);
    expect(ids(await listForDesigner(1, "all", NOW, { q: "wardrobe" })).length).toBeGreaterThan(0);
  });

  it("finds by part of a phone number", async () => {
    const { P } = await four();
    const digits = P.callerPhone!.slice(-6);
    expect(ids(await listForDesigner(1, "all", NOW, { q: digits }))).toContain(P.id);
  });

  it("treats % and _ as ordinary characters, not wildcards", async () => {
    await four();
    expect(await listForDesigner(1, "all", NOW, { q: "%" })).toHaveLength(0);
    expect(await listForDesigner(1, "all", NOW, { q: "_" })).toHaveLength(0);
    expect(await listForDesigner(1, "all", NOW, { q: "\\" })).toHaveLength(0);
  });

  it("also searches a designer's own notes", async () => {
    const { P, H } = await four();
    await addNote(P.id, 1, "Prefers an evening site visit");
    expect(ids(await listForDesigner(1, "all", NOW, { q: "evening site" }))).toEqual([P.id]);
    expect(ids(await listForDesigner(1, "all", NOW, { q: "EVENING" }))).toEqual([P.id]);
    expect(ids(await listForDesigner(1, "all", NOW, { q: "aundh" }))).toEqual([H.id]); // other fields still work
  });

  it("a blank search changes nothing, and nothing found gives an empty list", async () => {
    await four();
    expect(await listForDesigner(1, "all", NOW, { q: "   " })).toHaveLength(4);
    expect(await listForDesigner(1, "all", NOW, { q: "zzzzzz" })).toHaveLength(0);
  });
});

describe("filters and sorting", () => {
  it("by status", async () => {
    const { P, H, N, W } = await four();
    expect(ids(await listForDesigner(1, "all", NOW, { status: "qualified" }))).toEqual([P.id, H.id].sort((a, b) => a - b));
    expect(ids(await listForDesigner(1, "all", NOW, { status: "disqualified" }))).toEqual([N.id]);
    expect(ids(await listForDesigner(1, "all", NOW, { status: "needs_attention" }))).toEqual([W.id]);
  });

  it("booked, after hours and overdue", async () => {
    const { P, N, W, H } = await four();
    expect(ids(await listForDesigner(1, "all", NOW, { booked: true }))).toEqual([P.id]);
    expect(ids(await listForDesigner(1, "all", NOW, { afterHours: true }))).toEqual([N.id]);
    expect(ids(await listForDesigner(1, "all", NOW, { overdue: true }))).toEqual([P.id, N.id, W.id].sort((a, b) => a - b));
    expect(ids(await listForDesigner(1, "all", NOW, { overdue: true }))).not.toContain(H.id); // not due until 12:30
  });

  it("filters combine", async () => {
    const { W } = await four();
    expect(ids(await listForDesigner(1, "all", NOW, { status: "needs_attention", overdue: true }))).toEqual([W.id]);
    expect(await listForDesigner(1, "all", NOW, { status: "qualified", afterHours: true })).toHaveLength(0);
  });

  it("an acknowledged call is never overdue, and a cancelled booking is not 'booked'", async () => {
    const { P } = await four();
    await acknowledgeCall(P.id, 1, at("2026-10-09 11:00"));
    expect(ids(await listForDesigner(1, "all", NOW, { overdue: true }))).not.toContain(P.id);
    await db.update(schema.calls).set({ bookingStatus: "cancelled" }).where(eq(schema.calls.id, P.id));
    expect(await listForDesigner(1, "all", NOW, { booked: true })).toHaveLength(0);
  });

  it("sorts by newest, by deadline, and by score", async () => {
    const { P, N, W, H } = await four();
    expect((await listForDesigner(1, "all", NOW, { sort: "newest" })).map((c) => c.id)).toEqual([H.id, W.id, N.id, P.id]);
    expect((await listForDesigner(1, "all", NOW, { sort: "due" })).map((c) => c.id)).toEqual([P.id, N.id, W.id, H.id]);
    const byScore = (await listForDesigner(1, "all", NOW, { sort: "score" })).map((c) => c.score ?? -1);
    expect(byScore).toEqual([...byScore].sort((a, b) => b - a));
  });

  it("filters apply inside a tab too", async () => {
    const { P } = await four();
    await acknowledgeCall(P.id, 1, at("2026-10-09 11:00"));
    expect(await listForDesigner(1, "pending", NOW, { status: "qualified" })).toHaveLength(1); // only H is left waiting
    expect(ids(await listForDesigner(1, "acknowledged", NOW, { status: "qualified" }))).toEqual([P.id]);
  });
});

describe("today strip", () => {
  it("counts what needs the designer right now", async () => {
    await four();
    expect(await todayForDesigner(1, NOW)).toEqual({ overdue: 3, dueSoon: 1, bookedToday: 1, afterHoursWaiting: 1 });
  });

  it("is empty for a designer with no calls, and ignores other designers' calls", async () => {
    await four();
    expect(await todayForDesigner(2, NOW)).toEqual({ overdue: 0, dueSoon: 0, bookedToday: 0, afterHoursWaiting: 0 });
  });
});

describe("notes", () => {
  it("are saved with the author and the time, oldest first", async () => {
    const { P } = await four();
    await addNote(P.id, 1, "  Rang back, wants a weekday evening  ", at("2026-10-09 11:00"));
    await addNote(P.id, 2, "Meera: site visit Saturday", at("2026-10-09 11:30"));
    const d = (await getDetail(P.id))!;
    expect(d.notes.map((n) => [n.body, n.byName])).toEqual([
      ["Rang back, wants a weekday evening", "Aryan"],
      ["Meera: site visit Saturday", "Meera"],
    ]);
  });

  it("must have text, and have a length limit", async () => {
    const { P } = await four();
    await expect(addNote(P.id, 1, "   ")).rejects.toBeInstanceOf(UserError);
    await expect(addNote(P.id, 1, "x".repeat(MAX_NOTE + 1))).rejects.toThrow(/under/);
    await expect(addNote(99999, 1, "hello")).rejects.toThrow(/not found/);
    expect((await getDetail(P.id))!.notes).toHaveLength(0);
  });

  it("are kept as written, including characters that look like markup", async () => {
    const { P } = await four();
    await addNote(P.id, 1, "<b>call</b> back & \"ask\" about %_");
    expect((await getDetail(P.id))!.notes[0].body).toBe("<b>call</b> back & \"ask\" about %_");
  });
});

describe("timeline", () => {
  it("lists what happened in order: received, reminder, acknowledged, status change", async () => {
    const P = await call("T01", "2026-10-07 11:00");
    await runDueJobs(at("2026-10-07 13:00")); // the one-hour reminder fires
    await acknowledgeCall(P.id, 1, at("2026-10-07 13:10"));
    await overrideStatus(P.id, 1, "needs_attention", "Checking the area with the caller", at("2026-10-07 13:20"));
    const text = (await getDetail(P.id))!.timeline.map((e) => e.text);
    const pos = (needle: RegExp) => text.findIndex((t) => needle.test(t));
    expect(pos(/Call received/)).toBe(0);
    expect(pos(/Reminder sent to Aryan/)).toBeGreaterThan(pos(/Call received/));
    expect(pos(/Acknowledged by Aryan/)).toBeGreaterThan(pos(/Reminder sent/));
    expect(pos(/Status changed from qualified to needs attention by Aryan: Checking the area/)).toBeGreaterThan(pos(/Acknowledged by/));
    expect(pos(/Scored: qualified/)).toBeGreaterThan(-1);
  });

  it("marks a call that arrived outside working hours, and lists a booking", async () => {
    const P = await call("T01", "2026-10-07 21:30", { booking_id: "b1", booked_slot: istIso("2026-10-09 15:00") });
    const text = (await getDetail(P.id))!.timeline.map((e) => e.text);
    expect(text[0]).toMatch(/outside working hours/);
    expect(text.some((t) => /Booking booked/.test(t))).toBe(true);
  });

  it("is in time order", async () => {
    const P = await call("T01", "2026-10-07 11:00");
    await acknowledgeCall(P.id, 1, at("2026-10-07 13:10"));
    const times = (await getDetail(P.id))!.timeline.map((e) => e.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("recording link", () => {
  it("is stored when the provider sends one", async () => {
    const c = await call("T01", "2026-10-07 11:00", { recording_url: "https://example.com/rec/1.mp3" });
    expect((await one(db.select().from(schema.calls).where(eq(schema.calls.id, c.id))))!.recordingUrl).toBe("https://example.com/rec/1.mp3");
  });

  it("is optional", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    expect(c.recordingUrl).toBeNull();
  });

  it("refuses anything that is not an http(s) link, so a call can never carry a script link", async () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", "ftp://x/y", "not a link", "https://"]) {
      await expect(ingestCall(payloadFor("T01", { recording_url: bad }))).rejects.toThrow();
    }
  });
});

describe("founder: trend, designers, funnel", () => {
  /** A Wed, B Thu, C Thu (after hours, booked), D Fri, E Fri. */
  async function scenario() {
    const A = await call("T01", "2026-10-07 11:00");
    const B = await call("T02", "2026-10-08 17:30");
    const C = await call("T06", "2026-10-08 21:00", { booked_slot: istIso("2026-10-12 11:00") });
    const D = await call("T03", "2026-10-09 10:00");
    const E = await call("T07", "2026-10-09 11:30");
    await acknowledgeCall(A.id, 1, at("2026-10-07 11:30"));
    await acknowledgeCall(B.id, 1, at("2026-10-09 09:45"));
    await acknowledgeCall(C.id, 1, at("2026-10-09 09:10"));
    return { A, B, C, D, E };
  }

  it("trend: one entry per day, zero days included, split by status", async () => {
    await scenario();
    const t = await founderTrend("7d", NOW);
    expect(t).toHaveLength(7);
    expect(t.map((d) => d.date)).toEqual(["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(t.map((d) => d.total)).toEqual([0, 0, 0, 0, 1, 2, 2]);
    expect(t[6]).toMatchObject({ qualified: 0, disqualified: 1, needsAttention: 1 });
    expect(t[5]).toMatchObject({ qualified: 2 });
    expect(t[0].label).toBe("Sat 3");
  });

  it("trend: 'today' still shows a week, and '30d' shows thirty days", async () => {
    expect(await founderTrend("today", NOW)).toHaveLength(7);
    expect(await founderTrend("30d", NOW)).toHaveLength(30);
  });

  it("designers: assigned, waiting, overdue, on-time share, and working-time average", async () => {
    await scenario();
    const load = await designerWorkload("7d", NOW);
    const aryan = load.find((d) => d.name === "Aryan")!;
    expect(aryan).toMatchObject({ assigned: 5, waiting: 2, overdue: 1, acknowledged: 3, onTimePct: 50 });
    expect(aryan.avgAckMinutes).toBeCloseTo((30 + 75 + 10) / 3, 5);
    const meera = load.find((d) => d.name === "Meera")!;
    expect(meera).toMatchObject({ assigned: 0, waiting: 0, overdue: 0, onTimePct: null, avgAckMinutes: null });
    expect(load.map((d) => d.name)).toEqual([...load.map((d) => d.name)].sort((a, b) => a.localeCompare(b)));
  });

  it("designers: waiting counts every old call, not just the chosen period", async () => {
    await call("T01", "2026-09-01 11:00");
    const aryan = (await designerWorkload("today", NOW)).find((d) => d.name === "Aryan")!;
    expect(aryan.assigned).toBe(0);
    expect(aryan.waiting).toBe(1);
  });

  it("funnel: calls, qualified, acknowledged, booked, with shares of all calls", async () => {
    await scenario();
    const f = await funnel("7d", NOW);
    expect(f.map((s) => [s.label, s.count, s.pct])).toEqual([
      ["Calls", 5, 100],
      ["Qualified", 3, 60],
      ["Acknowledged by a designer", 3, 60],
      ["Booked a consultation", 1, 20],
    ]);
  });

  it("funnel: with no calls there is no share to show", async () => {
    const f = await funnel("7d", NOW);
    expect(f.every((s) => s.count === 0 && s.pct === null)).toBe(true);
  });
});
