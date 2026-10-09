import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import { setAssigner, defaultAssigner } from "@/lib/assignment";
import { applyCalEvent } from "@/lib/bookings";
import { acknowledgeCall } from "@/lib/calls";
import { ingestCall } from "@/lib/ingest";
import { reconcileReminders, runDueJobs, scheduleForCall } from "@/lib/reminders";
import { saveSettings } from "@/lib/settings";
import { toInlineKeyboard, verifyTelegramSecret } from "@/lib/telegram";
import { createLinkCode, handleUpdate } from "@/lib/telegram-bot";
import { istIso, payloadFor, resetDb } from "./helpers";

// 2026-10-07 is a Wednesday. 10-10 Saturday, 10-11 Sunday, 10-12 Monday.
const at = (s: string) => new Date(istIso(s));

interface Sent {
  chatId: string | null;
  text: string;
  buttons: { text: string; url?: string; callback_data?: string }[][];
}
const sends = (): Sent[] =>
  db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.kind, "mock.telegram.send"))
    .all()
    .map((r) => r.detail as Sent);
const jobs = (kind?: string, state = "pending") =>
  db
    .select()
    .from(schema.reminderJobs)
    .all()
    .filter((j) => (!kind || j.kind === kind) && j.state === state);

/** Ingest a call "now" (the fake clock is set to the call time) assigned to Aryan (id 1). */
async function call(id: string, when: string, over: Record<string, unknown> = {}) {
  vi.setSystemTime(at(when));
  return (await ingestCall(payloadFor(id, { started_at: istIso(when), ...over }))).call;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("2026-10-07 10:00"));
  resetDb();
  setAssigner(() => 1);
  db.update(schema.designers).set({ telegramChatId: "111" }).where(eq(schema.designers.id, 1)).run();
  db.update(schema.designers).set({ telegramChatId: "555" }).where(eq(schema.designers.id, 5)).run(); // founder
});
afterEach(() => {
  vi.useRealTimers();
  setAssigner(defaultAssigner);
});

describe("in-hours call: reminder after one WORKING hour", () => {
  it("queues one job at +1h, sends nothing early, then sends exactly once", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    expect(jobs("sla")).toHaveLength(1);
    expect(jobs("sla")[0].runAt.toISOString()).toBe(istIso("2026-10-07 12:00"));

    expect((await runDueJobs(at("2026-10-07 11:59"))).sent).toBe(0);
    expect(sends()).toHaveLength(0);

    expect((await runDueJobs(at("2026-10-07 12:00"))).sent).toBe(1);
    expect(sends()).toHaveLength(1);
    expect((await runDueJobs(at("2026-10-07 12:30"))).sent).toBe(0); // not again
    expect(sends()).toHaveLength(1);

    const m = sends()[0];
    expect(m.chatId).toBe("111");
    expect(m.text).toMatch(/Priya/); // caller name
    expect(m.text).toMatch(/Qualified/); // status
    expect(m.text).toMatch(/score 9\d/); // score
    expect(m.text).toContain(`call=${c.id}`); // deep link
    const labels = m.buttons.flat().map((b) => b.text);
    expect(labels).toEqual(expect.arrayContaining(["Acknowledge"]));
    expect(m.buttons.flat().find((b) => b.text === "Acknowledge")!.callback_data).toBe(`ack:${c.id}`);
  });

  it("a call at 17:30 is due at 09:30 the next working day", async () => {
    await call("T01", "2026-10-07 17:30");
    expect(jobs("sla")[0].runAt.toISOString()).toBe(istIso("2026-10-08 09:30"));
    expect((await runDueJobs(at("2026-10-07 18:30"))).sent).toBe(0); // the night does not count
    expect((await runDueJobs(at("2026-10-08 09:29"))).sent).toBe(0);
    expect((await runDueJobs(at("2026-10-08 09:30"))).sent).toBe(1);
  });

  it("a Saturday 17:30 call is due Monday 09:30 (Sunday is skipped)", async () => {
    await call("T01", "2026-10-10 17:30");
    expect(jobs("sla")[0].runAt.toISOString()).toBe(istIso("2026-10-12 09:30"));
  });

  it("acknowledging cancels the pending reminder", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    await acknowledgeCall(c.id, 1, at("2026-10-07 11:30"));
    expect(jobs("sla")).toHaveLength(0);
    expect(db.select().from(schema.reminderJobs).get()!.note).toMatch(/acknowledged/);
    expect((await runDueJobs(at("2026-10-07 13:00"))).sent).toBe(0);
    expect(sends()).toHaveLength(0);
  });

  it("scheduling is idempotent: never two pending SLA jobs for one call", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    scheduleForCall(c.id);
    scheduleForCall(c.id);
    expect(jobs("sla")).toHaveLength(1);
  });
});

