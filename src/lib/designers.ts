import { and, asc, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { getMe } from "@/lib/telegram";
import { createLinkCode } from "@/lib/telegram-bot";
import { UserError } from "@/lib/calls";

export interface DesignerInput {
  name: string;
  telegramChatId: string | null;
  hubspotOwnerId: string | null;
  calcomUser: string | null;
  active: boolean;
  isEscalation: boolean;
}

const blank = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

function clean(raw: DesignerInput, selfId?: number): DesignerInput {
  const name = raw.name.trim();
  if (name.length < 2) throw new UserError("Enter the designer's name");
  const telegramChatId = blank(raw.telegramChatId);
  if (telegramChatId && !/^-?\d{5,15}$/.test(telegramChatId)) throw new UserError("A Telegram chat ID is a number (the bot's /start link fills it in for you)");
  const hubspotOwnerId = blank(raw.hubspotOwnerId);
  if (hubspotOwnerId && !/^\d+$/.test(hubspotOwnerId)) throw new UserError("A HubSpot owner ID is a number");
  const calcom = blank(raw.calcomUser)?.toLowerCase() ?? null;
  if (calcom && !/^[\w.@+-]+$/.test(calcom)) throw new UserError("Cal.com user: use the username or email, with no spaces");

  if (telegramChatId) {
    const clash = db.select().from(schema.designers).where(and(eq(schema.designers.telegramChatId, telegramChatId), selfId ? ne(schema.designers.id, selfId) : undefined)).get();
    if (clash) throw new UserError(`That Telegram chat is already linked to ${clash.name}`);
  }
  return { name, telegramChatId, hubspotOwnerId, calcomUser: calcom, active: raw.active, isEscalation: raw.isEscalation };
}

/** At least one active designer who takes new calls must always remain, or round-robin has nobody to assign to. */
function assertRotationNotEmpty(selfId: number | null, next: DesignerInput) {
  const others = db.select().from(schema.designers).all().filter((d) => d.id !== selfId && d.active && !d.isEscalation);
  const selfCounts = next.active && !next.isEscalation;
  if (others.length === 0 && !selfCounts) throw new UserError("At least one active designer (not the studio head) must take new calls");
}

export function updateDesigner(id: number, raw: DesignerInput) {
  if (!db.select().from(schema.designers).where(eq(schema.designers.id, id)).get()) throw new UserError("Designer not found");
  const d = clean(raw, id);
  assertRotationNotEmpty(id, d);
  db.update(schema.designers).set(d).where(eq(schema.designers.id, id)).run();
}

export function addDesigner(raw: DesignerInput): number {
  const d = clean(raw);
  const last = db.select().from(schema.designers).where(eq(schema.designers.isEscalation, false)).orderBy(asc(schema.designers.rrOrder)).all().at(-1);
  return db.insert(schema.designers).values({ ...d, rrOrder: (last?.rrOrder ?? 0) + 1 }).returning().get().id;
}

/** A personal link the designer opens to connect their Telegram chat. */
export async function telegramLinkFor(designerId: number): Promise<{ url: string; code: string; note: string }> {
  if (!db.select().from(schema.designers).where(eq(schema.designers.id, designerId)).get()) throw new UserError("Designer not found");
  const code = createLinkCode(designerId);
  let bot = "<your_bot_username>";
  let note = "";
  if (env.TELEGRAM_MODE === "live") {
    const me = await getMe().catch(() => null);
    if (me?.ok && me.result) bot = me.result.username;
    else note = "Could not reach Telegram to look up the bot name. Replace <your_bot_username> with your bot's username.";
  } else {
    note = "Telegram is in mock mode, so this link goes nowhere yet. Set TELEGRAM_MODE=live and add the bot token.";
  }
  return { url: `https://t.me/${bot}?start=${code}`, code, note };
}
