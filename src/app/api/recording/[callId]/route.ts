import { NextResponse } from "next/server";
import { fetchRecording } from "@/lib/voice/vaani";

export const runtime = "nodejs";

/** Plays a call recording. Vaani's recording link needs the API key, so the app streams it for the designer. */
export async function GET(_req: Request, { params }: { params: Promise<{ callId: string }> }) {
  const { callId } = await params;
  const upstream = await fetchRecording(callId);
  if (!upstream || !upstream.body) return NextResponse.json({ error: "no recording" }, { status: 404 });
  return new Response(upstream.body, {
    headers: { "content-type": upstream.headers.get("content-type") ?? "audio/ogg", "cache-control": "private, max-age=300" },
  });
}
