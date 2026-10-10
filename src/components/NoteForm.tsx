"use client";

import { Button, Input } from "antd";
import { useActionState, useEffect, useRef, useState } from "react";
import { addNoteAction, type ActionState } from "@/app/actions";

export function NoteForm({ callId }: { callId: number }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addNoteAction, {});
  const [text, setText] = useState("");
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) setText(""); // clear the box once the note is saved
  }, [state]);
  return (
    <form ref={ref} action={action} className="mt-4 space-y-2">
      <input type="hidden" name="callId" value={callId} />
      <label htmlFor={`note-${callId}`} className="block text-small font-bold">
        Add a note (saved with your name and the time)
      </label>
      <Input.TextArea id={`note-${callId}`} name="body" rows={3} required maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex items-center gap-4">
        <Button htmlType="submit" loading={pending} disabled={!text.trim()}>
          Save note
        </Button>
        <p role="status" className={`text-small ${state.error ? "font-bold" : ""}`}>
          {state.error ?? state.ok ?? ""}
        </p>
      </div>
    </form>
  );
}
