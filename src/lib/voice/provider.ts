import type { IngestPayload } from "@/lib/ingest";

/**
 * The seam between a voice vendor and this app. An adapter turns the vendor's call record into the
 * IngestPayload that POST /api/calls already accepts, so the pipeline never knows which vendor it is.
 */
export interface VoiceProvider {
  readonly name: string;
  /** "webhook": the vendor pushes an end-of-call event. "poll": we ask for calls since a time. */
  readonly ingestMode: "webhook" | "poll";

  /** Webhook mode: verify the request is genuine (signature or shared secret). */
  verifyWebhook(rawBody: string, headers: Headers): boolean;

  /** Webhook mode: turn the vendor's event into zero or more payloads. */
  parseWebhook(rawBody: string): Promise<IngestPayload[]>;

  /** Poll mode: list calls that ended after `since`, already normalised. */
  listCallsSince(since: Date): Promise<IngestPayload[]>;

  /** Fetch one call's full detail (transcript, entities, evaluation, summary) and normalise it. */
  fetchCall(externalId: string): Promise<IngestPayload>;
}
