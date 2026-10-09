import { audit } from "@/lib/audit";
import { PIPELINE_LABEL, PROPERTIES, STAGES, type ContactMatch, type DealRecord, type HubSpotApi, type Meta } from "./types";

interface Rec {
  id: string;
  props: Record<string, string>;
  modifiedAt: number;
}

/**
 * HUBSPOT_MODE=mock. Logs every write as "mock.hubspot.*" and keeps contacts and deals in memory so the
 * rest of the app (including the 60-second poll) behaves as it would against a real portal.
 * Tests use it as a fake HubSpot: `edit()` plays the part of someone changing a deal in the HubSpot UI.
 */
export class MockHubSpot implements HubSpotApi {
  readonly mode = "mock" as const;
  contacts = new Map<string, Rec>();
  deals = new Map<string, Rec>();
  associations: { dealId: string; contactId: string }[] = [];
  /** Names of API operations performed, in order. Tests assert on this. */
  ops: string[] = [];
  clock: () => number = () => Date.now();
  /** Make the next N write operations fail, to test retries. */
  failNext = 0;
  private seq = 1000;
  private setupDone = false;

  private meta: Meta = {
    pipelineId: "mock-pipeline",
    stages: { yet_to_be_processed: "mock-stage-yet", qualified: "mock-stage-qualified", disqualified: "mock-stage-disqualified", needs_attention: "mock-stage-needs" },
  };

  private write(op: string, detail: unknown) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`mock HubSpot failure on ${op}`);
    }
    this.ops.push(op);
    audit(`mock.hubspot.${op}`, detail);
  }

  async ensureSetup(): Promise<Meta> {
    if (!this.setupDone) {
      this.setupDone = true;
      this.ops.push("setup");
      audit("mock.hubspot.setup", { properties: PROPERTIES.map((p) => p.name), pipeline: PIPELINE_LABEL, stages: STAGES.map((s) => s.label) });
    }
    return this.meta;
  }

  async findContactByPhone(phone: string): Promise<ContactMatch | null> {
    const hit = [...this.contacts.values()].find((c) => c.props.phone === phone);
    return hit ? { id: hit.id, firstname: hit.props.firstname ?? null } : null;
  }

  async createContact(props: Record<string, string>): Promise<string> {
    this.write("contact.create", props);
    const id = `c${++this.seq}`;
    this.contacts.set(id, { id, props: { ...props }, modifiedAt: this.clock() });
    return id;
  }

  async updateContact(id: string, props: Record<string, string>): Promise<void> {
    this.write("contact.update", { id, ...props });
    const c = this.contacts.get(id);
    if (!c) throw new Error(`contact ${id} not found`);
    Object.assign(c.props, props);
    c.modifiedAt = this.clock();
  }

  async createDeal(props: Record<string, string>): Promise<string> {
    this.write("deal.create", props);
    const id = `d${++this.seq}`;
    this.deals.set(id, { id, props: { ...props }, modifiedAt: this.clock() });
    return id;
  }

  async updateDeal(id: string, props: Record<string, string>): Promise<void> {
    this.write("deal.update", { id, ...props });
    const d = this.deals.get(id);
    if (!d) throw new Error(`deal ${id} not found`);
    Object.assign(d.props, props);
    d.modifiedAt = this.clock();
  }

  async associateDealWithContact(dealId: string, contactId: string): Promise<void> {
    this.write("associate", { dealId, contactId });
    this.associations.push({ dealId, contactId });
  }

  private toRecord(d: Rec): DealRecord {
    return { id: d.id, properties: { ...d.props, hs_lastmodifieddate: String(d.modifiedAt) } };
  }

  async searchDealsModifiedSince(pipelineId: string, sinceMs: number): Promise<DealRecord[]> {
    return [...this.deals.values()].filter((d) => d.props.pipeline === pipelineId && d.modifiedAt >= sinceMs).map((d) => this.toRecord(d));
  }

  async listDeals(pipelineId: string): Promise<DealRecord[]> {
    return [...this.deals.values()].filter((d) => d.props.pipeline === pipelineId).map((d) => this.toRecord(d));
  }

  /** Test helper: someone edits a deal in the HubSpot UI. */
  edit(dealId: string, props: Record<string, string>) {
    const d = this.deals.get(dealId);
    if (!d) throw new Error(`deal ${dealId} not found`);
    Object.assign(d.props, props);
    d.modifiedAt = this.clock();
  }

  /** Test helper: operations that changed something in HubSpot (not setup). */
  get writes() {
    return this.ops.filter((o) => o !== "setup");
  }
}
