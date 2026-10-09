import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { CallStatus } from "@/db/schema";
import { audit } from "@/lib/audit";
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
  __hsCycle?: boolean;
  __hsLastCycleError?: string;
};

/** Turn the immediate background push off (tests do, so they control exactly when HubSpot is called). */
export function setAutoPush(enabled: boolean) {
  g.__hsAutoPush = enabled;
}

const getCall = (id: number) => db.select().from(schema.calls).where(eq(schema.calls.id, id)).get();
const designerById = (id: number | null) => (id ? db.select().from(schema.designers).where(eq(schema.designers.id, id)).get() : undefined);
const designerByOwner = (ownerId: string | null | undefined) => (ownerId ? db.select().from(schema.designers).where(eq(schema.designers.hubspotOwnerId, ownerId)).get() : undefined);
const syncRow = (callId: number) => db.select().from(schema.hubspotSync).where(eq(schema.hubspotSync.callId, callId)).get();

async function metaFor(api: HubSpotApi): Promise<Meta> {
  if (g.__hsMeta?.api !== api) g.__hsMeta = { api, meta: await api.ensureSetup() };
  return g.__hsMeta.meta;
}

/** One sync at a time per call, so "received" and "processed" can never create two deals. */
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
export function markDirty(callId: number, force = false) {
  db.insert(schema.hubspotSync)
    .values({ callId, dirty: true, lastPushedHash: null })
    .onConflictDoUpdate({ target: schema.hubspotSync.callId, set: force ? { dirty: true, lastPushedHash: null } : { dirty: true } })
    .run();
}

/** Seed (demo) calls are never sent to a real HubSpot portal. Simulated calls are, so the integration can be tested. */
const isDemoCall = (c: { externalId: string }, api: HubSpotApi) => api.mode === "live" && c.externalId.startsWith("seed-");

const iso = (d: Date | null) => (d ? d.toISOString() : "");
const num = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

/** The deal properties for a call. Every field is always present so that cleared values also reach HubSpot. */
export function dealProperties(call: Call, meta: Meta): Record<string, string> {
  const owner = designerById(call.assignedDesignerId);
  const ackBy = designerById(call.acknowledgedBy);
  const cost = db.select().from(schema.callsCost).where(eq(schema.callsCost.callId, call.id)).get();
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
  return props;
}

/** Contact for this call: reuse a known one for the phone number, else find by phone in HubSpot, else create. */
async function resolveContact(api: HubSpotApi, call: Call): Promise<string> {
  if (call.hubspotContactId) return call.hubspotContactId;
  let id: string | null = null;

  if (call.callerPhone) {
    const sibling = db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.callerPhone, call.callerPhone), isNotNull(schema.calls.hubspotContactId)))
      .get();
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

  db.update(schema.calls).set({ hubspotContactId: id }).where(eq(schema.calls.id, call.id)).run();
  return id;
}

function fail(callId: number, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  const row = syncRow(callId);
  const attempts = (row?.attempts ?? 0) + 1;
  db.insert(schema.hubspotSync).values({ callId, dirty: true, attempts, lastError: message }).onConflictDoUpdate({ target: schema.hubspotSync.callId, set: { dirty: true, attempts, lastError: message } }).run();
  if (attempts <= 3) audit("hubspot.error", { error: message, attempts }, callId);
}

/**
 * Push one call to HubSpot: contact, deal, properties. Idempotent: nothing is sent if nothing changed.
 * On failure the call stays dirty and the next cycle retries; the app's data is never lost or blocked.
 */
export async function syncCall(callId: number, api: HubSpotApi = getHubSpot()): Promise<boolean> {
  return withLock(callId, async () => {
    try {
      const call0 = getCall(callId);
      if (!call0 || isDemoCall(call0, api)) return false;
      const meta = await metaFor(api);
      const contactId = await resolveContact(api, call0);

      let call = getCall(callId)!;
      const props = dealProperties(call, meta);
      const hash = hashOf(props);
      const row = syncRow(callId);
      let dealId = call.hubspotDealId;

      if (!dealId) {
        dealId = await api.createDeal(props);
        db.update(schema.calls).set({ hubspotDealId: dealId }).where(eq(schema.calls.id, callId)).run(); // saved before anything else can fail
        call = getCall(callId)!;
      } else if (row?.lastPushedHash !== hash) {
        await api.updateDeal(dealId, props);
      }
      if (!row?.lastPushedHash) await api.associateDealWithContact(dealId, contactId); // idempotent; only until the first full success

      db.insert(schema.hubspotSync)
        .values({ callId, dirty: false, attempts: 0, lastPushedHash: hash, lastSeenStage: props.dealstage, lastSeenAckAt: props.acknowledged_at || null, lastSeenOwner: props.hubspot_owner_id ?? null, lastSyncedAt: new Date(), lastError: null })
        .onConflictDoUpdate({ target: schema.hubspotSync.callId, set: { dirty: false, attempts: 0, lastPushedHash: hash, lastSeenStage: props.dealstage, lastSeenAckAt: props.acknowledged_at || null, lastSeenOwner: props.hubspot_owner_id ?? null, lastSyncedAt: new Date(), lastError: null } })
        .run();
      return true;
    } catch (e) {
      fail(callId, e);
      if (e instanceof HubSpotError && e.status === 429) throw e; // stop the whole cycle, HubSpot asked us to slow down
      return false;
    }
  });
}

