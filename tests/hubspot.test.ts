import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import { setAssigner, defaultAssigner } from "@/lib/assignment";
import { acknowledgeCall, overrideStatus } from "@/lib/calls";
import { MockHubSpot, PIPELINE_LABEL, PROPERTIES, STAGES, getHubSpot, setHubSpot } from "@/lib/hubspot";
import { pollHubSpot, runHubSpotCycle, syncCall, syncDirty } from "@/lib/hubspot/sync";
import { ingestCall } from "@/lib/ingest";
import { istIso, payloadFor, resetDb } from "./helpers";

let hs: MockHubSpot;
let clock = Date.parse("2026-10-07T06:00:00Z");
const tick = (ms = 60_000) => (clock += ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(istIso("2026-10-07 11:00")));
  resetDb(); // installs a fresh MockHubSpot and turns auto-push off
  hs = getHubSpot() as MockHubSpot;
  clock = Date.parse("2026-10-07T06:00:00Z");
  hs.clock = () => clock;
  setAssigner(() => 1);
  db.update(schema.designers).set({ hubspotOwnerId: "owner-1" }).where(eq(schema.designers.id, 1)).run();
  db.update(schema.designers).set({ hubspotOwnerId: "owner-2" }).where(eq(schema.designers.id, 2)).run();
});
afterEach(() => {
  vi.useRealTimers();
  setAssigner(defaultAssigner);
});

const ingest = async (id: string, over: Record<string, unknown> = {}) => (await ingestCall(payloadFor(id, { started_at: istIso("2026-10-07 11:00"), ...over }))).call;
const row = (id: number) => db.select().from(schema.calls).where(eq(schema.calls.id, id)).get()!;
const deal = (id: number) => hs.deals.get(row(id).hubspotDealId!)!;
const metaStages = async () => (await hs.ensureSetup()).stages;

describe("setup", () => {
  it("defines the required custom properties, the pipeline and its four stages in order", () => {
    const names = PROPERTIES.map((p) => p.name);
    for (const required of ["ai_score", "ai_status", "ai_reason", "ai_summary", "call_transcript_url", "acknowledged_at", "acknowledged_by", "call_ai_cost_inr", "call_telephony_cost_inr"]) expect(names).toContain(required);
    expect(PIPELINE_LABEL).toBe("Phone Enquiries");
    expect(STAGES.map((s) => s.label)).toEqual(["Yet to be processed", "Qualified", "Disqualified", "Needs attention"]);
  });
  it("probabilities are in the 0.1 steps HubSpot requires", () => {
    for (const s of STAGES) expect(Number(s.probability) * 10).toBeCloseTo(Math.round(Number(s.probability) * 10));
  });
});

