"use server";

import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { acknowledgeCall, addNote, assignCall, overrideStatus, UserError, activeDesigners } from "@/lib/calls";
import { db, one, schema } from "@/db";
import { eq } from "drizzle-orm";
import { ingestCall } from "@/lib/ingest";
import { DESIGNER_COOKIE, currentDesigner, currentPerson } from "@/lib/session";
import { IST } from "@/lib/working-hours";

export interface ActionState {
  error?: string;
  ok?: string;
}

export interface SimulateState extends ActionState {
  result?: { id: number; status: string; score: number | null; reason: string | null; designerId: number | null; designerName: string | null; afterHours: boolean; duplicate: boolean };
}

async function setDesigner(id: number) {
  (await cookies()).set(DESIGNER_COOKIE, String(id), { path: "/", httpOnly: true, sameSite: "lax" });
}

/** Demo auth: pick who you are. */
export async function selectDesigner(formData: FormData) {
  const id = Number(formData.get("designerId"));
  if ((await activeDesigners()).some((d) => d.id === id)) await setDesigner(id);
  const next = String(formData.get("next") ?? "/");
  redirect(next.startsWith("/") ? next : "/");
}

/** Switch to a designer and jump to a call (used after a simulated call). */
export async function openAs(formData: FormData) {
  const id = Number(formData.get("designerId"));
  const callId = Number(formData.get("callId"));
  if ((await activeDesigners()).some((d) => d.id === id)) await setDesigner(id);
  redirect(`/call/${callId}`);
}

/**
 * Acknowledge a call. It is always recorded for the designer the call is assigned to: the dashboard has no
 * per-person login, so "who is viewing" is only a convenience and must not decide who is accountable.
 */
export async function acknowledgeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const callId = Number(formData.get("callId"));
  if (!callId) return { error: "Call not found" };
  const call = await one(db.select().from(schema.calls).where(eq(schema.calls.id, callId)));
  if (!call) return { error: "Call not found" };
  if (!call.assignedDesignerId) return { error: "Assign this call to a designer first" };
  try {
    await acknowledgeCall(callId, call.assignedDesignerId);
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    throw e;
  }
  revalidatePath("/", "layout");
  return { ok: "Acknowledged" };
}

/** The front desk gives a call to a designer, or moves it to another designer before it is acknowledged. */
export async function assignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await currentPerson("front_desk");
  if (!me) return { error: "Add a front desk officer in Settings first" };
  const designerId = Number(formData.get("designerId"));
  if (!designerId) return { error: "Choose a designer" };
  try {
    const call = await assignCall(Number(formData.get("callId")), designerId, { id: me.id, how: "front_desk" });
    const to = (await activeDesigners()).find((d) => d.id === call.assignedDesignerId);
    revalidatePath("/", "layout");
    return { ok: `Assigned to ${to?.name ?? "the designer"}` };
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    throw e;
  }
}

export async function overrideAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await currentDesigner();
  if (!me) return { error: "Choose a designer first" };
  try {
    await overrideStatus(Number(formData.get("callId")), me.id, String(formData.get("status") ?? ""), String(formData.get("reason") ?? ""));
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    throw e;
  }
  revalidatePath("/", "layout");
  return { ok: "Status changed and logged" };
}

export async function addNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const me = await currentDesigner();
  if (!me) return { error: "Choose a designer first" };
  try {
    await addNote(Number(formData.get("callId")), me.id, String(formData.get("body") ?? ""));
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    throw e;
  }
  revalidatePath("/", "layout");
  return { ok: "Note saved" };
}

/** Same pipeline as POST /api/calls: builds the payload a voice provider would send and runs ingestCall. */
export async function simulateAction(_prev: SimulateState, formData: FormData): Promise<SimulateState> {
  const transcript = String(formData.get("transcript") ?? "");
  const when = DateTime.fromISO(String(formData.get("startedAt") ?? ""), { zone: IST });
  if (!when.isValid) return { error: "Choose a date and time for the call" };
  const slotRaw = String(formData.get("bookedSlot") ?? "").trim();
  const slot = slotRaw ? DateTime.fromISO(slotRaw, { zone: IST }) : null;
  if (slot && !slot.isValid) return { error: "The booked slot is not a valid date and time" };

  const withheld = formData.get("withheld") === "on";
  const phone = withheld ? null : String(formData.get("phone") ?? "").trim() || null;
  const duration = Math.max(0, Math.round(Number(formData.get("duration")) || 0));

  try {
    const { outcome, call } = await ingestCall({
      external_id: String(formData.get("externalId") || `sim-${randomUUID()}`),
      caller_phone: phone,
      started_at: when.toISO(),
      duration_sec: duration,
      transcript,
      booking_id: null,
      booked_slot: slot ? slot.toISO() : null,
    });
    const designer = (await activeDesigners()).find((d) => d.id === call.assignedDesignerId);
    revalidatePath("/", "layout");
    return {
      result: { id: call.id, status: call.status, score: call.score, reason: call.reason, designerId: call.assignedDesignerId, designerName: designer?.name ?? null, afterHours: call.afterHours, duplicate: outcome === "duplicate" },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not process the call" };
  }
}
