/**
 * Runs the 20 sample transcripts through the REAL scoring model and compares each status with the expected one.
 *   npm run ai:test
 *
 * Uses an in-memory database and mocks HubSpot, Telegram and Cal.com, so the only outside call is to the AI provider
 * (AI_PROVIDER in .env). It costs a few rupees. A disagreement is not necessarily a bug: the model reads the
 * transcript itself, so read the reason it gave before deciding which side is wrong.
 */
process.env.AI_MODE = "live";
process.env.HUBSPOT_MODE = "mock";
process.env.TELEGRAM_MODE = "mock";
process.env.CALCOM_MODE = "mock";
process.env.DATABASE_URL = ":memory:";

async function main() {
  const { runMigrations } = await import("@/db");
  const { ingestCall } = await import("@/lib/ingest");
  const { setAutoPush } = await import("@/lib/hubspot/sync");
  const { env } = await import("@/lib/env");
  const samples = (await import("@/seed/sample-calls.json")).default;
  const { GOLD } = await import("../tests/fixtures/gold-scores");
  setAutoPush(false);
  await runMigrations();
  console.log(`Provider: ${env.AI_PROVIDER}, model: ${env.AI_PROVIDER === "gemini" ? env.GEMINI_MODEL : env.ANTHROPIC_MODEL}\n`);

  let agree = 0;
  let fallbacks = 0;
  for (const g of GOLD) {
    const s = samples.find((x) => x.id === g.id)!;
    const { call } = await ingestCall({
      external_id: `ai-test-${g.id}`,
      caller_phone: "+919800000000",
      started_at: new Date().toISOString(),
      duration_sec: s.durationSec,
      transcript: s.transcript,
    });
    const ok = call.status === g.expected;
    if (ok) agree++;
    if (/could not be scored|fallback|AI/i.test(call.reason ?? "") && call.score === null && call.status === "needs_attention" && g.expected !== "needs_attention") fallbacks++;
    console.log(`${ok ? "same " : "DIFF "} ${g.id.padEnd(4)} expected ${g.expected.padEnd(15)} got ${call.status.padEnd(15)} score ${String(call.score ?? "-").padStart(3)}${ok ? "" : `  ${call.reason ?? ""}`}`);
  }
  console.log(`\n${agree} of ${GOLD.length} match the expected status${fallbacks ? ` (${fallbacks} fell back because the model failed)` : ""}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
