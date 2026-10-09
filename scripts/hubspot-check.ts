import { env } from "@/lib/env";
import { RealHubSpot } from "@/lib/hubspot/real";
import { PIPELINE_LABEL, PROPERTIES } from "@/lib/hubspot/types";

/**
 * Checks the HubSpot connection. Read-only unless you pass --setup.
 *   npm run hubspot:check            read-only: is the key valid, which scopes work, what already exists, who the owners are
 *   npm run hubspot:check -- --setup also create the missing properties and the "Phone Enquiries" pipeline
 * Never prints the key.
 */
const BASE = "https://api.hubapi.com";

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${env.HUBSPOT_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, body };
}

const verdict = (status: number) => (status === 200 ? "ok" : status === 401 ? "KEY REJECTED (401)" : status === 403 ? "MISSING SCOPE (403)" : `HTTP ${status}`);

async function main() {
  if (!env.HUBSPOT_TOKEN) return console.log("HUBSPOT_TOKEN is not set in .env");
  console.log(`Hub ID in .env: ${env.HUBSPOT_PORTAL_ID || "(not set)"}\n`);

  const checks: [string, string][] = [
    ["Read deals (crm.objects.deals.read)", "/crm/v3/objects/deals?limit=1"],
    ["Read contacts (crm.objects.contacts.read)", "/crm/v3/objects/contacts?limit=1"],
    ["Read deal pipelines", "/crm/v3/pipelines/deals"],
    ["Read deal properties (schemas)", "/crm/v3/properties/deals"],
    ["Read owners", "/crm/v3/owners?limit=100"],
  ];
  const results: Record<string, { status: number; body: Record<string, any> }> = {};
  for (const [label, path] of checks) {
    results[path] = await get(path);
    console.log(`${verdict(results[path].status).padEnd(22)} ${label}`);
    if (results[path].status !== 200 && results[path].body.message) console.log(`    ${String(results[path].body.message).slice(0, 200)}`);
  }

  const pipes = results["/crm/v3/pipelines/deals"];
  if (pipes.status === 200) {
    const list = pipes.body.results as { label: string; stages: unknown[] }[];
    console.log(`\nDeal pipelines (${list.length}): ${list.map((p) => `"${p.label}" (${p.stages.length} stages)`).join(", ")}`);
    console.log(list.some((p) => p.label === PIPELINE_LABEL) ? `"${PIPELINE_LABEL}" already exists.` : `"${PIPELINE_LABEL}" does not exist yet; it will be created on setup.`);
  }
  const props = results["/crm/v3/properties/deals"];
  if (props.status === 200) {
    const have = new Set((props.body.results as { name: string }[]).map((p) => p.name));
    const missing = PROPERTIES.filter((p) => !have.has(p.name)).map((p) => p.name);
    console.log(`Custom properties: ${PROPERTIES.length - missing.length} of ${PROPERTIES.length} exist${missing.length ? `; missing: ${missing.join(", ")}` : ""}.`);
  }
  const owners = results["/crm/v3/owners?limit=100"];
  if (owners.status === 200) {
    console.log("\nOwners (put each designer's ID in Settings):");
    for (const o of owners.body.results as { id: string; email?: string; firstName?: string; lastName?: string }[]) console.log(`  ${o.id}  ${[o.firstName, o.lastName].filter(Boolean).join(" ")}  ${o.email ?? ""}`);
  }

  if (process.argv.includes("--setup")) {
    console.log("\nSetting up (creating anything missing)...");
    const meta = await new RealHubSpot().ensureSetup();
    console.log("Done. Pipeline id:", meta.pipelineId, "| stages:", JSON.stringify(meta.stages));
  } else {
    console.log("\nRead-only check finished. Nothing was created. Add --setup to create the properties and pipeline.");
  }
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