describe("push: app to HubSpot", () => {
  it("creates a contact (matched on phone) and a deal in the right stage with all the properties", async () => {
    const c = await ingest("T01");
    await syncDirty();
    const stages = await metaStages();
    const d = deal(c.id);
    expect(d.props.dealstage).toBe(stages.qualified);
    expect(d.props.pipeline).toBe((await hs.ensureSetup()).pipelineId);
    expect(d.props).toMatchObject({ ai_status: "qualified", app_call_id: String(c.id), hubspot_owner_id: "owner-1" });
    expect(Number(d.props.ai_score)).toBe(c.score);
    expect(d.props.ai_summary).toBe(c.summary);
    expect(d.props.call_transcript_url).toContain(`call=${c.id}`);
    expect(Number(d.props.call_telephony_cost_inr)).toBeGreaterThan(0);
    expect(Number(d.props.call_ai_cost_inr)).toBeGreaterThan(0);
    const contact = hs.contacts.get(row(c.id).hubspotContactId!)!;
    expect(contact.props.phone).toBe("+919800000000");
    expect(hs.associations).toEqual([{ dealId: row(c.id).hubspotDealId, contactId: row(c.id).hubspotContactId }]);
  });

  it("each status lands in its own stage", async () => {
    const calls = { qualified: await ingest("T01"), disqualified: await ingest("T03"), needs_attention: await ingest("T07") };
    await syncDirty();
    const stages = await metaStages();
    for (const [status, c] of Object.entries(calls)) expect(deal(c.id).props.dealstage).toBe(stages[status as keyof typeof stages]);
  });

  it("a call saved but not yet processed is a deal in 'Yet to be processed'", async () => {
    const c = (await ingestCall(payloadFor("T01"), { process: false })).call;
    await syncDirty();
    expect(deal(c.id).props.dealstage).toBe((await metaStages()).yet_to_be_processed);
    expect(deal(c.id).props.ai_status).toBe("yet_to_be_processed");
  });

  it("the same phone number reuses one contact; each call still gets its own deal", async () => {
    const a = await ingest("T01");
    const b = await ingest("T02");
    await syncDirty();
    expect(hs.contacts.size).toBe(1);
    expect(hs.deals.size).toBe(2);
    expect(row(a.id).hubspotContactId).toBe(row(b.id).hubspotContactId);
  });

  it("finds an existing HubSpot contact by phone instead of creating a duplicate", async () => {
    const existing = await hs.createContact({ firstname: "Priya", phone: "+919800000000" });
    const c = await ingest("T01");
    await syncDirty();
    expect(row(c.id).hubspotContactId).toBe(existing);
    expect(hs.contacts.size).toBe(1);
  });

  it("fills in a placeholder name on a matched contact, but never overwrites a real one", async () => {
    const placeholder = await hs.createContact({ firstname: "Unknown caller", phone: "+919800000000" });
    await ingest("T01");
    await syncDirty();
    expect(hs.contacts.get(placeholder)!.props.firstname).toBe("Priya");
    resetDb();
    hs = getHubSpot() as MockHubSpot;
    const typed = await hs.createContact({ firstname: "P. Sharma", phone: "+919800000000" });
    await ingest("T01");
    await syncDirty();
    expect(hs.contacts.get(typed)!.props.firstname).toBe("P. Sharma");
  });

  it("caller ID withheld: a contact without a phone is created for the call", async () => {
    const c = await ingest("T01", { caller_phone: null });
    await syncDirty();
    const contact = hs.contacts.get(row(c.id).hubspotContactId!)!;
    expect(contact.props.phone).toBeUndefined();
    expect(contact.props.lastname).toMatch(/withheld/);
    expect(deal(c.id).props.dealname).toMatch(/Priya/);
  });

  it("is idempotent: syncing again with nothing changed sends nothing", async () => {
    const c = await ingest("T01");
    await syncDirty();
    const before = hs.writes.length;
    await syncCall(c.id);
    await syncDirty();
    expect(hs.writes.length).toBe(before);
  });

  it("acknowledging updates the deal immediately with who and when", async () => {
    const c = await ingest("T01");
    await syncDirty();
    await acknowledgeCall(c.id, 1, new Date(istIso("2026-10-07 11:20")));
    await syncCall(c.id);
    expect(deal(c.id).props.acknowledged_at).toBe(istIso("2026-10-07 11:20"));
    expect(deal(c.id).props.acknowledged_by).toBe("Aryan");
  });

  it("a status override moves the deal to the new stage", async () => {
    const c = await ingest("T03");
    await syncDirty();
    await overrideStatus(c.id, 1, "qualified", "Has a flat in Pune too");
    await syncCall(c.id);
    expect(deal(c.id).props.dealstage).toBe((await metaStages()).qualified);
    expect(deal(c.id).props.ai_status).toBe("qualified");
  });

  it("booking details reach the deal, and a cancelled booking clears the slot", async () => {
    const c = await ingest("T01", { booking_id: "b1", booked_slot: istIso("2026-10-08 15:00") });
    await syncDirty();
    expect(deal(c.id).props.booked_slot).toBe(istIso("2026-10-08 15:00"));
    db.update(schema.calls).set({ bookingStatus: "cancelled" }).where(eq(schema.calls.id, c.id)).run();
    await syncCall(c.id);
    expect(deal(c.id).props.booked_slot).toBe("");
    expect(deal(c.id).props.booking_status).toBe("cancelled");
  });

  it("no price is ever written to HubSpot", async () => {
    await ingest("T10");
    await ingest("T13");
    await syncDirty();
    for (const d of hs.deals.values()) expect(`${d.props.ai_summary} ${d.props.ai_reason}`).not.toMatch(/₹|per sq/i);
  });
});

