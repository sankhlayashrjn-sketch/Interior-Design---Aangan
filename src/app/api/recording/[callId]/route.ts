import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, one, schema } from "@/db";
import { fetchRecording } from "@/lib/voice/vaani";

export const runtime = "nodejs";

/** Plays a call recording. Vaani's recording link needs the API key, so the app streams it for the designer. */
export async function GET(_req: Request, { params }: { params: Promise<{ callId: string }> }) {
  const { callId } = await params;
  // Only recordings of calls this app has stored: the server's Vaani key must not play arbitrary ids.
  if (!(await one(db.select({ id: schema.calls.id }).from(schema.calls).where(eq(schema.calls.externalId, callId)).limit(1)))) return NextResponse.json({ error: "no recording" }, { status: 404 });
  const upstream = await fetchRecording(callId);
  if (!upstream || !upstream.body) return NextResponse.json({ error: "no recording" }, { status: 404 });
  return new Response(upstream.body, {
    headers: { "content-type": upstream.headers.get("content-type") ?? "audio/ogg", "cache-control": "private, max-age=300" },
  });
}
