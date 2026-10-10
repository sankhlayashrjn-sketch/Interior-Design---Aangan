import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, one, schema } from "@/db";
import { suggestDesignerFor } from "@/lib/assignment";
import { acknowledgeCall, assignCall, countsForFrontDesk, listForDesigner, listForFrontDesk, todayForFrontDesk, UserError } from "@/lib/calls";
import { updateDesigner } from "@/lib/designers";
import { env } from "@/lib/env";
import { ingestCall } from "@/lib/ingest";
import { runDueJobs } from "@/lib/reminders";
import { saveSettings } from "@/lib/settings";
import { handleUpdate } from "@/lib/telegram-bot";
import { callById, istIso, payloadFor, resetDb } from "./helpers";

// 2026-10-07 is a Wednesday.
const at = (s: string) => new Date(istIso(s));

interface Sent {
  chatId: string | null;
  text: string;
  buttons: { text: string; url?: string; callback_data?: string }[][];
}
const sends = async (): Promise<Sent[]> => (await db.select().from(schema.auditLog).where(eq(schema.auditLog.kind, "mock.telegram.send"))).map((r) => r.detail as Sent);
const jobs = async (kind?: string, state = "pending") => (await db.select().from(schema.reminderJobs)).filter((j) => (!kind || j.kind === kind) && j.state === state);

let ISHA: number; // front desk officer, Telegram 901
let DEV: number; // front desk officer, no Telegram
const ARYAN = 1;
const MEERA = 2;

async function call(id: string, when: string, over: Record<string, unknown> = {}) {
  vi.setSystemTime(at(when));
  return (await ingestCall(payloadFor(id, { started_at: istIso(when), ...over }))).call;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("2026-10-07 10:00"));
  await resetDb();
  await saveSettings({ assignmentMode: "manual" });
  await db.update(schema.designers).set({ telegramChatId: "111" }).where(eq(schema.designers.id, ARYAN));
  await db.update(schema.designers).set({ telegramChatId: "222" }).where(eq(schema.designers.id, MEERA));
  // Direct inserts: the settings form insists on realistic chat IDs, but these tests use short ones.
  [{ id: ISHA }, { id: DEV }] = await db
    .insert(schema.designers)
    .values([
      { name: "Isha", role: "front_desk", rrOrder: 50, telegramChatId: "901" },
      { name: "Dev", role: "front_desk", rrOrder: 51 },
    ])
    .returning({ id: schema.designers.id });
});
afterEach(() => vi.useRealTimers());

describe("manual mode: a call waits for the front desk", () => {
  it("a qualified call arrives unassigned, with an assign reminder at +1h and an auto-assign fallback at +2h", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    expect(c.status).toBe("qualified");
    expect(c.assignedDesignerId).toBeNull();
    expect(c.assignDueAt?.toISOString()).toBe(istIso("2026-10-07 12:00"));
    expect(await jobs("sla")).toHaveLength(0); // the designer's clock has not started
    const assign = await jobs("assign");
    expect(assign.map((j) => j.designerId).sort()).toEqual([ISHA, DEV].sort());
    expect(assign.every((j) => j.runAt.toISOString() === istIso("2026-10-07 12:00"))).toBe(true);
    const auto = await jobs("autoassign");
    expect(auto).toHaveLength(1);
    expect(auto[0].runAt.toISOString()).toBe(istIso("2026-10-07 13:00"));
    expect(auto[0].designerId).toBeNull();
  });

  it("needs-attention calls go to the front desk too; disqualified ones are visible but nobody is chased", async () => {
    const n = await call("T07", "2026-10-07 11:00");
    const d = await call("T03", "2026-10-07 11:05");
    expect(n.status).toBe("needs_attention");
    expect(d.status).toBe("disqualified");
    expect((await jobs()).filter((j) => j.callId === d.id)).toHaveLength(0);
    expect((await listForFrontDesk("assign")).map((c) => c.id)).toEqual([n.id]);
    expect((await listForFrontDesk("disqualified")).map((c) => c.id)).toEqual([d.id]);
    expect(await countsForFrontDesk()).toMatchObject({ assign: 1, disqualified: 1, assigned: 0 });
  });

  it("the assign reminder goes to the front desk with one button per designer, and not to designers", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    expect((await runDueJobs(at("2026-10-07 11:59"))).sent).toBe(0);
    await runDueJobs(at("2026-10-07 12:00"));
    const out = (await sends()).filter((s) => s.chatId); // Dev has no Telegram chat, so only Isha is reachable
    expect(out).toHaveLength(1);
    expect(out[0].chatId).toBe("901");
    expect(out[0].text).toMatch(/Waiting to be assigned/);
    const asg = out[0].buttons.flat().filter((b) => b.callback_data?.startsWith("asg:"));
    expect(asg.map((b) => b.callback_data).sort()).toEqual([ARYAN, MEERA, 3, 4, 5].map((id) => `asg:${c.id}:${id}`).sort());
    expect(out[0].text).toContain(`/call/${c.id}`);
  });

  it("a call that came in after hours is listed in ONE 09:00 digest for the front desk", async () => {
    await call("T01", "2026-10-07 21:00");
    await call("T02", "2026-10-07 22:10");
    const digest = (await jobs("digest")).filter((j) => j.designerId === ISHA);
    expect(digest).toHaveLength(1);
    expect(digest[0].runAt.toISOString()).toBe(istIso("2026-10-08 09:00"));
    await runDueJobs(at("2026-10-08 09:00"));
    const out = (await sends()).filter((s) => s.chatId === "901");
    expect(out).toHaveLength(1);
    expect(out[0].text).toMatch(/2 calls are waiting to be assigned/);
  });
});

