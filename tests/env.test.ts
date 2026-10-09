import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENV_KEYS } from "@/lib/env";

const example = readFileSync(".env.example", "utf8");
const values = new Map(
  example
    .split("\n")
    .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()] as const),
);

/** The variables the brief asks for, by name. */
const REQUIRED = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "HUBSPOT_TOKEN", "HUBSPOT_PORTAL_ID", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "APP_BASE_URL",
  "VAANI_API_KEY", "VAANI_AGENT_ID", "VAANI_BASE_URL", "VAANI_INGEST_MODE", "VAANI_WEBHOOK_SECRET", "TELEPHONY_COST_PER_MIN_INR",
  "AI_MODE", "HUBSPOT_MODE", "TELEGRAM_MODE", "CALCOM_WEBHOOK_SECRET",
];

describe(".env.example", () => {
  it("lists every variable the brief asks for", () => {
    for (const k of REQUIRED) expect(values.has(k), `${k} missing`).toBe(true);
  });

  it("lists every variable the code reads, so none can be forgotten", () => {
    for (const k of ENV_KEYS) expect(values.has(k), `${k} is read by src/lib/env.ts but missing from .env.example`).toBe(true);
  });

  it("ships in mock mode so the app runs with no keys", () => {
    for (const k of ["AI_MODE", "HUBSPOT_MODE", "TELEGRAM_MODE", "CALCOM_MODE"]) expect(values.get(k)).toBe("mock");
  });

  it("contains no secrets: every key, token and secret is blank", () => {
    for (const [k, v] of values) if (/(KEY|TOKEN|SECRET)$/.test(k)) expect(v, `${k} should be blank`).toBe("");
  });
});
