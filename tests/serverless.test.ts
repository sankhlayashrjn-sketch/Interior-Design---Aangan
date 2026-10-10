import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLease, db, one, releaseLease, schema, withLease } from "@/db";
import { acknowledgeCall } from "@/lib/calls";
import { on } from "@/lib/hooks";
import { ingestCall, processCall } from "@/lib/ingest";
import { runDueJobs } from "@/lib/reminders";
import { runTick } from "@/lib/scheduler";
import { allCalls, istIso, payloadFor, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.unstubAllEnvs());

const at = (s: string) => new Date(istIso(s));
const costRows = () => db.select().from(schema.callsCost);
const auditKinds = async () => (await db.select().from(schema.auditLog)).map((r) => r.kind);

/**
 * On Vercel several servers can act at the same moment, so "nobody else is doing this" can never be assumed.
 * These tests fire the competing work together and check that exactly one of them takes effect.
 */
describe("two servers at the same moment", () => {
  it("the same call arriving twice at once is stored and scored once", async () => {
    const p = payloadFor("T01");
    const [a, b] = await Promise.all([ingestCall(p), ingestCall(p)]);
    expect([a.outcome, b.outcome].sort()).toEqual(["created", "duplicate"]);
    expect(await allCalls()).toHaveLength(1);
    expect(await costRows()).toHaveLength(1);
  });

  it("a call picked up by two workers is processed exactly once", async () => {
    const { call } = await ingestCall(payloadFor("T01"), { process: false });
    const processed: number[] = [];
    on("call.processed", ({ callId }) => void processed.push(callId));
    await Promise.all([processCall(call.id), processCall(call.id), processCall(call.id)]);
    expect(processed).toEqual([call.id]);
    expect(await costRows()).toHaveLength(1);
    // The round-robin advanced once: the next call goes to the second designer, not the third.
    const next = (await ingestCall(payloadFor("T02"))).call;
    expect(next.assignedDesignerId).toBe(2);
  });

  it("a worker that died mid-call does not strand it: the claim expires and another worker takes over", async () => {
    const { call } = await ingestCall(payloadFor("T01"), { process: false });
    await db.update(schema.calls).set({ processingStartedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(schema.calls.id, call.id));
    const done = await processCall(call.id);
    expect(done.processedAt).not.toBeNull();
  });

  it("a fresh claim by another worker is respected", async () => {
    const { call } = await ingestCall(payloadFor("T01"), { process: false });
    await db.update(schema.calls).set({ processingStartedAt: new Date() }).where(eq(schema.calls.id, call.id));
    const r = await processCall(call.id);
    expect(r.processedAt).toBeNull(); // someone else is on it
    expect(await costRows()).toHaveLength(0);
  });

  it("the assignee acknowledging from two devices at once: one wins, only one announcement goes out, and nobody else can", async () => {
    const { call } = await ingestCall(payloadFor("T01"));
    const seen: number[] = [];
    on("call.acknowledged", ({ callId }) => void seen.push(callId));
    const me = call.assignedDesignerId!;
    const other = me === 1 ? 2 : 1;
    await expect(acknowledgeCall(call.id, other, at("2026-10-07 11:19"))).rejects.toThrow(/assigned to/);
    await Promise.all([acknowledgeCall(call.id, me, at("2026-10-07 11:20")), acknowledgeCall(call.id, me, at("2026-10-07 11:21"))]);
    expect(seen).toHaveLength(1);
    const row = (await one(db.select().from(schema.calls).where(eq(schema.calls.id, call.id))))!;
    expect(row.acknowledgedBy).toBe(me);
  });

  it("two reminder runs at once send each reminder once", async () => {
    await ingestCall(payloadFor("T01", { started_at: istIso("2026-10-07 11:00") }));
    await db.update(schema.designers).set({ telegramChatId: "111" }).where(eq(schema.designers.id, 1));
    const [a, b] = await Promise.all([runDueJobs(at("2026-10-07 13:00")), runDueJobs(at("2026-10-07 13:00"))]);
    expect(a.sent + b.sent).toBe(1);
    const sends = (await db.select().from(schema.auditLog)).filter((r) => r.kind === "mock.telegram.send");
    expect(sends).toHaveLength(1);
  });
});

describe("local database safety", () => {
  it("refuses to open a database folder another live process is using, with a plain message", async () => {
    const folder = path.join(mkdtempSync(path.join(tmpdir(), "pglite-lock-")), "db");
    writeFileSync(`${folder}.lock`, String(process.ppid)); // the parent process is alive and is not us
    const saved = globalThis.__engine;
    globalThis.__engine = undefined;
    try {
      vi.stubEnv("DATABASE_URL", folder);
      vi.resetModules();
      const { runMigrations } = await import("@/db");
      expect(() => runMigrations()).toThrow(/already open in another process/);
    } finally {
      globalThis.__engine = saved;
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("leases", () => {
  it("only one holder at a time, and release frees it", async () => {
    expect(await acquireLease("x", 60_000)).toBe(true);
    expect(await acquireLease("x", 60_000)).toBe(false);
    await releaseLease("x");
    expect(await acquireLease("x", 60_000)).toBe(true);
  });

  it("a lease held by a dead server runs out by itself", async () => {
    expect(await acquireLease("y", 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 15));
    expect(await acquireLease("y", 60_000)).toBe(true);
  });

  it("withLease skips the work when the lease is taken, and releases it even if the work throws", async () => {
    await acquireLease("z", 60_000);
    let ran = false;
    expect(await withLease("z", 60_000, async () => (ran = true))).toBeUndefined();
    expect(ran).toBe(false);
    await releaseLease("z");
    await expect(withLease("z", 60_000, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await acquireLease("z", 60_000)).toBe(true); // released despite the error
  });
});

describe("the tick (what Vercel Cron, an outside pinger, or the local timer runs)", () => {
  it("processes waiting calls, queues reminders for them, sends what is due, and syncs HubSpot", async () => {
    await ingestCall(payloadFor("T01", { started_at: istIso("2026-10-07 11:00") }), { process: false });
    const r = await runTick(at("2026-10-07 11:05"));
    expect(r.processed).toBe(1);
    expect(r.hubspot).toMatchObject({ failed: 0 });
    expect((await db.select().from(schema.reminderJobs)).length).toBeGreaterThan(0);
  });

  it("is safe to run over and over: a second tick does nothing new", async () => {
    await ingestCall(payloadFor("T01", { started_at: istIso("2026-10-07 11:00") }));
    await db.update(schema.designers).set({ telegramChatId: "111" }).where(eq(schema.designers.id, 1));
    const first = await runTick(at("2026-10-07 13:00"));
    const second = await runTick(at("2026-10-07 13:01"));
    expect(first.reminders.sent).toBe(1);
    expect(second.reminders.sent).toBe(0);
    expect(second.processed).toBe(0);
    expect((await auditKinds()).filter((k) => k === "mock.telegram.send")).toHaveLength(1);
  });
});

describe("GET /api/cron/tick", () => {
  async function route(env: Record<string, string>) {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.resetModules(); // re-read the environment
    return (await import("@/app/api/cron/tick/route")).GET;
  }
  const req = (auth?: string) => new Request("http://localhost/api/cron/tick", { headers: auth ? { authorization: auth } : {} });

  it("rejects a missing or wrong secret and accepts the right one", async () => {
    const GET = await route({ CRON_SECRET: "s3cret", NODE_ENV: "production" });
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer wrong"))).status).toBe(401);
    expect((await GET(req("s3cret"))).status).toBe(401);
    const ok = await GET(req("Bearer s3cret"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
  });

  it("in production with no CRON_SECRET it refuses everyone", async () => {
    const GET = await route({ CRON_SECRET: "", NODE_ENV: "production" });
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer "))).status).toBe(401);
  });

  it("on a laptop (development) with no secret it is open, for easy testing", async () => {
    const GET = await route({ CRON_SECRET: "", NODE_ENV: "development" });
    expect((await GET(req())).status).toBe(200);
  });
});

describe("POST /api/calls access", () => {
  async function post(env: Record<string, string>, headers: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.resetModules();
    const { POST } = await import("@/app/api/calls/route");
    const body = JSON.stringify({ ...payloadFor("T01") });
    return POST(new Request("http://localhost/api/calls", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));
  }

  it("with a key set, rejects a missing or wrong key and accepts the right one", async () => {
    expect((await post({ INGEST_API_KEY: "k1", NODE_ENV: "production" })).status).toBe(401);
    expect((await post({ INGEST_API_KEY: "k1", NODE_ENV: "production" }, { "x-api-key": "nope" })).status).toBe(401);
    expect((await post({ INGEST_API_KEY: "k1", NODE_ENV: "production" }, { "x-api-key": "k1" })).status).toBe(201);
  });

  it("in production with no key it refuses everything rather than running open", async () => {
    expect((await post({ INGEST_API_KEY: "", NODE_ENV: "production" })).status).toBe(401);
    expect((await post({ INGEST_API_KEY: "", NODE_ENV: "production" }, { "x-api-key": "" })).status).toBe(401);
  });

  it("on a laptop with no key it is open, so the Simulate screen and curl just work", async () => {
    expect((await post({ INGEST_API_KEY: "", NODE_ENV: "development" })).status).toBe(201);
  });
});
