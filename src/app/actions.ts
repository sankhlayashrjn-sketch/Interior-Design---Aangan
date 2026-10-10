"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { acknowledgeCall, addNote, assignCall, overrideStatus, UserError, activeDesigners } from "@/lib/calls";
import { db, one, schema } from "@/db";
import { eq } from "drizzle-orm";
import { refreshTranscript } from "@/lib/voice/transcript";
import { DESIGNER_COOKIE, currentDesigner, currentPerson } from "@/lib/session";

export interface ActionState {
  error?: string;
  ok?: string;
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


/** Fetch a call's transcript from Vaani again (for when it did not arrive with the call, or arrived incomplete). */
export async function refreshTranscriptAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const callId = Number(formData.get("callId"));
  if (!callId) return { error: "Call not found" };
  const r = await refreshTranscript(callId);
  if (r.ok) revalidatePath("/", "layout");
  return r.ok ? { ok: r.message } : { error: r.message };
}
