// Neon recommends the direct (non-pooled) connection for schema changes. Use it when one is provided.
if (process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;

async function main() {
  const { runMigrations } = await import("@/db"); // imported after the line above so it sees the right URL
  await runMigrations();
  console.log("Migrations applied.");
}

main()
  .then(() => process.exit(0)) // the database connection would otherwise keep the process alive
  .catch((e) => {
    console.error("Migration failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });

export {}; // makes this file a module, so `main` is not shared with other scripts