describe("assigning", () => {
  it("assigning starts the designer's clock, cancels the front desk reminders, and tells the designer", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    vi.setSystemTime(at("2026-10-07 11:30"));
    const done = await assignCall(c.id, ARYAN, { id: ISHA, how: "front_desk" }, at("2026-10-07 11:30"));
    expect(done.assignedDesignerId).toBe(ARYAN);
    expect(done.assignedBy).toBe(ISHA);
    expect(done.assignedHow).toBe("front_desk");
    expect(await jobs("assign")).toHaveLength(0);
    expect(await jobs("autoassign")).toHaveLength(0);
    const sla = await jobs("sla");
    expect(sla).toHaveLength(1);
    expect(sla[0].designerId).toBe(ARYAN);
    expect(sla[0].runAt.toISOString()).toBe(istIso("2026-10-07 12:30")); // one working hour after assignment, not after the call
    expect((await callById(c.id)).dueAt?.toISOString()).toBe(istIso("2026-10-07 12:30"));

    const told = (await sends()).filter((s) => s.chatId === "111");
    expect(told).toHaveLength(1);
    expect(told[0].text).toMatch(/assigned to you by Isha/);
    expect(told[0].buttons.flat().some((b) => b.callback_data === `ack:${c.id}`)).toBe(true);
    expect((await listForDesigner(ARYAN, "pending")).map((x) => x.id)).toEqual([c.id]);
    expect(await listForFrontDesk("assign")).toHaveLength(0);
  });

  it("only designers can receive a call, and only active ones", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    await expect(assignCall(c.id, ISHA, { id: ISHA, how: "front_desk" })).rejects.toBeInstanceOf(UserError);
    await db.update(schema.designers).set({ active: false }).where(eq(schema.designers.id, MEERA));
    await expect(assignCall(c.id, MEERA, { id: ISHA, how: "front_desk" })).rejects.toBeInstanceOf(UserError);
    expect((await callById(c.id)).assignedDesignerId).toBeNull();
  });

  it("can be moved to another designer until it is acknowledged, then it is locked", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    await assignCall(c.id, ARYAN, { id: ISHA, how: "front_desk" }, at("2026-10-07 11:10"));
    await assignCall(c.id, MEERA, { id: DEV, how: "front_desk" }, at("2026-10-07 11:20"));
    const moved = await callById(c.id);
    expect(moved.assignedDesignerId).toBe(MEERA);
    expect(moved.assignedBy).toBe(DEV);
    const sla = await jobs("sla");
    expect(sla.map((j) => j.designerId)).toEqual([MEERA]); // Aryan's reminder is gone, Meera's clock restarted
    expect(sla[0].runAt.toISOString()).toBe(istIso("2026-10-07 12:20"));

    await acknowledgeCall(c.id, MEERA, at("2026-10-07 11:40"));
    await expect(assignCall(c.id, ARYAN, { id: ISHA, how: "front_desk" })).rejects.toThrow(/already acknowledged/);
    expect((await callById(c.id)).assignedDesignerId).toBe(MEERA);
  });

  it("the suggestion is the designer with the fewest waiting calls", async () => {
    const a = await call("T01", "2026-10-07 11:00");
    const first = await suggestDesignerFor(a);
    expect(first).toBe(ARYAN); // everyone at zero: rotation order
    await assignCall(a.id, ARYAN, { id: ISHA, how: "front_desk" }, at("2026-10-07 11:01"));
    const b = await call("T02", "2026-10-07 11:05");
    expect(await suggestDesignerFor(b)).toBe(MEERA);
  });

  it("an existing-client complaint is suggested to the studio head", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    await db.update(schema.calls).set({ flag: "existing_client" }).where(eq(schema.calls.id, c.id));
    expect(await suggestDesignerFor({ ...c, flag: "existing_client" })).toBe(5);
  });
});

