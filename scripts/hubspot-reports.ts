import { env } from "@/lib/env";
import { getHubSpot } from "@/lib/hubspot";
import { PIPELINE_LABEL, type DealRecord } from "@/lib/hubspot/types";

/**
 * Founder numbers straight from HubSpot, computed with the CRM API.
 *
 * HubSpot's public API cannot create REPORTS (as of the docs checked: a beta dashboards endpoint exists,
 * but a report's configuration is not exposed, so there is nothing to attach). So this script does the
 * part that can be automated: it makes sure the properties and pipeline exist, then prints the five
 * figures the founder dashboard should show, so you can check your HubSpot reports against them.
 * Step-by-step instructions for building the dashboard in the HubSpot UI: docs/HUBSPOT.md
 */
async function main() {
  if (env.HUBSPOT_MODE !== "live") {
    console.log("HUBSPOT_MODE is not live, so there is no real portal to read. Set HUBSPOT_MODE=live and HUBSPOT_TOKEN, then run again.");
    console.log("Building the dashboard by hand: see docs/HUBSPOT.md");
    return;
  }
  const api = getHubSpot();
  const meta = await api.ensureSetup();
  const deals = await api.listDeals(meta.pipelineId);
  const stageName = new Map<string, string>([
    [meta.stages.yet_to_be_processed, "Yet to be processed"],
    [meta.stages.qualified, "Qualified"],
    [meta.stages.disqualified, "Disqualified"],
    [meta.stages.needs_attention, "Needs attention"],
  ]);

  console.log(`\nPipeline "${PIPELINE_LABEL}": ${deals.length} deals\n`);

  // 1. Deals by stage
  const byStage = new Map<string, number>();
  for (const d of deals) byStage.set(stageName.get(d.properties.dealstage ?? "") ?? "Other", (byStage.get(stageName.get(d.properties.dealstage ?? "") ?? "Other") ?? 0) + 1);
  console.log("1. Deals by stage");
  console.table(Object.fromEntries([...byStage].map(([k, v]) => [k, { deals: v }])));

  // 2. Disqualified, with the reason
  const disq = deals.filter((d) => d.properties.dealstage === meta.stages.disqualified);
  console.log(`2. Disqualified with reason (${disq.length})`);
  console.table(disq.map((d) => ({ deal: d.properties.dealname, reason: d.properties.ai_reason })));

  // 3. Unprocessed count
  console.log(`3. Unprocessed (Yet to be processed): ${byStage.get("Yet to be processed") ?? 0}\n`);

  // 4. Time to acknowledge (wall-clock; the app's founder view also gives working-time)
  const mins = (d: DealRecord) => {
    const created = Date.parse(d.properties.createdate ?? d.properties.hs_createdate ?? "");
    const ack = Date.parse(d.properties.acknowledged_at ?? "");
    return Number.isNaN(created) || Number.isNaN(ack) ? null : (ack - created) / 60_000;
  };
  const times = deals.map(mins).filter((m): m is number => m !== null && m >= 0);
  console.log(`4. Time to acknowledge: ${times.length ? `${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(0)} min average over ${times.length} acknowledged deals (wall-clock, includes nights and Sundays)` : "no acknowledged deals yet"}\n`);

  // 5. Cost per qualified lead
  const sum = (key: string) => deals.reduce((s, d) => s + (Number(d.properties[key]) || 0), 0);
  const qualified = byStage.get("Qualified") ?? 0;
  const total = sum("call_ai_cost_inr") + sum("call_telephony_cost_inr");
  console.log(`5. Cost per qualified lead: ${qualified ? `INR ${(total / qualified).toFixed(2)}` : "no qualified deals yet"} (all ${deals.length} calls cost INR ${total.toFixed(2)}: AI ${sum("call_ai_cost_inr").toFixed(2)}, telephony ${sum("call_telephony_cost_inr").toFixed(2)})\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
