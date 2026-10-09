import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";

const file = path.resolve(env.DATABASE_URL);
for (const f of [file, `${file}-wal`, `${file}-shm`]) {
  if (existsSync(f)) rmSync(f);
}
console.log(`Removed ${file}. Run: npm run db:migrate && npm run db:seed`);
