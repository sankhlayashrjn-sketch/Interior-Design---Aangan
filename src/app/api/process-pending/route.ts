import { NextResponse } from "next/server";
import { processPending } from "@/lib/ingest";

export const runtime = "nodejs";

/** Re-run processing for calls stuck in "yet_to_be_processed". */
export async function POST() {
  const n = await processPending();
  return NextResponse.json({ processed: n });
}
