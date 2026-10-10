import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import { assignCall, overrideStatus } from "@/lib/calls";
import { env } from "@/lib/env";
import { ingestCall } from "@/lib/ingest";
import { refreshTranscript } from "@/lib/voice/transcript";
import { callById, payloadFor, resetDb, sample } from "./helpers";

const VAANI = sample("T01").transcript.split("\n").map((l) => l.replace(/^Agent:/, "AGENT:").replace(/^Caller:/, "USER:")).join("\n\n");

function stubDetails(transcription: string | null, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => (status === 200 ? new Response(JSON.stringify({ transcription: transcription ?? "Transcript is not available for further evaluations." }), { status }) : new Response("{}", { status }))),
  );
}

beforeEach(async () => {
  await resetDb();
  env.VAANI_API_KEY = "k";
});
afterEach(() => {
  vi.unstubAllGlobals();
  env.VAANI_API_KEY = "";
});

describe("fetching the transcript from Vaani again", () => {
  it("fills in a call that arrived with no transcript, and scores it again", async () => {
    const { call } = await ingestCall(payloadFor("T01", { transcript: "" }));
    expect(call.transcript).toBe("");
    stubDetails(VAANI);
    const r = await refreshTranscript(call.id);
    expect(r).toEqual({ ok: true, message: "Transcript updated from Vaani" });
    const after = await callById(call.id);
    expect(after.transcript.split("\n")[0]).toMatch(/^Agent:/);
    expect(after.transcript).toContain("Caller:");
    expect(after.status).toBe("qualified"); // scored on the real conversation now
  });

  it("says so when Vaani has not finished, when it cannot be reached, and when nothing changed", async () => {
    const { call } = await ingestCall(payloadFor("T01"));
    stubDetails(null);
    expect((await refreshTranscript(call.id)).ok).toBe(false);
    stubDetails(null, 404);
    expect(await refreshTranscript(call.id)).toMatchObject({ ok: false, message: expect.stringMatching(/does not know/) });
    stubDetails(VAANI);
    await refreshTranscript(call.id);
    expect(await refreshTranscript(call.id)).toEqual({ ok: true, message: "Already up to date" });
  });

  it("re-analysing keeps who has the call and a status a person set by hand", async () => {
    const { call } = await ingestCall(payloadFor("T01", { transcript: "" }));
    await assignCall(call.id, 2, { id: null, how: "front_desk" });
    await overrideStatus(call.id, 2, "disqualified", "Checked by hand: out of scope");
    stubDetails(VAANI);
    await refreshTranscript(call.id);
    const after = await callById(call.id);
    expect(after.assignedDesignerId).toBe(2);
    expect(after.status).toBe("disqualified"); // the person's decision stands
    expect(after.transcript).toContain("Caller:");
  });

  it("never replaces a longer saved transcript with a shorter one", async () => {
    const { call } = await ingestCall(payloadFor("T01"));
    const saved = (await callById(call.id)).transcript;
    stubDetails("AGENT: Hi\n\nUSER: Hello");
    const r = await refreshTranscript(call.id);
    expect(r.ok).toBe(true);
    expect((await callById(call.id)).transcript).toBe(saved);
  });

  it("an unknown call id is reported, not thrown", async () => {
    expect(await refreshTranscript(9999)).toEqual({ ok: false, message: "Call not found" });
    void db;
    void schema;
    void eq;
  });
});

describe("a caller with an email can be reached", () => {
  it("no caller ID but an email is not 'No way to reach caller'", async () => {
    const withheld = (await ingestCall(payloadFor("T01", { caller_phone: null }))).call;
    const withEmail = (await ingestCall(payloadFor("T01", { caller_phone: null, caller_email: "p@example.com" }))).call;
    expect(withheld.reason ?? "").toMatch(/No way to reach caller/);
    expect(withEmail.reason ?? "").not.toMatch(/No way to reach caller/);
    expect(withEmail.status).toBe("qualified");
  });
});