describe("auto-assign fallback", () => {
  it("gives an unassigned call to the least-loaded designer once the grace period passes", async () => {
    const held = await call("T02", "2026-10-07 10:00");
    await assignCall(held.id, ARYAN, { id: ISHA, how: "front_desk" }, at("2026-10-07 10:05")); // Aryan now holds one
    const c = await call("T01", "2026-10-07 11:00");
    await runDueJobs(at("2026-10-07 12:59"));
    expect((await callById(c.id)).assignedDesignerId).toBeNull();

    await runDueJobs(at("2026-10-07 13:00"));
    const after = await callById(c.id);
    expect(after.assignedDesignerId).toBe(MEERA);
    expect(after.assignedHow).toBe("auto");
    expect(after.assignedBy).toBeNull();
    expect((await jobs("sla")).some((j) => j.callId === c.id && j.designerId === MEERA)).toBe(true);
  });

  it("never overwrites a person's decision made first", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    await assignCall(c.id, 3, { id: ISHA, how: "front_desk" }, at("2026-10-07 12:30"));
    await runDueJobs(at("2026-10-07 13:30"));
    const after = await callById(c.id);
    expect(after.assignedDesignerId).toBe(3);
    expect(after.assignedHow).toBe("front_desk");
  });

  it("can be switched off with 0 minutes", async () => {
    await saveSettings({ autoAssignAfterMinutes: 0 });
    await call("T01", "2026-10-07 11:00");
    expect(await jobs("autoassign")).toHaveLength(0);
  });
});

describe("automatic mode", () => {
  it("assigns on arrival, starts the designer's clock at the call, and the front desk can still move it", async () => {
    await saveSettings({ assignmentMode: "auto" });
    const c = await call("T01", "2026-10-07 11:00");
    expect(c.assignedDesignerId).toBe(ARYAN);
    expect(c.assignedHow).toBe("auto");
    expect(await jobs("assign")).toHaveLength(0);
    expect((await jobs("sla"))[0].runAt.toISOString()).toBe(istIso("2026-10-07 12:00"));
    await assignCall(c.id, MEERA, { id: ISHA, how: "front_desk" }, at("2026-10-07 11:20"));
    expect((await callById(c.id)).assignedDesignerId).toBe(MEERA);
  });
});

describe("assign from Telegram", () => {
  const tap = (chat: number, data: string) => handleUpdate({ callback_query: { id: "cb", data, message: { message_id: 7, chat: { id: chat } } } });

  it("a front desk officer taps a designer and the call is assigned and the designer is told", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    await tap(901, `asg:${c.id}:${MEERA}`);
    const after = await callById(c.id);
    expect(after.assignedDesignerId).toBe(MEERA);
    expect(after.assignedBy).toBe(ISHA);
    expect((await sends()).some((s) => s.chatId === "222" && /assigned to you by Isha/.test(s.text))).toBe(true);
  });

  it("a designer cannot assign, and a stranger cannot do anything", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    await tap(111, `asg:${c.id}:${MEERA}`);
    await tap(999, `asg:${c.id}:${MEERA}`);
    expect((await callById(c.id)).assignedDesignerId).toBeNull();
  });

  it("front desk officers cannot acknowledge on a designer's behalf", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    await assignCall(c.id, ARYAN, { id: ISHA, how: "front_desk" });
    await tap(901, `ack:${c.id}`);
    expect((await callById(c.id)).acknowledgedAt).toBeNull();
    await tap(111, `ack:${c.id}`);
    expect((await callById(c.id)).acknowledgedAt).not.toBeNull();
  });
});