describe("after-hours calls: ONE digest at 09:00 next working day", () => {
  it("three overnight calls produce one digest job and one message listing all of them", async () => {
    await call("T01", "2026-10-07 21:00");
    await call("T02", "2026-10-07 22:15");
    await call("T06", "2026-10-08 07:30");
    expect(jobs("sla")).toHaveLength(0);
    expect(jobs("digest")).toHaveLength(1);
    expect(jobs("digest")[0].runAt.toISOString()).toBe(istIso("2026-10-08 09:00"));

    expect((await runDueJobs(at("2026-10-08 08:59"))).sent).toBe(0);
    expect((await runDueJobs(at("2026-10-08 09:00"))).sent).toBe(1);
    expect(sends()).toHaveLength(1);
    const text = sends()[0].text;
    expect(text).toMatch(/3 calls are waiting/);
    expect(text.match(/score \d+/g)).toHaveLength(3);
    expect(text.match(/call=\d+/g)).toHaveLength(3);
    // acknowledgement is not offered in the digest
    expect(sends()[0].buttons.flat().some((b) => b.callback_data)).toBe(false);
  });

  it("a Sunday call waits for Monday 09:00", async () => {
    await call("T01", "2026-10-11 14:00");
    expect(jobs("digest")[0].runAt.toISOString()).toBe(istIso("2026-10-12 09:00"));
  });

  it("the digest lists only calls still unacknowledged, and is dropped if none are", async () => {
    const a = await call("T01", "2026-10-07 21:00");
    const b = await call("T02", "2026-10-07 22:00");
    await acknowledgeCall(a.id, 1, at("2026-10-08 08:00"));
    await runDueJobs(at("2026-10-08 09:00"));
    expect(sends()).toHaveLength(1);
    expect(sends()[0].text).toMatch(/1 call is waiting/);

    await acknowledgeCall(b.id, 1, at("2026-10-08 09:05"));
    const c = await call("T01", "2026-10-08 22:00");
    await acknowledgeCall(c.id, 1, at("2026-10-08 22:01"));
    await runDueJobs(at("2026-10-09 09:00"));
    expect(sends()).toHaveLength(1); // nothing new
  });

  it("each designer gets their own digest", async () => {
    setAssigner(() => 1);
    await call("T01", "2026-10-07 21:00");
    setAssigner(() => 2);
    db.update(schema.designers).set({ telegramChatId: "222" }).where(eq(schema.designers.id, 2)).run();
    await call("T02", "2026-10-07 21:30");
    expect(jobs("digest")).toHaveLength(2);
    await runDueJobs(at("2026-10-08 09:00"));
    expect(sends().map((s) => s.chatId).sort()).toEqual(["111", "222"]);
  });
});

