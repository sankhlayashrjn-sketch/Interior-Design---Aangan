import { and, asc, eq, inArray, isNull, lte, ne, notExists, sql } from "drizzle-orm";
import { db, one, schema, withLease } from "@/db";
import { audit } from "@/lib/audit";
import { on } from "@/lib/hooks";
import { eligibleDesigners, suggestDesignerFor } from "@/lib/assignment";
import { assignDigestMessage, assignedMessage, assignReminderMessage, bookingChangedMessage, digestMessage, slaMessage, slotMessage } from "@/lib/reminder-messages";
import { env } from "@/lib/env";
import { getSettings, hoursConfig } from "@/lib/settings";
import { sendTelegram, type OutMessage } from "@/lib/telegram";
import { addWorkingMinutes, isWorkingTime, planReminder } from "@/lib/working-hours";

type Call = typeof schema.calls.$inferSelect;
type Job = typeof schema.reminderJobs.$inferSelect;
type Kind = Job["kind"];

const MAX_ATTEMPTS = 5;
/** Written by the seed script on reminder jobs it switches off. */
export const SEED_NOTE = "cancelled: seed data";
const getCall = (id: number) => one(db.select().from(schema.calls).where(eq(schema.calls.id, id)));
const designer = async (id: number | null) => (id ? one(db.select().from(schema.designers).where(eq(schema.designers.id, id))) : undefined);
const isProcessed = (c: Call) => c.status !== "yet_to_be_processed";
/** Calls the front desk has to place: scored as worth a designer's time, and nobody has them yet. */
const needsAssigning = (c: Call) => !c.assignedDesignerId && (c.status === "qualified" || c.status === "needs_attention");

/** Active front desk officers: the people who assign calls. */
const frontDesk = async () => db.select().from(schema.designers).where(and(eq(schema.designers.active, true), eq(schema.designers.role, "front_desk")));

/** Calls that are waiting for this designer to acknowledge. */
export async function pendingFor(designerId: number): Promise<Call[]> {
  return db
    .select()
    .from(schema.calls)
    .where(and(eq(schema.calls.assignedDesignerId, designerId), isNull(schema.calls.acknowledgedAt), ne(schema.calls.status, "yet_to_be_processed")))
    .orderBy(asc(schema.calls.startedAt));
}

export async function cancelJobs(where: { callId?: number; kinds?: Kind[] }, note: string): Promise<void> {
  const conds = [eq(schema.reminderJobs.state, "pending")];
  if (where.callId !== undefined) conds.push(eq(schema.reminderJobs.callId, where.callId));
  if (where.kinds) conds.push(inArray(schema.reminderJobs.kind, where.kinds));
  await db
    .update(schema.reminderJobs)
    .set({ state: "cancelled", note: `cancelled: ${note}` })
    .where(and(...conds));
}

async function addJob(job: { kind: Kind; callId: number | null; designerId: number | null; runAt: Date }, now: Date): Promise<void> {
  await db.insert(schema.reminderJobs).values({ ...job, state: "pending", createdAt: now });
}

/** Queue a once-per-morning digest for one person, shared by every call that landed overnight. */
async function addDigest(designerId: number, runAt: Date, now: Date) {
  const existing = await one(
    db.select().from(schema.reminderJobs).where(and(eq(schema.reminderJobs.kind, "digest"), eq(schema.reminderJobs.designerId, designerId), eq(schema.reminderJobs.runAt, runAt))).limit(1),
  );
  if (!existing) await addJob({ kind: "digest", callId: null, designerId, runAt }, now);
}

const alreadySent = (callId: number, kind: Kind, designerId: number) =>
  one(db.select().from(schema.reminderJobs).where(and(eq(schema.reminderJobs.callId, callId), eq(schema.reminderJobs.kind, kind), eq(schema.reminderJobs.designerId, designerId), eq(schema.reminderJobs.state, "sent"))).limit(1));

