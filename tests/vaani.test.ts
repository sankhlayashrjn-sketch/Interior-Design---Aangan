import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { ingestCall } from "@/lib/ingest";
import { normaliseTranscript, spanFromTimestamps, toPayload, VaaniAdapter } from "@/lib/voice/vaani";
import { pollVaani } from "@/lib/voice/poll";
import { POST as webhook } from "@/app/api/vaani/webhook/route";
import { payloadFor, resetDb, sample } from "./helpers";

// Shapes copied from https://docs.vaanivoice.ai (call history, call details, webhook "call_postprocessing").
const historyCall = (over: Record<string, unknown> = {}) => ({
  call_id: "inbound-1784899978-aaaa1111",
  call_type: "Inbound",
  direction: "Incoming",
  agent_id: "agent-1",
  from_number: "+919822000111",
  to_number: "+918037565218",
  Start_time: "2026-10-09T05:30:00.000000",
  End_time: "2026-10-09T05:34:12.000000",
  duration_ms: 742.269, // Vaani's own figure disagrees with its timestamps, which is why we use the timestamps
  post_processing_status: "completed",
  ...over,
});

const TRANSCRIPT = sample("T01").transcript.split("\n").map((l) => l.replace(/^Agent:/, "AGENT:").replace(/^Caller:/, "USER:")).join("\n\n");

function stubVaani(calls: unknown[], details: Record<string, string> = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/call-history")) return new Response(JSON.stringify({ data: calls, pagination: { has_next: false } }), { status: 200 });
    const m = /\/api\/call_details\/([^/?]+)/.exec(u);
    if (m) return new Response(JSON.stringify({ transcription: details[decodeURIComponent(m[1])] ?? "Transcript is not available for further evaluations." }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  await resetDb();
  env.VAANI_API_KEY = "test-key";
  env.VAANI_BASE_URL = "https://api.vaanivoice.ai";
  env.VAANI_WEBHOOK_SECRET = "s3cret";
  env.VAANI_INGEST_MODE = "webhook";
  env.VAANI_AGENT_ID = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
  env.VAANI_API_KEY = "";
  env.VAANI_WEBHOOK_SECRET = "";
  env.VAANI_INGEST_MODE = "";
  env.VAANI_AGENT_ID = "";
});

describe("Vaani transcript and mapping", () => {
  it("turns Vaani's labels and timestamps into the app's Agent:/Caller: lines", () => {
    const out = normaliseTranscript("[13:33:14] AGENT: Hello\n\n[13:33:19] USER: Hi there\n\nAGENT: Bye");
    expect(out).toBe("Agent: Hello\nCaller: Hi there\nAgent: Bye");
  });

  it("maps a history record: inbound caller is the from-number, times are UTC, duration comes from the timestamps", () => {
    const p = toPayload(historyCall(), TRANSCRIPT);
    expect(p.external_id).toBe("inbound-1784899978-aaaa1111");
    expect(p.caller_phone).toBe("+919822000111");
    expect(p.started_at).toBe("2026-10-09T05:30:00.000Z");
    expect(p.duration_sec).toBe(252);
    expect(p.recording_url).toMatch(/\/api\/recording\/inbound-1784899978-aaaa1111$/);
    expect(p.transcript.split("\n")[0]).toMatch(/^Agent:/);
  });

  it("a withheld number becomes null, never a made-up one", () => {
    expect(toPayload(historyCall({ from_number: "" }), "x").caller_phone).toBeNull();
    expect(toPayload(historyCall({ from_number: null }), "x").caller_phone).toBeNull();
  });

  it("the mapped payload is accepted by the real pipeline and scored", async () => {
    const { call } = await ingestCall(toPayload(historyCall(), TRANSCRIPT));
    expect(call.status).toBe("qualified");
    expect(call.callerPhone).toBe("+919822000111");
  });
});

describe("Vaani webhook", () => {
  const evt = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      event: "call_postprocessing",
      call_id: "inbound-1784899978-aaaa1111",
      timestamp: "2026-10-09T05:34:30+00:00",
      data: { call_id: "inbound-1784899978-aaaa1111", call_duration: 252000, summary: "…", entities: {}, recording_url: "https://uat.vaaniresearch.com/api/stream/x", transcript: TRANSCRIPT },
      ...over,
    });

  it("call_postprocessing: transcript from the event, phone and start time from the history", async () => {
    stubVaani([historyCall()]);
    const [p] = await new VaaniAdapter().parseWebhook(evt());
    expect(p.caller_phone).toBe("+919822000111");
    expect(p.started_at).toBe("2026-10-09T05:30:00.000Z");
    expect(p.transcript).toContain("Caller:");
  });

  it("the email the caller gave (an entity) is carried onto the call", async () => {
    stubVaani([historyCall()]);
    const [p] = await new VaaniAdapter().parseWebhook(evt({ data: { call_id: "inbound-1784899978-aaaa1111", call_duration: 1000, transcript: TRANSCRIPT, entities: { customer_email: "Priya@Example.com" } } }));
    expect(p.caller_email).toBe("priya@example.com");
  });

  it("still stores the call, with caller ID unknown, if the history cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const [p] = await new VaaniAdapter().parseWebhook(evt());
    expect(p.caller_phone).toBeNull();
    expect(p.duration_sec).toBe(252);
    expect(p.external_id).toBe("inbound-1784899978-aaaa1111");
  });

  it("when the history is unavailable, the caller number comes from the earlier call_started event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const post = (qs: string, body: string) => webhook(new Request(`http://x/api/vaani/webhook${qs}`, { method: "POST", body }));
    await post("?key=s3cret", JSON.stringify({ event: "call_started", room_name: "inbound-1784899978-aaaa1111", status: "dialing", phone_number: "+91 98220 00111" }));
    const r = await post("?key=s3cret", evt());
    expect((await r.json()).created).toBe(1);
    const c = (await db.select().from(schema.calls))[0];
    expect(c.callerPhone).toBe("+919822000111");
  });

  it("a call with no call_duration gets its length from the transcript timestamps", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const body = JSON.stringify({ event: "call_postprocessing", call_id: "webrtc-1", timestamp: "2026-10-09T05:40:00+00:00", data: { call_id: "webrtc-1", transcript: "[13:00:10] AGENT: Hi\n\n[13:01:40] USER: Hello\n\n[13:03:10] AGENT: Bye" } });
    const [p] = await new VaaniAdapter().parseWebhook(body);
    expect(p.duration_sec).toBe(180);
    expect(spanFromTimestamps("no marks")).toBe(0);
  });

  it("other events and outbound calls are ignored", async () => {
    stubVaani([historyCall()]);
    const a = new VaaniAdapter();
    expect(await a.parseWebhook(JSON.stringify({ event: "call_started", room_name: "x" }))).toEqual([]);
    expect(await a.parseWebhook("not json")).toEqual([]);
    stubVaani([historyCall({ call_type: "Outbound", direction: "Outbound" })]);
    expect(await a.parseWebhook(evt())).toEqual([]);
  });

  it("the route rejects a wrong or missing secret and ingests with the right one, once", async () => {
    stubVaani([historyCall()]);
    const post = (qs: string) => webhook(new Request(`http://x/api/vaani/webhook${qs}`, { method: "POST", body: evt() }));
    expect((await post("")).status).toBe(401);
    expect((await post("?key=wrong")).status).toBe(401);
    expect(await db.select().from(schema.calls)).toHaveLength(0);

    const ok = await post("?key=s3cret");
    expect(ok.status).toBe(200);
    expect((await ok.json()).created).toBe(1);
    const again = await post("?key=s3cret"); // Vaani retries are harmless
    expect((await again.json()).created).toBe(0);
    expect(await db.select().from(schema.calls)).toHaveLength(1);
  });
});

