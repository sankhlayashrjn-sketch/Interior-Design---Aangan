"use client";

import { Button } from "antd";
import { useActionState } from "react";
import { acknowledgeAction, type ActionState } from "@/app/actions";

/** The one place a designer acknowledges a call: inside the call's details. Shows the result, or why it did not work. */
export function AcknowledgeButton({ callId }: { callId: number }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(acknowledgeAction, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="callId" value={callId} />
      <Button type="primary" size="large" htmlType="submit" loading={pending}>
        Acknowledge
      </Button>
      <p role="status" className={`text-small ${state.error ? "font-bold" : ""}`}>
        {state.error ?? state.ok ?? ""}
      </p>
    </form>
  );
}
