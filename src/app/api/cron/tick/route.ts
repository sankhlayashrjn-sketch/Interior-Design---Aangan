import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runTick } from "@/lib/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A tick may process waiting calls (an AI call each) and talk to HubSpot and Telegram. */
export const maxDuration = 120;

function authorised(req: Request): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // no secret: fine on a laptop, never in production
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when the CRON_SECRET variable is set. An outside pinger can send the same.
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The heartbeat: processes waiting calls, sends due reminders, syncs HubSpot. Safe to call as often as you like. */
export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await runTick();
  return NextResponse.json({ ok: true, ...result });
}
