import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { handleUpdate, type TgUpdate } from "@/lib/telegram-bot";
import { verifyTelegramSecret } from "@/lib/telegram";

export const runtime = "nodejs";

/** Telegram webhook. Telegram proves itself with the secret_token header set when the webhook was registered. */
export async function POST(req: Request) {
  if (!verifyTelegramSecret(req.headers.get("x-telegram-bot-api-secret-token"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: true }); // nothing to retry
  }
  try {
    await handleUpdate(update);
  } catch (e) {
    // Always 200: Telegram would otherwise redeliver the same update forever.
    audit("telegram.update_error", { error: e instanceof Error ? e.message : String(e) });
  }
  return NextResponse.json({ ok: true });
}
