import { and, asc, eq, ne } from "drizzle-orm";
import { db, one, schema } from "@/db";
import { env } from "@/lib/env";
import { getMe } from "@/lib/telegram";
import { createLinkCode } from "@/lib/telegram-bot";
import { ROLES, type Role } from "@/db/schema";
import { UserError } from "@/lib/calls";

export interface DesignerInput {
  name: string;
  telegramChatId: string | null;
  hubspotOwnerId: string | null;
  calcomUser: string | null;
  active: boolean;
  isEscalation: boolean;
  role?: Role;
}

const blank = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

async function clean(raw: DesignerInput, selfId?: number): Promise<DesignerInput> {
  const name = raw.name.trim();
  if (name.length < 2) throw new UserError("Enter the designer's name");
  const telegramChatId = blank(raw.telegramChatId);
  if (telegramChatId && !/^-?\d{5,15}$/.test(telegramChatId)) throw new UserError("A Telegram chat ID is a number (the bot's /start link fills it in for you)");
  const hubspotOwnerId = blank(raw.hubspotOwnerId);
  if (hubspotOwnerId && !/^\d+$/.test(hubspotOwnerId)) throw new UserError("A HubSpot owner ID is a number");
  const calcom = blank(raw.calcomUser)?.toLowerCase() ?? null;
  if (calcom && !/^[\w.@+-]+$/.test(calcom)) throw new UserError("Cal.com user: use the username or email, with no spaces");

  if (telegramChatId) {
    const clash = await one(db.select().from(schema.designers).where(and(eq(schema.designers.telegramChatId, telegramChatId), selfId ? ne(schema.designers.id, selfId) : undefined)).limit(1));
    if (clash) throw new UserError(`That Telegram chat is already linked to ${clash.name}`);
  }
  const role: Role = raw.role ?? "designer";
  if (!ROLES.includes(role)) throw new UserError("Choose a role");
  // The studio head is a designer who receives escalations; a front desk officer is neither.
  return { name, telegramChatId, hubspotOwnerId, calcomUser: calcom, active: raw.active, isEscalation: role === "designer" && raw.isEscalation, role };
}

/** At least one active designer who takes new calls must always remain, or round-robin has nobody to assign to. */
async function assertRotationNotEmpty(selfId: number | null, next: DesignerInput) {
  const others = (await db.select().from(schema.designers)).filter((d) => d.id !== selfId && d.active && d.role === "designer" && !d.isEscalation);
  const selfCounts = next.active && (next.role ?? "designer") === "designer" && !next.isEscalation;
  if (others.length === 0 && !selfCounts) throw new UserError("At least one active designer (not the studio head) must take new calls");
}

export async function updateDesigner(id: number, raw: DesignerInput): Promise<void> {
  if (!(await one(db.select().from(schema.designers).where(eq(schema.designers.id, id))))) throw new UserError("Designer not found");
  const d = await clean(raw, id);
  await assertRotationNotEmpty(id, d);
  await db.update(schema.designers).set(d).where(eq(schema.designers.id, id));
}

export async function addDesigner(raw: DesignerInput): Promise<number> {
  const d = await clean(raw);
  const last = (await db.select().from(schema.designers).where(eq(schema.designers.isEscalation, false)).orderBy(asc(schema.designers.rrOrder))).at(-1);
  const [row] = await db.insert(schema.designers).values({ ...d, rrOrder: (last?.rrOrder ?? 0) + 1 }).returning();
  return row.id;
}

/** A personal link the designer opens to connect their Telegram chat. */
export async function telegramLinkFor(designerId: number): Promise<{ url: string; code: string; note: string }> {
  if (!(await one(db.select().from(schema.designers).where(eq(schema.designers.id, designerId))))) throw new UserError("Designer not found");
  const code = await createLinkCode(designerId);
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
