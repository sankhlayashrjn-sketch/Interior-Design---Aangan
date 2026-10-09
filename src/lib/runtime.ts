import { registerHubSpotHandlers } from "@/lib/hubspot/sync";
import { registerReminderHandlers } from "@/lib/reminders";

/**
 * Importing this module (the pipeline does) makes sure the event handlers are registered exactly once
 * per process, whichever Next bundle (route, server action, instrumentation, script) loads first.
 */
const g = globalThis as { __handlersRegistered?: boolean };
if (!g.__handlersRegistered) {
  g.__handlersRegistered = true;
  registerReminderHandlers();
  registerHubSpotHandlers();
}

export {};