describe("booked slot: urgent alert if still unacknowledged 30 minutes before", () => {
  it("alerts the designer and copies the founder", async () => {
    const c = await call("T01", "2026-10-07 11:00", { booked_slot: istIso("2026-10-07 15:00") });
    expect(jobs("slot")[0].runAt.toISOString()).toBe(istIso("2026-10-07 14:30"));
    await runDueJobs(at("2026-10-07 14:30"));
    const urgent = sends().filter((s) => /URGENT/.test(s.text));
    expect(urgent.map((s) => s.chatId).sort()).toEqual(["111", "555"]);
    expect(urgent[0].text).toMatch(/Booked:/);
    expect(urgent[0].text).toContain(`call=${c.id}`);
    expect(urgent.find((s) => s.chatId === "555")!.text).toMatch(/copy: assigned to Aryan/);
  });

  it("does nothing once the call is acknowledged", async () => {
    const c = await call("T01", "2026-10-07 11:00", { booked_slot: istIso("2026-10-07 15:00") });
    await acknowledgeCall(c.id, 1, at("2026-10-07 13:00"));
    await runDueJobs(at("2026-10-07 14:30"));
    expect(sends().filter((s) => /URGENT/.test(s.text))).toHaveLength(0);
  });

  it("booked less than 30 minutes ahead alerts at once; a slot already past does not alert", async () => {
    await call("T01", "2026-10-07 14:45", { booked_slot: istIso("2026-10-07 15:00") });
    expect(jobs("slot")[0].runAt.toISOString()).toBe(istIso("2026-10-07 14:45"));
    resetDb();
    setAssigner(() => 1);
    await call("T01", "2026-10-07 14:45", { booked_slot: istIso("2026-10-07 14:00") });
    expect(jobs("slot")).toHaveLength(0);
  });

  it("is not subject to working hours: a 09:15 slot alerts at 08:45", async () => {
    await call("T01", "2026-10-07 21:00", { booked_slot: istIso("2026-10-08 09:15") });
    expect(jobs("slot")[0].runAt.toISOString()).toBe(istIso("2026-10-08 08:45"));
  });
});

describe("booking cancelled or rescheduled", () => {
  it("reschedule: updates the call, moves the alert, and tells the designer", async () => {
    const c = await call("T01", "2026-10-07 11:00", { booking_id: "b1", booked_slot: istIso("2026-10-07 15:00") });
    vi.setSystemTime(at("2026-10-07 11:30"));
    await applyCalEvent({ triggerEvent: "BOOKING_RESCHEDULED", payload: { uid: "b2", rescheduleUid: "b1", startTime: istIso("2026-10-08 16:00"), organizer: { email: "aryan@aangan.test" } } });
    expect(jobs("slot")).toHaveLength(1);
    expect(jobs("slot")[0].runAt.toISOString()).toBe(istIso("2026-10-08 15:30"));
    const msg = sends().find((s) => /rescheduled/i.test(s.text))!;
    expect(msg.chatId).toBe("111");
    expect(msg.text).toContain(`call=${c.id}`);
    expect(db.select().from(schema.calls).where(eq(schema.calls.id, c.id)).get()!.bookingStatus).toBe("rescheduled");
  });

  it("cancel: drops the slot alert and tells the designer", async () => {
    await call("T01", "2026-10-07 11:00", { booking_id: "b1", booked_slot: istIso("2026-10-07 15:00") });
    await applyCalEvent({ triggerEvent: "BOOKING_CANCELLED", payload: { uid: "b1", startTime: istIso("2026-10-07 15:00") } });
    expect(jobs("slot")).toHaveLength(0);
    expect(sends().some((s) => /cancelled/i.test(s.text) && s.chatId === "111")).toBe(true);
    await runDueJobs(at("2026-10-07 14:30"));
    expect(sends().filter((s) => /URGENT/.test(s.text))).toHaveLength(0);
  });

  it("a first booking is not announced, but its alert is queued", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    vi.setSystemTime(at("2026-10-07 11:10"));
    await applyCalEvent({ triggerEvent: "BOOKING_CREATED", payload: { uid: "late", startTime: istIso("2026-10-07 17:00"), attendees: [{ phoneNumber: "+919800000000" }] } });
    expect(sends()).toHaveLength(0);
    expect(jobs("slot")[0].callId).toBe(c.id);
  });
});

