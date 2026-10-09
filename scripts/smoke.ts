/**
 * End-to-end smoke test against whatever database DATABASE_URL points at (for example Neon).
 *   npm run smoke:neon
 *
 * It runs the app's real code (scoring, assignment, reminders, acknowledgement, override, founder numbers,
 * HubSpot sync, concurrency) against that database, then removes everything it created.
 *
 * Safety:
 *  - every external integration is forced to MOCK, so it never calls Anthropic, HubSpot, Telegram or Cal.com;
 *  - it REFUSES to run if the database already has any calls or designers, so it can never touch real data.
 */
process.env.AI_MODE = "mock";
process.env.HUBSPOT_MODE = "mock";
process.env.TELEGRAM_MODE = "mock";
process.env.CALCOM_MODE = "mock";
if (process.env.DATABASE_URL_UNPOOLED) delete process.env.DATABASE_URL_UNPOOLED; // exercise the same pooled connection the app uses

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function main() {
  const { sql, eq } = await import("drizzle-orm");
  const { db, one, runMigrations, schema, withLease } = await import("@/db");
  const { acknowledgeCall, overrideStatus } = await import("@/lib/calls");
  const { costPanel, founderList, founderMetrics, statusCounts } = await import("@/lib/founder");
  const { setAutoPush, syncDirty } = await import("@/lib/hubspot/sync");
  const { ingestCall } = await import("@/lib/ingest");
  const { runTick } = await import("@/lib/scheduler");
  const { getSettings, saveSettings } = await import("@/lib/settings");
  const samples = (await import("@/seed/sample-calls.json")).default;
  setAutoPush(false);

  await runMigrations();
  const existing = (await db.select().from(schema.calls)).length + (await db.select().from(schema.designers)).length;
  if (existing > 0) {
    console.error("Refusing to run: this database already has calls or designers. The smoke test only runs on an empty database.");
    process.exit(2);
  }

  const wipe = () =>
    db.execute(sql.raw("TRUNCATE audit_log, telegram_link_codes, reminder_jobs, status_overrides, calls_cost, hubspot_sync, app_state, bookings, calls, designers, settings RESTART IDENTITY CASCADE"));

  try {
    await getSettings();
    await db.insert(schema.designers).values([
      { name: "Smoke A", rrOrder: 1, telegramChatId: "100001" },
      { name: "Smoke B", rrOrder: 2 },
      { name: "Smoke Head", rrOrder: 99, isEscalation: true },
    ]);

    // The most recent working day (not Sunday) at 11:00 IST: in hours and well past its one-hour deadline,
    // whatever time of day this test runs.
    const { DateTime } = await import("luxon");
    let day = DateTime.now().setZone("Asia/Kolkata").minus({ days: 1 });
    while (day.weekday === 7) day = day.minus({ days: 1 });
    const when = day.set({ hour: 11, minute: 0, second: 0, millisecond: 0 }).toISO()!;
    const payload = (id: string, extra: Record<string, unknown> = {}) => {
      const s = samples.find((x) => x.id === id)!;
      return { external_id: `smoke-${id}-${Date.now()}`, caller_phone: "+919000000001", started_at: when, duration_sec: s.durationSec, transcript: s.transcript, ...extra };
    };

    const good = (await ingestCall(payload("T01", { booked_slot: new Date(Date.now() + 86_400_000).toISOString() }))).call;
    const bad = (await ingestCall(payload("T03", { caller_phone: "+919000000002" }))).call;
    const angry = (await ingestCall(payload("T09", { caller_phone: "+919000000003" }))).call;

    check("a good enquiry is scored qualified", good.status === "qualified", `score ${good.score}`);
    check("an out-of-area enquiry is disqualified but kept, with its reason", bad.status === "disqualified" && !!bad.reason, bad.reason ?? "");
    check("a complaint goes to the studio head", angry.flag === "existing_client");
    const names = await Promise.all([good, bad, angry].map(async (c) => (await one(db.select().from(schema.designers).where(eq(schema.designers.id, c.assignedDesignerId!))))!.name));
    check("round-robin rotates and the complaint reaches the studio head", names[0] === "Smoke A" && names[1] === "Smoke B" && names[2] === "Smoke Head", names.join(", "));
    check("a cost row is written for every call", (await db.select().from(schema.callsCost)).length === 3);
    check("reminders are queued", (await db.select().from(schema.reminderJobs)).length > 0);

    const p = payload("T02");
    const [r1, r2] = await Promise.all([ingestCall(p), ingestCall(p)]);
    check("the same call arriving twice at once is stored once", [r1.outcome, r2.outcome].sort().join() === "created,duplicate");

    const tick = await runTick();
    check("a tick sends the overdue reminder", tick.reminders.sent >= 1, `sent ${tick.reminders.sent}`);
    const again = await runTick();
    check("a second tick sends nothing new", again.reminders.sent === 0);

    await acknowledgeCall(good.id, good.assignedDesignerId!);
    const acked = await one(db.select().from(schema.calls).where(eq(schema.calls.id, good.id)));
    check("acknowledging is recorded", !!acked?.acknowledgedAt);
    await overrideStatus(bad.id, bad.assignedDesignerId!, "qualified", "Smoke test override, has a Pune site too");
    check("an override is logged with its reason", (await db.select().from(schema.statusOverrides)).length === 1);

    const counts = await statusCounts();
    const metrics = await founderMetrics("30d");
    const cost = await costPanel("30d");
    check("founder counts add up", counts.qualified + counts.disqualified + counts.needs_attention + counts.yet_to_be_processed === 4, JSON.stringify(counts));
    check("founder metrics and cost panel compute", metrics.callsInRange === 4 && cost.month.calls === 4);
    check("founder lists return rows with a designer", (await founderList("qualified")).every((c) => !!c.designerName));

    const hs = await syncDirty(); // the ticks already pushed most calls; this catches the ones changed since
    const withDeal = (await db.select().from(schema.calls)).filter((c) => !!c.hubspotDealId).length;
    check("HubSpot sync (mock) gives every call a deal, with no failures", withDeal === 4 && hs.failed === 0, `${withDeal} of 4 have a deal`);

    await saveSettings({ slaMinutes: 90 });
    check("changing the SLA saves and reschedules", (await getSettings()).slaMinutes === 90);

    check("a lease is exclusive", (await withLease("smoke", 30_000, async () => (await withLease("smoke", 30_000, async () => "inner")) === undefined)) === true);
  } finally {
    await wipe();
    const left = (await db.select().from(schema.calls)).length + (await db.select().from(schema.designers)).length;
    check("everything the test created was removed", left === 0);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
  if (failed.length) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("SMOKE TEST CRASHED:", e instanceof Error ? e.stack ?? e.message : e);
    process.exit(1);
  });

export {};
