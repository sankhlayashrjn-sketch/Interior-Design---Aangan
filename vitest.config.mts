import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    // Every test file starts its own in-process Postgres and migrates it. On a busy machine (or CI) that can take
    // several seconds, so the defaults (5s per test, 10s per hook) are too tight.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: ":memory:",
      AI_MODE: "mock",
      HUBSPOT_MODE: "mock",
      TELEGRAM_MODE: "mock",
      CALCOM_MODE: "mock",
      INGEST_API_KEY: "",
      CALCOM_WEBHOOK_SECRET: "",
    },
  },
});
