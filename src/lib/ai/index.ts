import { env } from "@/lib/env";
import { liveScore } from "./live";
import { mockScore } from "./mock";
import type { ScoreRequest, ScoreResult } from "./schema";

export type { AiOutput, ScoreRequest, ScoreResult } from "./schema";

/** AI_MODE=mock uses the keyword-based stand-in; AI_MODE=live calls Anthropic with `model`. */
export async function scoreTranscript(req: ScoreRequest, model: string): Promise<ScoreResult> {
  if (env.AI_MODE === "mock") return mockScore(req);
  return liveScore(req, model);
}
