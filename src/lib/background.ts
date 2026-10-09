import { after } from "next/server";

/**
 * Run work after the HTTP response has been sent, without making the user wait.
 *
 * On serverless hosting (Vercel) a function can be frozen the moment it responds, so a plain `void promise`
 * may never finish. Next's `after()` keeps the function alive until the work is done. Outside a request
 * (a script, a cron pass, tests) `after()` is not available, and the work simply starts and runs.
 */
export function background(task: () => Promise<unknown>): void {
  const run = () =>
    task().catch((e) => {
      console.error("background task failed:", e instanceof Error ? e.message : e);
    });
  try {
    after(run);
  } catch {
    void run();
  }
}
