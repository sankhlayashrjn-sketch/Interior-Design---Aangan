import { env } from "@/lib/env";
import { geminiScore } from "./gemini";
import { liveScore } from "./live";
import { mockScore } from "./mock";
import type { ScoreRequest, ScoreResult } from "./schema";

export type { AiOutput, ScoreRequest, ScoreResult } from "./schema";

/** AI_MODE=mock uses the keyword-based stand-in; AI_MODE=live calls the provider in AI_PROVIDER (Anthropic by default, or Gemini). */
export async function scoreTranscript(req: ScoreRequest, model: string): Promise<ScoreResult> {
  if (env.AI_MODE === "mock") return mockScore(req);
  if (env.AI_PROVIDER === "gemini") return geminiScore(req, env.GEMINI_MODEL);
  return liveScore(req, model);
}
