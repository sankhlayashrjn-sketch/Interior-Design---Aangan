import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { db, runMigrations, schema } from "@/db";
import { setAutoPush } from "@/lib/hubspot/sync";
import { ingestCall } from "@/lib/ingest";
import { SEED_NOTE } from "@/lib/reminders";
import { getSettings } from "@/lib/settings";
import { IST } from "@/lib/working-hours";
import samples from "@/seed/sample-calls.json";

// Demo data must never reach real systems.
const live = ["AI_MODE", "HUBSPOT_MODE", "TELEGRAM_MODE", "CALCOM_MODE"].filter((k) => process.env[k] === "live");
if (live.length && !process.argv.includes("--force")) {
  console.error(`Refusing to seed demo calls while ${live.join(", ")} is live (it would call real services with fake data). Set them to mock, or pass --force.`);
  process.exit(1);
}
setAutoPush(false); // the HubSpot sync cycle picks the seeded calls up later

async function seedDesigners() {
  await runMigrations();
  await getSettings(); // creates the default settings row

  if ((await db.select().from(schema.designers)).length === 0) {
    await db.insert(schema.designers).values([
      { name: "Aryan Kulkarni", rrOrder: 1, calcomUser: "aryan@example.com" },
      { name: "Meera Iyer", rrOrder: 2, calcomUser: "meera@example.com" },
      { name: "Rohan Bhide", rrOrder: 3, calcomUser: "rohan@example.com" },
      { name: "Kavya Menon", rrOrder: 4, calcomUser: "kavya@example.com" },
      // Studio head. Receives complaints / escalations, not in round-robin.
      { name: "Nikhil Deshpande", rrOrder: 99, isEscalation: true, calcomUser: "nikhil@example.com" },
    ]);
    console.log("Seeded 5 designers (set Telegram chat IDs, HubSpot owner IDs and Cal.com users in Settings).");
  } else {
    console.log("Designers already present, skipping.");
  }
}

/**
 * Sample calls come from the real September transcripts. Dates are moved to the last few days so the
 * dashboard shows a live mix (acknowledged, pending, overdue, after-hours), keeping each call's time of day.
 * Phone numbers are invented: the transcripts are anonymised. T13 has caller ID withheld, to show the
 * "No way to reach caller" rule. T01, T06 and T11 have a booked slot.
 */
const SEED = samples.filter((s) => s.seed);
const DAYS_AGO = [4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 1, 1, 1, 0, 0];
const now = DateTime.now().setZone(IST);
const phoneFor = (id: string) => `+9198${String(76000000 + Number(id.replace(/\D/g, "")) * 3571).padStart(8, "0")}`;
const BOOKED: Record<string, { days: number; time: string }> = { T01: { days: 1, time: "11:00" }, T06: { days: 3, time: "15:00" }, T11: { days: 3, time: "10:30" } };

async function main() {
await seedDesigners();
let created = 0;
for (let i = 0; i < SEED.length; i++) {
  const s = SEED[i];
  const [h, m] = s.time.split(":").map(Number);
  let when = now.minus({ days: DAYS_AGO[i] ?? 0 }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (when > now) when = when.minus({ days: 1 });

  let booked_slot: string | null = null;
  const b = BOOKED[s.id];
  if (b) {
    const [bh, bm] = b.time.split(":").map(Number);
    booked_slot = now.plus({ days: b.days }).set({ hour: bh, minute: bm, second: 0, millisecond: 0 }).toISO();
  }

  const { outcome, call } = await ingestCall({
    external_id: `seed-${s.id}`,
    caller_phone: s.id === "T13" ? null : phoneFor(s.id),
    started_at: when.toISO(),
    duration_sec: s.durationSec,
    transcript: s.transcript,
    booking_id: b ? `seed-booking-${s.id}` : null,
    booked_slot,
  });
  if (outcome === "created") created++;

  // Older qualified calls were already picked up by their designer.
  if ((DAYS_AGO[i] ?? 0) >= 2 && call.status === "qualified" && !call.acknowledgedAt && call.assignedDesignerId) {
    await db
      .update(schema.calls)
      .set({ acknowledgedAt: new Date(when.toMillis() + 25 * 60_000), acknowledgedBy: call.assignedDesignerId })
      .where(eq(schema.calls.id, call.id));
  }
}

// Demo calls are old: do not let them fire reminders (or, with TELEGRAM_MODE=live, message real people).
await db.update(schema.reminderJobs).set({ state: "cancelled", note: SEED_NOTE }).where(eq(schema.reminderJobs.state, "pending"));

const all = await db.select().from(schema.calls);
const by = (st: string) => all.filter((c) => c.status === st).length;
console.log(`Seeded ${created} sample calls (${all.length} total): ${by("qualified")} qualified, ${by("needs_attention")} needs attention, ${by("disqualified")} disqualified.`);
}

main()
  .then(() => process.exit(0)) // the database connection would otherwise keep the process alive
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
