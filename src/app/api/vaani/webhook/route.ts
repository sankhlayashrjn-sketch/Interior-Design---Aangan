import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ingestCall } from "@/lib/ingest";
import { bookAfterCall } from "@/lib/voice/book-after-call";
import { rememberCallerPhone, voiceProvider } from "@/lib/voice/vaani";

export const runtime = "nodejs";
export const maxDuration = 120; // scoring a call is an AI request

/**
 * POST /api/vaani/webhook?key=<VAANI_WEBHOOK_SECRET>
 * Register this URL (with the key) in Vaani: Settings > Webhooks. Vaani sends many event types; only
 * "call_postprocessing" (transcript ready) turns into a call here, the rest are acknowledged and ignored.
 * Always answers 200 for a valid request so Vaani does not keep retrying; failures are logged and the call
 * is picked up by the tick if it was saved but not scored.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const key = new URL(req.url).searchParams.get("key");
  if (!voiceProvider.verifyWebhook(raw, req.headers, key)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  await rememberCallerPhone(raw); // the call_started event is the only one that says who is calling
  let created = 0;
  try {
    for (const payload of await voiceProvider.parseWebhook(raw)) {
      const { outcome, call } = await ingestCall(payload);
      if (outcome === "created") {
        created++;
        await bookFromEntities(call.id, raw);
      }
    }
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ ok: true, ignored: "payload did not fit" });
    console.error("[vaani webhook]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 }); // let Vaani retry
  }
  return NextResponse.json({ ok: true, created });
}

/** The caller gave an email and a preferred time on the call: book the nearest free Cal.com slot. Never fails the webhook. */
async function bookFromEntities(callId: number, raw: string) {
  try {
    const entities = (JSON.parse(raw) as { data?: { entities?: unknown } }).data?.entities;
    await bookAfterCall(callId, entities);
  } catch (e) {
    console.error("[vaani booking]", e);
  }
}
