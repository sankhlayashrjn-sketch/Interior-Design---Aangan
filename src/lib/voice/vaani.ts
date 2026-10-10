import { eq } from "drizzle-orm";
import { db, one, schema } from "@/db";
import { env } from "@/lib/env";
import type { IngestPayload } from "@/lib/ingest";
import type { VoiceProvider } from "./provider";

/**
 * Adapter for Vaanivoice.ai, built from Vaani's published API docs (https://docs.vaanivoice.ai):
 *   auth        header X-API-Key
 *   history     GET /api/call-history?page&page_size        -> { data: [call], pagination }
 *   details     GET /api/call_details/{call_id}             -> { transcription, entity, summary, ... }
 *   transcript  GET /api/transcript/{call_id}               -> { transcript }
 *   audio       GET /api/stream/{call_id}                   -> audio/ogg or audio/mpeg (needs the key)
 *   webhook     POST to the URL set in the Vaani dashboard (Settings > Webhooks); the one we use is
 *               "call_postprocessing" (transcript, summary, entities ready). Vaani documents no signature,
 *               so our webhook URL carries a secret (see src/app/api/vaani/webhook/route.ts).
 *
 * Only INBOUND calls are ingested: this app handles incoming enquiries.
 */

const base = () => (env.VAANI_BASE_URL || "https://api.vaanivoice.ai").replace(/\/$/, "");
const headers = () => ({ "X-API-Key": env.VAANI_API_KEY });

/** One record from /api/call-history. Only the fields we use. */
export interface VaaniHistoryCall {
  call_id: string;
  call_type?: string;
  direction?: string;
  agent_id?: string;
  from_number?: string | null;
  to_number?: string | null;
  Start_time?: string | null;
  End_time?: string | null;
  duration_ms?: number | null;
  post_processing_status?: string | null;
}

export class VaaniError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  if (!env.VAANI_API_KEY) throw new VaaniError("VAANI_API_KEY is not set");
  const res = await fetch(`${base()}${path}`, { headers: headers(), signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || body === null) throw new VaaniError(`Vaani ${res.status} on ${path.split("?")[0]}`, res.status);
  return body;
}

/**
 * Vaani's transcript lines look like "[13:33:14] AGENT: ..." or "AGENT: ..." / "USER: ...", separated by blank lines.
 * The app reads "Agent:" and "Caller:". Timestamps are dropped, empty lines removed.
 */
export function normaliseTranscript(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .split("\n")
    .map((l) => l.trim().replace(/^\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/, ""))
    .filter(Boolean)
    .map((l) => l.replace(/^user\s*:/i, "Caller:").replace(/^agent\s*:/i, "Agent:"))
    .join("\n");
}

/** Vaani sends times without a zone ("2026-04-21T12:27:23.335803"). They are UTC. */
function asUtc(s: string): Date {
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
}

const isInbound = (c: Pick<VaaniHistoryCall, "call_type" | "direction">) => /inbound|incoming/i.test(`${c.call_type ?? ""} ${c.direction ?? ""}`);

/** The caller's number: for an inbound call it is the number the call came from. Null when withheld. */
function callerNumber(c: VaaniHistoryCall): string | null {
  const n = (isInbound(c) ? c.from_number : c.to_number)?.trim();
  return n && /\d{6,}/.test(n) ? n : null;
}

/** Recordings need Vaani's key, so designers play them through this app (see /api/recording/[callId]). */
export const recordingUrl = (callId: string) => `${env.APP_BASE_URL.replace(/\/$/, "")}/api/recording/${encodeURIComponent(callId)}`;

/** Turn a history record plus its transcript into the payload POST /api/calls accepts. */
export function toPayload(c: VaaniHistoryCall, transcript: string): IngestPayload {
  const started = c.Start_time ? asUtc(c.Start_time) : new Date();
  const ended = c.End_time ? asUtc(c.End_time) : null;
  // Prefer the wall-clock span. Vaani's duration_ms has been seen to disagree with the timestamps, so it is only a fallback.
  const seconds = ended ? (ended.getTime() - started.getTime()) / 1000 : (c.duration_ms ?? 0) / 1000;
  return {
    external_id: c.call_id,
    caller_phone: callerNumber(c),
    started_at: started.toISOString(),
    duration_sec: Math.max(0, Math.round(seconds)),
    transcript: normaliseTranscript(transcript),
    recording_url: recordingUrl(c.call_id),
  };
}

/** Look a call up in the history, newest first, giving up after `maxPages`. */
async function findInHistory(callId: string, maxPages = 5): Promise<VaaniHistoryCall | null> {
  for (let page = 1; page <= maxPages; page++) {
    const r = await get<{ data: VaaniHistoryCall[]; pagination?: { has_next?: boolean } }>(`/api/call-history?page=${page}&page_size=100`);
    const hit = r.data.find((c) => c.call_id === callId);
    if (hit) return hit;
    if (!r.pagination?.has_next) break;
  }
  return null;
}

async function transcriptFor(callId: string): Promise<string> {
  const d = await get<{ transcription?: unknown }>(`/api/call_details/${encodeURIComponent(callId)}`);
  // Until post-processing finishes Vaani answers with a sentence instead of a transcript.
  return typeof d.transcription === "string" && /(agent|user)\s*:/i.test(d.transcription) ? d.transcription : "";
}

const phoneKey = (callId: string) => `vaani_phone:${callId}`;

/**
 * Vaani's call-history can fail for an account (it has answered 500 "Invalid client_id format" here), and the
 * finished-call event carries no phone number. The earlier "call_started" event does (phone_number, keyed by
 * room_name = call id), so remember it until the transcript arrives.
 */
