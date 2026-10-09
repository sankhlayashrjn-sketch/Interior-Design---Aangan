import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";

const read = (p: string) => readFileSync(path.resolve(p), "utf8");

export const promptFile = (name: string) => read(path.join("prompts", name));
export const contextFile = (name: string) => read(path.join(env.CONTEXT_DIR, name));

/** The full system prompt for scoring: instructions, studio knowledge and rubric. Read fresh each call so edits apply without a restart. */
export function buildScoringSystemPrompt(): string {
  return [
    promptFile("scoring_system.md"),
    "# Reference: services (what the studio does)\n\n" + contextFile("services.md"),
    "# Reference: pricing (INTERNAL. Never repeat any figure from this)\n\n" + contextFile("pricing.md"),
    "# Reference: Nikhil's notes on a worthwhile enquiry (the rubric below wins where they differ)\n\n" + contextFile("qualified.md"),
    promptFile("rubric.md"),
  ].join("\n\n---\n\n");
}
