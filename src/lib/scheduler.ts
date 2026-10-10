import { audit } from "@/lib/audit";
import { runHubSpotCycle } from "@/lib/hubspot/sync";
import { processPending } from "@/lib/ingest";
import { pollVaani } from "@/lib/voice/poll";
import { reconcileReminders, runDueJobs } from "@/lib/reminders";

export interface TickResult {
  processed: number;
  reminders: { sent: number; cancelled: number; retrying: number };
  hubspot: { pushed: number; failed: number; applied: number } | null;
}

/**
 * One pass of all the background work. This is the single place that does it, and it is safe to run from
 * anywhere, any number of times: the local timer (below), Vercel Cron, or any outside pinger call the same function.
 * Each part takes its own lease, so overlapping runs never send a reminder or create a deal twice.
 */
export async function runTick(now: Date = new Date()): Promise<TickResult> {
  await pollVaani(now); // poll mode only: pull in new inbound calls from Vaani
  const processed = await processPending(); // calls saved but never processed (crash, AI outage)
  await reconcileReminders(now); // processed calls that have no reminder yet
  const reminders = await runDueJobs(now);
  const hubspot = await runHubSpotCycle(now); // push anything not yet sent, then read back changes made in HubSpot
  return { processed, reminders, hubspot };
}

const g = globalThis as { __schedulerStarted?: boolean };

async function tick() {
  try {
    const r = await runTick();
    const { reminders: rem, hubspot: hs } = r;
    if (r.processed) console.log(`[tick] processed ${r.processed} waiting calls`);
    if (rem.sent || rem.cancelled || rem.retrying) console.log(`[reminders] sent ${rem.sent}, cancelled ${rem.cancelled}, retrying ${rem.retrying}`);
    if (hs && (hs.pushed || hs.failed || hs.applied)) console.log(`[hubspot] pushed ${hs.pushed}, failed ${hs.failed}, applied from HubSpot ${hs.applied}`);
  } catch (e) {
    await audit("scheduler.error", { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Local and self-hosted timer: runs a tick once a minute inside the server process.
 * Not used on Vercel, where functions are short-lived: there, Vercel Cron calls /api/cron/tick instead.
 */
export async function startScheduler() {
  if (g.__schedulerStarted) return;
  g.__schedulerStarted = true;
  const cron = (await import("node-cron")).default;
  void tick(); // catch up straight away on anything that fell due while the server was down
  cron.schedule("* * * * *", () => void tick(), { timezone: "Asia/Kolkata" });
  console.log("[scheduler] started (every minute)");
}