export async function rememberCallerPhone(rawBody: string): Promise<void> {
  try {
    const evt = JSON.parse(rawBody) as { event?: string; room_name?: string; phone_number?: string };
    const phone = evt.phone_number?.trim();
    const digits = phone?.replace(/[\s-]/g, "") ?? "";
    if (!evt.room_name || !/^\+?\d{8,15}$/.test(digits)) return;
    const value = digits.startsWith("+") ? digits : `+${digits}`;
    await db.insert(schema.appState).values({ key: phoneKey(evt.room_name), value }).onConflictDoUpdate({ target: schema.appState.key, set: { value } });
  } catch {
    /* an event we cannot read is simply not remembered */
  }
}

const recallPhone = async (callId: string) => (await one(db.select().from(schema.appState).where(eq(schema.appState.key, phoneKey(callId)))))?.value ?? null;

/** Milliseconds between the first and last "[hh:mm:ss]" marker in a transcript, or 0 if there are fewer than two. */
export function spanFromTimestamps(transcript: string): number {
  const marks = [...transcript.matchAll(/\[(\d{1,2}):(\d{2}):(\d{2})\]/g)].map((m) => ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000);
  if (marks.length < 2) return 0;
  const span = marks[marks.length - 1] - marks[0];
  return span >= 0 ? span : span + 86_400_000; // a call that crossed midnight
}

export class VaaniAdapter implements VoiceProvider {
  readonly name = "vaani";

  get ingestMode(): "webhook" | "poll" {
    return env.VAANI_INGEST_MODE === "poll" ? "poll" : "webhook";
  }

  /** Vaani documents no signature, so the request must carry our secret (header or ?key=). Never open in production. */
  verifyWebhook(_rawBody: string, hdrs: Headers, urlKey?: string | null): boolean {
    const secret = env.VAANI_WEBHOOK_SECRET;
    if (!secret) return process.env.NODE_ENV !== "production";
    const given = urlKey ?? hdrs.get("x-webhook-secret") ?? "";
    return given.length === secret.length && given === secret;
  }

  /**
   * Only "call_postprocessing" matters: it is the one event that carries the finished transcript. Everything else
   * (started, ringing, ended, transfers) returns nothing. The event has no phone number or start time, so those
   * come from the call history; if the history cannot be read the call is still stored, with caller ID unknown.
   */
  async parseWebhook(rawBody: string): Promise<IngestPayload[]> {
    let evt: { event?: string; call_id?: string; timestamp?: string; data?: Record<string, unknown> };
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return [];
    }
    if (evt.event !== "call_postprocessing" || !evt.data) return [];
    const d = evt.data;
    const callId = String(d.call_id ?? evt.call_id ?? d.room_name ?? "");
    if (!callId) return [];

    let record: VaaniHistoryCall | null = null;
    try {
      record = await findInHistory(callId, 2);
    } catch {
      /* fall back to what the event itself says */
    }
    if (record && !isInbound(record)) return []; // an outbound call is not an enquiry
    const rawTranscript = typeof d.transcript === "string" ? d.transcript : "";
    // Some calls (browser test calls) arrive without a call_duration; the transcript's own timestamps still tell the length.
    const durationMs = Number(d.call_duration) || spanFromTimestamps(rawTranscript);
    const ended = evt.timestamp ? new Date(evt.timestamp) : new Date();
    const fallback: VaaniHistoryCall = {
      call_id: callId,
      call_type: "Inbound",
      from_number: null,
      Start_time: new Date(ended.getTime() - durationMs).toISOString(),
      End_time: ended.toISOString(),
    };
    if (!record) fallback.from_number = await recallPhone(callId);
    const payload = toPayload(record ?? fallback, typeof d.transcript === "string" ? d.transcript : "");
    if (typeof d.recording_url === "string" && d.recording_url) payload.recording_url = recordingUrl(callId);
    return [payload];
  }

  /** Inbound calls that ended after `since`, with finished transcripts. History is read newest first. */
  async listCallsSince(since: Date): Promise<IngestPayload[]> {
    const out: IngestPayload[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await get<{ data: VaaniHistoryCall[]; pagination?: { has_next?: boolean } }>(`/api/call-history?page=${page}&page_size=100`);
      let reachedOld = false;
      for (const c of r.data) {
        const started = c.Start_time ? asUtc(c.Start_time) : null;
        if (started && started < since) {
          reachedOld = true;
          continue;
        }
        if (!isInbound(c)) continue;
        if (env.VAANI_AGENT_ID && c.agent_id && c.agent_id !== env.VAANI_AGENT_ID) continue;
        if (c.post_processing_status && c.post_processing_status !== "completed") continue; // picked up on a later pass
        const transcript = await transcriptFor(c.call_id).catch(() => "");
        if (!transcript) continue;
        out.push(toPayload(c, transcript));
      }
      if (reachedOld || !r.pagination?.has_next) break;
    }
    return out;
  }

  async fetchCall(externalId: string): Promise<IngestPayload> {
    const record = await findInHistory(externalId);
    if (!record) throw new VaaniError(`Call ${externalId} was not found in Vaani's history`, 404);
    return toPayload(record, await transcriptFor(externalId));
  }
}

export const voiceProvider: VoiceProvider = new VaaniAdapter();

/** Stream a call's recording from Vaani. Returns null if there is none (yet). */
export async function fetchRecording(callId: string): Promise<Response | null> {
  if (!env.VAANI_API_KEY) return null;
  const res = await fetch(`${base()}/api/stream/${encodeURIComponent(callId)}`, { headers: headers(), signal: AbortSignal.timeout(60_000) });
  return res.ok ? res : null;
}
