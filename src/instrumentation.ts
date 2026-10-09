export async function register() {
  // The scheduler needs a long-running Node process (not the Edge runtime, not serverless).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runMigrations } = await import("./db");
    runMigrations();
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
  }
}
