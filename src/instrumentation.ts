export async function register() {
  // Only where the server stays up: `next dev` and a self-hosted `next start`.
  // On Vercel functions are short-lived, so there is no timer here. Vercel Cron calls /api/cron/tick instead,
  // and the database is migrated at build time (see README, "Deploying to Vercel and Neon").
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VERCEL) {
    const { runMigrations } = await import("./db");
    await runMigrations();
    const { startScheduler } = await import("./lib/scheduler");
    await startScheduler();
    const { startTelegramPolling } = await import("./lib/telegram-poll");
    await startTelegramPolling();
  }
}
