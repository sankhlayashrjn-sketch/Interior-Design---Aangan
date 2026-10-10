import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

/**
 * Thin Telegram Bot API client. TELEGRAM_MODE=mock logs what would have been sent (to the console and
 * the audit_log as "mock.telegram.*") and always succeeds. TELEGRAM_MODE=live calls api.telegram.org.
 */

export interface Button {
  text: string;
  /** Opens a link. Telegram only accepts https URLs on inline buttons. */
  url?: string;
  /** Sent back to the webhook when tapped. Max 64 bytes. */
  callbackData?: string;
}

export interface OutMessage {
  text: string;
  rows?: Button[][];
}

export interface SendResult {
  ok: boolean;
  error?: string;
  messageId?: number;
}

const isHttps = (u: string) => /^https:\/\//i.test(u);

/** One stable link per call. The app sends you to the right screen: the front desk inbox if nobody has it yet, otherwise the designer's page. */
export function deepLink(callId: number): string {
  return `${env.APP_BASE_URL.replace(/\/$/, "")}/call/${callId}`;
}

/** The front desk inbox, or the designers' page. */
export function dashboardLink(audience: "front_desk" | "designer" = "designer"): string {
  return `${env.APP_BASE_URL.replace(/\/$/, "")}${audience === "front_desk" ? "/" : "/designers"}`;
}

/** Inline buttons that Telegram will accept. An http:// (for example localhost) URL button is dropped; the link stays in the text. */
export function toInlineKeyboard(rows: Button[][] | undefined) {
  if (!rows) return undefined;
  const kb = rows
    .map((row) =>
      row
        .filter((b) => b.callbackData || (b.url && isHttps(b.url)))
        .map((b) => (b.callbackData ? { text: b.text, callback_data: b.callbackData } : { text: b.text, url: b.url! })),
    )
    .filter((row) => row.length > 0);
  return kb.length ? { inline_keyboard: kb } : undefined;
}

async function api<T = unknown>(method: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<{ ok: boolean; result?: T; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await res.json()) as { ok: boolean; result?: T; description?: string };
}

export async function sendTelegram(chatId: string | null, msg: OutMessage): Promise<SendResult> {
  if (env.TELEGRAM_MODE === "mock") {
    audit("mock.telegram.send", { chatId, text: msg.text, buttons: toInlineKeyboard(msg.rows)?.inline_keyboard ?? [] });
    return { ok: true };
  }
  if (!chatId) return { ok: false, error: "no chat id" };
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not set" };
  try {
    const r = await api<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: msg.text,
      disable_web_page_preview: true,
      reply_markup: toInlineKeyboard(msg.rows),
    });
    return r.ok ? { ok: true, messageId: r.result?.message_id } : { ok: false, error: r.description ?? "telegram error" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function answerCallback(callbackQueryId: string, text: string): Promise<void> {
  if (env.TELEGRAM_MODE === "mock") return void audit("mock.telegram.answerCallback", { callbackQueryId, text });
  try {
    await api("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  } catch {
    /* the tap already worked; a failed toast is harmless */
  }
}

/** Remove the buttons from a message after it has been acted on. */
export async function clearButtons(chatId: string, messageId: number): Promise<void> {
  if (env.TELEGRAM_MODE === "mock") return void audit("mock.telegram.clearButtons", { chatId, messageId });
  try {
    await api("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  } catch {
    /* cosmetic */
  }
}

export async function reply(chatId: string, text: string): Promise<void> {
  await sendTelegram(chatId, { text });
}

/** The webhook must prove it came from Telegram: the secret_token we registered is echoed in a header. */
export function verifyTelegramSecret(header: string | null, secret = env.TELEGRAM_WEBHOOK_SECRET, mocking = env.TELEGRAM_MODE === "mock"): boolean {
  if (!secret) return mocking;
  return header === secret;
}

export async function setWebhook(): Promise<unknown> {
  return api("setWebhook", {
    url: `${env.APP_BASE_URL.replace(/\/$/, "")}/api/telegram/webhook`,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET || undefined,
    allowed_updates: ["message", "callback_query"],
  });
}

export const deleteWebhook = () => api("deleteWebhook", { drop_pending_updates: false });
export const getMe = () => api<{ username: string }>("getMe", {});
/** Long poll: Telegram holds the request open up to 25 seconds, so our own timeout must be longer than that. */
export const getUpdates = (offset: number) => api<unknown[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 35_000);