describe("persistence across restarts", () => {
  it("jobs live in the database and reminders that fell due while the server was down go out on the next run", async () => {
    await call("T01", "2026-10-07 11:00");
    expect(db.select().from(schema.reminderJobs).all()).toHaveLength(1); // a row, not an in-memory timer
    // ...server down 12:00-15:00...
    expect((await runDueJobs(at("2026-10-07 15:00"))).sent).toBe(1);
  });

  it("reconcile gives reminders to processed calls that have none", async () => {
    await call("T01", "2026-10-07 11:00");
    db.delete(schema.reminderJobs).run();
    expect(reconcileReminders(at("2026-10-07 11:05"))).toBe(1);
    expect(jobs("sla")).toHaveLength(1);
  });
});

describe("changing working hours or the SLA recomputes the schedule", () => {
  it("moves a pending reminder to the new hours", async () => {
    await call("T01", "2026-10-07 17:30");
    expect(jobs("sla")[0].runAt.toISOString()).toBe(istIso("2026-10-08 09:30"));
    await saveSettings({ workStart: "10:00" });
    expect(jobs("sla")).toHaveLength(1);
    expect(jobs("sla")[0].runAt.toISOString()).toBe(istIso("2026-10-08 10:30"));
  });

  it("a different SLA length moves the due time", async () => {
    await call("T01", "2026-10-07 11:00");
    await saveSettings({ slaMinutes: 120 });
    expect(jobs("sla")[0].runAt.toISOString()).toBe(istIso("2026-10-07 13:00"));
  });

  it("a call that arrived in hours can become after-hours (and gets a digest instead)", async () => {
    await call("T01", "2026-10-07 11:00");
    await saveSettings({ workStart: "12:00" });
    expect(jobs("sla")).toHaveLength(0);
    expect(jobs("digest")).toHaveLength(1);
    expect(jobs("digest")[0].runAt.toISOString()).toBe(istIso("2026-10-07 12:00")); // 11:00 is now before opening, so it is next opened at 12:00 today
  });

  it("does not resend a reminder that was already sent", async () => {
    await call("T01", "2026-10-07 11:00");
    await runDueJobs(at("2026-10-07 12:00"));
    await saveSettings({ workEnd: "17:00" });
    expect(jobs("sla")).toHaveLength(0);
    await runDueJobs(at("2026-10-07 13:00"));
    expect(sends()).toHaveLength(1);
  });

  it("keeps acknowledged calls out of the new schedule", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    await acknowledgeCall(c.id, 1, at("2026-10-07 11:10"));
    await saveSettings({ slaMinutes: 30 });
    expect(jobs()).toHaveLength(0);
  });

  it("rejects invalid settings and leaves the schedule alone", async () => {
    await call("T01", "2026-10-07 11:00");
    await expect(saveSettings({ workStart: "18:00", workEnd: "09:00" })).rejects.toThrow();
    await expect(saveSettings({ workStart: "9am" })).rejects.toThrow();
    await expect(saveSettings({ workDays: [] })).rejects.toThrow();
    expect(jobs("sla")[0].runAt.toISOString()).toBe(istIso("2026-10-07 12:00"));
  });
});

describe("seed data is never reminded about", () => {
  it("a recomputed schedule skips calls whose reminders the seed switched off", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    db.update(schema.reminderJobs).set({ state: "cancelled", note: "cancelled: seed data" }).where(eq(schema.reminderJobs.callId, c.id)).run();
    await saveSettings({ slaMinutes: 90 });
    expect(jobs()).toHaveLength(0);
    expect((await runDueJobs(at("2026-10-08 12:00"))).sent).toBe(0);
  });
});

