"use client";

import { useRef } from "react";
import { selectDesigner } from "@/app/actions";

export function DesignerSelect({ designers, currentId }: { designers: { id: number; name: string }[]; currentId: number | null }) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={selectDesigner} className="flex items-center gap-2">
      <label htmlFor="designer" className="text-small text-mute">
        Viewing as
      </label>
      <select
        id="designer"
        name="designerId"
        defaultValue={currentId ?? undefined}
        onChange={() => form.current?.requestSubmit()}
        className="rounded border border-line bg-paper px-2 py-1 text-small"
      >
        {designers.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </form>
  );
}
