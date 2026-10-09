"use client";

import { useActionState } from "react";
import { overrideAction, type ActionState } from "@/app/actions";
import { STATUS_LABEL } from "@/lib/format";

const OPTIONS = ["qualified", "needs_attention", "disqualified"];

export function OverrideForm({ callId, current }: { callId: number; current: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(overrideAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="callId" value={callId} />
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="status" className="block text-small text-mute">
            Change status to
          </label>
          <select id="status" name="status" defaultValue="" className="mt-1 rounded border border-line bg-paper px-2 py-1.5 text-body">
            <option value="" disabled>
              Choose
            </option>
            {OPTIONS.filter((o) => o !== current).map((o) => (
              <option key={o} value={o}>
                {STATUS_LABEL[o]}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[14rem] flex-1">
          <label htmlFor="reason" className="block text-small text-mute">
            Reason (required, logged)
          </label>
          <input id="reason" name="reason" required minLength={5} autoComplete="off" className="mt-1 w-full rounded border border-line bg-paper px-2 py-1.5 text-body" />
        </div>
        <button type="submit" disabled={pending} className="rounded border border-ink px-3 py-1.5 text-body font-medium disabled:opacity-50">
          {pending ? "Saving" : "Save override"}
        </button>
      </div>
      <p role="status" className={`text-small ${state.error ? "font-medium text-ink" : "text-mute"}`}>
        {state.error ?? state.ok ?? ""}
      </p>
    </form>
  );
}
