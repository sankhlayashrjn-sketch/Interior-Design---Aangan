import type { ReactNode } from "react";
import { Shapes } from "./Shapes";
import { M } from "./theme";

/** A page's title block: a coloured slab with shapes. `tone` picks the colour so each page feels different. */
export function PageBanner({ title, subtitle, tone = "pink", children }: { title: string; subtitle?: ReactNode; tone?: "pink" | "teal" | "blue" | "yellow"; children?: ReactNode }) {
  const bg = { pink: M.pink, teal: M.teal, blue: M.blue, yellow: M.yellow }[tone];
  const fg = tone === "blue" ? "#fff" : M.ink;
  return (
    <section className="relative mb-6 overflow-hidden rounded-[18px] border-2 border-ink px-6 py-5" style={{ background: bg, color: fg, boxShadow: `6px 6px 0 ${M.ink}` }}>
      <Shapes />
      <div className="relative flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[30px] font-extrabold leading-none tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-body font-semibold">{subtitle}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}
