import { sql } from "drizzle-orm";
import { db, runMigrations, schema } from "@/db";
import { getSettings } from "@/lib/settings";
import { MockHubSpot, setHubSpot } from "@/lib/hubspot";
import { setAutoPush } from "@/lib/hubspot/sync";
import samples from "@/seed/sample-calls.json";

let migrated = false;

/** Fresh in-memory state: migrations applied, default settings, 4 rotation designers + the studio head. */
export function resetDb() {
  if (!migrated) {
    runMigrations();
    migrated = true;
  }
  for (const t of ["audit_log", "telegram_link_codes", "reminder_jobs", "status_overrides", "calls_cost", "hubspot_sync", "app_state", "bookings", "calls", "designers", "settings"]) {
    db.run(sql.raw(`DELETE FROM ${t}`));
  }
  db.run(sql.raw(`DELETE FROM sqlite_sequence`));
  // A fresh in-memory HubSpot per test. Pushes happen only when a test calls syncDirty()/syncCall().
  setAutoPush(false);
  setHubSpot(new MockHubSpot());
  getSettings();
  db.insert(schema.designers)
    .values([
      { name: "Aryan", rrOrder: 1, calcomUser: "aryan@aangan.test" },
      { name: "Meera", rrOrder: 2, calcomUser: "meera@aangan.test" },
      { name: "Rohan", rrOrder: 3 },
      { name: "Kavya", rrOrder: 4 },
      { name: "Nikhil", rrOrder: 99, isEscalation: true },
    ])
    .run();
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
