import { existsSync } from "node:fs";
import { z } from "zod";

if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* already loaded by Next */
  }
}

const mode = z.enum(["live", "mock"]).default("mock");
const num = (d: number) => z.coerce.number().default(d);

const schema = z.object({
  AI_MODE: mode,
  HUBSPOT_MODE: mode,
  TELEGRAM_MODE: mode,
  CALCOM_MODE: mode,
  CONTEXT_DIR: z.string().default("context"),
  INGEST_API_KEY: z.string().default(""),
  CRON_SECRET: z.string().default(""),
  APP_PASSWORD: z.string().default(""),
  AUTH_SECRET: z.string().default(""),
  CALCOM_API_KEY: z.string().default(""),
  CALCOM_WEBHOOK_SECRET: z.string().default(""),
  CALCOM_EVENT_TYPE_ID: z.string().default(""),
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().default("./data/pglite"),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  HUBSPOT_TOKEN: z.string().default(""),
  HUBSPOT_PORTAL_ID: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  VAANI_API_KEY: z.string().default(""),
  VAANI_AGENT_ID: z.string().default(""),
  VAANI_BASE_URL: z.string().default(""),
  VAANI_INGEST_MODE: z.string().default(""),
  VAANI_WEBHOOK_SECRET: z.string().default(""),
  TELEPHONY_COST_PER_MIN_INR: num(1.5),
  AI_INPUT_COST_PER_MTOK_INR: num(250),
  AI_OUTPUT_COST_PER_MTOK_INR: num(1250),
});

export const env = schema.parse(process.env);
/** Every variable the app reads. A test checks that .env.example lists them all. */
export const ENV_KEYS = Object.keys(schema.shape);
export type Env = z.infer<typeof schema>;

/** Which integrations are live and whether their key is set. Never returns a key's value. */
export function integrationStatus() {
  return [
    { name: "AI scoring", live: env.AI_MODE === "live", keySet: !!env.ANTHROPIC_API_KEY, needs: "ANTHROPIC_API_KEY" },
    { name: "HubSpot", live: env.HUBSPOT_MODE === "live", keySet: !!env.HUBSPOT_TOKEN, needs: "HUBSPOT_TOKEN" },
    { name: "Telegram", live: env.TELEGRAM_MODE === "live", keySet: !!env.TELEGRAM_BOT_TOKEN, needs: "TELEGRAM_BOT_TOKEN" },
    { name: "Cal.com", live: env.CALCOM_MODE === "live", keySet: !!env.CALCOM_WEBHOOK_SECRET, needs: "CALCOM_WEBHOOK_SECRET" },
  ];
}