/**
 * (Re)create the reminders for one call from its current state. Two stages:
 *  1. Nobody has it: the front desk is reminded to assign it (digest at 09:00 if it came in after hours), and if
 *     it is still unassigned after the grace period the app assigns it by workload.
 *  2. A designer has it: they are reminded to acknowledge, counted from the moment it was assigned.
 * Safe to call any number of times. A reminder that was already sent is never sent again.
 */
export async function scheduleForCall(callId: number, now: Date = new Date()): Promise<void> {
  const call = await getCall(callId);
  if (!call) return;
  // Demo data from the seed script is never reminded about, even when the schedule is recomputed.
  const seeded = await one(db.select().from(schema.reminderJobs).where(and(eq(schema.reminderJobs.callId, callId), eq(schema.reminderJobs.note, SEED_NOTE))).limit(1));
  if (seeded) return;
  await cancelJobs({ callId, kinds: ["sla", "slot", "assign", "autoassign"] }, "rescheduled");

  if (!isProcessed(call) || call.acknowledgedAt) return;
  const s = await getSettings();
  const cfg = hoursConfig(s);
  const afterHours = !isWorkingTime(call.startedAt, cfg);

  if (call.assignedDesignerId) {
    const plan = planReminder(call.assignedAt ?? call.startedAt, s.slaMinutes, cfg);
    await db.update(schema.calls).set({ dueAt: plan.dueAt, afterHours }).where(eq(schema.calls.id, callId));
    if (plan.kind === "sla") {
      if (!(await alreadySent(callId, "sla", call.assignedDesignerId))) await addJob({ kind: "sla", callId, designerId: call.assignedDesignerId, runAt: plan.runAt }, now);
    } else {
      await addDigest(call.assignedDesignerId, plan.runAt, now);
    }
    await queueSlot(call, [call.assignedDesignerId], s.slotAlertMinutes, now);
    return;
  }

  if (!needsAssigning(call)) return; // disqualified and unassigned: visible, but nobody is chased about it

  const plan = planReminder(call.startedAt, s.assignSlaMinutes, cfg);
  await db.update(schema.calls).set({ assignDueAt: plan.dueAt, afterHours }).where(eq(schema.calls.id, callId));
  const officers = await frontDesk();
  if (plan.kind === "sla") {
    for (const o of officers) if (!(await alreadySent(callId, "assign", o.id))) await addJob({ kind: "assign", callId, designerId: o.id, runAt: plan.runAt }, now);
  } else {
    for (const o of officers) await addDigest(o.id, plan.runAt, now);
  }
  if (s.assignmentMode === "manual" && s.autoAssignAfterMinutes > 0) {
    await addJob({ kind: "autoassign", callId, designerId: null, runAt: addWorkingMinutes(plan.dueAt, s.autoAssignAfterMinutes, cfg) }, now);
  }
  await queueSlot(call, officers.map((o) => o.id), s.slotAlertMinutes, now);
}

async function queueSlot(call: Call, recipients: number[], slotAlertMinutes: number, now: Date) {
  if (!call.bookedSlot || call.bookingStatus === "cancelled" || call.bookedSlot.getTime() <= now.getTime()) return;
  const runAt = new Date(Math.max(call.bookedSlot.getTime() - slotAlertMinutes * 60_000, now.getTime()));
  for (const designerId of recipients) await addJob({ kind: "slot", callId: call.id, designerId, runAt }, now);
}

/** Working hours or SLA changed: cancel everything pending and rebuild it for every unacknowledged call. */
export async function rescheduleAll(now: Date = new Date()): Promise<number> {
  await cancelJobs({}, "settings changed");
  const rows = (await db.select().from(schema.calls).where(isNull(schema.calls.acknowledgedAt))).filter(isProcessed);
  for (const c of rows) await scheduleForCall(c.id, now);
  await audit("reminders.rescheduled", { calls: rows.length });
  return rows.length;
}

/** Give a pending-reminder row to any processed, unacknowledged call that has none at all (for example calls created before this engine existed). */
export async function reconcileReminders(now: Date = new Date()): Promise<number> {
  const hasJobs = db.select({ one: sql`1` }).from(schema.reminderJobs).where(eq(schema.reminderJobs.callId, schema.calls.id));
  const rows = (await db.select().from(schema.calls).where(and(isNull(schema.calls.acknowledgedAt), notExists(hasJobs)))).filter(isProcessed);
  for (const c of rows) await scheduleForCall(c.id, now);
  return rows.length;
}