describe("Telegram linking and the Acknowledge button", () => {
  it("/start <code> stores the chat id, and the code works once", async () => {
    const code = createLinkCode(2);
    await handleUpdate({ message: { text: `/start ${code}`, chat: { id: 777 } } });
    expect(db.select().from(schema.designers).where(eq(schema.designers.id, 2)).get()!.telegramChatId).toBe("777");
    expect(sends().at(-1)!.text).toMatch(/Linked/);
    await handleUpdate({ message: { text: `/start ${code}`, chat: { id: 888 } } });
    expect(db.select().from(schema.designers).where(eq(schema.designers.id, 2)).get()!.telegramChatId).toBe("777");
  });

  it("pressing Start again with a used link says the chat is already linked, not that the link is broken", async () => {
    const code = createLinkCode(2);
    await handleUpdate({ message: { text: `/start ${code}`, chat: { id: 777 } } });
    await handleUpdate({ message: { text: `/start ${code}`, chat: { id: 777 } } });
    expect(sends().at(-1)!.text).toMatch(/already linked as Meera/);
  });

  it("rejects an unknown or expired code, and plain /start explains how to link", async () => {
    await handleUpdate({ message: { text: "/start nope", chat: { id: 9 } } });
    expect(sends().at(-1)!.text).toMatch(/invalid or has expired/);
    const code = createLinkCode(3, at("2026-10-01 10:00"));
    await handleUpdate({ message: { text: `/start ${code}`, chat: { id: 9 } } }, at("2026-10-07 10:00"));
    expect(db.select().from(schema.designers).where(eq(schema.designers.id, 3)).get()!.telegramChatId).toBeNull();
    await handleUpdate({ message: { text: "/start", chat: { id: 9 } } });
    expect(sends().at(-1)!.text).toMatch(/personal link/);
  });

  it("tapping Acknowledge updates the app and cancels the reminder", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    await handleUpdate({ callback_query: { id: "cb1", data: `ack:${c.id}`, message: { message_id: 5, chat: { id: 111 } } } });
    const row = db.select().from(schema.calls).where(eq(schema.calls.id, c.id)).get()!;
    expect(row.acknowledgedBy).toBe(1);
    expect(row.acknowledgedAt).not.toBeNull();
    expect(jobs("sla")).toHaveLength(0);
    const kinds = db.select().from(schema.auditLog).all().map((r) => r.kind);
    expect(kinds).toContain("mock.telegram.answerCallback");
    expect(kinds).toContain("mock.telegram.clearButtons");
  });

  it("a tap from a chat that is not linked to any designer changes nothing", async () => {
    const c = await call("T01", "2026-10-07 11:00");
    await handleUpdate({ callback_query: { id: "cb2", data: `ack:${c.id}`, message: { message_id: 5, chat: { id: 424242 } } } });
    expect(db.select().from(schema.calls).where(eq(schema.calls.id, c.id)).get()!.acknowledgedAt).toBeNull();
  });

  it("ignores malformed callback data", async () => {
    await expect(handleUpdate({ callback_query: { id: "cb3", data: "ack:abc", message: { message_id: 1, chat: { id: 111 } } } })).resolves.toBeUndefined();
  });
});

describe("Telegram plumbing", () => {
  it("webhook secret: must match when set; with none, only allowed while mocking", () => {
    expect(verifyTelegramSecret("s3", "s3", false)).toBe(true);
    expect(verifyTelegramSecret("wrong", "s3", false)).toBe(false);
    expect(verifyTelegramSecret(null, "s3", false)).toBe(false);
    expect(verifyTelegramSecret(null, "", true)).toBe(true);
    expect(verifyTelegramSecret(null, "", false)).toBe(false);
  });

  it("inline keyboards drop http:// URL buttons (Telegram rejects them) but keep https and callbacks", () => {
    const kb = toInlineKeyboard([[{ text: "Open", url: "http://localhost:3000/x" }, { text: "Ack", callbackData: "ack:1" }], [{ text: "Web", url: "https://example.com" }]]);
    expect(kb!.inline_keyboard).toEqual([[{ text: "Ack", callback_data: "ack:1" }], [{ text: "Web", url: "https://example.com" }]]);
    expect(toInlineKeyboard([[{ text: "Open", url: "http://localhost:3000" }]])).toBeUndefined();
  });

  it("no reminder text contains a price", async () => {
    await call("T10", "2026-10-07 11:00");
    await call("T13", "2026-10-07 11:05");
    await runDueJobs(at("2026-10-07 13:00"));
    for (const s of sends()) expect(s.text).not.toMatch(/₹|lakh|per sq/i);
  });
});
