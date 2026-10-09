import { env } from "@/lib/env";
import { MockHubSpot } from "./mock";
import { RealHubSpot } from "./real";
import type { HubSpotApi } from "./types";

const g = globalThis as { __hubspot?: HubSpotApi };

/** The HubSpot client for the current HUBSPOT_MODE (one per process). */
export function getHubSpot(): HubSpotApi {
  return (g.__hubspot ??= env.HUBSPOT_MODE === "live" ? new RealHubSpot() : new MockHubSpot());
}

/** Swap the client (tests inject a MockHubSpot they can inspect and edit). */
export function setHubSpot(api: HubSpotApi | null) {
  g.__hubspot = api ?? undefined;
}

export * from "./types";
export { MockHubSpot } from "./mock";
