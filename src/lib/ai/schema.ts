import { z } from "zod";
import { CRITERIA } from "@/lib/rubric";

const criterion = (max: number) =>
  z.object({
    points: z.number().min(0).max(max),
    evidence: z.string().min(1).max(400),
    clear_no: z.boolean().optional().default(false),
  });

const nullableText = z.string().max(300).nullable();

/** What the model must return. Status and final score are NOT here: the app computes them from the criteria. */
export const AiOutputSchema = z.object({
  caller_name: nullableText,
  location: nullableText,
  property_type: z.enum(["residential", "commercial", "unknown"]),
  area_sqft: z.number().int().positive().nullable(),
  scope: nullableText,
  timeline: nullableText,
  /** The caller's own words about budget, or null. Never an estimate of ours. */
  budget: nullableText,
  criteria: z.object(
    Object.fromEntries(CRITERIA.map((c) => [c.key, criterion(c.max)])) as Record<(typeof CRITERIA)[number]["key"], ReturnType<typeof criterion>>,
  ),
  not_a_lead: z.object({ evidence: z.string().min(1) }).nullable(),
  existing_client: z.boolean(),
  proxy_no_authority: z.boolean(),
  upset_caller: z.boolean(),
  no_transcript: z.boolean(),
  /** One line. The app overrides it where the code has a more specific reason. */
  reason: z.string().max(300).nullable(),
  /** 3-4 lines, key facts first. */
  summary: z.string().min(1).max(900),
  /** Questions the voice agent already asked, so the designer doesn't repeat them. */
  already_asked: z.string().max(400),
  suggested_next_step: z.string().min(1).max(300),
});

export type AiOutput = z.infer<typeof AiOutputSchema>;

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ScoreRequest {
  transcript: string;
  startedAt: Date;
  durationSec: number;
  hasPhone: boolean;
  bookedSlot: Date | null;
}

export interface ScoreResult {
  output: AiOutput | null;
  usage: AiUsage;
  model: string;
  error?: string;
}
