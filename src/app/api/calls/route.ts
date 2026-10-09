import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { env } from "@/lib/env";
import { ingestCall } from "@/lib/ingest";

export const runtime = "nodejs";

/**
 * POST /api/calls
 * { external_id, caller_phone (nullable), started_at, duration_sec, transcript, booking_id?, booked_slot? }
 * 201 = created and processed, 200 = duplicate external_id (nothing re-processed), 400 = invalid body.
 */
export async function POST(req: Request) {
  if (env.INGEST_API_KEY && req.headers.get("x-api-key") !== env.INGEST_API_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  try {
    const { outcome, call } = await ingestCall(body);
    return NextResponse.json(
      { outcome, id: call.id, external_id: call.externalId, status: call.status, score: call.score, reason: call.reason, assigned_designer_id: call.assignedDesignerId },
      { status: outcome === "created" ? 201 : 200 },
    );
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "invalid payload", issues: e.issues }, { status: 400 });
    console.error(e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
