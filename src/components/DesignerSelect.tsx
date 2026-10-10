"use client";

import { Select } from "antd";
import { useRef, useState } from "react";
import { selectDesigner } from "@/app/actions";

/** "Viewing as": picks who you act as in this demo. Submits once, only when you choose someone. */
export function DesignerSelect({ designers, currentId }: { designers: { id: number; name: string }[]; currentId: number | null }) {
  const form = useRef<HTMLFormElement>(null);
  const hidden = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState<number | null>(currentId);
  return (
    <form ref={form} action={selectDesigner} className="space-y-1.5">
      <input ref={hidden} type="hidden" name="designerId" defaultValue={currentId ?? ""} />
      <label htmlFor="designer" className="block text-small font-semibold text-mute">
        Viewing as
      </label>
      <Select
        id="designer"
        value={value ?? undefined}
        onChange={(v: number) => {
          setValue(v);
          if (hidden.current) hidden.current.value = String(v); // set the form field directly so the submit below sees it
          form.current?.requestSubmit();
        }}
        options={designers.map((d) => ({ value: d.id, label: d.name }))}
        style={{ width: "100%" }}
        popupMatchSelectWidth
      />
    </form>
  );
}