/** Give every call that has never been synced a dirty row, then push everything dirty. */
export async function syncDirty(api: HubSpotApi = getHubSpot()): Promise<{ pushed: number; failed: number }> {
  const known = db.select({ id: schema.hubspotSync.callId }).from(schema.hubspotSync).all().map((r) => r.id);
  const unsynced = db.select().from(schema.calls).where(known.length ? notInArray(schema.calls.id, known) : undefined).all();
  for (const c of unsynced) if (!isDemoCall(c, api)) markDirty(c.id);

  const out = { pushed: 0, failed: 0 };
  for (const r of db.select().from(schema.hubspotSync).where(eq(schema.hubspotSync.dirty, true)).all()) {
    const c = getCall(r.callId);
    if (c && isDemoCall(c, api)) {
      db.update(schema.hubspotSync).set({ dirty: false }).where(eq(schema.hubspotSync.callId, r.callId)).run(); // demo data: leave it out for good
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
  const stored = db.select().from(schema.appState).where(eq(schema.appState.key, CURSOR_KEY)).get();
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
  db.insert(schema.appState).values({ key: CURSOR_KEY, value: String(cursor) }).onConflictDoUpdate({ target: schema.appState.key, set: { value: String(cursor) } }).run();
  return { applied };
}

async function applyInbound(deal: DealRecord, statusOfStage: Map<string, CallStatus>, now: Date): Promise<number> {
  // Loaded lazily: calls.ts pulls in the runtime, which registers these handlers, so a static import would be circular.
  const { acknowledgeCall, applyExternalStatus, reassignCall } = await import("@/lib/calls");
  const call = db.select().from(schema.calls).where(eq(schema.calls.hubspotDealId, deal.id)).get();
  const row = call ? syncRow(call.id) : undefined;
  if (!call || !row || row.dirty) return 0; // not ours, or the app has unsent changes and wins

  let changes = 0;
  const p = deal.properties;
  const patch: Partial<typeof schema.hubspotSync.$inferInsert> = {};
  const ownerDesigner = designerByOwner(p.hubspot_owner_id);

  // 1. Stage moved in HubSpot -> status override, logged.
  const stage = p.dealstage ?? null;
  if (stage && stage !== row.lastSeenStage) {
    const status = statusOfStage.get(stage);
    patch.lastSeenStage = stage;
    if (status === "yet_to_be_processed" && call.status !== "yet_to_be_processed") {
      markDirty(call.id, true); // a processed call cannot go back to "unprocessed": tell HubSpot the truth again
    } else if (status && status !== call.status) {
      await applyExternalStatus(call.id, status, "Changed in HubSpot", ownerDesigner?.id ?? null, now);
      changes++;
    }
  }

  // 2. Acknowledged in HubSpot.
  const ackValue = p.acknowledged_at || null;
  if (ackValue && !call.acknowledgedAt && ackValue !== row.lastSeenAckAt) {
    const when = parseWhen(ackValue) ?? now;
    await acknowledgeCall(call.id, ownerDesigner?.id ?? call.assignedDesignerId ?? 0, when);
    changes++;
  } else if (!ackValue && call.acknowledgedAt) {
    markDirty(call.id, true); // cleared in HubSpot but the app has an acknowledgement: the app is right
  }
  if (ackValue !== row.lastSeenAckAt) patch.lastSeenAckAt = ackValue;

  // 3. Owner changed in HubSpot -> reassign to that designer.
  const owner = p.hubspot_owner_id || null;
  if (owner && owner !== row.lastSeenOwner) {
    patch.lastSeenOwner = owner;
    if (ownerDesigner && ownerDesigner.id !== call.assignedDesignerId) {
      await reassignCall(call.id, ownerDesigner.id);
      changes++;
    }
  }

  if (Object.keys(patch).length) db.update(schema.hubspotSync).set({ ...patch, lastSyncedAt: new Date() }).where(eq(schema.hubspotSync.callId, call.id)).run();
  return changes;
}

/** One pass: set up HubSpot if needed, push what is dirty, read back what changed. Called every minute. */
export async function runHubSpotCycle(now: Date = new Date()): Promise<{ pushed: number; failed: number; applied: number } | null> {
  if (g.__hsCycle) return null;
  g.__hsCycle = true;
  try {
    const api = getHubSpot();
    const push = await syncDirty(api);
    const { applied } = await pollHubSpot(now, api);
    g.__hsLastCycleError = undefined;
    return { ...push, applied };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (g.__hsLastCycleError !== message) audit("hubspot.cycle_error", { error: message }); // once per distinct error, not every minute
    g.__hsLastCycleError = message;
    return null;
  } finally {
    g.__hsCycle = false;
  }
}

/** App events -> HubSpot, right away. The change is recorded first, so a HubSpot outage cannot lose it. */
export function registerHubSpotHandlers() {
  const push = ({ callId }: { callId: number }) => {
    markDirty(callId);
    if (g.__hsAutoPush !== false) void syncCall(callId).catch(() => undefined);
  };
  on("call.received", push);
  on("call.processed", push);
  on("call.acknowledged", push);
  on("call.overridden", push);
  on("call.reassigned", push);
  on("booking.changed", push);
}

export { STAGES };