/** The founder(s): anyone marked as escalation contact. They get a copy of urgent slot alerts. */
async function founders(excludeId: number | null) {
  return (await db.select().from(schema.designers).where(eq(schema.designers.isEscalation, true))).filter((d) => d.id !== excludeId);
}

type Recipient = { id: number; name: string; role: string; telegramChatId: string | null };

/**
 * Send a message to a person. With TELEGRAM_REDIRECT_CHAT_ID set (one-phone testing) it goes to that chat instead,
 * says who it is really for, and its buttons carry that person's id so a tap acts as them.
 */
async function deliver(to: Recipient, msg: OutMessage) {
  const redirect = env.TELEGRAM_REDIRECT_CHAT_ID;
  if (!redirect) return sendTelegram(to.telegramChatId, msg);
  const label = `To: ${to.name} (${to.role === "front_desk" ? "front desk" : "designer"})`;
  const rows = msg.rows?.map((row) => row.map((b) => (b.callbackData ? { ...b, callbackData: `${b.callbackData}:u${to.id}` } : b)));
  return sendTelegram(redirect, { text: `${label}

${msg.text}`, rows });
}

type Outcome = { state: "sent" | "cancelled"; note: string } | { retry: string };

async function execute(job: Job, now: Date): Promise<Outcome> {
  if (job.kind === "autoassign") return executeAutoAssign(job, now);

  const d = await designer(job.designerId);
  if (!d || !d.active) return { state: "cancelled", note: "cancelled: recipient not found" };

  if (job.kind === "digest") {
    if (d.role === "front_desk") {
      const waiting = (await db.select().from(schema.calls).where(isNull(schema.calls.assignedDesignerId)).orderBy(asc(schema.calls.startedAt))).filter(needsAssigning);
      if (waiting.length === 0) return { state: "cancelled", note: "cancelled: nothing to assign" };
      const r = await deliver(d, assignDigestMessage(waiting, now));
      return r.ok ? { state: "sent", note: `sent: digest of ${waiting.length}` } : { retry: r.error ?? "send failed" };
    }
    const calls = await pendingFor(d.id);
    if (calls.length === 0) return { state: "cancelled", note: "cancelled: nothing pending" };
    const r = await deliver(d, digestMessage(calls, now));
    return r.ok ? { state: "sent", note: `sent: digest of ${calls.length}` } : { retry: r.error ?? "send failed" };
  }

  const call = job.callId ? await getCall(job.callId) : undefined;
  if (!call) return { state: "cancelled", note: "cancelled: call not found" };
  if (call.acknowledgedAt) return { state: "cancelled", note: "cancelled: acknowledged" };
  const forFrontDesk = d.role === "front_desk";
  if (forFrontDesk && !needsAssigning(call)) return { state: "cancelled", note: "cancelled: already assigned" };
  if (!forFrontDesk && call.assignedDesignerId !== d.id) return { state: "cancelled", note: "cancelled: reassigned" };

  if (job.kind === "assign") {
    const r = await deliver(d, assignReminderMessage(call, (await eligibleDesigners()).map((x) => ({ id: x.id, name: x.name })), now));
    return r.ok ? { state: "sent", note: "sent" } : { retry: r.error ?? "send failed" };
  }

  if (job.kind === "sla") {
    const r = await deliver(d, slaMessage(call, now));
    return r.ok ? { state: "sent", note: "sent" } : { retry: r.error ?? "send failed" };
  }

  // slot
  if (!call.bookedSlot || call.bookingStatus === "cancelled") return { state: "cancelled", note: "cancelled: no active booking" };
  const minutes = Math.round((call.bookedSlot.getTime() - now.getTime()) / 60_000);
  if (minutes < 0) return { state: "cancelled", note: "cancelled: slot already started" };
  const r = await deliver(d, slotMessage(call, Math.max(minutes, 0), now));
  if (!r.ok) return { retry: r.error ?? "send failed" };
  for (const f of await founders(d.id)) await deliver(f, slotMessage(call, Math.max(minutes, 0), now, d.name));
  return { state: "sent", note: "sent: recipient and founder" };
}

