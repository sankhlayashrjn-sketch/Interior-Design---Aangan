import type { CallStatus } from "@/db/schema";

/**
 * Deterministic half of the scoring. The AI judges each criterion (points + a quote); this file
 * clamps the points, sums them, and decides the status. The model never picks the status, so the
 * "no auto-reject" and "ambiguous means needs_attention" rules cannot be broken by a bad generation.
 */

export const CRITERIA = [
  { key: "service_fit", max: 25, label: "Service fit" },
  { key: "scale", max: 20, label: "Project scale" },
  { key: "budget", max: 15, label: "Budget realism" },
  { key: "location", max: 10, label: "Location" },
  { key: "timeline", max: 15, label: "Timeline and intent" },
  { key: "property_dm", max: 10, label: "Property and decision-maker" },
  { key: "next_step", max: 5, label: "Next step secured" },
] as const;

export type CriterionKey = (typeof CRITERIA)[number]["key"];
const MAX = Object.fromEntries(CRITERIA.map((c) => [c.key, c.max])) as Record<CriterionKey, number>;

export const BANDS = { qualifiedMin: 70, needsAttentionMin: 25 } as const;

/**
 * Score ceiling when a quoted clear no (service fit or location) or a not-a-lead is verified.
 * 24 = such calls land in "disqualified" (recommended). Set to 69 for the literal reading of the
 * brief, where they stay in "needs_attention" and are only capped.
 */
export const CLEAR_NO_CAP = 24;
/** Caller is researching for someone else and has not said they're authorised. */
export const PROXY_CAP = 69;

export interface CriterionInput {
  points: number;
  /** One-line quote from the transcript (or "not mentioned"). */
  evidence: string;
  /** Only meaningful on service_fit and location: the caller/agent clearly said this is out of scope/area. */
  clearNo?: boolean;
}

export interface RubricInput {
  criteria: Record<CriterionKey, CriterionInput>;
  /** Wrong number, vendor, job seeker, spam. Needs a quote. */
  notALead?: { evidence: string } | null;
  /** Caller is an existing client raising an issue with a running project. Not scored. */
  existingClient?: boolean;
  /** Researching for someone else, authorisation not confirmed. */
  proxyNoAuthority?: boolean;
  hasPhone: boolean;
  hasBooking: boolean;
  transcript: string;
  /** The model's own one-line reason, used when the code has nothing more specific to say. */
  llmReason?: string;
}

export interface RubricResult {
  score: number | null;
  status: Exclude<CallStatus, "yet_to_be_processed">;
  reason: string | null;
  breakdown: Record<CriterionKey, { verdict: "pass" | "unclear" | "fail"; points: number; max: number; evidence: string }>;
  /** Things the code corrected or noticed, for the audit log. */
  notes: string[];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** A clear-no quote must really appear in the transcript. */
export function quoteIsInTranscript(quote: string, transcript: string): boolean {
  const q = norm(quote).replace(/^["']|["']$/g, "");
  return q.length >= 8 && norm(transcript).includes(q);
}

function verdict(points: number, max: number, clearNo: boolean): "pass" | "unclear" | "fail" {
  if (clearNo || points === 0) return "fail";
  return points >= max * 0.8 ? "pass" : "unclear";
}

export function finalizeScore(input: RubricInput, opts: { clearNoCap?: number } = {}): RubricResult {
  const clearNoCap = opts.clearNoCap ?? CLEAR_NO_CAP;
  const notes: string[] = [];
  const breakdown = {} as RubricResult["breakdown"];
  let sum = 0;
  let verifiedClearNo: string | null = null;

  for (const { key, max } of CRITERIA) {
    const c = input.criteria[key];
    let points = Math.max(0, Math.min(max, Math.round(c.points)));
    if (points !== c.points) notes.push(`${key}: points ${c.points} clamped to ${points}`);
    let clearNo = false;
    if (c.clearNo && (key === "service_fit" || key === "location")) {
      if (quoteIsInTranscript(c.evidence, input.transcript)) {
        clearNo = true;
        points = 0;
        verifiedClearNo ??= `${key === "location" ? "Outside service area" : "Out of scope"}: "${c.evidence.slice(0, 100)}"`;
      } else {
        // Affirmative evidence is required to say no. Treat as unknown instead.
        points = Math.round(max / 2);
        notes.push(`${key}: clear-no quote not found in transcript, treated as unclear`);
      }
    }
    sum += points;
    breakdown[key] = { verdict: verdict(points, max, clearNo), points, max, evidence: c.evidence };
  }

  const base = { breakdown, notes };

  if (input.existingClient) {
    return { ...base, score: null, status: "needs_attention", reason: "Existing client with a running project. Needs a senior callback, not a sales follow-up." };
  }

  let notALead: string | null = null;
  if (input.notALead) {
    if (quoteIsInTranscript(input.notALead.evidence, input.transcript)) notALead = input.notALead.evidence;
    else notes.push("not-a-lead quote not found in transcript, ignored");
  }

  let score = sum;
  const clearNo = verifiedClearNo ?? (notALead ? `Not a lead: "${notALead.slice(0, 100)}"` : null);
  if (clearNo) score = Math.min(score, clearNoCap);
  if (input.proxyNoAuthority) score = Math.min(score, PROXY_CAP);

  let status: RubricResult["status"];
  let reason: string | null = null;

  if (score >= BANDS.qualifiedMin) {
    status = "qualified";
    if (breakdown.service_fit.points === 0 || breakdown.location.points === 0) {
      status = "needs_attention";
      reason = "Service fit or location scored zero, so it cannot be qualified";
    } else if (!input.hasPhone && !input.hasBooking) {
      status = "needs_attention";
      reason = "No way to reach caller";
    }
  } else if (score >= BANDS.needsAttentionMin) {
    status = "needs_attention";
  } else if (clearNo) {
    status = "disqualified";
  } else {
    status = "needs_attention";
    notes.push("score below 25 without a quoted clear no, so needs_attention");
  }

  if (status !== "qualified" && !reason) {
    if (clearNo) reason = clearNo;
    else if (!input.hasPhone && !input.hasBooking) reason = "No way to reach caller";
    else if (input.proxyNoAuthority) reason = "Caller is researching for someone else; decision-maker not confirmed";
    else reason = input.llmReason?.trim() || "Score in the check band; a designer should review";
  }
  if (status === "qualified") reason = null;

  return { ...base, score, status, reason };
}
