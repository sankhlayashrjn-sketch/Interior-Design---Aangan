import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * One database layer, two engines, chosen by DATABASE_URL:
 *   postgres://...   Postgres (Neon in production), through a small connection pool
 *   ./data/pglite    PGlite, a real Postgres running inside this process. No server to install,
 *                    so local development and the tests need nothing. ":memory:" for tests.
 * Both speak the same SQL, so the app has a single code path.
 */
type Engine = {
  kind: "postgres" | "pglite";
  db: NodePgDatabase<typeof schema>;
  migrate: () => Promise<void>;
};

declare global {
  // eslint-disable-next-line no-var
  var __engine: Engine | undefined;
}

const migrationsFolder = () => path.resolve("drizzle");

/** Is a process with this id running? (EPERM means it exists but belongs to someone else.) */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * PGlite lets only ONE process use a database folder. Opening it from two at once does not fail: it
 * silently risks corrupting the data. So we leave a lock file with our process id and refuse, with a plain
 * message, to open a folder another live process is using.
 */
function lockFolder(dir: string) {
  const lock = `${dir}.lock`;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    if (pid && pid !== process.pid && alive(pid)) {
      throw new Error(
        `The local database folder ${dir} is already open in another process (pid ${pid}). It allows one process at a time. Stop that process (for example the dev server) and try again.`,
      );
    }
  }
  writeFileSync(lock, String(process.pid));
  process.on("exit", () => {
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock);
    } catch {
      /* already gone */
    }
  });
}

function create(): Engine {
  const url = env.DATABASE_URL;

  if (/^postgres(ql)?:\/\//i.test(url)) {
    // Serverless: keep the pool small. Neon's pooled connection string handles the rest.
    const pool = new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX) || 5, idleTimeoutMillis: 10_000 });
    const db = drizzlePg(pool, { schema });
    return { kind: "postgres", db, migrate: () => migratePg(db, { migrationsFolder: migrationsFolder() }) };
  }

  let client: PGlite;
  if (url === ":memory:") client = new PGlite();
  else {
    const dir = path.resolve(url);
    mkdirSync(path.dirname(dir), { recursive: true });
    lockFolder(dir);
    client = new PGlite(dir);
  }
  const db = drizzlePglite(client, { schema });
  return {
    kind: "pglite",
    // Same query-builder API as node-postgres; the cast lets the rest of the code use one type.
    db: db as unknown as NodePgDatabase<typeof schema>,
    migrate: () => migratePglite(db, { migrationsFolder: migrationsFolder() }),
  };
}

/** The engine is created on first use, not at import. */
const engine = () => (globalThis.__engine ??= create());

/**
 * The database handle. It looks like a normal Drizzle `db`, but the connection is only opened on the first
 * query. That keeps the build (which imports every route) from opening a database it never reads.
 */
export const db: NodePgDatabase<typeof schema> = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, prop) {
    const real = engine().db as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

export const dbKind = (): Engine["kind"] => engine().kind;
export { schema };
export type DB = typeof db;

/** Apply SQL migrations from ./drizzle. Safe to call repeatedly. */
export function runMigrations(): Promise<void> {
  return engine().migrate();
}

/** First row, or undefined. For queries that expect at most one row. */
export async function one<T>(query: PromiseLike<T[]>): Promise<T | undefined> {
  return (await query)[0];
}

/**
 * A lease is a lock with an expiry, kept in the app_state table. It works the same on Postgres and PGlite,
 * and a server that dies while holding one cannot block everyone forever: the lease simply runs out.
 * Returns true if this caller now holds it.
 */
export async function acquireLease(key: string, ttlMs: number): Promise<boolean> {
  const now = Date.now();
  const until = String(now + ttlMs);
  const rows = await db
    .insert(schema.appState)
    .values({ key: `lease:${key}`, value: until })
    .onConflictDoUpdate({ target: schema.appState.key, set: { value: until }, setWhere: sql`cast(${schema.appState.value} as bigint) < ${now}` })
    .returning({ key: schema.appState.key });
  return rows.length > 0;
}

export async function releaseLease(key: string): Promise<void> {
  await db.update(schema.appState).set({ value: "0" }).where(eq(schema.appState.key, `lease:${key}`));
}

/** Run `fn` only if the lease is free. Returns undefined (without running) if someone else holds it. */
export async function withLease<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined> {
  if (!(await acquireLease(key, ttlMs))) return undefined;
  try {
    return await fn();
  } finally {
    await releaseLease(key);
  }
}
