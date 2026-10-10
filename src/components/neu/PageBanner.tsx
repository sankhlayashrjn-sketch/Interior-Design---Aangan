import type { ReactNode } from "react";
import { N } from "./theme";

const TONE = { pink: N.danger, teal: N.good, blue: N.info, yellow: N.warn } as const;

/** A page's title: a raised slab with a small glowing dot in the page's colour. */
export function PageBanner({ title, subtitle, tone = "blue", children }: { title: string; subtitle?: ReactNode; tone?: "pink" | "teal" | "blue" | "yellow"; children?: ReactNode }) {
  return (
    <section className="n-card mb-7 px-7 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <span className="n-inset-sm flex h-12 w-12 shrink-0 items-center justify-center rounded-full" aria-hidden="true">
            <span className="block h-4 w-4 rounded-full" style={{ background: TONE[tone] }} />
          </span>
          <div>
            <h1 className="text-[28px] font-bold leading-none tracking-tight">{title}</h1>
            {subtitle && <p className="mt-2 text-body text-mute">{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </section>
  );
}
