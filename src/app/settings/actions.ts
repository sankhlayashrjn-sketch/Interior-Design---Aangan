"use server";

import "@/lib/runtime"; // makes sure settings.changed reaches the reminder engine in this bundle
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { UserError } from "@/lib/calls";
import { addDesigner, telegramLinkFor, updateDesigner, type DesignerInput } from "@/lib/designers";
import { getSettings, saveSettings } from "@/lib/settings";

export interface FormState {
  error?: string;
  ok?: string;
  link?: { url: string; note: string };
}

const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const toNumber = (f: FormData, k: string) => (text(f, k).trim() === "" ? NaN : Number(text(f, k)));

function message(e: unknown): string {
  if (e instanceof UserError) return e.message;
  if (e instanceof ZodError) {
    const i = e.issues[0];
    return `${String(i.path[0] ?? "Value")}: ${i.message}`;
  }
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

export async function saveSettingsAction(_prev: FormState, f: FormData): Promise<FormState> {
  const holidays = text(f, "holidays")
    .split(/[\s,]+/)
    .filter(Boolean);
  const before = await getSettings();
  try {
    const after = await saveSettings({
      workStart: text(f, "workStart"),
      workEnd: text(f, "workEnd"),
      workDays: f.getAll("workDays").map(Number),
      holidays,
      slaMinutes: toNumber(f, "slaMinutes"),
      assignSlaMinutes: toNumber(f, "assignSlaMinutes"),
      autoAssignAfterMinutes: toNumber(f, "autoAssignAfterMinutes"),
      assignmentMode: text(f, "assignmentMode") || undefined,
      slotAlertMinutes: toNumber(f, "slotAlertMinutes"),
      aiModel: text(f, "aiModel"),
    });
    revalidatePath("/settings");
    const rescheduled = (["workStart", "workEnd", "workDays", "holidays", "slaMinutes", "slotAlertMinutes", "assignSlaMinutes", "autoAssignAfterMinutes", "assignmentMode"] as const).some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    return { ok: rescheduled ? "Saved. Pending reminders were recomputed for the new hours." : "Saved." };
  } catch (e) {
    return { error: message(e) };
  }
}

function designerFrom(f: FormData): DesignerInput {
  return {
    name: text(f, "name"),
    telegramChatId: text(f, "telegramChatId"),
    hubspotOwnerId: text(f, "hubspotOwnerId"),
    calcomUser: text(f, "calcomUser"),
    active: f.get("active") === "on",
    isEscalation: f.get("isEscalation") === "on",
    role: text(f, "role") === "front_desk" ? "front_desk" : "designer",
  };
}

export async function saveDesignerAction(_prev: FormState, f: FormData): Promise<FormState> {
  try {
    await updateDesigner(Number(f.get("id")), designerFrom(f));
    revalidatePath("/settings");
    return { ok: "Saved" };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function addDesignerAction(_prev: FormState, f: FormData): Promise<FormState> {
  try {
    await addDesigner({ ...designerFrom(f), active: true, isEscalation: false });
    revalidatePath("/settings");
    return { ok: "Added" };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function telegramLinkAction(_prev: FormState, f: FormData): Promise<FormState> {
  try {
    const { url, note } = await telegramLinkFor(Number(f.get("id")));
    return { link: { url, note } };
  } catch (e) {
    return { error: message(e) };
  }
}
