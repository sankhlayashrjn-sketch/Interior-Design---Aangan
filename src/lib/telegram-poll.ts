import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { deleteWebhook, getUpdates } from "@/lib/telegram";
import { handleUpdate, type TgUpdate } from "@/lib/telegram-bot";

const g = globalThis as { __tgPolling?: boolean };

/** Polling is for development: Telegram can only call a webhook on a public https address. */
export function shouldPollTelegram(): boolean {
  return env.TELEGRAM_MODE === "live" && !!env.TELEGRAM_BOT_TOKEN && !env.APP_BASE_URL.startsWith("https://");
}

/**
 * Receive Telegram updates by long-polling, inside the server process. This replaces a separate poller,
 * which could not share the local database. It starts by itself when Telegram is live and APP_BASE_URL is
 * not https (for example http://localhost:3000). With an https address, register the webhook instead.
 */
export async function startTelegramPolling() {
  if (g.__tgPolling || !shouldPollTelegram()) return;
  g.__tgPolling = true;
  await deleteWebhook().catch(() => undefined); // polling and a webhook are mutually exclusive
  console.log("[telegram] polling for updates (development mode; use the webhook once the app has an https address)");
  void (async () => {
    let offset = 0;
    for (;;) {
      const r = await getUpdates(offset).catch(() => null);
      if (!r?.ok || !r.result) {
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      for (const u of r.result as (TgUpdate & { update_id: number })[]) {
        offset = u.update_id + 1;
        await handleUpdate(u).catch((e) => audit("telegram.update_error", { error: e instanceof Error ? e.message : String(e) }));
      }
    }
  })();
}