describe("Vaani polling", () => {
  it("does nothing unless poll mode is on", async () => {
    stubVaani([historyCall()]);
    expect(await pollVaani()).toBeNull();
  });

  it("ingests finished inbound calls of our agent, skips outbound, other agents, and unfinished ones", async () => {
    env.VAANI_INGEST_MODE = "poll";
    env.VAANI_AGENT_ID = "agent-1";
    const calls = [
      historyCall(),
      historyCall({ call_id: "out-1", call_type: "Outbound", direction: "Outbound" }),
      historyCall({ call_id: "other-agent", agent_id: "agent-2" }),
      historyCall({ call_id: "not-ready", post_processing_status: "processing" }),
    ];
    stubVaani(calls, { "inbound-1784899978-aaaa1111": TRANSCRIPT, "out-1": TRANSCRIPT, "other-agent": TRANSCRIPT, "not-ready": TRANSCRIPT });
    const r = await pollVaani(new Date("2026-10-09T06:00:00Z"));
    expect(r?.created).toBe(1);
    expect((await db.select().from(schema.calls).where(eq(schema.calls.externalId, "inbound-1784899978-aaaa1111"))).length).toBe(1);
    expect((await db.select().from(schema.calls)).length).toBe(1);
    // A second pass finds the same call and creates nothing new.
    expect((await pollVaani(new Date("2026-10-09T06:01:00Z")))?.created).toBe(0);
  });

  it("an unreadable transcript is skipped for now, not stored empty", async () => {
    env.VAANI_INGEST_MODE = "poll";
    stubVaani([historyCall()], {}); // details say "Transcript is not available..."
    expect((await pollVaani(new Date("2026-10-09T06:00:00Z")))?.created).toBe(0);
    expect(await db.select().from(schema.calls)).toHaveLength(0);
  });
});

void payloadFor;

describe("the recording route", () => {
  it("loads on its own (no circular import through the booking code) and answers 404 when there is no recording", async () => {
    vi.resetModules();
    stubVaani([]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const { GET } = await import("@/app/api/recording/[callId]/route");
    const res = await GET(new Request("http://x/api/recording/nope"), { params: Promise.resolve({ callId: "nope" }) });
    expect(res.status).toBe(404);
  });
});
