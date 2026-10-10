import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import { db, one, schema, withLease } from "@/db";
import type { CallStatus } from "@/db/schema";
import { audit } from "@/lib/audit";
import { background } from "@/lib/background";
import { on } from "@/lib/hooks";
import { deepLink } from "@/lib/telegram";
import { IST } from "@/lib/working-hours";
import { getHubSpot } from "./index";
import { HubSpotError, STAGES, type DealRecord, type HubSpotApi, type Meta } from "./types";

type Call = typeof schema.calls.$inferSelect;

const g = globalThis as {
  __hsMeta?: { api: HubSpotApi; meta: Meta };
  __hsLocks?: Map<number, Promise<unknown>>;
  __hsAutoPush?: boolean;
  __hsLastCycleError?: string;
};

/** Turn the immediate background push off (tests do, so they control exactly when HubSpot is called). */
export function setAutoPush(enabled: boolean) {
  g.__hsAutoPush = enabled;
}

const getCall = (id: number) => one(db.select().from(schema.calls).where(eq(schema.calls.id, id)));
const designerById = async (id: number | null) => (id ? one(db.select().from(schema.designers).where(eq(schema.designers.id, id))) : undefined);
const designerByOwner = async (ownerId: string | null | undefined) => (ownerId ? one(db.select().from(schema.designers).where(eq(schema.designers.hubspotOwnerId, ownerId)).limit(1)) : undefined);
const syncRow = (callId: number) => one(db.select().from(schema.hubspotSync).where(eq(schema.hubspotSync.callId, callId)));

async function metaFor(api: HubSpotApi): Promise<Meta> {
  if (g.__hsMeta?.api !== api) g.__hsMeta = { api, meta: await api.ensureSetup() };
  return g.__hsMeta.meta;
}

