import type { CallStatus } from "@/db/schema";

export const PIPELINE_LABEL = "Phone Enquiries";

/** Deal stages, in pipeline order. The label is what people see in HubSpot. */
export const STAGES: { status: CallStatus; label: string; probability: string }[] = [
  { status: "yet_to_be_processed", label: "Yet to be processed", probability: "0.1" },
  { status: "qualified", label: "Qualified", probability: "0.5" },
  { status: "disqualified", label: "Disqualified", probability: "0.1" },
  { status: "needs_attention", label: "Needs attention", probability: "0.3" },
];

export const GROUP = { name: "aangan_enquiry_desk", label: "Aangan Enquiry Desk" };

/** Custom deal properties created on startup if missing. */
export const PROPERTIES: { name: string; label: string; type: "string" | "number" | "datetime"; fieldType: "text" | "textarea" | "number" | "date" }[] = [
  { name: "ai_score", label: "AI score", type: "number", fieldType: "number" },
  { name: "ai_status", label: "AI status", type: "string", fieldType: "text" },
  { name: "ai_reason", label: "AI reason", type: "string", fieldType: "textarea" },
  { name: "ai_summary", label: "AI summary", type: "string", fieldType: "textarea" },
  { name: "call_transcript_url", label: "Call transcript URL", type: "string", fieldType: "text" },
  { name: "acknowledged_at", label: "Acknowledged at", type: "datetime", fieldType: "date" },
  { name: "acknowledged_by", label: "Acknowledged by", type: "string", fieldType: "text" },
  { name: "call_ai_cost_inr", label: "Call AI cost (INR)", type: "number", fieldType: "number" },
  { name: "call_telephony_cost_inr", label: "Call telephony cost (INR)", type: "number", fieldType: "number" },
  // Beyond the required set: booking info and the id that links a deal back to the app.
  { name: "booked_slot", label: "Booked slot", type: "datetime", fieldType: "date" },
  { name: "booking_status", label: "Booking status", type: "string", fieldType: "text" },
  { name: "app_call_id", label: "App call ID", type: "string", fieldType: "text" },
];

export interface Meta {
  pipelineId: string;
  /** status -> HubSpot stage id */
  stages: Record<CallStatus, string>;
}

export interface DealRecord {
  id: string;
  properties: Record<string, string | null>;
}

export interface ContactMatch {
  id: string;
  firstname: string | null;
}

/** Everything the sync needs from HubSpot. Implemented by RealHubSpot (HTTP) and MockHubSpot (in memory). */
export interface HubSpotApi {
  readonly mode: "live" | "mock";
  /** Create missing properties and the "Phone Enquiries" pipeline and stages. Safe to repeat. */
  ensureSetup(): Promise<Meta>;
  findContactByPhone(phone: string): Promise<ContactMatch | null>;
  createContact(props: Record<string, string>): Promise<string>;
  updateContact(id: string, props: Record<string, string>): Promise<void>;
  createDeal(props: Record<string, string>): Promise<string>;
  updateDeal(id: string, props: Record<string, string>): Promise<void>;
  associateDealWithContact(dealId: string, contactId: string): Promise<void>;
  /** Deals in the pipeline modified at or after `sinceMs`, with the properties the sync reads. */
  searchDealsModifiedSince(pipelineId: string, sinceMs: number): Promise<DealRecord[]>;
  /** Every deal in the pipeline (for the reports script). */
  listDeals(pipelineId: string): Promise<DealRecord[]>;
  /** Move a deal or contact to HubSpot's recycle bin (used to clean up test records). */
  archiveDeal(id: string): Promise<void>;
  archiveContact(id: string): Promise<void>;
}

export class HubSpotError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    /** Seconds to wait, from a 429 response. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** The deal properties the sync reads back from HubSpot. */
export const READ_PROPERTIES = ["dealname", "dealstage", "pipeline", "hubspot_owner_id", "acknowledged_at", "acknowledged_by", "ai_status", "app_call_id", "hs_lastmodifieddate", "hs_createdate", "createdate", "ai_score", "ai_reason", "call_ai_cost_inr", "call_telephony_cost_inr"];
