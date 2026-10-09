import { runMigrations } from "@/db";

runMigrations()
  .then(() => {
    console.log("Migrations applied.");
    process.exit(0); // the database connection would otherwise keep the process alive
  })
  .catch((e) => {
    console.error("Migration failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