/** Nobody assigned the call in time: the app gives it to the designer the default rule suggests. A person's earlier decision always wins. */
async function executeAutoAssign(job: Job, now: Date): Promise<Outcome> {
  const call = job.callId ? await getCall(job.callId) : undefined;
  if (!call) return { state: "cancelled", note: "cancelled: call not found" };
  if (!needsAssigning(call)) return { state: "cancelled", note: "cancelled: already assigned" };
  const pick = await suggestDesignerFor(call);
  if (!pick) return { retry: "no designer available" };
  const { assignCall } = await import("@/lib/calls"); // loaded on demand: calls.ts pulls in this module through runtime.ts
  await assignCall(call.id, pick, { id: null, how: "auto" }, now, { onlyIfUnassigned: true });
  return { state: "sent", note: "sent: auto-assigned" };
}

/**
 * Send every job that is due. Called once a minute by the scheduler (or Vercel Cron), and once at startup so
 * reminders that fell due while the server was down go out straight away.
 * A lease makes sure only one server runs this at a time, so a reminder is never sent twice.
 */
export async function runDueJobs(now: Date = new Date()): Promise<{ sent: number; cancelled: number; retrying: number }> {
  const out = { sent: 0, cancelled: 0, retrying: 0 };
  await withLease("reminders", 120_000, async () => {
    const due = await db
      .select()
      .from(schema.reminderJobs)
      .where(and(eq(schema.reminderJobs.state, "pending"), lte(schema.reminderJobs.runAt, now)))
      .orderBy(asc(schema.reminderJobs.runAt), asc(schema.reminderJobs.id));
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
          await db.update(schema.reminderJobs).set({ state: "cancelled", attempts, note: `failed: ${outcome.retry}` }).where(eq(schema.reminderJobs.id, job.id));
          await audit("reminder.failed", { jobId: job.id, error: outcome.retry }, job.callId);
          out.cancelled++;
        } else {
          await db.update(schema.reminderJobs).set({ attempts, note: `retrying: ${outcome.retry}` }).where(eq(schema.reminderJobs.id, job.id));
          out.retrying++;
        }
      } else {
        await db.update(schema.reminderJobs).set({ state: outcome.state, note: outcome.note, sentAt: outcome.state === "sent" ? now : null }).where(eq(schema.reminderJobs.id, job.id));
        out[outcome.state === "sent" ? "sent" : "cancelled"]++;
      }
    }
  });
  return out;
}

/** Wire the engine to the pipeline's events. Called once per process (see runtime.ts). */
export function registerReminderHandlers() {
  on("call.processed", ({ callId }) => scheduleForCall(callId));
  on("call.acknowledged", ({ callId }) => cancelJobs({ callId }, "acknowledged"));
  on("call.overridden", ({ callId }) => scheduleForCall(callId));
  on("call.assigned", async ({ callId }) => {
    await scheduleForCall(callId);
    const call = await getCall(callId);
    const d = await designer(call?.assignedDesignerId ?? null);
    if (!call || !d || call.acknowledgedAt) return;
    const by = await designer(call.assignedBy);
    await deliver(d, assignedMessage(call, new Date(), by?.name ?? null));
  });
  on("settings.changed", async () => void (await rescheduleAll()));
  on("booking.changed", async ({ callId, kind }) => {
    await scheduleForCall(callId);
    if (kind === "booked") return; // a first booking is not news; the slot alert is already queued
    const call = await getCall(callId);
    if (!call) return;
    const recipients = call.assignedDesignerId ? [await designer(call.assignedDesignerId)] : needsAssigning(call) ? await frontDesk() : [];
    for (const d of recipients) if (d) await deliver(d, bookingChangedMessage(call, kind, new Date()));
  });
}
