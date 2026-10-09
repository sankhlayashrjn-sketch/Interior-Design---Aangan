import type { CallStatus } from "@/db/schema";
import type { CriterionKey, RubricInput } from "@/lib/rubric";

/**
 * Hand-scored criteria for the 20 phone transcripts in context/. These are the calibration
 * targets: the rubric weights, caps and bands must turn these points into the expected status.
 * Order: service_fit, scale, budget, location, timeline, property_dm, next_step.
 */
type Pts = [number, number, number, number, number, number, number];
const KEYS: CriterionKey[] = ["service_fit", "scale", "budget", "location", "timeline", "property_dm", "next_step"];

export interface Gold {
  id: string;
  expected: Exclude<CallStatus, "yet_to_be_processed">;
  /** What the literal brief gives (cap 69) when it differs from the recommended result. */
  literal?: Exclude<CallStatus, "yet_to_be_processed">;
  pts: Pts;
  clearNo?: { key: "service_fit" | "location"; quote: string };
  existingClient?: boolean;
  proxyNoAuthority?: boolean;
  tag?: string;
  note: string;
}

export const GOLD: Gold[] = [
  { id: "T01", expected: "qualified", pts: [25, 20, 8, 10, 15, 10, 3], note: "3BHK Kothrud, owner, husband authorised" },
  { id: "T02", expected: "qualified", pts: [25, 20, 8, 10, 15, 7, 3], note: "Asked for a price twice: neutral" },
  {
    id: "T03", expected: "disqualified", literal: "needs_attention", pts: [25, 12, 8, 0, 8, 7, 0],
    clearNo: { key: "location", quote: "I'm in Nashik" }, note: "Nashik, outside service area",
  },
  {
    id: "T04", expected: "disqualified", literal: "needs_attention", pts: [0, 5, 8, 5, 7, 5, 0],
    clearNo: { key: "service_fit", quote: "Just want suggestions on colours, furniture arrangement" }, note: "Advice only, no execution",
  },
  { id: "T05", expected: "qualified", pts: [25, 20, 8, 10, 15, 8, 3], note: "4BHK Koregaon Park, referral" },
  { id: "T06", expected: "qualified", pts: [25, 20, 8, 10, 15, 10, 3], note: "800 sq ft startup office, founder" },
  { id: "T07", expected: "needs_attention", pts: [25, 14, 8, 5, 5, 5, 3], note: "Wants it before Diwali (3 weeks), then 'after Diwali'" },
  { id: "T08", expected: "needs_attention", pts: [12, 10, 8, 5, 8, 5, 3], tag: "no_transcript", note: "Missed call, no transcript: everything unknown" },
  { id: "T09", expected: "needs_attention", pts: [0, 0, 0, 0, 0, 0, 0], existingClient: true, tag: "existing_client", note: "Complaint from a running project, wants Nikhil" },
  { id: "T10", expected: "needs_attention", pts: [25, 12, 0, 10, 8, 5, 0], note: "Volunteered budget far below scope. Not a 'clear no' category in the new brief" },
  { id: "T11", expected: "qualified", pts: [25, 14, 8, 10, 8, 10, 3], note: "Rented 2BHK, landlord fine, no structural" },
  { id: "T12", expected: "qualified", pts: [25, 20, 8, 10, 10, 10, 3], note: "5,500 sq ft villa, new possession" },
  { id: "T13", expected: "qualified", pts: [25, 20, 8, 10, 8, 7, 3], note: "Asked for a price twice: neutral" },
  {
    id: "T14", expected: "needs_attention", pts: [25, 12, 8, 10, 8, 3, 3], proxyNoAuthority: true,
    note: "Son 'just calling to see if it's worth pursuing'; parents decide",
  },
  { id: "T15", expected: "qualified", pts: [25, 20, 8, 10, 15, 10, 3], note: "Possession in 6 weeks, wants design to start now" },
  { id: "T16", expected: "qualified", pts: [25, 16, 8, 10, 8, 5, 3], tag: "upset_caller", note: "Real lead, earlier enquiry was dropped. Qualified, but flag as handle-with-care" },
  { id: "T17a", expected: "needs_attention", pts: [12, 10, 8, 5, 8, 5, 3], tag: "no_transcript", note: "Line dropped after one sentence" },
  { id: "T17", expected: "qualified", pts: [25, 20, 8, 10, 15, 8, 3], note: "Redial after the drop, 3BHK Pimple Saudagar" },
  {
    id: "T18", expected: "disqualified", literal: "needs_attention", pts: [0, 0, 8, 5, 8, 8, 0],
    clearNo: { key: "service_fit", quote: "A 180 sq ft pod is below our minimum scope" }, note: "180 sq ft pod, below the 500 sq ft commercial minimum",
  },
  {
    id: "T19", expected: "disqualified", literal: "needs_attention", pts: [0, 10, 8, 10, 8, 5, 0],
    clearNo: { key: "service_fit", quote: "Restaurant and hospitality interiors are outside our current scope" }, note: "Restaurant: out of scope",
  },
  { id: "T20", expected: "qualified", pts: [25, 20, 8, 10, 10, 10, 3], note: "2BHK Magarpatta, January start" },
];

export function toInput(g: Gold, transcript: string, ctx: { hasPhone?: boolean; hasBooking?: boolean } = {}): RubricInput {
  const criteria = {} as RubricInput["criteria"];
  KEYS.forEach((k, i) => {
    const isNo = g.clearNo?.key === k;
    criteria[k] = { points: g.pts[i], evidence: isNo ? g.clearNo!.quote : "see transcript", clearNo: isNo };
  });
  return {
    criteria,
    transcript,
    existingClient: g.existingClient,
    proxyNoAuthority: g.proxyNoAuthority,
    hasPhone: ctx.hasPhone ?? true,
    hasBooking: ctx.hasBooking ?? false,
  };
}
