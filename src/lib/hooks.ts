import { audit } from "@/lib/audit";

/**
 * A tiny in-process event bus. The pipeline emits; reminders (Telegram) and HubSpot sync subscribe.
 * Handlers must never break the pipeline, so failures are logged to the audit log and swallowed.
 */
export interface Events {
  /** A call was saved (before AI processing). */
  "call.received": { callId: number };
  /** A call was handed to a different designer (for example the owner was changed in HubSpot). */
  "call.reassigned": { callId: number };
  /** A call finished AI processing and was assigned. */
  "call.processed": { callId: number };
  /** A designer acknowledged. */
  "call.acknowledged": { callId: number };
  /** Status changed by a designer override. */
  "call.overridden": { callId: number };
  /** A Cal.com booking was created, rescheduled or cancelled and linked to a call. */
  "booking.changed": { callId: number; kind: "booked" | "rescheduled" | "cancelled" };
  /** Working hours or SLA changed: recompute pending reminders. */
  "settings.changed": Record<string, never>;
}

type Handler<K extends keyof Events> = (payload: Events[K]) => void | Promise<void>;
// Stored on globalThis: Next bundles routes, server actions and instrumentation separately, and they must share one registry.
const g = globalThis as { __hooks?: { [K in keyof Events]?: Handler<K>[] } };
const handlers = (g.__hooks ??= {});

export function on<K extends keyof Events>(event: K, fn: Handler<K>) {
  (handlers[event] ??= [] as never).push(fn as never);
}

export async function emit<K extends keyof Events>(event: K, payload: Events[K]) {
  for (const fn of (handlers[event] ?? []) as Handler<K>[]) {
    try {
      await fn(payload);
    } catch (e) {
      await audit("hook.error", { event, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
