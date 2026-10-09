import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
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