describe("roles", () => {
  it("front desk officers are never offered calls or counted as designers", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    expect(await suggestDesignerFor(c)).not.toBe(ISHA);
    await expect(updateDesigner(ISHA, { name: "Isha", telegramChatId: "90100", hubspotOwnerId: null, calcomUser: null, active: true, isEscalation: true, role: "front_desk" })).resolves.toBeUndefined();
    const row = await one(db.select().from(schema.designers).where(eq(schema.designers.id, ISHA)));
    expect(row?.isEscalation).toBe(false); // the studio head is always a designer
  });

  it("the front desk today strip counts what is waiting and overdue", async () => {
    await call("T01", "2026-10-07 09:30");
    await call("T02", "2026-10-07 11:00");
    const t = await todayForFrontDesk(at("2026-10-07 11:30"));
    expect(t.toAssign).toBe(2);
    expect(t.overdue).toBe(1); // the 09:30 call was due 10:30
  });
});

describe("one-phone testing (TELEGRAM_REDIRECT_CHAT_ID)", () => {
  afterEach(() => {
    env.TELEGRAM_REDIRECT_CHAT_ID = "";
  });

  it("sends every reminder to the one chat, says who it is for, and taps act as that person", async () => {
    env.TELEGRAM_REDIRECT_CHAT_ID = "77777";
    const c = await call("T01", "2026-10-07 11:00");
    await runDueJobs(at("2026-10-07 12:00"));
    const out = (await sends()).filter((s) => s.chatId);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => s.chatId === "77777")).toBe(true);
    const forIsha = out.find((s) => s.text.startsWith("To: Isha (front desk)"))!;
    expect(forIsha).toBeTruthy();
    const button = forIsha.buttons.flat().find((b) => b.callback_data?.startsWith(`asg:${c.id}:${MEERA}`))!;
    expect(button.callback_data).toBe(`asg:${c.id}:${MEERA}:u${ISHA}`);

    // Tapping it from the test chat assigns the call as Isha, even though that chat is not linked to Isha.
    await handleUpdate({ callback_query: { id: "cb", data: button.callback_data, message: { message_id: 1, chat: { id: 77777 } } } });
    const after = await callById(c.id);
    expect(after.assignedDesignerId).toBe(MEERA);
    expect(after.assignedBy).toBe(ISHA);

    // The designer's message arrives in the same chat, addressed to Meera, and Acknowledge acts as Meera.
    const toMeera = (await sends()).find((s) => s.text.startsWith("To: Meera (designer)"))!;
    const ack = toMeera.buttons.flat().find((b) => b.callback_data?.startsWith("ack:"))!;
    expect(ack.callback_data).toBe(`ack:${c.id}:u${MEERA}`);
    await handleUpdate({ callback_query: { id: "cb2", data: ack.callback_data, message: { message_id: 2, chat: { id: 77777 } } } });
    expect((await callById(c.id)).acknowledgedBy).toBe(MEERA);
  });

  it("taps from other chats cannot borrow someone else's identity", async () => {
    env.TELEGRAM_REDIRECT_CHAT_ID = "77777";
    const c = await call("T01", "2026-10-07 11:00");
    await handleUpdate({ callback_query: { id: "cb", data: `asg:${c.id}:${MEERA}:u${ISHA}`, message: { message_id: 1, chat: { id: 4242 } } } });
    expect((await callById(c.id)).assignedDesignerId).toBeNull();
  });

  it("/id tells you your chat id", async () => {
    await handleUpdate({ message: { text: "/id", chat: { id: 5551234 } } });
    expect((await sends()).some((s) => /5551234/.test(s.text))).toBe(true);
  });
});
