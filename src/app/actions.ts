"use server";

import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { acknowledgeCall, overrideStatus, UserError, activeDesigners } from "@/lib/calls";
import { ingestCall } from "@/lib/ingest";
import { DESIGNER_COOKIE, currentDesigner } from "@/lib/session";
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
  if (activeDesigners().some((d) => d.id === id)) await setDesigner(id);
  const next = String(formData.get("next") ?? "/");
  redirect(next.startsWith("/") ? next : "/");
}

/** Switch to a designer and jump to a call (used after a simulated call). */
export async function openAs(formData: FormData) {
  const id = Number(formData.get("designerId"));
  const callId = Number(formData.get("callId"));
  if (activeDesigners().some((d) => d.id === id)) await setDesigner(id);
  redirect(`/?tab=pending&call=${callId}`);
}

export async function acknowledgeAction(formData: FormData) {
  const me = await currentDesigner();
  const callId = Number(formData.get("callId"));
  if (!me || !callId) return;
  try {
    await acknowledgeCall(callId, me.id);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
  }
  revalidatePath("/");
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
  revalidatePath("/");
  return { ok: "Status changed and logged" };
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
    const designer = activeDesigners().find((d) => d.id === call.assignedDesignerId);
    revalidatePath("/");
    return {
      result: { id: call.id, status: call.status, score: call.score, reason: call.reason, designerId: call.assignedDesignerId, designerName: designer?.name ?? null, afterHours: call.afterHours, duplicate: outcome === "duplicate" },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not process the call" };
  }
}
