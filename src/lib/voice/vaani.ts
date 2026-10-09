import { env } from "@/lib/env";
import type { IngestPayload } from "@/lib/ingest";
import type { VoiceProvider } from "./provider";

/**
 * Stub adapter for Vaanivoice.ai. Nothing here talks to Vaani yet.
 *
 * Known so far (from the studio, NOT yet checked against Vaani's docs):
 *   - base URL https://api.vaanivoice.ai (env VAANI_BASE_URL)
 *   - auth header X-API-Key (env VAANI_API_KEY)
 *   - a call-details endpoint returns transcript, entities, evaluation and summary
 *   - agents have an agent_id (env VAANI_AGENT_ID) and a system_prompt (see prompts/voice_agent.md)
 *   - NOT confirmed: whether Vaani sends end-of-call webhooks. Hence VAANI_INGEST_MODE=webhook|poll.
 *
 * TODO before integrating: read Vaani's CURRENT API docs, then fill in every method below.
 * Do not guess endpoint paths, payload field names, or signature schemes.
 */
export class VaaniAdapter implements VoiceProvider {
  readonly name = "vaani";

  get ingestMode(): "webhook" | "poll" {
    return env.VAANI_INGEST_MODE === "webhook" ? "webhook" : "poll";
  }

  verifyWebhook(_rawBody: string, _headers: Headers): boolean {
    // TODO(vaani-docs): how does Vaani sign webhooks (header name, algorithm)? Use VAANI_WEBHOOK_SECRET.
    throw notImplemented("verifyWebhook");
  }

  async parseWebhook(_rawBody: string): Promise<IngestPayload[]> {
    // TODO(vaani-docs): event name(s) for "call ended" and the payload shape.
    // TODO(mapping): external_id <- Vaani call id; caller_phone <- caller ID field (null if withheld, never ask the caller);
    //                started_at, duration_sec, transcript (flatten turns to "Agent: ..." / "Caller: ..." lines);
    //                booking_id / booked_slot <- the Cal.com booking the agent made, if the details expose it.
    throw notImplemented("parseWebhook");
  }

  async listCallsSince(_since: Date): Promise<IngestPayload[]> {
    // TODO(vaani-docs): list-calls endpoint, filters by agent_id and time, pagination.
    throw notImplemented("listCallsSince");
  }

  async fetchCall(_externalId: string): Promise<IngestPayload> {
    // TODO(vaani-docs): call-details endpoint (GET <VAANI_BASE_URL>/...) with header X-API-Key.
    // Then map to IngestPayload as in parseWebhook, and POST it to /api/calls (or call ingestCall directly).
    throw notImplemented("fetchCall");
  }
}

function notImplemented(method: string) {
  return new Error(`VaaniAdapter.${method} is not implemented yet. Read Vaani's current docs first; see the TODOs in src/lib/voice/vaani.ts.`);
}

export const voiceProvider: VoiceProvider = new VaaniAdapter();
