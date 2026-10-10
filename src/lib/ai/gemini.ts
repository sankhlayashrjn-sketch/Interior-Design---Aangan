import { env } from "@/lib/env";
import { buildScoringSystemPrompt } from "@/lib/knowledge";
import { extractJson, userMessage } from "./live";
import { AiOutputSchema, type ScoreRequest, type ScoreResult } from "./schema";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string };
}

/** Scores one call with Gemini. Same contract as liveScore: one retry on invalid JSON, then output: null so the caller falls back to needs_attention. */
export async function geminiScore(req: ScoreRequest, model: string): Promise<ScoreResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  if (!env.GEMINI_API_KEY) return { output: null, usage, model, error: "GEMINI_API_KEY is not set" };

  const contents: { role: "user" | "model"; parts: { text: string }[] }[] = [{ role: "user", parts: [{ text: userMessage(req) }] }];
  let lastError = "unknown";

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildScoringSystemPrompt() }] },
          contents,
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4000, temperature: 0 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await res.json().catch(() => ({}))) as GeminiResponse;
      if (!res.ok) {
        lastError = `Gemini ${res.status}: ${body.error?.message ?? "request failed"}`;
        if (res.status < 500 && res.status !== 429) break; // retrying will not help
        continue;
      }
      usage.inputTokens += body.usageMetadata?.promptTokenCount ?? 0;
      usage.outputTokens += (body.usageMetadata?.candidatesTokenCount ?? 0) + (body.usageMetadata?.thoughtsTokenCount ?? 0);
      const text = (body.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
      const parsed = AiOutputSchema.safeParse(extractJson(text));
      if (parsed.success) return { output: parsed.data, usage, model };
      lastError = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      contents.push({ role: "model", parts: [{ text }] }, { role: "user", parts: [{ text: `That JSON was invalid: ${lastError}. Return the corrected JSON object only.` }] });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { output: null, usage, model, error: lastError };
}
