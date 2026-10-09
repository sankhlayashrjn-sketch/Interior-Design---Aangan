import { env } from "@/lib/env";
import { deleteWebhook, getUpdates } from "@/lib/telegram";
import { handleUpdate, type TgUpdate } from "@/lib/telegram-bot";

// Dev only: receive Telegram updates by long-polling, for when the app is on localhost and a webhook cannot reach it.
async function main() {
  if (env.TELEGRAM_MODE !== "live") return console.log("TELEGRAM_MODE is not live.");
  await deleteWebhook(); // polling and webhooks are mutually exclusive
  console.log("Polling Telegram. Press Ctrl+C to stop.");
  let offset = 0;
  for (;;) {
    const r = await getUpdates(offset).catch(() => null);
    if (!r?.ok || !r.result) {
      await new Promise((res) => setTimeout(res, 3000));
      continue;
    }
    for (const u of r.result as (TgUpdate & { update_id: number })[]) {
      offset = u.update_id + 1;
      await handleUpdate(u).catch((e) => console.error(e));
    }
  }
}
main();