describe("demo data never reaches a real portal", () => {
  it("in live mode, seed calls are skipped for good while simulated and real calls sync", async () => {
    Object.defineProperty(hs, "mode", { value: "live" });
    const demo = await ingest("T01", { external_id: "seed-T01" });
    const real = await ingest("T02", { external_id: "sim-abc" });
    const r = await syncDirty();
    expect(r.pushed).toBe(1);
    expect(hs.deals.size).toBe(1);
    expect(row(real.id).hubspotDealId).toBeTruthy();
    expect(row(demo.id).hubspotDealId).toBeNull();
    await syncCall(demo.id);
    await syncDirty();
    expect(hs.deals.size).toBe(1);
  });

  it("in mock mode seed calls still sync, so the mock demo works", async () => {
    await ingest("T01", { external_id: "seed-T01" });
    expect((await syncDirty()).pushed).toBe(1);
  });
});

describe("failures never lose data", () => {
  it("a HubSpot outage leaves the call dirty and the app unaffected; the next cycle completes it with no duplicates", async () => {
    const c = await ingest("T01");
    hs.failNext = 1;
    expect(await syncCall(c.id)).toBe(false);
    expect(db.select().from(schema.hubspotSync).where(eq(schema.hubspotSync.callId, c.id)).get()).toMatchObject({ dirty: true, attempts: 1 });
    expect(row(c.id).status).toBe("qualified"); // the app carried on
    await syncDirty();
    expect(hs.deals.size).toBe(1);
    expect(hs.contacts.size).toBe(1);
    expect(db.select().from(schema.hubspotSync).where(eq(schema.hubspotSync.callId, c.id)).get()).toMatchObject({ dirty: false, attempts: 0 });
  });

  it("if the deal was created but associating failed, the retry reuses the deal", async () => {
    const c = await ingest("T01");
    const realAssociate = hs.associateDealWithContact.bind(hs);
    let first = true;
    hs.associateDealWithContact = async (d, k) => {
      if (first) {
        first = false;
        throw new Error("association failed");
      }
      return realAssociate(d, k);
    };
    expect(await syncCall(c.id)).toBe(false);
    expect(await syncCall(c.id)).toBe(true);
    expect(hs.deals.size).toBe(1);
    expect(hs.associations).toHaveLength(1);
  });

  it("two syncs at once for one call create one deal", async () => {
    const c = await ingest("T01");
    await Promise.all([syncCall(c.id), syncCall(c.id), syncCall(c.id)]);
    expect(hs.deals.size).toBe(1);
  });
});

