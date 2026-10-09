import { deleteWebhook, setWebhook } from "@/lib/telegram";
import { env } from "@/lib/env";

// Usage: npm run telegram:webhook          (register APP_BASE_URL/api/telegram/webhook)
//        npm run telegram:webhook -- off   (remove it, e.g. to use the dev poller)
async function main() {
  if (env.TELEGRAM_MODE !== "live") return console.log("TELEGRAM_MODE is not live; nothing to register.");
  if (!env.APP_BASE_URL.startsWith("https://")) console.log("Warning: Telegram only delivers webhooks to https URLs. APP_BASE_URL is", env.APP_BASE_URL);
  const r = process.argv[2] === "off" ? await deleteWebhook() : await setWebhook();
  console.log(JSON.stringify(r));
}
main();
