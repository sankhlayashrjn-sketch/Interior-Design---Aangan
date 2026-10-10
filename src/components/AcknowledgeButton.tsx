"use client";

import { useActionState } from "react";
import { acknowledgeAction, type ActionState } from "@/app/actions";

/** The one place a designer acknowledges a call: inside the call's details. Shows the result, or why it did not work. */
export function AcknowledgeButton({ callId }: { callId: number }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(acknowledgeAction, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="callId" value={callId} />
      <button type="submit" disabled={pending} className="rounded bg-accent px-4 py-2 font-medium text-white disabled:opacity-50">
        {pending ? "Saving" : "Acknowledge"}
      </button>
      <p role="status" className={`text-small ${state.error ? "font-medium text-ink" : "text-mute"}`}>
        {state.error ?? state.ok ?? ""}
      </p>
    </form>
  );
}
