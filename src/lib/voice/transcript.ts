import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { reanalyseCall } from "@/lib/ingest";
import { fetchVaaniTranscript } from "./vaani";

export interface RefreshResult {
  ok: boolean;
  message: string;
}

/**
 * Ask Vaani for a call's transcript again and save it on the call. For when the transcript did not arrive with the
 * "call finished" message, or arrived incomplete. A changed transcript is scored again, since the first score was
 * made on less. Never makes the stored transcript shorter.
 */
export async function refreshTranscript(callId: number): Promise<RefreshResult> {
  const call = (await db.select().from(schema.calls).where(eq(schema.calls.id, callId)))[0];
  if (!call) return { ok: false, message: "Call not found" };
  let fresh = "";
  try {
    fresh = await fetchVaaniTranscript(call.externalId);
  } catch (e) {
    return { ok: false, message: e instanceof Error && /404/.test(e.message) ? "Vaani does not know this call" : "Could not reach Vaani. Try again in a minute." };
  }
  if (!fresh) return { ok: false, message: "Vaani has not finished the transcript yet. It usually takes a minute or two after the call." };
  if (fresh === call.transcript) return { ok: true, message: "Already up to date" };
  if (fresh.length < call.transcript.length) return { ok: true, message: "The saved transcript is already the longer one" };
  await db.update(schema.calls).set({ transcript: fresh }).where(eq(schema.calls.id, callId));
  await audit("transcript.refreshed", { chars: fresh.length }, callId);
  await reanalyseCall(callId);
  return { ok: true, message: "Transcript updated from Vaani" };
}