/** One sync at a time per call inside this process, so "received" and "processed" can never create two deals. Other servers are kept out by a lease (see syncCall). */
async function withLock<T>(callId: number, fn: () => Promise<T>): Promise<T> {
  const locks = (g.__hsLocks ??= new Map());
  const prev = locks.get(callId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(callId, run);
  try {
    return await run;
  } finally {
    if (locks.get(callId) === run) locks.delete(callId);
  }
}

/** Queue a call for pushing. `force` also forgets the last pushed state, so it is re-sent even though the app's own data did not change (HubSpot drifted from the app). */
export async function markDirty(callId: number, force = false): Promise<void> {
  await db
    .insert(schema.hubspotSync)
    .values({ callId, dirty: true, lastPushedHash: null })
    .onConflictDoUpdate({ target: schema.hubspotSync.callId, set: force ? { dirty: true, lastPushedHash: null } : { dirty: true } });
}

/** Seed (demo) calls are never sent to a real HubSpot portal. Simulated calls are, so the integration can be tested. */
const isDemoCall = (c: { externalId: string }, api: HubSpotApi) => api.mode === "live" && c.externalId.startsWith("seed-");

const iso = (d: Date | null) => (d ? d.toISOString() : "");
const num = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

/** The deal properties for a call. Every field is always present so that cleared values also reach HubSpot. */
export async function dealProperties(call: Call, meta: Meta): Promise<Record<string, string>> {
  const owner = await designerById(call.assignedDesignerId);
  const ackBy = await designerById(call.acknowledgedBy);
  const cost = await one(db.select().from(schema.callsCost).where(eq(schema.callsCost.callId, call.id)));
  const who = call.callerName ?? call.callerPhone ?? "Unknown caller";
  const props: Record<string, string> = {
    dealname: `${who} - phone enquiry ${DateTime.fromJSDate(call.startedAt, { zone: IST }).toFormat("d LLL")}`,
    pipeline: meta.pipelineId,
    dealstage: meta.stages[call.status],
    ai_score: num(call.score),
    ai_status: call.status,
    ai_reason: call.reason ?? "",
    ai_summary: call.summary ?? "",
    call_transcript_url: deepLink(call.id),
    acknowledged_at: iso(call.acknowledgedAt),
    acknowledged_by: ackBy?.name ?? "",
    call_ai_cost_inr: num(cost?.aiCostInr),
    call_telephony_cost_inr: num(cost?.telephonyCostInr),
    booked_slot: call.bookingStatus === "cancelled" ? "" : iso(call.bookedSlot),
    booking_status: call.bookingStatus ?? "",
    app_call_id: String(call.id),
  };
  if (owner?.hubspotOwnerId) props.hubspot_owner_id = owner.hubspotOwnerId;
  return props;
}

const hashOf = (props: Record<string, string>) => createHash("sha1").update(JSON.stringify(Object.entries(props).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");

function contactProperties(call: Call): Record<string, string> {
  const parts = (call.callerName ?? "").trim().split(/\s+/).filter(Boolean);
  const props: Record<string, string> = {
    firstname: parts[0] ?? "Unknown caller",
    lastname: parts.slice(1).join(" ") || (call.callerPhone ? "" : "(caller ID withheld)"),
  };
  if (call.callerPhone) props.phone = call.callerPhone;
  if (call.callerEmail) props.email = call.callerEmail;
  return props;
}

/** Contact for this call: reuse a known one for the phone number, else find by phone in HubSpot, else create. */
async function resolveContact(api: HubSpotApi, call: Call): Promise<string> {
  if (call.hubspotContactId) return call.hubspotContactId;
  let id: string | null = null;

  if (call.callerPhone) {
    const sibling = await one(
      db
        .select()
        .from(schema.calls)
        .where(and(eq(schema.calls.callerPhone, call.callerPhone), isNotNull(schema.calls.hubspotContactId)))
        .limit(1),
    );
    if (sibling?.hubspotContactId) id = sibling.hubspotContactId;
    else {
      const match = await api.findContactByPhone(call.callerPhone);
      if (match) {
        id = match.id;
        // An earlier call had no name; now we have one. Never overwrite a name a person typed.
        if (call.callerName && (!match.firstname || match.firstname === "Unknown caller")) await api.updateContact(match.id, contactProperties(call));
      }
    }
  }
  // Withheld caller ID: nothing to match on, so each call gets its own contact.
  if (!id) id = await api.createContact(contactProperties(call));

  await db.update(schema.calls).set({ hubspotContactId: id }).where(eq(schema.calls.id, call.id));
  return id;
}

async function fail(callId: number, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  const row = await syncRow(callId);
  const attempts = (row?.attempts ?? 0) + 1;
  await db
    .insert(schema.hubspotSync)
    .values({ callId, dirty: true, attempts, lastError: message })
    .onConflictDoUpdate({ target: schema.hubspotSync.callId, set: { dirty: true, attempts, lastError: message } });
  if (attempts <= 3) await audit("hubspot.error", { error: message, attempts }, callId);
}

/**
 * Push one call to HubSpot: contact, deal, properties. Idempotent: nothing is sent if nothing changed.
 * On failure the call stays dirty and the next cycle retries; the app's data is never lost or blocked.
 */
export async function syncCall(callId: number, api: HubSpotApi = getHubSpot()): Promise<boolean> {
  return withLock(callId, async () => {
    // Another server is already syncing this call: leave it dirty and let the next pass pick it up if needed.
    const done = await withLease(`hubspot:${callId}`, 60_000, async () => {
      try {
        const call0 = await getCall(callId);
        if (!call0 || isDemoCall(call0, api)) return false;
        const meta = await metaFor(api);
        const contactId = await resolveContact(api, call0);

        const call = (await getCall(callId))!;
        const props = await dealProperties(call, meta);
        const hash = hashOf(props);
        const row = await syncRow(callId);
        let dealId = call.hubspotDealId;

        if (!dealId) {
          dealId = await api.createDeal(props);
          await db.update(schema.calls).set({ hubspotDealId: dealId }).where(eq(schema.calls.id, callId)); // saved before anything else can fail
        } else if (row?.lastPushedHash !== hash) {
          await api.updateDeal(dealId, props);
        }
        if (!row?.lastPushedHash) await api.associateDealWithContact(dealId, contactId); // idempotent; only until the first full success

        const synced = { dirty: false, attempts: 0, lastPushedHash: hash, lastSeenStage: props.dealstage, lastSeenAckAt: props.acknowledged_at || null, lastSeenOwner: props.hubspot_owner_id ?? null, lastSyncedAt: new Date(), lastError: null };
        await db.insert(schema.hubspotSync).values({ callId, ...synced }).onConflictDoUpdate({ target: schema.hubspotSync.callId, set: synced });
        return true;
      } catch (e) {
        await fail(callId, e);
        if (e instanceof HubSpotError && e.status === 429) throw e; // stop the whole cycle, HubSpot asked us to slow down
        return false;
      }
    });
    return done ?? false;
  });
}

/** Give every call that has never been synced a dirty row, then push everything dirty. */
export async function syncDirty(api: HubSpotApi = getHubSpot()): Promise<{ pushed: number; failed: number }> {
  const known = (await db.select({ id: schema.hubspotSync.callId }).from(schema.hubspotSync)).map((r) => r.id);
  const unsynced = await db.select().from(schema.calls).where(known.length ? notInArray(schema.calls.id, known) : undefined);
  for (const c of unsynced) if (!isDemoCall(c, api)) await markDirty(c.id);

  const out = { pushed: 0, failed: 0 };
  for (const r of await db.select().from(schema.hubspotSync).where(eq(schema.hubspotSync.dirty, true))) {
    const c = await getCall(r.callId);
    if (c && isDemoCall(c, api)) {
      await db.update(schema.hubspotSync).set({ dirty: false }).where(eq(schema.hubspotSync.callId, r.callId)); // demo data: leave it out for good
      continue;
    }
    if (await syncCall(r.callId, api)) out.pushed++;
    else out.failed++;
  }
  return out;
}

const CURSOR_KEY = "hubspot_cursor";
const OVERLAP_MS = 2 * 60_000;

function parseWhen(v: string): Date | null {
  const d = /^\d+$/.test(v) ? new Date(Number(v)) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Read changes people made in HubSpot and apply them to the app:
 * a deal moved to another stage (logged as an override), acknowledged_at set, or the owner changed.
 * Only differences from what we last pushed or saw count, so our own writes never echo back.
 * If the app has unsent changes for a call, the app wins and the call is skipped this round.
 */
export async function pollHubSpot(now: Date = new Date(), api: HubSpotApi = getHubSpot()): Promise<{ applied: number }> {
  const meta = await metaFor(api);
  const stored = await one(db.select().from(schema.appState).where(eq(schema.appState.key, CURSOR_KEY)));
  const since = (stored ? Number(stored.value) : now.getTime() - 10 * 60_000) - OVERLAP_MS;
  const deals = await api.searchDealsModifiedSince(meta.pipelineId, since);
  const statusOfStage = new Map(Object.entries(meta.stages).map(([status, id]) => [id, status as CallStatus]));

  let applied = 0;
  let cursor = stored ? Number(stored.value) : now.getTime();
  for (const deal of deals) {
    const modified = Number(deal.properties.hs_lastmodifieddate) || 0;
    if (modified > cursor) cursor = modified;
    applied += await withLock(Number(deal.properties.app_call_id) || -1, () => applyInbound(deal, statusOfStage, now));
  }
  await db.insert(schema.appState).values({ key: CURSOR_KEY, value: String(cursor) }).onConflictDoUpdate({ target: schema.appState.key, set: { value: String(cursor) } });
  return { applied };
}

async function applyInbound(deal: DealRecord, statusOfStage: Map<string, CallStatus>, now: Date): Promise<number> {
  // Loaded lazily: calls.ts pulls in the runtime, which registers these handlers, so a static import would be circular.
  const { acknowledgeCall, applyExternalStatus, reassignCall, UserError } = await import("@/lib/calls");
  const call = await one(db.select().from(schema.calls).where(eq(schema.calls.hubspotDealId, deal.id)).limit(1));
  const row = call ? await syncRow(call.id) : undefined;
  if (!call || !row || row.dirty) return 0; // not ours, or the app has unsent changes and wins

  let changes = 0;
  const p = deal.properties;
  const patch: Partial<typeof schema.hubspotSync.$inferInsert> = {};
  const ownerDesigner = await designerByOwner(p.hubspot_owner_id);

  // 1. Stage moved in HubSpot -> status override, logged.
  const stage = p.dealstage ?? null;
  if (stage && stage !== row.lastSeenStage) {
    const status = statusOfStage.get(stage);
    patch.lastSeenStage = stage;
    if (status === "yet_to_be_processed" && call.status !== "yet_to_be_processed") {
      await markDirty(call.id, true); // a processed call cannot go back to "unprocessed": tell HubSpot the truth again
    } else if (status && status !== call.status) {
      await applyExternalStatus(call.id, status, "Changed in HubSpot", ownerDesigner?.id ?? null, now);
      changes++;
    }
  }

  // 2. Acknowledged in HubSpot.
  const ackValue = p.acknowledged_at || null;
  if (ackValue && !call.acknowledgedAt && ackValue !== row.lastSeenAckAt) {
    const when = parseWhen(ackValue) ?? now;
    // Only a designer can acknowledge. A call nobody has been given yet cannot be acknowledged from HubSpot.
    const by = call.assignedDesignerId ?? (ownerDesigner?.role === "designer" ? ownerDesigner.id : null);
    if (by) {
      try {
        if (!call.assignedDesignerId) await reassignCall(call.id, by);
        await acknowledgeCall(call.id, by, when);
        changes++;
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
      }
    } else {
      await markDirty(call.id, true); // tell HubSpot the call is still unacknowledged
    }
  } else if (!ackValue && call.acknowledgedAt) {
    await markDirty(call.id, true); // cleared in HubSpot but the app has an acknowledgement: the app is right
  }
  if (ackValue !== row.lastSeenAckAt) patch.lastSeenAckAt = ackValue;

  // 3. Owner changed in HubSpot -> reassign to that designer.
  const owner = p.hubspot_owner_id || null;
  if (owner && owner !== row.lastSeenOwner) {
    patch.lastSeenOwner = owner;
    if (ownerDesigner && ownerDesigner.id !== call.assignedDesignerId) {
      try {
        await reassignCall(call.id, ownerDesigner.id);
        changes++;
      } catch (e) {
        if (!(e instanceof UserError)) throw e; // the new owner is not a designer, or the call is already acknowledged: keep the app's assignment
        await markDirty(call.id, true);
      }
    }
  }

  if (Object.keys(patch).length) await db.update(schema.hubspotSync).set({ ...patch, lastSyncedAt: new Date() }).where(eq(schema.hubspotSync.callId, call.id));
  return changes;
}

/** One pass: set up HubSpot if needed, push what is dirty, read back what changed. Called every minute. */
export async function runHubSpotCycle(now: Date = new Date()): Promise<{ pushed: number; failed: number; applied: number } | null> {
  const result = await withLease("hubspot-cycle", 120_000, async () => {
    try {
      const api = getHubSpot();
      const push = await syncDirty(api);
      const { applied } = await pollHubSpot(now, api);
      g.__hsLastCycleError = undefined;
      return { ...push, applied };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (g.__hsLastCycleError !== message) await audit("hubspot.cycle_error", { error: message }); // once per distinct error, not every minute
      g.__hsLastCycleError = message;
      return null;
    }
  });
  return result ?? null;
}

/** App events -> HubSpot, right away. The change is recorded first, so a HubSpot outage cannot lose it. */
export function registerHubSpotHandlers() {
  const push = async ({ callId }: { callId: number }) => {
    await markDirty(callId);
    // After the response is sent (on Vercel, work outside after() can be cut off). A failure stays dirty and is retried by the cron pass.
    if (g.__hsAutoPush !== false) background(() => syncCall(callId));
  };
  on("call.received", push);
  on("call.processed", push);
  on("call.acknowledged", push);
  on("call.overridden", push);
  on("call.assigned", push);
  on("booking.changed", push);
}

export { STAGES };
