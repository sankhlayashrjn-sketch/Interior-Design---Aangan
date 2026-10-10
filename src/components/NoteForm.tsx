"use client";

import { useActionState, useEffect, useRef } from "react";
import { addNoteAction, type ActionState } from "@/app/actions";

export function NoteForm({ callId }: { callId: number }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addNoteAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) ref.current?.reset(); // clear the box once the note is saved
  }, [state]);
  return (
    <form ref={ref} action={action} className="mt-4 space-y-2">
      <input type="hidden" name="callId" value={callId} />
      <label htmlFor={`note-${callId}`} className="block text-small text-mute">
        Add a note (saved with your name and the time)
      </label>
      <textarea id={`note-${callId}`} name="body" rows={3} required maxLength={2000} className="w-full rounded border border-line bg-paper px-2 py-1.5" />
      <div className="flex items-center gap-4">
        <button type="submit" disabled={pending} className="rounded border border-ink px-3 py-1.5 font-medium disabled:opacity-50">
          {pending ? "Saving" : "Save note"}
        </button>
        <p role="status" className={`text-small ${state.error ? "font-medium text-ink" : "text-mute"}`}>
          {state.error ?? state.ok ?? ""}
        </p>
      </div>
    </form>
  );
}
