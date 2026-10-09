import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { applyCalEvent, CalWebhookSchema, verifyCalSignature } from "@/lib/bookings";

export const runtime = "nodejs";

/** Cal.com webhook: BOOKING_CREATED / BOOKING_RESCHEDULED / BOOKING_CANCELLED. Signature is checked on the raw body. */
export async function POST(req: Request) {
  const raw = await req.text();
  // TODO(verify): header name per Cal.com docs (we believe x-cal-signature-256).
  if (!verifyCalSignature(raw, req.headers.get("x-cal-signature-256"))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = CalWebhookSchema.safeParse(json);
  if (!parsed.success) {
    audit("booking.invalid", { issues: parsed.error.issues.slice(0, 5) });
    return NextResponse.json({ error: "unrecognised payload", issues: parsed.error.issues }, { status: 400 });
  }
  const out = await applyCalEvent(parsed.data);
  return NextResponse.json({ ok: true, ...out });
}
