import { eq } from "drizzle-orm";
import { db, one, schema, withLease } from "@/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { ingestCall } from "@/lib/ingest";
import { voiceProvider } from "./vaani";

const CURSOR_KEY = "vaani_cursor";
const OVERLAP_MS = 10 * 60_000; // calls finish post-processing a little after they end, so look back a bit; ingest dedupes on call id

/**
 * Poll mode (VAANI_INGEST_MODE=poll): ask Vaani for inbound calls since the last pass and ingest them.
 * Webhook mode needs none of this. Safe to run from several servers at once (lease) and any number of times (dedupe).
 */
export async function pollVaani(now: Date = new Date()): Promise<{ created: number } | null> {
  if (env.VAANI_INGEST_MODE !== "poll" || !env.VAANI_API_KEY) return null;
  return (
    (await withLease("vaani-poll", 120_000, async () => {
      const stored = await one(db.select().from(schema.appState).where(eq(schema.appState.key, CURSOR_KEY)));
      const since = new Date((stored ? Number(stored.value) : now.getTime() - 60 * 60_000) - OVERLAP_MS);
      let created = 0;
      try {
        for (const payload of await voiceProvider.listCallsSince(since)) {
          if ((await ingestCall(payload)).outcome === "created") created++;
        }
      } catch (e) {
        await audit("vaani.poll_error", { error: e instanceof Error ? e.message : String(e) });
        return { created };
      }
      await db.insert(schema.appState).values({ key: CURSOR_KEY, value: String(now.getTime()) }).onConflictDoUpdate({ target: schema.appState.key, set: { value: String(now.getTime()) } });
      return { created };
    })) ?? null
  );
}
