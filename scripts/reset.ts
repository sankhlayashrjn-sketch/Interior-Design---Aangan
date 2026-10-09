import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";

// Resets the LOCAL development database only. It will not touch a real Postgres (Neon) database.
if (/^postgres(ql)?:\/\//i.test(env.DATABASE_URL)) {
  console.error("DATABASE_URL points at a Postgres server. Refusing to reset it from here. Drop the tables in the Neon console if you really mean to.");
  process.exit(1);
}
const dir = path.resolve(env.DATABASE_URL);
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
console.log(`Removed ${dir}. Run: npm run db:migrate && npm run db:seed`);
