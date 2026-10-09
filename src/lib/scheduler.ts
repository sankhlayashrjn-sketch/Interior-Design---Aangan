import cron from "node-cron";
import { audit } from "@/lib/audit";
import { processPending } from "@/lib/ingest";
import { runHubSpotCycle } from "@/lib/hubspot/sync";
import { reconcileReminders, runDueJobs } from "@/lib/reminders";

const g = globalThis as { __schedulerStarted?: boolean };

async function tick() {
  try {
    const r = await runDueJobs();
    if (r.sent || r.cancelled || r.retrying) console.log(`[reminders] sent ${r.sent}, cancelled ${r.cancelled}, retrying ${r.retrying}`);
  } catch (e) {
    audit("scheduler.error", { error: e instanceof Error ? e.message : String(e) });
  }
  // HubSpot: push anything not yet sent, then read back changes made there (every minute).
  const hs = await runHubSpotCycle();
  if (hs && (hs.pushed || hs.failed || hs.applied)) console.log(`[hubspot] pushed ${hs.pushed}, failed ${hs.failed}, applied from HubSpot ${hs.applied}`);
}

/**
 * Persistent scheduler. The queue lives in the reminder_jobs table, so nothing is lost if the process
 * restarts: on startup we catch up on anything that fell due while we were down, then tick every minute.
 */
export function startScheduler() {
  if (g.__schedulerStarted) return;
  g.__schedulerStarted = true;
  void (async () => {
    await processPending(); // calls saved but never processed (crash, API outage)
    reconcileReminders();
    await tick();
  })();
  cron.schedule("* * * * *", () => void tick(), { timezone: "Asia/Kolkata" });
  console.log("[reminders] scheduler started (every minute)");
}
