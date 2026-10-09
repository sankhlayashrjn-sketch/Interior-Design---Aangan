import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { emit } from "@/lib/hooks";
import type { WorkingHoursConfig } from "@/lib/working-hours";
import { IST } from "@/lib/working-hours";

export type Settings = typeof schema.settings.$inferSelect;

/** Returns the single settings row, creating it with defaults if missing. */
export function getSettings(): Settings {
  const row = db.select().from(schema.settings).where(eq(schema.settings.id, 1)).get();
  if (row) return row;
  db.insert(schema.settings).values({ id: 1, aiModel: env.ANTHROPIC_MODEL }).run();
  return db.select().from(schema.settings).where(eq(schema.settings.id, 1)).get()!;
}

export function hoursConfig(s: Settings = getSettings()): WorkingHoursConfig {
  return {
    workStart: s.workStart,
    workEnd: s.workEnd,
    workDays: s.workDays,
    holidays: s.holidays,
    timezone: IST,
  };
}

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24-hour");

export const SettingsPatchSchema = z
  .object({
    workStart: hm,
    workEnd: hm,
    workDays: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one working day"),
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")),
    slaMinutes: z.number().int().min(1).max(1440),
    slotAlertMinutes: z.number().int().min(0).max(1440),
    aiModel: z.string().trim().min(1),
    minCommercialSqft: z.number().int().min(0),
    maxCommercialSqft: z.number().int().min(0),
    minLeadWeeks: z.number().int().min(0).max(52),
  })
  .partial();

const SCHEDULE_KEYS = ["workStart", "workEnd", "workDays", "holidays", "slaMinutes", "slotAlertMinutes"] as const;

/**
 * Validate and save settings. If anything that affects reminders changed, emit settings.changed so
 * every pending reminder is recomputed against the new hours.
 */
export async function saveSettings(patch: unknown): Promise<Settings> {
  const p = SettingsPatchSchema.parse(patch);
  const before = getSettings();
  const next = { ...before, ...p };
  if (next.workStart >= next.workEnd) throw new Error("Working hours must start before they end");
  if (next.minCommercialSqft > next.maxCommercialSqft) throw new Error("Minimum commercial size cannot exceed the maximum");
  db.update(schema.settings).set(p).where(eq(schema.settings.id, 1)).run();
  const after = getSettings();
  if (SCHEDULE_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) await emit("settings.changed", {});
  return after;
}
