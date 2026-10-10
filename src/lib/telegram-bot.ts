import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, one, schema } from "@/db";
import { acknowledgeCall, assignCall, UserError } from "@/lib/calls";
import { answerCallback, clearButtons, reply } from "@/lib/telegram";

const CODE_TTL_MS = 48 * 3_600_000;

export interface TgUpdate {
  message?: { text?: string; chat: { id: number }; from?: { id: number } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } }; from?: { id: number } };
}

/** One-time code a designer sends to the bot (t.me/<bot>?start=<code>) to link their chat. */
export async function createLinkCode(designerId: number, now: Date = new Date()): Promise<string> {
  await db.delete(schema.telegramLinkCodes).where(eq(schema.telegramLinkCodes.designerId, designerId));
  const code = randomBytes(8).toString("hex");
  await db.insert(schema.telegramLinkCodes).values({ code, designerId, createdAt: now });
  return code;
}

const designerByChat = (chatId: number | string) => one(db.select().from(schema.designers).where(eq(schema.designers.telegramChatId, String(chatId))).limit(1));

async function onStart(chatId: number, text: string, now: Date) {
  const code = text.split(/\s+/)[1];
  if (!code) {
    const known = await designerByChat(chatId);
    return reply(String(chatId), known ? `You are linked as ${known.name}. Reminders will arrive here.` : "To link this chat, open the personal link your studio admin gave you (it starts this bot with a code).");
  }
  const row = await one(db.select().from(schema.telegramLinkCodes).where(eq(schema.telegramLinkCodes.code, code)));
  if (!row || now.getTime() - row.createdAt.getTime() > CODE_TTL_MS) {
    const known = await designerByChat(chatId);
    if (known) return reply(String(chatId), `This chat is already linked as ${known.name}. Reminders will arrive here.`); // the one-time link was used already
    return reply(String(chatId), "That link is invalid or has expired. Ask your studio admin for a new one.");
  }
  const d = await one(db.select().from(schema.designers).where(eq(schema.designers.id, row.designerId)));
  if (!d) return reply(String(chatId), "That link is no longer valid.");
  await db.update(schema.designers).set({ telegramChatId: String(chatId) }).where(eq(schema.designers.id, d.id));
  await db.delete(schema.telegramLinkCodes).where(eq(schema.telegramLinkCodes.code, code));
  return reply(String(chatId), `Linked. You will get Aangan enquiry reminders here, ${d.name}.`);
}

async function onCallback(q: NonNullable<TgUpdate["callback_query"]>) {
  const chatId = q.message?.chat.id;
  const ack = /^ack:(\d+)$/.exec(q.data ?? "");
  const asg = /^asg:(\d+):(\d+)$/.exec(q.data ?? "");
  if (!chatId || (!ack && !asg)) return answerCallback(q.id, "Unknown action");
  const d = await designerByChat(chatId);
  if (!d) return answerCallback(q.id, "This chat is not linked to anyone");
  let done = "Acknowledged";
  try {
    if (asg) {
      // Only front desk officers assign, whoever else happens to hold the message.
      if (d.role !== "front_desk") return answerCallback(q.id, "Only the front desk can assign calls");
      const call = await assignCall(Number(asg[1]), Number(asg[2]), { id: d.id, how: "front_desk" });
      const to = await one(db.select().from(schema.designers).where(eq(schema.designers.id, call.assignedDesignerId ?? -1)));
      done = `Assigned to ${to?.name ?? "the designer"}`;
    } else {
      if (d.role === "front_desk") return answerCallback(q.id, "Designers acknowledge calls, the front desk assigns them");
      await acknowledgeCall(Number(ack![1]), d.id); // same path as the dashboard button: cancels reminders, updates HubSpot
    }
  } catch (e) {
    if (e instanceof UserError) return answerCallback(q.id, e.message);
    throw e;
  }
  await answerCallback(q.id, done);
  if (q.message) await clearButtons(String(chatId), q.message.message_id);
}

/** Entry point for every Telegram update, from the webhook or the dev poller. Never throws on bad input. */
export async function handleUpdate(update: TgUpdate, now: Date = new Date()): Promise<void> {
  const text = update.message?.text?.trim();
  if (update.message && text && /^\/start(@\w+)?(\s|$)/.test(text)) return onStart(update.message.chat.id, text.replace(/^\/start@\w+/, "/start"), now);
  if (update.callback_query) return onCallback(update.callback_query);
}
