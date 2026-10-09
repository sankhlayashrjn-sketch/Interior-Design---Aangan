import { eq } from "drizzle-orm";
import { db, one, runMigrations, schema } from "@/db";
import { env } from "@/lib/env";
import { getMe } from "@/lib/telegram";
import { createLinkCode } from "@/lib/telegram-bot";

// Usage: npm run telegram:link -- <designerId>
async function main() {
  await runMigrations();
  const id = Number(process.argv[2]);
  const d = await one(db.select().from(schema.designers).where(eq(schema.designers.id, id)));
  if (!d) {
    console.log("Usage: npm run telegram:link -- <designerId>");
    console.log("Designers:", (await db.select().from(schema.designers)).map((x) => `${x.id}=${x.name}`).join(", "));
    process.exit(1);
  }
  const code = await createLinkCode(d.id);
  let bot = "<your_bot_username>";
  if (env.TELEGRAM_MODE === "live") {
    const me = await getMe();
    if (me.ok && me.result) bot = me.result.username;
  }
  console.log(`Send this link to ${d!.name} (valid 48 hours). Opening it and pressing Start links their chat:`);
  console.log(`https://t.me/${bot}?start=${code}`);
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
