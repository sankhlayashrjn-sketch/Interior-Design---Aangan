"use client";

import { Button, Input, Select } from "antd";
import { useActionState, useState } from "react";
import { overrideAction, type ActionState } from "@/app/actions";
import { STATUS_LABEL } from "@/lib/format";

const OPTIONS = ["qualified", "needs_attention", "disqualified"];

export function OverrideForm({ callId, current }: { callId: number; current: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(overrideAction, {});
  const [status, setStatus] = useState<string | undefined>();
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="callId" value={callId} />
      <input type="hidden" name="status" value={status ?? ""} />
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`status-${callId}`} className="block text-small font-bold">
            Change status to
          </label>
          <Select id={`status-${callId}`} value={status} onChange={setStatus} placeholder="Choose" style={{ width: 190 }} options={OPTIONS.filter((o) => o !== current).map((o) => ({ value: o, label: STATUS_LABEL[o] }))} />
        </div>
        <div className="min-w-[14rem] flex-1">
          <label htmlFor={`reason-${callId}`} className="block text-small font-bold">
            Reason (required, logged)
          </label>
          <Input id={`reason-${callId}`} name="reason" required minLength={5} autoComplete="off" />
        </div>
        <Button htmlType="submit" loading={pending} disabled={!status}>
          Save override
        </Button>
      </div>
      <p role="status" className={`text-small ${state.error ? "font-bold" : ""}`}>
        {state.error ?? state.ok ?? ""}
      </p>
    </form>
  );
}
