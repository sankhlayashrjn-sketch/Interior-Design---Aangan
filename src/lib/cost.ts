import { env } from "@/lib/env";

export function aiCostInr(inputTokens: number, outputTokens: number): number {
  const c = (inputTokens / 1_000_000) * env.AI_INPUT_COST_PER_MTOK_INR + (outputTokens / 1_000_000) * env.AI_OUTPUT_COST_PER_MTOK_INR;
  return Math.round(c * 10000) / 10000;
}

export function telephonyCost(durationSec: number) {
  const minutes = Math.round((durationSec / 60) * 100) / 100;
  return { minutes, costInr: Math.round(minutes * env.TELEPHONY_COST_PER_MIN_INR * 10000) / 10000 };
}
