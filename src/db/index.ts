import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __sqlite: Database.Database | undefined;
}

function open() {
  const file = env.DATABASE_URL === ":memory:" ? ":memory:" : path.resolve(env.DATABASE_URL);
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

const sqlite = globalThis.__sqlite ?? open();
globalThis.__sqlite = sqlite;

export const db = drizzle(sqlite, { schema });
export { schema };
export type DB = typeof db;

/** Apply SQL migrations from ./drizzle. Safe to call repeatedly. */
export function runMigrations() {
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
}
