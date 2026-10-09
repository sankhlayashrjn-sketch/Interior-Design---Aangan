import { env } from "@/lib/env";
import {
  GROUP,
  HubSpotError,
  PIPELINE_LABEL,
  PROPERTIES,
  READ_PROPERTIES,
  STAGES,
  type ContactMatch,
  type DealRecord,
  type HubSpotApi,
  type Meta,
} from "./types";

/**
 * HUBSPOT_MODE=live. Talks to the HubSpot CRM API with the Private App token from env.
 * The token is read here and nowhere else, and this module is only imported by server code.
 *
 * TODO(verify against your portal before relying on it): this uses the /crm/v3 object, property,
 * pipeline and search endpoints. HubSpot's newest docs also publish dated versions (for example
 * /crm/objects/2026-09/...). The private app needs these scopes: crm.objects.contacts.read/write,
 * crm.objects.deals.read/write, crm.schemas.deals.read/write.
 */
const BASE = "https://api.hubapi.com";

type Json = Record<string, unknown>;

async function hs<T = Json>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T | null> {
  if (!env.HUBSPOT_TOKEN) throw new HubSpotError("HUBSPOT_TOKEN is not set");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.HUBSPOT_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) throw new HubSpotError("HubSpot rate limit reached", 429, Number(res.headers.get("retry-after")) || 10);
  if (okStatuses.includes(res.status)) return null;
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Json) : {};
  if (!res.ok) throw new HubSpotError(`${method} ${path}: ${res.status} ${(json.message as string) ?? text.slice(0, 200)}`, res.status);
  return json as T;
}

interface Stage {
  id: string;
  label: string;
}
interface Pipeline {
  id: string;
  label: string;
  stages: Stage[];
}

export class RealHubSpot implements HubSpotApi {
  readonly mode = "live" as const;

  async ensureSetup(): Promise<Meta> {
    // Property group (409 = already exists)
    await hs("POST", "/crm/v3/properties/deals/groups", { name: GROUP.name, label: GROUP.label, displayOrder: -1 }, [409]);

    const existing = await hs<{ results: { name: string }[] }>("GET", "/crm/v3/properties/deals");
    const have = new Set((existing?.results ?? []).map((p) => p.name));
    for (const p of PROPERTIES.filter((p) => !have.has(p.name))) {
      await hs("POST", "/crm/v3/properties/deals", { name: p.name, label: p.label, type: p.type, fieldType: p.fieldType, groupName: GROUP.name }, [409]);
    }

    const list = await hs<{ results: Pipeline[] }>("GET", "/crm/v3/pipelines/deals");
    let pipeline = list?.results.find((p) => p.label === PIPELINE_LABEL);
    if (!pipeline) {
      pipeline = (await hs<Pipeline>("POST", "/crm/v3/pipelines/deals", {
        label: PIPELINE_LABEL,
        displayOrder: 99,
        stages: STAGES.map((s, i) => ({ label: s.label, displayOrder: i, metadata: { probability: s.probability } })),
      }))!;
    }
    for (const [i, s] of STAGES.entries()) {
      if (!pipeline.stages.some((x) => x.label === s.label)) {
        const added = await hs<Stage>("POST", `/crm/v3/pipelines/deals/${pipeline.id}/stages`, { label: s.label, displayOrder: i, metadata: { probability: s.probability } });
        pipeline.stages.push(added!);
      }
    }
    const stages = Object.fromEntries(STAGES.map((s) => [s.status, pipeline!.stages.find((x) => x.label === s.label)!.id])) as Meta["stages"];
    return { pipelineId: pipeline.id, stages };
  }

  async findContactByPhone(phone: string): Promise<ContactMatch | null> {
    const r = await hs<{ results: { id: string; properties: { firstname?: string } }[] }>("POST", "/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: phone }] }],
      properties: ["firstname", "phone"],
      limit: 1,
    });
    const hit = r?.results[0];
    return hit ? { id: hit.id, firstname: hit.properties.firstname ?? null } : null;
  }

  async createContact(props: Record<string, string>): Promise<string> {
    return (await hs<{ id: string }>("POST", "/crm/v3/objects/contacts", { properties: props }))!.id;
  }

  async updateContact(id: string, props: Record<string, string>): Promise<void> {
    await hs("PATCH", `/crm/v3/objects/contacts/${id}`, { properties: props });
  }

  async createDeal(props: Record<string, string>): Promise<string> {
    return (await hs<{ id: string }>("POST", "/crm/v3/objects/deals", { properties: props }))!.id;
  }

  async updateDeal(id: string, props: Record<string, string>): Promise<void> {
    await hs("PATCH", `/crm/v3/objects/deals/${id}`, { properties: props });
  }

  async associateDealWithContact(dealId: string, contactId: string): Promise<void> {
    // The default association: avoids hard-coding an association type id.
    await hs("PUT", `/crm/v4/objects/deals/${dealId}/associations/default/contacts/${contactId}`);
  }

  private async search(pipelineId: string, sinceMs: number | null): Promise<DealRecord[]> {
    const out: DealRecord[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const filters: Json[] = [{ propertyName: "pipeline", operator: "EQ", value: pipelineId }];
      if (sinceMs !== null) filters.push({ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(sinceMs) });
      const r = await hs<{ results: { id: string; properties: Record<string, string | null> }[]; paging?: { next?: { after: string } } }>("POST", "/crm/v3/objects/deals/search", {
        filterGroups: [{ filters }],
        properties: READ_PROPERTIES,
        sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
        limit: 100,
        after,
      });
      out.push(...(r?.results ?? []).map((d) => ({ id: d.id, properties: d.properties })));
      after = r?.paging?.next?.after;
      if (!after) break;
    }
    return out;
  }

  searchDealsModifiedSince(pipelineId: string, sinceMs: number) {
    return this.search(pipelineId, sinceMs);
  }

  listDeals(pipelineId: string) {
    return this.search(pipelineId, null);
  }
}
