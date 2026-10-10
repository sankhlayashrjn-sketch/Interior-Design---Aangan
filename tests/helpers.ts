import { eq, sql } from "drizzle-orm";
import { db, one, runMigrations, schema } from "@/db";
import { MockHubSpot, setHubSpot } from "@/lib/hubspot";
import { setAutoPush } from "@/lib/hubspot/sync";
import { getSettings } from "@/lib/settings";
import samples from "@/seed/sample-calls.json";

let migrated: Promise<void> | null = null;

/** Fresh in-memory state: migrations applied, default settings, 4 rotation designers + the studio head. */
export async function resetDb() {
  migrated ??= runMigrations();
  await migrated;
  // One statement empties every table and restarts the id counters, so tests never see each other's rows.
  await db.execute(
    sql.raw(
      "TRUNCATE audit_log, telegram_link_codes, reminder_jobs, status_overrides, calls_cost, hubspot_sync, app_state, bookings, calls, designers, settings RESTART IDENTITY CASCADE",
    ),
  );
  // A fresh in-memory HubSpot per test. Pushes happen only when a test calls syncDirty()/syncCall().
  setAutoPush(false);
  setHubSpot(new MockHubSpot());
  await getSettings();
  // Most tests exercise the pipeline end to end, so calls are assigned on arrival. Tests of the front desk flow switch to manual.
  await db.update(schema.settings).set({ assignmentMode: "auto" });
  await db.insert(schema.designers).values([
    { name: "Aryan", rrOrder: 1, calcomUser: "aryan@aangan.test" },
    { name: "Meera", rrOrder: 2, calcomUser: "meera@aangan.test" },
    { name: "Rohan", rrOrder: 3 },
    { name: "Kavya", rrOrder: 4 },
    { name: "Nikhil", rrOrder: 99, isEscalation: true },
  ]);
}

export const sample = (id: string) => samples.find((s) => s.id === id)!;

/** IST wall clock -> ISO string. */
export const istIso = (s: string) => new Date(`${s.replace(" ", "T")}:00+05:30`).toISOString();

let n = 0;
export function payloadFor(id: string, over: Record<string, unknown> = {}) {
  const s = sample(id);
  return {
    external_id: `t-${id}-${++n}`,
    caller_phone: "+919800000000",
    started_at: istIso("2026-10-07 11:00"),
    duration_sec: s.durationSec,
    transcript: s.transcript,
    ...over,
  };
}

/** Small readers so tests can check what is stored. */
export const callById = async (id: number) => (await one(db.select().from(schema.calls).where(eq(schema.calls.id, id))))!;
export const designerById = async (id: number) => (await one(db.select().from(schema.designers).where(eq(schema.designers.id, id))))!;
export const allCalls = () => db.select().from(schema.calls);
