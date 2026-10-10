"use client";

import { Button, Select } from "antd";
import { useActionState, useState } from "react";
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
  const [value, setValue] = useState<number | undefined>(reassign ? undefined : (suggestedId ?? undefined));
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="callId" value={callId} />
      <input type="hidden" name="designerId" value={value ?? ""} />
      <label htmlFor={`designer-${callId}`} className="block text-small font-bold">
        {reassign ? "Move to a different designer" : "Assign to a designer"}
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          id={`designer-${callId}`}
          value={value}
          onChange={setValue}
          placeholder="Choose a designer"
          style={{ minWidth: 260 }}
          options={designers
            .filter((d) => d.id !== currentId)
            .map((d) => ({ value: d.id, label: `${d.name} · ${d.load} waiting${d.id === suggestedId ? " · suggested" : ""}` }))}
        />
        <Button type={reassign ? "default" : "primary"} htmlType="submit" loading={pending} disabled={!value}>
          {reassign ? "Reassign" : "Assign"}
        </Button>
      </div>
      <p role="status" className={`text-small ${state.error ? "font-bold" : ""}`}>
        {state.error ?? state.ok ?? ""}
      </p>
    </form>
  );
}
