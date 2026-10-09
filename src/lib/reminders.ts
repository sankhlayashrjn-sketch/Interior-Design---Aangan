import { and, asc, eq, inArray, isNull, lte, ne, notInArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { on } from "@/lib/hooks";
import { bookingChangedMessage, digestMessage, slaMessage, slotMessage } from "@/lib/reminder-messages";
import { getSettings, hoursConfig } from "@/lib/settings";
import { sendTelegram, type OutMessage } from "@/lib/telegram";
import { planReminder } from "@/lib/working-hours";

type Call = typeof schema.calls.$inferSelect;
type Job = typeof schema.reminderJobs.$inferSelect;
type Kind = Job["kind"];

const MAX_ATTEMPTS = 5;
/** Written by the seed script on reminder jobs it switches off. */
export const SEED_NOTE = "cancelled: seed data";
const getCall = (id: number) => db.select().from(schema.calls).where(eq(schema.calls.id, id)).get();
const designer = (id: number | null) => (id ? db.select().from(schema.designers).where(eq(schema.designers.id, id)).get() : undefined);
const isProcessed = (c: Call) => c.status !== "yet_to_be_processed";

/** Calls that are waiting for this designer to acknowledge. */
export function pendingFor(designerId: number): Call[] {
  return db
    .select()
    .from(schema.calls)
    .where(and(eq(schema.calls.assignedDesignerId, designerId), isNull(schema.calls.acknowledgedAt), ne(schema.calls.status, "yet_to_be_processed")))
    .orderBy(asc(schema.calls.startedAt))
    .all();
}

export function cancelJobs(where: { callId?: number; kinds?: Kind[] }, note: string) {
  const conds = [eq(schema.reminderJobs.state, "pending")];
  if (where.callId !== undefined) conds.push(eq(schema.reminderJobs.callId, where.callId));
  if (where.kinds) conds.push(inArray(schema.reminderJobs.kind, where.kinds));
  db.update(schema.reminderJobs)
    .set({ state: "cancelled", note: `cancelled: ${note}` })
    .where(and(...conds))
    .run();
}

function addJob(job: { kind: Kind; callId: number | null; designerId: number; runAt: Date }, now: Date) {
  db.insert(schema.reminderJobs).values({ ...job, state: "pending", createdAt: now }).run();
}

/**
 * (Re)create the reminders for one call from its current state: assignee, booking, working hours, SLA.
 * Safe to call any number of times. An SLA reminder that was already sent is never sent again.
 */
export function scheduleForCall(callId: number, now: Date = new Date()): void {
  const call = getCall(callId);
  if (!call) return;
  // Demo data from the seed script is never reminded about, even when the schedule is recomputed.
  const seeded = db.select().from(schema.reminderJobs).where(and(eq(schema.reminderJobs.callId, callId), eq(schema.reminderJobs.note, SEED_NOTE))).get();
  if (seeded) return;
  cancelJobs({ callId, kinds: ["sla", "slot"] }, "rescheduled");

  if (!isProcessed(call) || call.acknowledgedAt || !call.assignedDesignerId) return;
  const s = getSettings();
  const plan = planReminder(call.startedAt, s.slaMinutes, hoursConfig(s));
  db.update(schema.calls).set({ dueAt: plan.dueAt, afterHours: plan.afterHours }).where(eq(schema.calls.id, callId)).run();

  if (plan.kind === "sla") {
    const alreadySent = db.select().from(schema.reminderJobs).where(and(eq(schema.reminderJobs.callId, callId), eq(schema.reminderJobs.kind, "sla"), eq(schema.reminderJobs.state, "sent"))).get();
    if (!alreadySent) addJob({ kind: "sla", callId, designerId: call.assignedDesignerId, runAt: plan.runAt }, now);
  } else {
    // After hours: ONE digest per designer per morning, shared by every call that landed overnight.
    const existing = db
      .select()
      .from(schema.reminderJobs)
      .where(and(eq(schema.reminderJobs.kind, "digest"), eq(schema.reminderJobs.designerId, call.assignedDesignerId), eq(schema.reminderJobs.runAt, plan.runAt)))
      .get();
    if (!existing) addJob({ kind: "digest", callId: null, designerId: call.assignedDesignerId, runAt: plan.runAt }, now);
  }

  if (call.bookedSlot && call.bookingStatus !== "cancelled" && call.bookedSlot.getTime() > now.getTime()) {
    const lead = s.slotAlertMinutes * 60_000;
    const runAt = new Date(Math.max(call.bookedSlot.getTime() - lead, now.getTime()));
    addJob({ kind: "slot", callId, designerId: call.assignedDesignerId, runAt }, now);
  }
}

/** Working hours or SLA changed: cancel everything pending and rebuild it for every unacknowledged call. */
export function rescheduleAll(now: Date = new Date()): number {
  cancelJobs({}, "settings changed");
  const rows = db.select().from(schema.calls).where(isNull(schema.calls.acknowledgedAt)).all().filter(isProcessed);
  for (const c of rows) scheduleForCall(c.id, now);
  audit("reminders.rescheduled", { calls: rows.length });
  return rows.length;
}

/** Give a pending-reminder row to any processed, unacknowledged call that has none at all (for example calls created before this engine existed). */
export function reconcileReminders(now: Date = new Date()): number {
  const withJobs = db.select({ id: schema.reminderJobs.callId }).from(schema.reminderJobs).all().map((r) => r.id).filter((x): x is number => x !== null);
  const rows = db
    .select()
    .from(schema.calls)
    .where(and(isNull(schema.calls.acknowledgedAt), withJobs.length ? notInArray(schema.calls.id, withJobs) : undefined))
    .all()
    .filter(isProcessed);
  for (const c of rows) scheduleForCall(c.id, now);
  return rows.length;
}

/** The founder(s): anyone marked as escalation contact. They get a copy of urgent slot alerts. */
function founders(excludeId: number | null) {
  return db.select().from(schema.designers).where(eq(schema.designers.isEscalation, true)).all().filter((d) => d.id !== excludeId);
}

async function deliver(chatId: string | null, msg: OutMessage) {
  return sendTelegram(chatId, msg);
}

type Outcome = { state: "sent" | "cancelled"; note: string } | { retry: string };

async function execute(job: Job, now: Date): Promise<Outcome> {
  const d = designer(job.designerId);
  if (!d) return { state: "cancelled", note: "cancelled: designer not found" };

  if (job.kind === "digest") {
    const calls = pendingFor(d.id);
    if (calls.length === 0) return { state: "cancelled", note: "cancelled: nothing pending" };
    const r = await deliver(d.telegramChatId, digestMessage(calls, now));
    return r.ok ? { state: "sent", note: `sent: digest of ${calls.length}` } : { retry: r.error ?? "send failed" };
  }

  const call = job.callId ? getCall(job.callId) : undefined;
  if (!call) return { state: "cancelled", note: "cancelled: call not found" };
  if (call.acknowledgedAt) return { state: "cancelled", note: "cancelled: acknowledged" };
  if (call.assignedDesignerId !== d.id) return { state: "cancelled", note: "cancelled: reassigned" };

  if (job.kind === "sla") {
    const r = await deliver(d.telegramChatId, slaMessage(call, now));
    return r.ok ? { state: "sent", note: "sent" } : { retry: r.error ?? "send failed" };
  }

  // slot
  if (!call.bookedSlot || call.bookingStatus === "cancelled") return { state: "cancelled", note: "cancelled: no active booking" };
  const minutes = Math.round((call.bookedSlot.getTime() - now.getTime()) / 60_000);
  if (minutes < 0) return { state: "cancelled", note: "cancelled: slot already started" };
  const r = await deliver(d.telegramChatId, slotMessage(call, Math.max(minutes, 0), now));
  if (!r.ok) return { retry: r.error ?? "send failed" };
  for (const f of founders(d.id)) await deliver(f.telegramChatId, slotMessage(call, Math.max(minutes, 0), now, d.name));
  return { state: "sent", note: "sent: designer and founder" };
}

let running = false;

/**
 * Send every job that is due. Called once a minute by the scheduler, and once at startup so
 * reminders that fell due while the server was down go out straight away.
 */
export async function runDueJobs(now: Date = new Date()): Promise<{ sent: number; cancelled: number; retrying: number }> {
  const out = { sent: 0, cancelled: 0, retrying: 0 };
  if (running) return out;
  running = true;
  try {
    const due = db
      .select()
      .from(schema.reminderJobs)
      .where(and(eq(schema.reminderJobs.state, "pending"), lte(schema.reminderJobs.runAt, now)))
      .orderBy(asc(schema.reminderJobs.runAt), asc(schema.reminderJobs.id))
      .all();
    for (const job of due) {
      let outcome: Outcome;
      try {
        outcome = await execute(job, now);
      } catch (e) {
        outcome = { retry: e instanceof Error ? e.message : String(e) };
      }
      if ("retry" in outcome) {
        const attempts = job.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          db.update(schema.reminderJobs).set({ state: "cancelled", attempts, note: `failed: ${outcome.retry}` }).where(eq(schema.reminderJobs.id, job.id)).run();
          audit("reminder.failed", { jobId: job.id, error: outcome.retry }, job.callId);
          out.cancelled++;
        } else {
          db.update(schema.reminderJobs).set({ attempts, note: `retrying: ${outcome.retry}` }).where(eq(schema.reminderJobs.id, job.id)).run();
          out.retrying++;
        }
      } else {
        db.update(schema.reminderJobs).set({ state: outcome.state, note: outcome.note, sentAt: outcome.state === "sent" ? now : null }).where(eq(schema.reminderJobs.id, job.id)).run();
        out[outcome.state === "sent" ? "sent" : "cancelled"]++;
      }
    }
  } finally {
    running = false;
  }
  return out;
}

/** Wire the engine to the pipeline's events. Called once per process (see runtime.ts). */
export function registerReminderHandlers() {
  on("call.processed", ({ callId }) => scheduleForCall(callId));
  on("call.acknowledged", ({ callId }) => cancelJobs({ callId }, "acknowledged"));
  on("call.reassigned", ({ callId }) => scheduleForCall(callId));
  on("settings.changed", () => void rescheduleAll());
  on("booking.changed", async ({ callId, kind }) => {
    scheduleForCall(callId);
    if (kind === "booked") return; // a first booking is not news; the slot alert is already queued
    const call = getCall(callId);
    const d = designer(call?.assignedDesignerId ?? null);
    if (!call || !d) return;
    await deliver(d.telegramChatId, bookingChangedMessage(call, kind, new Date()));
  });
}