describe("poll: HubSpot to app (every 60 seconds)", () => {
  /** Push everything, then let a minute pass, as the scheduler would. */
  async function pushed(id: string, over: Record<string, unknown> = {}) {
    const c = await ingest(id, over);
    await syncDirty();
    await pollHubSpot(new Date(clock)); // sets the cursor
    tick();
    return c;
  }

  it("moving a deal to another stage in HubSpot changes the call's status and is logged as an override", async () => {
    const c = await pushed("T03");
    expect(row(c.id).status).toBe("disqualified");
    hs.edit(row(c.id).hubspotDealId!, { dealstage: (await metaStages()).qualified, hubspot_owner_id: "owner-2" });
    const r = await pollHubSpot(new Date(clock));
    expect(r.applied).toBeGreaterThan(0);
    expect(row(c.id).status).toBe("qualified");
    const log = db.select().from(schema.statusOverrides).all();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ fromStatus: "disqualified", toStatus: "qualified", reason: "Changed in HubSpot", byDesignerId: 2 });
  });

  it("a change made in HubSpot does not bounce back as a second write, and a repeat poll applies nothing", async () => {
    const c = await pushed("T03");
    hs.edit(row(c.id).hubspotDealId!, { dealstage: (await metaStages()).needs_attention });
    await pollHubSpot(new Date(clock));
    await syncDirty(); // the app records the override and pushes its own view
    tick();
    const writes = hs.writes.length;
    expect((await pollHubSpot(new Date(clock))).applied).toBe(0);
    await syncDirty();
    expect(hs.writes.length).toBe(writes);
    expect(db.select().from(schema.statusOverrides).all()).toHaveLength(1);
    expect(row(c.id).status).toBe("needs_attention");
  });

  it("acknowledged_at set in HubSpot acknowledges the call in the app and cancels its reminders", async () => {
    const c = await pushed("T01");
    expect(db.select().from(schema.reminderJobs).all().some((j) => j.state === "pending")).toBe(true);
    hs.edit(row(c.id).hubspotDealId!, { acknowledged_at: istIso("2026-10-07 11:40"), hubspot_owner_id: "owner-1" });
    await pollHubSpot(new Date(clock));
    const after = row(c.id);
    expect(after.acknowledgedAt!.toISOString()).toBe(istIso("2026-10-07 11:40"));
    expect(after.acknowledgedBy).toBe(1);
    expect(db.select().from(schema.reminderJobs).all().some((j) => j.state === "pending" && j.callId === c.id)).toBe(false);
  });

  it("changing the deal owner in HubSpot reassigns the call and moves its reminder", async () => {
    const c = await pushed("T01");
    hs.edit(row(c.id).hubspotDealId!, { hubspot_owner_id: "owner-2" });
    await pollHubSpot(new Date(clock));
    expect(row(c.id).assignedDesignerId).toBe(2);
    const pending = db.select().from(schema.reminderJobs).all().filter((j) => j.state === "pending" && j.callId === c.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].designerId).toBe(2);
  });

  it("clearing the acknowledgement in HubSpot does not un-acknowledge the call; the app pushes the truth back", async () => {
    const c = await pushed("T01");
    await acknowledgeCall(c.id, 1, new Date(istIso("2026-10-07 11:20")));
    await syncDirty();
    tick();
    hs.edit(row(c.id).hubspotDealId!, { acknowledged_at: "" });
    await pollHubSpot(new Date(clock));
    expect(row(c.id).acknowledgedAt).not.toBeNull();
    await syncDirty();
    expect(deal(c.id).props.acknowledged_at).toBe(istIso("2026-10-07 11:20"));
  });

  it("a processed call cannot be sent back to 'Yet to be processed' from HubSpot", async () => {
    const c = await pushed("T01");
    hs.edit(row(c.id).hubspotDealId!, { dealstage: (await metaStages()).yet_to_be_processed });
    await pollHubSpot(new Date(clock));
    expect(row(c.id).status).toBe("qualified");
    await syncDirty();
    expect(deal(c.id).props.dealstage).toBe((await metaStages()).qualified);
  });

  it("when the app has unsent changes the app wins: the HubSpot edit is not applied over them", async () => {
    const c = await pushed("T03");
    await overrideStatus(c.id, 1, "needs_attention", "Checking location with the caller"); // not pushed yet: dirty
    hs.edit(row(c.id).hubspotDealId!, { dealstage: (await metaStages()).qualified });
    await pollHubSpot(new Date(clock));
    expect(row(c.id).status).toBe("needs_attention");
    await syncDirty();
    expect(deal(c.id).props.dealstage).toBe((await metaStages()).needs_attention);
  });

  it("ignores deals the app did not create, and deals with no change", async () => {
    await pushed("T01");
    const strange = await hs.createDeal({ dealname: "Someone else's deal", pipeline: (await hs.ensureSetup()).pipelineId, dealstage: (await metaStages()).qualified });
    expect(hs.deals.has(strange)).toBe(true);
    expect((await pollHubSpot(new Date(clock))).applied).toBe(0);
    expect(db.select().from(schema.statusOverrides).all()).toHaveLength(0);
  });

  it("the cycle (what the scheduler runs each minute) pushes then polls", async () => {
    const c = await ingest("T03");
    const first = await runHubSpotCycle(new Date(clock));
    expect(first).toMatchObject({ pushed: 1, applied: 0 });
    tick();
    hs.edit(row(c.id).hubspotDealId!, { dealstage: (await metaStages()).qualified });
    const second = await runHubSpotCycle(new Date(clock));
    expect(second!.applied).toBe(1);
    expect(row(c.id).status).toBe("qualified");
  });
});

describe("mode switch and secrets", () => {
  it("HUBSPOT_MODE=mock (the default here) uses the in-memory client", () => {
    setHubSpot(null);
    expect(getHubSpot().mode).toBe("mock");
  });

  it("the HubSpot token is only read by server-side HubSpot code, never by anything a browser can load", () => {
    const root = path.resolve("src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) {
          const text = readFileSync(p, "utf8");
          if (/HUBSPOT_TOKEN/.test(text) && !/lib[\\/](hubspot[\\/]real|env)\.ts$/.test(p)) offenders.push(p);
          if (/^["']use client["']/.test(text) && /from\s+["'](@\/lib\/hubspot|@\/lib\/env)/.test(text)) offenders.push(`${p} (client component imports server-only HubSpot or env code)`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("no NEXT_PUBLIC variable carries the token", () => {
    expect(readFileSync(".env.example", "utf8")).not.toMatch(/NEXT_PUBLIC_HUBSPOT/);
  });
});
