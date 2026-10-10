"use client";

import { useActionState } from "react";
import { assignAction, type ActionState } from "@/app/actions";

export interface AssignOption {
  id: number;
  name: string;
  /** Unacknowledged calls they already hold. */
  load: number;
}

/** Pick a designer for a call. The suggested one is pre-selected; one click assigns. Once assigned it reads "Reassign". */
export function AssignForm({ callId, designers, suggestedId, currentId }: { callId: number; designers: AssignOption[]; suggestedId: number | null; currentId: number | null }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(assignAction, {});
  const reassign = currentId !== null;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="callId" value={callId} />
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`designer-${callId}`} className="block text-small text-mute">
            {reassign ? "Move to a different designer" : "Assign to"}
          </label>
          <select id={`designer-${callId}`} name="designerId" defaultValue={reassign ? "" : (suggestedId ?? "")} className="mt-1 rounded border border-line bg-paper px-2 py-1.5 text-body">
            <option value="" disabled>
              Choose a designer
            </option>
            {designers
              .filter((d) => d.id !== currentId)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.load} waiting{d.id === suggestedId ? " · suggested" : ""}
                </option>
              ))}
          </select>
        </div>
        <button type="submit" disabled={pending} className={`rounded px-4 py-2 font-medium disabled:opacity-50 ${reassign ? "border border-ink" : "bg-accent text-white"}`}>
          {pending ? "Saving" : reassign ? "Reassign" : "Assign"}
        </button>
      </div>
      <p role="status" className={`text-small ${state.error ? "font-medium text-ink" : "text-mute"}`}>
        {state.error ?? state.ok ?? ""}
      </p>
    </form>
  );
}
