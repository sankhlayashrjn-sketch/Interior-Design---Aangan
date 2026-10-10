/**
 * Proves the HubSpot integration against your REAL HubSpot account.
 *   npm run hubspot:test              creates ONE clearly labelled test contact and deal, checks them, leaves them to look at
 *   npm run hubspot:test -- --cleanup also moves the test records to HubSpot's recycle bin afterwards
 *
 * It runs on a throwaway in-memory database (nothing local is touched), with scoring and Telegram mocked.
 * Only HubSpot is live. Everything it creates is named "TEST - Aangan integration test".
 */
process.env.DATABASE_URL = ":memory:";
process.env.AI_MODE = "mock";
process.env.TELEGRAM_MODE = "mock";
process.env.CALCOM_MODE = "mock";

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { eq } = await import("drizzle-orm");
  const { db, one, runMigrations, schema } = await import("@/db");
  const { env } = await import("@/lib/env");
  if (env.HUBSPOT_MODE !== "live" || !env.HUBSPOT_TOKEN) {
    console.error("HUBSPOT_MODE must be live and HUBSPOT_TOKEN set in .env for this test.");
    process.exit(2);
  }
  const { acknowledgeCall } = await import("@/lib/calls");
  const { getHubSpot } = await import("@/lib/hubspot");
  const { pollHubSpot, setAutoPush, syncCall } = await import("@/lib/hubspot/sync");
  const { ingestCall } = await import("@/lib/ingest");
  const { getSettings } = await import("@/lib/settings");
  setAutoPush(false);

  const api = getHubSpot();
  const meta = await api.ensureSetup();
  await runMigrations();
  await getSettings();
  await db.insert(schema.designers).values([{ name: "Test Designer", rrOrder: 1 }]);

  const label = "TEST - Aangan integration test";
  const phone = `+9190000${String(Date.now()).slice(-5)}`;
  const { call } = await ingestCall({
    external_id: `hubspot-live-test-${Date.now()}`,
    caller_phone: phone,
    started_at: new Date().toISOString(),
    duration_sec: 150,
    transcript: `Agent: Aangan Studio.\nCaller: Hi, I am ${label}. 2BHK in Baner, 900 sq ft. Full redesign, kitchen, wardrobes, living room. Start next month. I own it.\nAgent: Shall I book a consultation?\nCaller: Yes please.`,
  });
  check("the app scores the test call", call.status === "qualified", `${call.status}, score ${call.score}`);

  const pushed = await syncCall(call.id);
  const row = await one(db.select().from(schema.calls).where(eq(schema.calls.id, call.id)));
  check("a contact and a deal are created in HubSpot", pushed && !!row?.hubspotDealId && !!row?.hubspotContactId, `deal ${row?.hubspotDealId}, contact ${row?.hubspotContactId}`);
  if (!row?.hubspotDealId) throw new Error("no deal was created; stopping");

  // HubSpot's search lags a few seconds behind writes, so look for the deal for a while.
  async function findDeal() {
    for (let i = 0; i < 12; i++) {
      const hit = (await api.listDeals(meta.pipelineId)).find((d) => d.id === row!.hubspotDealId);
      if (hit) return hit;
      await sleep(3000);
    }
    return undefined;
  }
  const deal = await findDeal();
  check("the deal is in the 'Phone Enquiries' pipeline", !!deal);
  check("it is in the Qualified stage", deal?.properties.dealstage === meta.stages.qualified);
  check("the AI score, status and call id are on the deal", deal?.properties.ai_status === "qualified" && Number(deal?.properties.ai_score) === call.score && deal?.properties.app_call_id === String(call.id), `score ${deal?.properties.ai_score}`);

  // 2. The app acknowledges: HubSpot should learn about it straight away.
  await acknowledgeCall(call.id, 1);
  await syncCall(call.id);
  let acked = false;
  for (let i = 0; i < 12 && !acked; i++) {
    acked = !!(await findDeal())?.properties.acknowledged_at;
    if (!acked) await sleep(3000);
  }
  check("acknowledging in the app updates HubSpot", acked);

  // 3. A person moves the deal in HubSpot: the app should follow.
  await api.updateDeal(row.hubspotDealId, { dealstage: meta.stages.needs_attention });
  let applied = 0;
  let status = "";
  for (let i = 0; i < 14 && status !== "needs_attention"; i++) {
    await sleep(4000);
    applied += (await pollHubSpot(new Date())).applied;
    status = (await one(db.select().from(schema.calls).where(eq(schema.calls.id, call.id))))!.status;
  }
  check("moving the deal in HubSpot changes the status in the app", status === "needs_attention", `status now ${status}`);
  const log = await db.select().from(schema.statusOverrides);
  check("and it is logged as an override with its source", log.length === 1 && log[0].reason === "Changed in HubSpot");

  const url = `https://app-na2.hubspot.com/contacts/${env.HUBSPOT_PORTAL_ID}/record/0-3/${row.hubspotDealId}`;
  console.log(`\nLook at the test deal in HubSpot: ${url}`);

  if (process.argv.includes("--cleanup")) {
    await api.archiveDeal(row.hubspotDealId);
    await api.archiveContact(row.hubspotContactId!);
    console.log("Test deal and contact moved to HubSpot's recycle bin.");
  } else {
    console.log('Left in place so you can look. Remove them later with: npm run hubspot:test -- --cleanup (or delete the deal and contact named "TEST" by hand).');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
  if (failed.length) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("TEST CRASHED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });

export {};
