import { sql } from "drizzle-orm";

/**
 * Checks the database connection the app will use, and proves it works end to end.
 * Read-only apart from one throwaway row in app_state that it writes and removes.
 *   npm run db:check         the local database
 *   npm run db:check:neon    the Neon database in .env.neon
 * Never prints the connection string.
 */
async function main() {
  const { db, dbKind, schema, acquireLease, releaseLease } = await import("@/db");
  const { env } = await import("@/lib/env");
  const kind = dbKind();
  const where = kind === "postgres" ? `Postgres at ${new URL(env.DATABASE_URL).host}` : `local PGlite folder ${env.DATABASE_URL}`;
  console.log(`Engine: ${where}`);

  const t0 = Date.now();
  const v = await db.execute(sql`select version() as v, current_database() as db`);
  const first = Date.now() - t0;
  const row = (v.rows as { v: string; db: string }[])[0];
  console.log(`Connected to database "${row.db}"`);
  console.log(`Server: ${row.v.split(" on ")[0]}`);

  const tables = await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);
  const names = (tables.rows as { table_name: string }[]).map((r) => r.table_name);
  console.log(`Tables (${names.length}): ${names.join(", ") || "none, run the migration"}`);
  const migs = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`).catch(() => null);
  console.log(`Migrations applied: ${migs ? (migs.rows as { n: number }[])[0].n : "none"}`);

  if (names.includes("app_state")) {
    // Write, read back, delete: proves inserts, reads, deletes and the lease lock all work on this database.
    const key = `db-check-${Date.now()}`;
    await db.insert(schema.appState).values({ key, value: "ok" });
    const back = await db.select().from(schema.appState).where(sql`${schema.appState.key} = ${key}`);
    await db.execute(sql`delete from app_state where key = ${key}`);
    const leaseA = await acquireLease("db-check", 30_000);
    const leaseB = await acquireLease("db-check", 30_000);
    await releaseLease("db-check");
    await db.execute(sql`delete from app_state where key = 'lease:db-check'`);
    console.log(`Write, read and delete: ${back[0]?.value === "ok" ? "ok" : "FAILED"}`);
    console.log(`Lock (lease) works: ${leaseA && !leaseB ? "ok" : "FAILED"}`);
  }

  const t1 = Date.now();
  for (let i = 0; i < 5; i++) await db.execute(sql`select 1`);
  console.log(`Round trip: about ${Math.round((Date.now() - t1) / 5)} ms per query (first query ${first} ms)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
